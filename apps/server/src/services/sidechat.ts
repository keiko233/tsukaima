import type { BusyArbitrationInput, BusyArbitrationResult, ModelPort } from "@tsukaima/core";
import type { Logger } from "../logging.ts";

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

export interface SidechatServiceOptions {
	/** Global default model id, read from runtime settings on demand. */
	readonly defaultModelId: () => Promise<string | undefined>;
	readonly logger: Logger;
	readonly model: () => ModelPort | undefined;
}

/**
 * Fast, single-call classifier for the "a run is still working, new messages arrived" decision.
 * It is deliberately not a second agent: it gets a bounded excerpt, returns strict JSON, and
 * any failure means `wait` at the caller.
 */
export class SidechatService {
	readonly #defaultModelId: SidechatServiceOptions["defaultModelId"];
	readonly #logger: Logger;
	readonly #model: SidechatServiceOptions["model"];

	constructor(options: SidechatServiceOptions) {
		this.#defaultModelId = options.defaultModelId;
		this.#logger = options.logger.child("tsukaima::server::sidechat");
		this.#model = options.model;
	}

	async decide(input: BusyArbitrationInput): Promise<BusyArbitrationResult | undefined> {
		if (!input.policy.sidechat.enabled) return undefined;
		const port = this.#model();
		if (port === undefined) return undefined;
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
					: port.modelId;
		let selected = port.models.getModel(port.providerId, requested);
		if (selected === undefined && requested !== port.modelId) {
			this.#logger.warn("sidechat model is not available; using the active model", {
				modelId: requested,
				providerId: port.providerId,
			});
			selected = port.models.getModel(port.providerId, port.modelId);
		}
		if (selected === undefined) {
			this.#logger.warn("sidechat has no usable model", {
				modelId: requested,
				providerId: port.providerId,
			});
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
			const response = await port.models.completeSimple(
				selected,
				{
					messages: [
						{
							content: buildSidechatPrompt(input),
							role: "user",
							timestamp: Date.now(),
						},
					],
				},
				{
					cacheRetention: "none",
					maxTokens: 160,
					signal: controller.signal,
					temperature: 0,
				},
			);
			const text = response.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			const parsed = parseDecision(text);
			if (parsed === undefined) {
				this.#logger.debug("sidechat returned no usable decision", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: selected.id,
					outputChars: text.length,
					providerId: port.providerId,
				});
				return undefined;
			}
			if (parsed.decision !== "wait" && parsed.confidence === undefined) {
				this.#logger.debug("sidechat decision without confidence downgraded", {
					decision: parsed.decision,
					modelId: selected.id,
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
					modelId: selected.id,
				});
				return {
					decision: "wait",
					...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
					reason: "below threshold",
				};
			}
			if (parsed.decision === "steer" && !input.toolsActive) {
				this.#logger.debug("sidechat steer downgraded: no active tool round", {
					modelId: selected.id,
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
				modelId: selected.id,
				providerId: port.providerId,
				toolRounds: input.turns,
				toolsActive: input.toolsActive,
			});
			return parsed;
		} catch (error) {
			if (controller.signal.aborted) {
				this.#logger.debug("sidechat timed out", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: selected.id,
					timeoutMs: input.policy.sidechat.timeoutMs,
				});
			} else {
				this.#logger.warn("sidechat completion failed", {
					error: error instanceof Error ? error.message : String(error),
					modelId: selected.id,
				});
			}
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Build the bounded routing prompt. Chat content is only sent to the model, never logged. */
export function buildSidechatPrompt(input: BusyArbitrationInput): string {
	return [
		"You are the sidechat router for a chat agent that is still working on its current turn.",
		"New user messages arrived in a pending batch. Decide exactly one action.",
		"",
		"Actions:",
		"- interrupt: the pending batch corrects, completes, contradicts, or replaces the request being answered, so the current answer will be wrong or wasted. The caller will cancel the current generation and answer the merged conversation.",
		"- steer: the agent is using tools and the pending batch adds a constraint or instruction that can be applied at the next tool step. Only valid when toolsActive is yes.",
		"- wait: the pending batch is a separate thought, reaction, acknowledgement, emoji or sticker, or can simply be answered after the current answer. When unsure, choose wait.",
		"",
		"Rules:",
		"- Prefer wait. Interrupt only when continuing the current answer would clearly waste the user's time or produce a wrong answer.",
		"- A request that is obviously unfinished and directly continued by the pending batch is an interrupt.",
		"- Do not interrupt for a mere reaction, thanks, laughter, or an unrelated new topic.",
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
