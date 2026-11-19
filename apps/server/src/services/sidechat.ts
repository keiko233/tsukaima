import type { BusyArbitrationInput, BusyArbitrationResult } from "@tsukaima/core";
import type { Logger } from "../logging.ts";
import { DEFAULT_PROMPTS } from "./prompt-defaults.ts";

const MAX_PENDING_CHARS = 3_000;
const MAX_REQUEST_CHARS = 1_500;
const MAX_ANSWER_CHARS = 1_000;
const MAX_PARTIAL_CHARS = 800;
const MAX_REASON_CHARS = 240;

const clip = (value: string, limit: number): string =>
	value.length <= limit ? value : `${value.slice(0, limit)}…`;

const none = (value: string | undefined): string =>
	value === undefined || value.trim().length === 0 ? "(none)" : value.trim();

function parseDecision(
	text: string,
): { confidence?: number; decision: "interrupt" | "steer" | "wait"; reason?: string } | undefined {
	const match = /\{[\s\S]*\}/u.exec(text);
	if (match === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const decision = record.decision;
	if (decision !== "interrupt" && decision !== "steer" && decision !== "wait") return undefined;
	const confidence =
		typeof record.confidence === "number" && Number.isFinite(record.confidence)
			? Math.max(0, Math.min(1, record.confidence))
			: undefined;
	const reason =
		typeof record.reason === "string" && record.reason.trim().length > 0
			? clip(record.reason.trim(), MAX_REASON_CHARS)
			: undefined;
	return {
		decision,
		...(confidence === undefined ? {} : { confidence }),
		...(reason === undefined ? {} : { reason }),
	};
}

export interface SidechatModelTarget {
	readonly modelId: string;
	readonly providerId: string;
}

/**
 * Model access supplied by the plugin registry. `eligible` is whatever providers advertise with
 * the sidechat capability, so each plugin decides which of its models may classify busy runs.
 */
export interface SidechatModels {
	/** Model currently serving conversations; the fallback when nothing is configured. */
	readonly active: () => SidechatModelTarget | undefined;
	readonly eligible: () => Promise<readonly SidechatModelTarget[]>;
	readonly complete: (
		target: SidechatModelTarget,
		prompt: string,
		options: {
			readonly maxTokens: number;
			readonly signal: AbortSignal;
			readonly temperature: number;
		},
	) => Promise<string>;
}

export interface SidechatServiceOptions {
	readonly prompt?: () => Promise<string>;
	/** Global default model id, read from runtime settings on demand. */
	readonly defaultModelId: () => Promise<string | undefined>;
	readonly logger: Logger;
	readonly models: SidechatModels;
}

/**
 * Picks the provider/model for a requested model id. Model ids are only unique per provider, so
 * the active provider wins a tie and the remaining catalog order breaks the rest.
 */
export function resolveSidechatTarget(
	eligible: readonly SidechatModelTarget[],
	modelId: string,
	active: SidechatModelTarget | undefined,
): SidechatModelTarget | undefined {
	const matches = eligible.filter((model) => model.modelId === modelId);
	return (
		matches.find((model) => model.providerId === active?.providerId) ??
		matches[0] ??
		(active?.modelId === modelId ? active : undefined)
	);
}

/**
 * Fast, single-call classifier for the "a run is still working, new messages arrived" decision.
 * It is deliberately not a second agent: it gets a bounded excerpt, returns strict JSON, and
 * any failure means `wait` at the caller.
 */
export class SidechatService {
	readonly #prompt: SidechatServiceOptions["prompt"];
	readonly #defaultModelId: SidechatServiceOptions["defaultModelId"];
	readonly #logger: Logger;
	readonly #models: SidechatModels;

	constructor(options: SidechatServiceOptions) {
		this.#prompt = options.prompt;
		this.#defaultModelId = options.defaultModelId;
		this.#logger = options.logger.child("tsukaima::server::sidechat");
		this.#models = options.models;
	}

	async decide(input: BusyArbitrationInput): Promise<BusyArbitrationResult | undefined> {
		if (!input.policy.sidechat.enabled) return undefined;
		const active = this.#models.active();
		const eligible = await this.#models.eligible().catch(() => []);
		const configured = input.policy.sidechat.model?.trim();
		const fallback =
			configured !== undefined && configured.length > 0
				? undefined
				: await this.#defaultModelId().catch(() => undefined);
		const requested =
			configured !== undefined && configured.length > 0
				? configured
				: fallback !== undefined && fallback.trim().length > 0
					? fallback.trim()
					: undefined;
		// With nothing configured, a plugin-declared model is better than no classifier at all.
		let target =
			requested === undefined
				? (active ?? eligible[0])
				: resolveSidechatTarget(eligible, requested, active);
		if (requested !== undefined && target === undefined) {
			this.#logger.warn("sidechat model is not available; using the active model", {
				modelId: requested,
			});
			target = active;
		}
		if (target === undefined) {
			this.#logger.warn("sidechat has no usable model", { modelId: requested });
			return undefined;
		}
		const startedAt = performance.now();
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			Math.max(100, input.policy.sidechat.timeoutMs),
		);
		timer.unref?.();
		try {
			const text = await this.#models.complete(
				target,
				buildSidechatPrompt(input, await this.#prompt?.()),
				{
					maxTokens: 160,
					signal: controller.signal,
					temperature: 0,
				},
			);
			const parsed = parseDecision(text);
			if (parsed === undefined) {
				this.#logger.debug("sidechat returned no usable decision", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: target.modelId,
					outputChars: text.length,
					providerId: target.providerId,
				});
				return undefined;
			}
			if (parsed.decision !== "wait" && parsed.confidence === undefined) {
				this.#logger.debug("sidechat decision without confidence downgraded", {
					decision: parsed.decision,
					modelId: target.modelId,
				});
				return { decision: "wait", reason: "missing confidence" };
			}
			if (
				parsed.confidence !== undefined &&
				parsed.confidence < input.policy.sidechat.minConfidence
			) {
				this.#logger.debug("sidechat decision below confidence threshold", {
					confidence: parsed.confidence,
					decision: parsed.decision,
					minConfidence: input.policy.sidechat.minConfidence,
					modelId: target.modelId,
				});
				return {
					decision: "wait",
					...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
					reason: "below threshold",
				};
			}
			if (parsed.decision === "steer" && !input.toolsActive) {
				this.#logger.debug("sidechat steer downgraded: no active tool round", {
					modelId: target.modelId,
				});
				return {
					decision: "wait",
					...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
					reason: "no active tool round",
				};
			}
			this.#logger.debug("sidechat decision", {
				confidence: parsed.confidence,
				decision: parsed.decision,
				durationMs: Math.round(performance.now() - startedAt),
				modelId: target.modelId,
				providerId: target.providerId,
				toolRounds: input.turns,
				toolsActive: input.toolsActive,
			});
			return parsed;
		} catch (error) {
			if (controller.signal.aborted) {
				this.#logger.debug("sidechat timed out", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: target.modelId,
					timeoutMs: input.policy.sidechat.timeoutMs,
				});
			} else {
				this.#logger.warn("sidechat completion failed", {
					error: error instanceof Error ? error.message : String(error),
					modelId: target.modelId,
				});
			}
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Build the bounded routing prompt. Chat content is only sent to the model, never logged. */
export function buildSidechatPrompt(
	input: BusyArbitrationInput,
	instructions = DEFAULT_PROMPTS.sidechat,
): string {
	return [
		instructions,
		"",
		`Current request being answered:\n${none(clip(input.runningRequest, MAX_REQUEST_CHARS))}`,
		`Previous settled assistant answer:\n${none(clip(input.previousAnswer ?? "", MAX_ANSWER_CHARS))}`,
		`Assistant progress so far:\n${none(clip(input.partialAnswer ?? "", MAX_PARTIAL_CHARS))}`,
		`Tool rounds so far: ${input.turns}. Tools active now: ${input.toolsActive ? "yes" : "no"}. Run age: ${Math.max(0, Math.round(input.runAgeMs))} ms.`,
		`Pending messages, newest last:\n${clip(input.pendingText, MAX_PENDING_CHARS)}`,
		"",
		'Return only JSON, with no markdown and no prose: {"decision":"interrupt|steer|wait","confidence":0.0,"reason":"short reason"}',
	].join("\n");
}
