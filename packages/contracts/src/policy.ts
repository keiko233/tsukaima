import { z } from "zod";

/**
 * Reasoning effort exposed by the host. `off` disables thinking; the remaining values map to
 * the provider's own effort scale. Keep this list in sync with pi-ai's model thinking levels.
 */
export const thinkingLevelSchema = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

/** Provider-scoped model selection. Model ids are only unique inside one provider. */
export const modelSelectionSchema = z
	.object({
		modelId: z.string().min(1),
		providerId: z.string().min(1),
	})
	.strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * Legacy activity-window settings stay supported. `windowMs` maps to
 * `pacing.burstSettleMs` and `maxMessages` maps to `pacing.burstMaxMessages`; the former
 * 3–10 second clamp is deliberately gone so tests and deployments can use short windows.
 */
export const activityAggregationPolicySchema = z
	.object({
		maxMessages: z.number().int().min(1),
		windowMs: z.number().int().min(1),
		burstMaxWaitMs: z.number().int().min(1).optional(),
	})
	.strict();

export type ActivityAggregationPolicy = z.infer<typeof activityAggregationPolicySchema>;

export const defaultActivityAggregationPolicy: ActivityAggregationPolicy = {
	maxMessages: 20,
	windowMs: 6_000,
};

export const triggerClassificationSchema = z.enum(["direct", "soft", "ambient"]);
export type TriggerClassification = z.infer<typeof triggerClassificationSchema>;

export const triggerDecisionSchema = z.enum(["direct", "soft", "ambient", "ignored"]);
export type TriggerDecision = z.infer<typeof triggerDecisionSchema>;

export const recentActivityEscalationSchema = z.enum(["off", "throttled", "always"]);
export type RecentActivityEscalation = z.infer<typeof recentActivityEscalationSchema>;

export const conversationTriggerPolicySchema = z
	.object({
		privateAccess: z.enum(["open", "allowlist", "disabled"]).default("open"),
		groupAccess: z.enum(["open", "allowlist", "disabled"]).default("open"),
		allowlist: z.array(z.string().min(1)).default([]),
		keywords: z.array(z.string().min(1)).default([]),
		groupMentionMode: z.enum(["always", "smart", "disabled"]).default("always"),
		replyToBotCounts: z.boolean().default(true),
		stickerOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).default("lurk"),
		imageOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).default("lurk"),
		selfAliases: z.array(z.string().min(1)).default([]),
		peerBotIds: z.array(z.string().min(1)).default([]),
		/**
		 * Whether recent bot activity lets an undirected group message start a full-model `soft`
		 * turn. `always` is the legacy behavior (every message for the activity window),
		 * `throttled` allows at most one such turn per `recentActivityMinIntervalMs`, and `off`
		 * keeps undirected messages ambient. Direct, alias, and reply triggers are unaffected.
		 */
		recentActivityEscalation: recentActivityEscalationSchema.default("throttled"),
		recentActivityMinIntervalMs: z.number().int().min(0).default(60_000),
	})
	.strict();

export type ConversationTriggerPolicy = z.infer<typeof conversationTriggerPolicySchema>;

export const quietHoursSchema = z
	.object({
		enabled: z.boolean().default(false),
		startHour: z.number().int().min(0).max(23).default(22),
		endHour: z.number().int().min(0).max(23).default(7),
	})
	.strict();

export type QuietHoursPolicy = z.infer<typeof quietHoursSchema>;

export const conversationPacingPolicySchema = z
	.object({
		burstSettleMs: z.number().int().min(1).default(1_200),
		burstMaxWaitMs: z.number().int().min(1).default(5_000),
		burstMaxMessages: z.number().int().min(1).default(20),
		burstLongMessageThreshold: z.number().int().min(1).default(32),
		/**
		 * Submit a single direct message (private chat, `@bot`, reply-to-bot, wake keyword)
		 * without waiting for `burstSettleMs` when it already reads as complete: it ends with
		 * terminal punctuation or reaches `burstLongMessageThreshold`.
		 */
		directFlushEnabled: z.boolean().default(true),
		/**
		 * A message that arrived within this window of the previous one is part of an active
		 * burst, so the direct-flush shortcut waits for the normal settle window instead.
		 */
		activeBurstWindowMs: z.number().int().min(0).default(1_500),
		/**
		 * Deliver assistant text written before a tool call as a mid-turn message, so the chat
		 * sees "let me check" before a slow tool finishes.
		 */
		narrationEnabled: z.boolean().default(true),
		/** Minimum spacing between two narration messages of the same conversation. */
		narrationMinIntervalMs: z.number().int().min(0).default(1_500),
		replyCooldownMs: z.number().int().min(0).default(0),
		typingEnabled: z.boolean().default(false),
		replyDelayEnabled: z.boolean().default(false),
		replyDelayMaxMs: z.number().int().min(0).default(2_000),
		sendIntervalMs: z.number().int().min(0).default(400),
		maxImmediateOutputMessages: z.number().int().min(1).default(6),
		stripMarkdown: z.boolean().default(true),
		quietHours: quietHoursSchema.optional(),
		maxRepliesPerMinute: z.number().int().min(0).default(20),
		allowedTools: z.array(z.string().min(1)).optional(),
	})
	.strict();

export type ConversationPacingPolicy = z.infer<typeof conversationPacingPolicySchema>;

/**
 * Channel notices (platform interactions that are not messages). Notices are always persisted
 * as history; these switches decide whether the model sees them and whether a self-targeted
 * poke may wake the conversation. A wake still passes the normal access policy.
 */
export const conversationNoticePolicySchema = z
	.object({
		/** Show self-targeted pokes to the model in the next turn's observation window. */
		pokeObserve: z.boolean().default(true),
		/** Start a turn when someone pokes the bot. */
		pokeWake: z.boolean().default(false),
		/** Minimum spacing between two poke-triggered turns of the same conversation. */
		pokeWakeCooldownMs: z.number().int().min(0).default(60_000),
	})
	.strict();

export type ConversationNoticePolicy = z.infer<typeof conversationNoticePolicySchema>;

export const lengthTruncationModeSchema = z.enum(["continue", "surface"]);
export type LengthTruncationMode = z.infer<typeof lengthTruncationModeSchema>;

/**
 * Per-conversation generation controls. Sampling fields override the provider model's
 * configured values for OpenAI-compatible requests only; unset fields keep the provider value.
 */
export const conversationGenerationPolicySchema = z
	.object({
		/**
		 * What to do when the model stops on its output token limit: `continue` delivers the cut
		 * text and asks the model to finish, at most `maxLengthContinuations` times per run;
		 * `surface` delivers it as-is and records the truncation.
		 */
		lengthTruncation: lengthTruncationModeSchema.default("continue"),
		maxLengthContinuations: z.number().int().min(0).max(3).default(1),
		temperature: z.number().min(0).max(2).optional(),
		topP: z.number().gt(0).max(1).optional(),
		stop: z.array(z.string().min(1)).max(4).optional(),
	})
	.strict();

export type ConversationGenerationPolicy = z.infer<typeof conversationGenerationPolicySchema>;

/**
 * How a conversation decides what to do with messages that arrive while a model run is
 * already working. The sidechat is a fast classifier; the host owns the actual interrupt and
 * batching behavior so a policy can never abort or queue work on its own.
 */
export const sidechatPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Model id inside the active provider. Falls back to the runtime sidechat setting. */
		model: z.string().min(1).optional(),
		timeoutMs: z.number().int().min(100).default(1_500),
		minConfidence: z.number().min(0).max(1).default(0.6),
		minRunAgeMs: z.number().int().min(0).default(0),
		maxInterruptsPerMinute: z.number().int().min(0).default(3),
		/** Stop accumulating and submit a follow-up if a run stays busy for this long. */
		maxHoldMs: z.number().int().min(1).default(120_000),
		/**
		 * Allow an optional fast-lane interjection for direct urgent messages while a long main
		 * turn is working, using minimal context plus a one-line persona/relation anchor.
		 */
		interjectEnabled: z.boolean().default(false),
		/** Optional model id override for fast-lane busy interjections. */
		interjectModel: z.string().min(1).optional(),
		interjectTimeoutMs: z.number().int().min(100).max(30_000).default(3_000),
		interjectMaxTokens: z.number().int().min(32).max(512).default(160),
	})
	.strict();

export type SidechatPolicy = z.infer<typeof sidechatPolicySchema>;

/**
 * Automatic context compaction thresholds for one conversation. Compaction starts at
 * `triggerTokens` when it is positive, otherwise above `contextWindow - reserveTokens`. It
 * keeps roughly `keepRecentTokens` of recent history verbatim, and a background pass starts
 * `backgroundTokens` before the blocking threshold. `0` disables the background pass.
 */
export const conversationCompactionPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		/**
		 * Absolute context size that triggers compaction. `0` means auto: use
		 * `contextWindow - reserveTokens` for the active model instead.
		 */
		triggerTokens: z.number().int().min(0).default(0),
		reserveTokens: z.number().int().min(0).default(16_384),
		keepRecentTokens: z.number().int().min(0).default(20_000),
		backgroundTokens: z.number().int().min(0).default(32_768),
	})
	.strict();

export type ConversationCompactionPolicy = z.infer<typeof conversationCompactionPolicySchema>;

/**
 * Named compaction shapes offered by the WebUI. They only set the compaction section, so an
 * operator can start from a strategy and still tune individual thresholds.
 */
export const conversationCompactionPresets = {
	/** Compact late and keep a large recent window verbatim. */
	conservative: {
		backgroundTokens: 8_192,
		enabled: true,
		keepRecentTokens: 32_768,
		reserveTokens: 8_192,
		triggerTokens: 0,
	},
	/** pi-durable's defaults: a middle ground for large-window models. */
	balanced: {
		backgroundTokens: 32_768,
		enabled: true,
		keepRecentTokens: 20_000,
		reserveTokens: 16_384,
		triggerTokens: 0,
	},
	/** Compact earlier and keep a smaller recent window verbatim. */
	aggressive: {
		backgroundTokens: 32_768,
		enabled: true,
		keepRecentTokens: 12_000,
		reserveTokens: 32_768,
		triggerTokens: 0,
	},
} as const satisfies Record<string, ConversationCompactionPolicy>;

export type ConversationCompactionPreset = keyof typeof conversationCompactionPresets;

/**
 * Cross-session awareness for the current speaker (DSH `crossSessionEnabled`,
 * `crossRecentMinutes`, `crossRecentLimit`, `crossInjectMaxChars`, `crossPrivateToGroup`).
 * The derived context is fail-closed: an unknown speaker yields nothing, and private chat text
 * never reaches a group prompt unless `privateToGroup` is explicitly `text`.
 */
export const crossSessionPrivacySchema = z.enum(["none", "indicator", "text"]);
export type CrossSessionPrivacy = z.infer<typeof crossSessionPrivacySchema>;

export const crossSessionPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Look-back window for the speaker's activity in other chats. */
		windowMinutes: z.number().int().min(1).max(10_080).default(120),
		/** Maximum other conversations listed. */
		maxEntries: z.number().int().min(0).max(20).default(4),
		/** Character budget of the rendered cross-session block. */
		maxChars: z.number().int().min(0).max(4_000).default(600),
		/**
		 * What a group prompt may learn about the speaker's private chats: `none` hides them,
		 * `indicator` says only that a recent private chat exists, `text` allows snippets.
		 */
		privateToGroup: crossSessionPrivacySchema.default("indicator"),
	})
	.strict();

export type CrossSessionPolicy = z.infer<typeof crossSessionPolicySchema>;

export const defaultCrossSessionPolicy: CrossSessionPolicy = {
	enabled: true,
	maxChars: 600,
	maxEntries: 4,
	privateToGroup: "indicator",
	windowMinutes: 120,
};

/**
 * Background semantic memory consolidation. One idle-debounced durable job per conversation
 * folds the settled message delta into the merged warm state and long-term memories. It runs
 * when the conversation has been idle for `idleMs`, when `minNewMessages` unconsolidated
 * messages accumulated, or at the latest `maxDelayMs` after the first pending message.
 */
export const memoryConsolidationPolicySchema = z
	.object({
		idleMs: z.number().int().min(0).default(90_000),
		minNewMessages: z.number().int().min(1).default(30),
		maxDelayMs: z.number().int().min(0).default(600_000),
		/** Settled messages read per consolidation pass. */
		maxBatchMessages: z.number().int().min(1).max(500).default(80),
		/** A batch that fails this many times is dropped (watermark advanced) and audited. */
		maxFailures: z.number().int().min(1).max(10).default(3),
		/** Bound on the rolling summary carried in the warm state. */
		summaryMaxChars: z.number().int().min(100).max(8_000).default(1_200),
		maxPersonCards: z.number().int().min(0).max(100).default(16),
		/** Recall earlier answers to recurring questions so replies stay consistent. */
		qaRecallEnabled: z.boolean().default(true),
	})
	.strict();

export type MemoryConsolidationPolicy = z.infer<typeof memoryConsolidationPolicySchema>;

export const defaultMemoryConsolidationPolicy: MemoryConsolidationPolicy = {
	idleMs: 90_000,
	maxBatchMessages: 80,
	maxDelayMs: 600_000,
	maxFailures: 3,
	maxPersonCards: 16,
	minNewMessages: 30,
	qaRecallEnabled: true,
	summaryMaxChars: 1_200,
};

/**
 * Per-conversation social familiarity learning and hard safety gates for proactive/bubble
 * turns. Hard gates always enforce quiet hours, explicit refusal cooldown, consecutive
 * unanswered silence, and recent self-message ratio ceiling regardless of familiarity level.
 */
export const socialPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		/** Designate this conversation as a close/home chat (defaults familiarity to `L2`). */
		homeChat: z.boolean().default(false),
		/** Silence window after an explicit user refusal (hours). */
		refusalCooldownHours: z.number().int().min(0).max(720).default(48),
		/** Silence window after consecutive unanswered proactive turns (hours). */
		unansweredSilenceHours: z.number().int().min(0).max(720).default(24),
		/** Consecutive unanswered proactive messages before triggering `unansweredSilenceHours`. */
		unansweredThreshold: z.number().int().min(1).max(20).default(2),
		/** Maximum allowed fraction of outbound bot messages in the recent window (0..1). */
		maxSelfMessageRatio: z.number().min(0).max(1).default(0.4),
		/** Number of recent messages inspected for the self-message ratio gate. */
		selfRatioWindowMessages: z.number().int().min(4).max(100).default(10),
	})
	.strict();

export type SocialPolicy = z.infer<typeof socialPolicySchema>;

export const defaultSocialPolicy: SocialPolicy = {
	enabled: true,
	homeChat: false,
	maxSelfMessageRatio: 0.4,
	refusalCooldownHours: 48,
	selfRatioWindowMessages: 10,
	unansweredSilenceHours: 24,
	unansweredThreshold: 2,
};

/**
 * Output humanization guards: anti-repetition avoid-list, optional bounded single-retry
 * rewrite guard, reply rhythm variety nudge, outbound meta-leak sanitization, and optional
 * hour/length-shaped reply delay curve.
 */
export const humanizationPolicySchema = z
	.object({
		antiRepetitionEnabled: z.boolean().default(true),
		antiRepetitionWindow: z.number().int().min(2).max(50).default(12),
		antiRepetitionThreshold: z.number().int().min(2).max(20).default(3),
		/** Bounded single-retry rewrite when an answer still repeats flagged catchphrases severely. */
		repetitionRewriteEnabled: z.boolean().default(false),
		rhythmVarietyEnabled: z.boolean().default(true),
		rhythmWindow: z.number().int().min(2).max(20).default(4),
		metaLeakSanitizeEnabled: z.boolean().default(true),
		/** Shape `pacing.replyDelayMaxMs` by local hour and reply length instead of uniform jitter. */
		delayCurveEnabled: z.boolean().default(false),
	})
	.strict();

export type HumanizationPolicy = z.infer<typeof humanizationPolicySchema>;

export const defaultHumanizationPolicy: HumanizationPolicy = {
	antiRepetitionEnabled: true,
	antiRepetitionThreshold: 3,
	antiRepetitionWindow: 12,
	delayCurveEnabled: false,
	metaLeakSanitizeEnabled: true,
	repetitionRewriteEnabled: false,
	rhythmVarietyEnabled: true,
	rhythmWindow: 4,
};

/**
 * Optional cheap pre-model gating (`ConversationGatePort`). Fail-open: when disabled,
 * unconfigured, timed out, or circuit-broken, the runtime falls back cleanly to deterministic
 * policy rules without blocking traffic.
 */
export const conversationGatePolicySchema = z
	.object({
		enabled: z.boolean().default(false),
		/** Lightweight model id inside the active provider; falls back to runtime `gateModelId`. */
		model: z.string().min(1).optional(),
		timeoutMs: z.number().int().min(100).max(30_000).default(1_500),
		burstCompletion: z.boolean().default(true),
		undirectedGroupReply: z.boolean().default(true),
		proactiveBubble: z.boolean().default(true),
		circuitBreakerThreshold: z.number().int().min(1).max(20).default(3),
		circuitBreakerCooldownMs: z.number().int().min(1_000).max(600_000).default(60_000),
	})
	.strict();

export type ConversationGatePolicy = z.infer<typeof conversationGatePolicySchema>;

export const defaultConversationGatePolicy: ConversationGatePolicy = {
	burstCompletion: true,
	circuitBreakerCooldownMs: 60_000,
	circuitBreakerThreshold: 3,
	enabled: false,
	proactiveBubble: true,
	timeoutMs: 1_500,
	undirectedGroupReply: true,
};

export const conversationPolicySchema = z
	.object({
		version: z.number().int().min(1).default(1),
		/**
		 * Explicit conversation capabilities (`coding`, ...). Coding tools require this to be
		 * granted; normal QQ/OneBot conversations never receive it by default.
		 */
		capabilities: z.array(z.string().min(1)).default([]),
		/**
		 * Allow trusted admins in an IM conversation (`private` / `group`) to delegate work to
		 * governed workspace sessions (`workspace_spawn`, `workspace_status`, `workspace_send`,
		 * `session_lookup`). Ordinary IM turns still never receive repository coding tools.
		 */
		workspaceDelegationEnabled: z.boolean().default(false),
		enabled: z.boolean().default(true),
		followUpWhenBusy: z.enum(["follow-up", "reject"]).default("follow-up"),
		steerWhenBusy: z.enum(["steer", "follow-up", "reject"]).default("steer"),
		memoryEnabled: z.boolean().default(true),
		sharedMemoryEnabled: z.boolean().default(true),
		sharedMemoryWriteEnabled: z.boolean().default(true),
		memoryReviewRequired: z.boolean().default(false),
		memoryCompactionEnabled: z.boolean().default(true),
		memoryExtractModel: z.string().min(1).optional(),
		/**
		 * Per-conversation model override. When unset, the chat or workspace default from
		 * runtime settings applies, then the active provider's default model.
		 */
		model: modelSelectionSchema.optional(),
		/** Per-conversation reasoning effort; unset inherits the chat/workspace default. */
		thinking: thinkingLevelSchema.optional(),
		memoryExtractionPromptVersion: z.string().min(1).default("memory-extract-v1"),
		memoryMinConfidence: z.number().min(0).max(1).default(0.55),
		memoryMaxWritesPerActivity: z.number().int().min(1).max(50).default(8),
		trigger: conversationTriggerPolicySchema.default({
			allowlist: [],
			groupAccess: "open",
			groupMentionMode: "always",
			imageOnly: "lurk",
			keywords: [],
			peerBotIds: [],
			privateAccess: "open",
			replyToBotCounts: true,
			recentActivityEscalation: "throttled",
			recentActivityMinIntervalMs: 60_000,
			selfAliases: [],
			stickerOnly: "lurk",
		}),
		pacing: conversationPacingPolicySchema.default({
			activeBurstWindowMs: 1_500,
			burstLongMessageThreshold: 32,
			burstMaxMessages: 20,
			burstMaxWaitMs: 5_000,
			burstSettleMs: 1_200,
			directFlushEnabled: true,
			maxImmediateOutputMessages: 6,
			maxRepliesPerMinute: 20,
			narrationEnabled: true,
			narrationMinIntervalMs: 1_500,
			replyCooldownMs: 0,
			replyDelayEnabled: false,
			replyDelayMaxMs: 2_000,
			sendIntervalMs: 400,
			stripMarkdown: true,
			typingEnabled: false,
		}),
		notices: conversationNoticePolicySchema.default({
			pokeObserve: true,
			pokeWake: false,
			pokeWakeCooldownMs: 60_000,
		}),
		generation: conversationGenerationPolicySchema.default({
			lengthTruncation: "continue",
			maxLengthContinuations: 1,
		}),
		sidechat: sidechatPolicySchema.default({
			enabled: true,
			interjectEnabled: false,
			interjectMaxTokens: 160,
			interjectTimeoutMs: 3_000,
			maxHoldMs: 120_000,
			maxInterruptsPerMinute: 3,
			minConfidence: 0.6,
			minRunAgeMs: 0,
			timeoutMs: 1_500,
		}),
		compaction: conversationCompactionPolicySchema.default({
			backgroundTokens: 32_768,
			enabled: true,
			keepRecentTokens: 20_000,
			reserveTokens: 16_384,
			triggerTokens: 0,
		}),
		crossSession: crossSessionPolicySchema.default(defaultCrossSessionPolicy),
		memoryConsolidation: memoryConsolidationPolicySchema.default(defaultMemoryConsolidationPolicy),
		social: socialPolicySchema.default(defaultSocialPolicy),
		humanization: humanizationPolicySchema.default(defaultHumanizationPolicy),
		gate: conversationGatePolicySchema.default(defaultConversationGatePolicy),
	})
	.strict();

export type ConversationPolicy = z.infer<typeof conversationPolicySchema>;

export const defaultConversationPolicy: ConversationPolicy = {
	version: 1,
	capabilities: [],
	workspaceDelegationEnabled: false,
	enabled: true,
	followUpWhenBusy: "follow-up",
	steerWhenBusy: "steer",
	memoryEnabled: true,
	sharedMemoryEnabled: true,
	sharedMemoryWriteEnabled: true,
	memoryReviewRequired: false,
	memoryCompactionEnabled: true,
	memoryExtractionPromptVersion: "memory-extract-v1",
	memoryMinConfidence: 0.55,
	memoryMaxWritesPerActivity: 8,
	trigger: {
		privateAccess: "open",
		groupAccess: "open",
		allowlist: [],
		keywords: [],
		groupMentionMode: "always",
		replyToBotCounts: true,
		stickerOnly: "lurk",
		imageOnly: "lurk",
		selfAliases: [],
		peerBotIds: [],
		recentActivityEscalation: "throttled",
		recentActivityMinIntervalMs: 60_000,
	},
	pacing: {
		burstSettleMs: 1_200,
		burstMaxWaitMs: 5_000,
		burstMaxMessages: 20,
		burstLongMessageThreshold: 32,
		directFlushEnabled: true,
		activeBurstWindowMs: 1_500,
		narrationEnabled: true,
		narrationMinIntervalMs: 1_500,
		replyCooldownMs: 0,
		typingEnabled: false,
		replyDelayEnabled: false,
		replyDelayMaxMs: 2_000,
		sendIntervalMs: 400,
		maxImmediateOutputMessages: 6,
		stripMarkdown: true,
		maxRepliesPerMinute: 20,
	},
	notices: {
		pokeObserve: true,
		pokeWake: false,
		pokeWakeCooldownMs: 60_000,
	},
	generation: {
		lengthTruncation: "continue",
		maxLengthContinuations: 1,
	},
	sidechat: {
		enabled: true,
		interjectEnabled: false,
		interjectMaxTokens: 160,
		interjectTimeoutMs: 3_000,
		maxHoldMs: 120_000,
		maxInterruptsPerMinute: 3,
		minConfidence: 0.6,
		minRunAgeMs: 0,
		timeoutMs: 1_500,
	},
	compaction: {
		backgroundTokens: 32_768,
		enabled: true,
		keepRecentTokens: 20_000,
		reserveTokens: 16_384,
		triggerTokens: 0,
	},
	crossSession: defaultCrossSessionPolicy,
	memoryConsolidation: defaultMemoryConsolidationPolicy,
	social: defaultSocialPolicy,
	humanization: defaultHumanizationPolicy,
	gate: defaultConversationGatePolicy,
};

const triggerPolicyPatchSchema = z
	.object({
		privateAccess: z.enum(["open", "allowlist", "disabled"]).optional(),
		groupAccess: z.enum(["open", "allowlist", "disabled"]).optional(),
		allowlist: z.array(z.string().min(1)).optional(),
		keywords: z.array(z.string().min(1)).optional(),
		groupMentionMode: z.enum(["always", "smart", "disabled"]).optional(),
		replyToBotCounts: z.boolean().optional(),
		stickerOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).optional(),
		imageOnly: z.enum(["wake", "text-only", "lurk", "ignore"]).optional(),
		selfAliases: z.array(z.string().min(1)).optional(),
		peerBotIds: z.array(z.string().min(1)).optional(),
		recentActivityEscalation: recentActivityEscalationSchema.optional(),
		recentActivityMinIntervalMs: z.number().int().min(0).optional(),
	})
	.strict();

const pacingPolicyPatchSchema = z
	.object({
		burstSettleMs: z.number().int().min(1).optional(),
		burstMaxWaitMs: z.number().int().min(1).optional(),
		burstMaxMessages: z.number().int().min(1).optional(),
		burstLongMessageThreshold: z.number().int().min(1).optional(),
		directFlushEnabled: z.boolean().optional(),
		activeBurstWindowMs: z.number().int().min(0).optional(),
		narrationEnabled: z.boolean().optional(),
		narrationMinIntervalMs: z.number().int().min(0).optional(),
		replyCooldownMs: z.number().int().min(0).optional(),
		typingEnabled: z.boolean().optional(),
		replyDelayEnabled: z.boolean().optional(),
		replyDelayMaxMs: z.number().int().min(0).optional(),
		sendIntervalMs: z.number().int().min(0).optional(),
		maxImmediateOutputMessages: z.number().int().min(1).optional(),
		stripMarkdown: z.boolean().optional(),
		quietHours: quietHoursSchema.optional(),
		maxRepliesPerMinute: z.number().int().min(0).optional(),
		allowedTools: z.array(z.string().min(1)).nullish(),
	})
	.strict();

const sidechatPolicyPatchSchema = z
	.object({
		enabled: z.boolean().optional(),
		model: z.string().min(1).nullish(),
		timeoutMs: z.number().int().min(100).optional(),
		minConfidence: z.number().min(0).max(1).optional(),
		minRunAgeMs: z.number().int().min(0).optional(),
		maxInterruptsPerMinute: z.number().int().min(0).optional(),
		maxHoldMs: z.number().int().min(1).optional(),
		interjectEnabled: z.boolean().optional(),
		interjectModel: z.string().min(1).nullish(),
		interjectTimeoutMs: z.number().int().min(100).max(30_000).optional(),
		interjectMaxTokens: z.number().int().min(32).max(512).optional(),
	})
	.strict();

const noticePolicyPatchSchema = z
	.object({
		pokeObserve: z.boolean().optional(),
		pokeWake: z.boolean().optional(),
		pokeWakeCooldownMs: z.number().int().min(0).optional(),
	})
	.strict();

/** `null` clears a sampling override so the provider model's value applies again. */
const generationPolicyPatchSchema = z
	.object({
		lengthTruncation: lengthTruncationModeSchema.optional(),
		maxLengthContinuations: z.number().int().min(0).max(3).optional(),
		temperature: z.number().min(0).max(2).nullish(),
		topP: z.number().gt(0).max(1).nullish(),
		stop: z.array(z.string().min(1)).max(4).nullish(),
	})
	.strict();

const compactionPolicyPatchSchema = z
	.object({
		enabled: z.boolean().optional(),
		triggerTokens: z.number().int().min(0).optional(),
		reserveTokens: z.number().int().min(0).optional(),
		keepRecentTokens: z.number().int().min(0).optional(),
		backgroundTokens: z.number().int().min(0).optional(),
	})
	.strict();

const crossSessionPolicyPatchSchema = z
	.object({
		enabled: z.boolean().optional(),
		windowMinutes: z.number().int().min(1).max(10_080).optional(),
		maxEntries: z.number().int().min(0).max(20).optional(),
		maxChars: z.number().int().min(0).max(4_000).optional(),
		privateToGroup: crossSessionPrivacySchema.optional(),
	})
	.strict();

const memoryConsolidationPolicyPatchSchema = z
	.object({
		idleMs: z.number().int().min(0).optional(),
		minNewMessages: z.number().int().min(1).optional(),
		maxDelayMs: z.number().int().min(0).optional(),
		maxBatchMessages: z.number().int().min(1).max(500).optional(),
		maxFailures: z.number().int().min(1).max(10).optional(),
		summaryMaxChars: z.number().int().min(100).max(8_000).optional(),
		maxPersonCards: z.number().int().min(0).max(100).optional(),
		qaRecallEnabled: z.boolean().optional(),
	})
	.strict();

const socialPolicyPatchSchema = z
	.object({
		enabled: z.boolean().optional(),
		homeChat: z.boolean().optional(),
		refusalCooldownHours: z.number().int().min(0).max(720).optional(),
		unansweredSilenceHours: z.number().int().min(0).max(720).optional(),
		unansweredThreshold: z.number().int().min(1).max(20).optional(),
		maxSelfMessageRatio: z.number().min(0).max(1).optional(),
		selfRatioWindowMessages: z.number().int().min(4).max(100).optional(),
	})
	.strict();

const humanizationPolicyPatchSchema = z
	.object({
		antiRepetitionEnabled: z.boolean().optional(),
		antiRepetitionWindow: z.number().int().min(2).max(50).optional(),
		antiRepetitionThreshold: z.number().int().min(2).max(20).optional(),
		repetitionRewriteEnabled: z.boolean().optional(),
		rhythmVarietyEnabled: z.boolean().optional(),
		rhythmWindow: z.number().int().min(2).max(20).optional(),
		metaLeakSanitizeEnabled: z.boolean().optional(),
		delayCurveEnabled: z.boolean().optional(),
	})
	.strict();

const conversationGatePolicyPatchSchema = z
	.object({
		enabled: z.boolean().optional(),
		model: z.string().min(1).nullish(),
		timeoutMs: z.number().int().min(100).max(30_000).optional(),
		burstCompletion: z.boolean().optional(),
		undirectedGroupReply: z.boolean().optional(),
		proactiveBubble: z.boolean().optional(),
		circuitBreakerThreshold: z.number().int().min(1).max(20).optional(),
		circuitBreakerCooldownMs: z.number().int().min(1_000).max(600_000).optional(),
	})
	.strict();

/** Explicit, strict patch: unknown keys are rejected rather than silently dropped. */
export const conversationPolicyPatchSchema = z
	.object({
		version: z.number().int().min(1).optional(),
		capabilities: z.array(z.string().min(1)).optional(),
		workspaceDelegationEnabled: z.boolean().optional(),
		enabled: z.boolean().optional(),
		followUpWhenBusy: z.enum(["follow-up", "reject"]).optional(),
		steerWhenBusy: z.enum(["steer", "follow-up", "reject"]).optional(),
		memoryEnabled: z.boolean().optional(),
		sharedMemoryEnabled: z.boolean().optional(),
		sharedMemoryWriteEnabled: z.boolean().optional(),
		memoryReviewRequired: z.boolean().optional(),
		memoryCompactionEnabled: z.boolean().optional(),
		memoryExtractModel: z.string().min(1).nullish(),
		model: modelSelectionSchema.nullish(),
		thinking: thinkingLevelSchema.nullish(),
		memoryExtractionPromptVersion: z.string().min(1).optional(),
		memoryMinConfidence: z.number().min(0).max(1).optional(),
		memoryMaxWritesPerActivity: z.number().int().min(1).max(50).optional(),
		trigger: triggerPolicyPatchSchema.optional(),
		pacing: pacingPolicyPatchSchema.optional(),
		notices: noticePolicyPatchSchema.optional(),
		generation: generationPolicyPatchSchema.optional(),
		sidechat: sidechatPolicyPatchSchema.optional(),
		compaction: compactionPolicyPatchSchema.optional(),
		crossSession: crossSessionPolicyPatchSchema.optional(),
		memoryConsolidation: memoryConsolidationPolicyPatchSchema.optional(),
		social: socialPolicyPatchSchema.optional(),
		humanization: humanizationPolicyPatchSchema.optional(),
		gate: conversationGatePolicyPatchSchema.optional(),
	})
	.strict();

export type ConversationPolicyPatch = z.infer<typeof conversationPolicyPatchSchema>;

/** Map the legacy activity-window contract onto the richer pacing policy. */
export function conversationPolicyFromActivityAggregation(
	policy: ActivityAggregationPolicy,
): ConversationPolicy {
	const queue = conversationPolicySchema.parse({});
	return {
		...queue,
		pacing: {
			...queue.pacing,
			burstMaxMessages: policy.maxMessages,
			burstMaxWaitMs: policy.burstMaxWaitMs ?? Math.max(policy.windowMs, 15_000),
			burstSettleMs: policy.windowMs,
		},
	};
}
