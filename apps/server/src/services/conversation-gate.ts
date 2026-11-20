import {
	FailOpenConversationGate,
	GateCircuitBreaker,
	type BurstCompletionGateDecision,
	type BurstCompletionGateInput,
	type ConversationGateDriver,
	type ConversationGatePort,
	type GateCircuitState,
	type ProactiveBubbleGateDecision,
	type ProactiveBubbleGateInput,
	type UndirectedGroupGateDecision,
	type UndirectedGroupGateInput,
} from "@tsukaima/core";
import type { Logger } from "../logging.ts";
import {
	resolveSidechatTarget,
	type SidechatModelTarget,
	type SidechatModels,
} from "./sidechat.ts";

const MAX_PROMPT_ITEM_CHARS = 240;

const clip = (value: string, max = MAX_PROMPT_ITEM_CHARS): string => {
	const single = value.replace(/\s+/gu, " ").trim();
	return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
};

function parseBinaryDecision<A extends string, B extends string>(
	raw: string,
	first: A,
	second: B,
):
	| { readonly confidence?: number; readonly decision: A | B; readonly reason?: string }
	| undefined {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const jsonMatch = /\{[\s\S]*\}/u.exec(trimmed);
	if (jsonMatch !== null) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
			const value = typeof parsed.decision === "string" ? parsed.decision.trim().toUpperCase() : "";
			const matched: A | B | undefined =
				value === first ? first : value === second ? second : undefined;
			if (matched !== undefined) {
				const confidence =
					typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
						? Math.max(0, Math.min(1, parsed.confidence))
						: undefined;
				const reason =
					typeof parsed.reason === "string" && parsed.reason.trim().length > 0
						? clip(parsed.reason.trim(), 160)
						: undefined;
				return {
					decision: matched,
					...(confidence === undefined ? {} : { confidence }),
					...(reason === undefined ? {} : { reason }),
				};
			}
		} catch {
			// Fall through to plain-token extraction.
		}
	}
	const upper = trimmed.toUpperCase();
	const tokenPattern = new RegExp(`\\b(${first}|${second})\\b`, "u");
	const tokenMatch = tokenPattern.exec(upper)?.[1];
	if (tokenMatch === first) return { decision: first };
	if (tokenMatch === second) return { decision: second };
	return undefined;
}

export function buildBurstCompletionPrompt(input: BurstCompletionGateInput): string {
	const lines = input.messages.slice(-6).map((msg, i) => `${i + 1}. ${clip(msg)}`);
	return [
		"Decide whether the user has finished typing their thought or is still mid-burst.",
		`Elapsed: ${Math.max(0, Math.round(input.elapsedMs))} ms. Message count: ${input.envelopeCount}.`,
		"Messages (oldest first):",
		...lines,
		'Return only JSON: {"decision":"SEND|WAIT","confidence":0.0,"reason":"short reason"}',
	].join("\n");
}

export function buildUndirectedGroupPrompt(input: UndirectedGroupGateInput): string {
	const recent = (input.recentContext ?? []).slice(-6).map((line) => `- ${clip(line)}`);
	return [
		"Decide whether the assistant should join this undirected group message or stay quiet.",
		"Choose SKIP unless the assistant is clearly invited by context or has something genuinely helpful to add.",
		...(recent.length > 0 ? ["Recent group context:", ...recent] : []),
		`Latest message from ${clip(input.senderName, 60)}: ${clip(input.messageText)}`,
		'Return only JSON: {"decision":"REPLY|SKIP","confidence":0.0,"reason":"short reason"}',
	].join("\n");
}

export function buildProactiveBubblePrompt(input: ProactiveBubbleGateInput): string {
	const recent = input.recentMessages
		.slice(-6)
		.map((msg) => `- ${msg.direction}: ${clip(msg.textPreview)}`);
	return [
		"Decide whether it feels natural to send a short proactive follow-up message in this chat right now.",
		`Chat kind: ${input.conversationKind}. Familiarity: ${input.level}. Idle minutes: ${Math.round(input.idleMinutes)}.`,
		...(recent.length > 0 ? ["Recent messages:", ...recent] : []),
		'Return only JSON: {"decision":"SHOULD|SKIP","confidence":0.0,"reason":"short reason"}',
	].join("\n");
}

export interface ConversationGateServiceOptions {
	readonly circuitBreakerCooldownMs?: number;
	readonly circuitBreakerThreshold?: number;
	/** Optional custom classifier driver (e.g. HTTP endpoint or test double); overrides model path. */
	readonly customDriver?: ConversationGateDriver;
	/** Global default gate model id from runtime settings. */
	readonly defaultModelId: () => Promise<string | undefined>;
	readonly logger: Logger;
	readonly models?: SidechatModels;
	readonly now?: () => number;
}

/**
 * Cheap pre-model conversation gate backed by either a pluggable classifier driver or a small
 * fast model, wrapped in {@link FailOpenConversationGate} with circuit breaker protection.
 *
 * When unconfigured (no classifier and no usable model), fails open immediately without
 * recording circuit-breaker failures or blocking traffic.
 */
export class ConversationGateService implements ConversationGatePort {
	readonly #breaker: GateCircuitBreaker;
	readonly #customDriver: ConversationGateDriver | undefined;
	readonly #defaultModelId: () => Promise<string | undefined>;
	readonly #gate: FailOpenConversationGate;
	readonly #logger: Logger;
	readonly #models: SidechatModels | undefined;

	constructor(options: ConversationGateServiceOptions) {
		this.#logger = options.logger.child("tsukaima::server::gate");
		this.#customDriver = options.customDriver;
		this.#defaultModelId = options.defaultModelId;
		this.#models = options.models;
		this.#breaker = new GateCircuitBreaker({
			...(options.circuitBreakerCooldownMs === undefined
				? {}
				: { cooldownMs: options.circuitBreakerCooldownMs }),
			...(options.circuitBreakerThreshold === undefined
				? {}
				: { failureThreshold: options.circuitBreakerThreshold }),
			...(options.now === undefined ? {} : { now: options.now }),
		});
		const driver: ConversationGateDriver = options.customDriver ?? {
			decideBurstCompletion: async (input, signal) => {
				const text = await this.#completePrompt(
					input.policy.model,
					buildBurstCompletionPrompt(input),
					signal,
				);
				return text === undefined ? undefined : parseBinaryDecision(text, "SEND", "WAIT");
			},
			decideProactiveBubble: async (input, signal) => {
				const text = await this.#completePrompt(
					input.policy?.model,
					buildProactiveBubblePrompt(input),
					signal,
				);
				return text === undefined ? undefined : parseBinaryDecision(text, "SHOULD", "SKIP");
			},
			decideUndirectedGroupReply: async (input, signal) => {
				const text = await this.#completePrompt(
					input.policy.model,
					buildUndirectedGroupPrompt(input),
					signal,
				);
				return text === undefined ? undefined : parseBinaryDecision(text, "REPLY", "SKIP");
			},
		};
		this.#gate = new FailOpenConversationGate({
			breaker: this.#breaker,
			driver,
			...(options.now === undefined ? {} : { now: options.now }),
			onFallback: ({ kind, reason }) => {
				this.#logger.debug("conversation gate fell back open", {
					breaker: this.#breaker.state().state,
					kind,
					reason,
				});
			},
		});
	}

	health(): GateCircuitState {
		return this.#gate.health();
	}

	async decideBurstCompletion(
		input: BurstCompletionGateInput,
	): Promise<BurstCompletionGateDecision> {
		if (!input.policy.enabled || !input.policy.burstCompletion) {
			return { decision: "SEND", reason: "disabled", source: "fallback" };
		}
		if (!(await this.#hasBackend(input.policy.model))) {
			return { decision: "SEND", reason: "unconfigured", source: "fallback" };
		}
		return this.#gate.decideBurstCompletion(input);
	}

	async decideUndirectedGroupReply(
		input: UndirectedGroupGateInput,
	): Promise<UndirectedGroupGateDecision> {
		if (!input.policy.enabled || !input.policy.undirectedGroupReply) {
			return { decision: "REPLY", reason: "disabled", source: "fallback" };
		}
		if (!(await this.#hasBackend(input.policy.model))) {
			return { decision: "REPLY", reason: "unconfigured", source: "fallback" };
		}
		return this.#gate.decideUndirectedGroupReply(input);
	}

	async decideProactiveBubble(
		input: ProactiveBubbleGateInput,
	): Promise<ProactiveBubbleGateDecision> {
		if (input.policy !== undefined && (!input.policy.enabled || !input.policy.proactiveBubble)) {
			return { decision: "SHOULD", reason: "disabled", source: "fallback" };
		}
		if (!(await this.#hasBackend(input.policy?.model))) {
			return { decision: "SHOULD", reason: "unconfigured", source: "fallback" };
		}
		return this.#gate.decideProactiveBubble(input);
	}

	async #hasBackend(policyModelId: string | undefined): Promise<boolean> {
		if (this.#customDriver !== undefined) return true;
		return (await this.#resolveTarget(policyModelId)) !== undefined;
	}

	async #resolveTarget(
		policyModelId: string | undefined,
	): Promise<SidechatModelTarget | undefined> {
		const models = this.#models;
		if (models === undefined) return undefined;
		const active = models.active();
		const eligible = await models.eligible().catch(() => []);
		const configured = policyModelId?.trim();
		const fallback =
			configured !== undefined && configured.length > 0
				? undefined
				: (await this.#defaultModelId().catch(() => undefined))?.trim();
		const requested =
			configured !== undefined && configured.length > 0
				? configured
				: fallback !== undefined && fallback.length > 0
					? fallback
					: undefined;
		if (requested === undefined) return active ?? eligible[0];
		return resolveSidechatTarget(eligible, requested, active) ?? active;
	}

	async #completePrompt(
		policyModelId: string | undefined,
		prompt: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		const models = this.#models;
		if (models === undefined) return undefined;
		const target = await this.#resolveTarget(policyModelId);
		if (target === undefined) return undefined;
		return models.complete(target, prompt, {
			maxTokens: 96,
			signal,
			temperature: 0,
		});
	}
}
