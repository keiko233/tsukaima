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
import type { NativeDecisionModels } from "./decision-models.ts";
import {
	resolveSidechatTarget,
	type SidechatModelTarget,
	type SidechatModels,
} from "./sidechat.ts";

const MAX_PROMPT_ITEM_CHARS = 240;
// Allow enough budget for reasoning/thinking tokens before the short JSON decision.
const GATE_MAX_TOKENS = 512;

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

export function buildBurstCompletionPrompt(
	input: BurstCompletionGateInput,
	structured = false,
): string {
	const lines = input.messages.slice(-6).map((msg, i) => `${i + 1}. ${clip(msg)}`);
	return [
		"Decide whether the user has finished typing their thought or is still mid-burst.",
		`Elapsed: ${Math.max(0, Math.round(input.elapsedMs))} ms. Message count: ${input.envelopeCount}.`,
		"Messages (oldest first):",
		...lines,
		...(structured
			? []
			: ['Return only JSON: {"decision":"SEND|WAIT","confidence":0.0,"reason":"short reason"}']),
	].join("\n");
}

export function buildUndirectedGroupPrompt(
	input: UndirectedGroupGateInput,
	structured = false,
): string {
	const recent = (input.recentContext ?? []).slice(-6).map((line) => `- ${clip(line)}`);
	return [
		"Decide whether the assistant should join this undirected group message or stay quiet.",
		input.requireDirectAddress
			? "Choose REPLY only if the latest speaker is addressing the assistant. Second-person wording is a clue, not proof. Choose SKIP when they address someone else or the addressee is unclear."
			: "Choose SKIP unless the assistant is clearly invited by context or has something genuinely helpful to add.",
		...(recent.length > 0 ? ["Recent group context:", ...recent] : []),
		`Latest message from ${clip(input.senderName, 60)}: ${clip(input.messageText)}`,
		...(structured
			? []
			: ['Return only JSON: {"decision":"REPLY|SKIP","confidence":0.0,"reason":"short reason"}']),
	].join("\n");
}

export function buildProactiveBubblePrompt(
	input: ProactiveBubbleGateInput,
	structured = false,
): string {
	const recent = input.recentMessages
		.slice(-6)
		.map((msg) => `- ${msg.direction}: ${clip(msg.textPreview)}`);
	return [
		"Decide whether it feels natural to send a short proactive follow-up message in this chat right now.",
		`Chat kind: ${input.conversationKind}. Familiarity: ${input.level}. Idle minutes: ${Math.round(input.idleMinutes)}.`,
		...(recent.length > 0 ? ["Recent messages:", ...recent] : []),
		...(structured
			? []
			: ['Return only JSON: {"decision":"SHOULD|SKIP","confidence":0.0,"reason":"short reason"}']),
	].join("\n");
}

export interface ConversationGateServiceOptions {
	readonly circuitBreakerCooldownMs?: number;
	readonly circuitBreakerThreshold?: number;
	/** Optional custom classifier driver (e.g. HTTP endpoint or test double); overrides model path. */
	readonly customDriver?: ConversationGateDriver;
	readonly decisionModels?: NativeDecisionModels;
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
	readonly #decisionModels: NativeDecisionModels | undefined;
	readonly #customDriver: ConversationGateDriver | undefined;
	readonly #defaultModelId: () => Promise<string | undefined>;
	readonly #gate: FailOpenConversationGate;
	readonly #logger: Logger;
	readonly #models: SidechatModels | undefined;

	constructor(options: ConversationGateServiceOptions) {
		this.#logger = options.logger.child("tsukaima::server::gate");
		this.#customDriver = options.customDriver;
		this.#defaultModelId = options.defaultModelId;
		this.#decisionModels = options.decisionModels;
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
			decideBurstCompletion: (input, signal) =>
				this.#decide(
					input.policy.model,
					(structured) => buildBurstCompletionPrompt(input, structured),
					"SEND",
					"WAIT",
					{
						SEND: "The user has finished the thought and the assistant can answer.",
						WAIT: "The user is likely to send another message to complete the thought.",
					},
					signal,
				),
			decideProactiveBubble: (input, signal) =>
				this.#decide(
					input.policy?.model,
					(structured) => buildProactiveBubblePrompt(input, structured),
					"SHOULD",
					"SKIP",
					{
						SHOULD: "A short unsolicited follow-up fits the situation and relationship.",
						SKIP: "A follow-up would feel unnecessary, disruptive, or unwelcome.",
					},
					signal,
				),
			decideUndirectedGroupReply: (input, signal) =>
				this.#decide(
					input.policy.model,
					(structured) => buildUndirectedGroupPrompt(input, structured),
					"REPLY",
					"SKIP",
					{
						REPLY:
							"The assistant is clearly invited by context or can add something genuinely helpful.",
						SKIP: "The message is group chatter and the assistant should stay silent.",
					},
					signal,
				),
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
		const requested = await this.#requestedModel(policyModelId);
		return (
			this.#decisionModels?.supports(requested) === true ||
			(await this.#resolveTarget(requested)) !== undefined
		);
	}

	async #requestedModel(policyModelId: string | undefined): Promise<string | undefined> {
		return (
			policyModelId?.trim() ||
			(await this.#defaultModelId().catch(() => undefined))?.trim() ||
			undefined
		);
	}

	async #resolveTarget(requested: string | undefined): Promise<SidechatModelTarget | undefined> {
		const models = this.#models;
		if (models === undefined) return undefined;
		const active = models.active();
		const eligible = await models.eligible().catch(() => []);
		if (requested === undefined) return active ?? eligible[0];
		return resolveSidechatTarget(eligible, requested, active) ?? active;
	}

	async #decide<A extends string, B extends string>(
		policyModelId: string | undefined,
		prompt: (structured: boolean) => string,
		first: A,
		second: B,
		options: Readonly<Record<A | B, string>>,
		signal: AbortSignal,
	) {
		const requested = await this.#requestedModel(policyModelId);
		if (this.#decisionModels?.supports(requested)) {
			const result = await this.#decisionModels.choose<A | B>(requested, {
				context: prompt(true),
				instructions:
					"Apply the conversation guidelines to the supplied context and choose the applicable outcome.",
				options,
				signal,
			});
			return { ...result, modelId: requested };
		}
		const models = this.#models;
		if (models === undefined) return undefined;
		const target = await this.#resolveTarget(requested);
		if (target === undefined) return undefined;
		const text = await models.complete(target, prompt(false), {
			maxTokens: GATE_MAX_TOKENS,
			reasoning: "minimal",
			signal,
			temperature: 0,
		});
		const result = parseBinaryDecision(text, first, second);
		if (result === undefined) {
			this.#logger.debug("conversation gate returned unparseable response", {
				modelId: target.modelId,
				providerId: target.providerId,
				textLength: text.length,
				textPreview: text.length === 0 ? undefined : clip(text, 120),
			});
			return undefined;
		}
		return { ...result, modelId: target.modelId };
	}
}
