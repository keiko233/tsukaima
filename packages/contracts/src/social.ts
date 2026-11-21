import { z } from "zod";

/**
 * Per-conversation social familiarity tier:
 * - `L0`: cold / unfamiliar (no unsolicited bubbles)
 * - `L1`: normal / acquainted (modest proactive budget)
 * - `L2`: close / designated home chat or admin DM (full policy-capped budget)
 */
export const socialFamiliarityLevelSchema = z.enum(["L0", "L1", "L2"]);
export type SocialFamiliarityLevel = z.infer<typeof socialFamiliarityLevelSchema>;

/**
 * Persisted per-conversation social familiarity profile (`HumanProfile`), compatible with
 * migrated DSH `human-profiles.json` records.
 */
export const humanProfileSchema = z
	.object({
		conversationId: z.string().min(1),
		interactions: z.number().int().nonnegative().default(0),
		otherFirst: z.number().int().nonnegative().default(0),
		selfFirst: z.number().int().nonnegative().default(0),
		proactiveSent: z.number().int().nonnegative().default(0),
		proactiveAnswered: z.number().int().nonnegative().default(0),
		unansweredStreak: z.number().int().nonnegative().default(0),
		refusedCount: z.number().int().nonnegative().default(0),
		/** Epoch ms when the user explicitly refused proactive/chat contact. */
		refusedAt: z.number().int().nonnegative().nullable().default(null),
		/** Epoch ms when consecutive unanswered proactive turns triggered silence. */
		unansweredAt: z.number().int().nonnegative().nullable().default(null),
		/** Epoch ms until which proactive/bubble initiation is silenced. */
		silentUntil: z.number().int().nonnegative().nullable().default(null),
		/** Local-hour activity histogram (`"0"`..`"23"` -> message count). */
		activeHours: z.record(z.string(), z.number().int().nonnegative()).default({}),
		level: socialFamiliarityLevelSchema.default("L0"),
		warm: z.boolean().default(false),
		proactiveToday: z.number().int().nonnegative().default(0),
		/** Local calendar date (`YYYY-MM-DD`) that `proactiveToday` belongs to. */
		dayKey: z.string().nullable().default(null),
		updatedAtMs: z.number().int().nonnegative().default(0),
	})
	.strict();

export type HumanProfile = z.infer<typeof humanProfileSchema>;

/** Effective proactive/bubble budget derived from familiarity level and capped by admin policy. */
export const socialBudgetSchema = z
	.object({
		bubbleEnabled: z.boolean(),
		cooldownMs: z.number().int().nonnegative(),
		dailyCap: z.number().int().nonnegative(),
		hourlyCap: z.number().int().nonnegative(),
		probability: z.number().min(0).max(1),
	})
	.strict();

export type SocialBudget = z.infer<typeof socialBudgetSchema>;

export const socialHardGateReasonSchema = z.enum([
	"quiet_hours",
	"refusal_cooldown",
	"unanswered_silence",
	"self_ratio_high",
	"daily_cap_reached",
]);

export type SocialHardGateReason = z.infer<typeof socialHardGateReasonSchema>;

export type SocialHardGateDecision =
	| { readonly allowed: true }
	| {
			readonly allowed: false;
			readonly detail?: string;
			readonly reason: SocialHardGateReason;
			readonly untilMs?: number;
	  };

/** Host dependency binding key exposing `SocialProfileService` to built-in plugins. */
export const SOCIAL_PROFILE_BINDING = "tsukaima.social-profile";

/** Host dependency binding key exposing `ConversationGatePort` to built-in plugins. */
export const CONVERSATION_GATE_BINDING = "tsukaima.conversation-gate";

export interface SocialProactiveCheckInput {
	readonly adminBudget: {
		readonly allowProactive: boolean;
		readonly cooldownMs: number;
		readonly dailyCap: number;
		readonly enabled: boolean;
		readonly hourlyCap: number;
		readonly probability: number;
	};
	readonly conversationId: string;
	readonly nowMs: number;
	readonly quietHoursBlocked?: boolean;
	readonly timezoneOffsetMinutes?: number;
}

export interface SocialProactiveCheckResult {
	readonly budget: SocialBudget;
	readonly gate: SocialHardGateDecision;
	readonly level: SocialFamiliarityLevel;
	readonly profile: HumanProfile;
}

/**
 * Narrow host bridge consumed by built-in plugins (such as `proactive-scheduler`) so they can
 * consult and update per-conversation social profiles without importing server internals.
 */
export interface SocialProfileBridge {
	readonly checkProactive: (
		input: SocialProactiveCheckInput,
	) => Promise<SocialProactiveCheckResult>;
	readonly getProfile: (conversationId: string) => Promise<HumanProfile | undefined>;
	readonly recordProactiveOutcome: (input: {
		readonly conversationId: string;
		readonly delivered: boolean;
		readonly nowMs: number;
		readonly timezoneOffsetMinutes?: number;
	}) => Promise<HumanProfile | undefined>;
}

/** Narrow proactive-bubble gate contract consumable by `proactive-scheduler`. */
export interface ProactiveBubbleGateBridge {
	readonly decideProactiveBubble: (input: {
		readonly conversationId: string;
		readonly conversationKind: string;
		readonly idleMinutes: number;
		readonly level: SocialFamiliarityLevel;
		readonly recentMessages: readonly {
			readonly direction: string;
			readonly textPreview: string;
		}[];
	}) => Promise<{
		readonly decision: "SHOULD" | "SKIP";
		readonly reason?: string;
		readonly source: "gate" | "fallback";
	}>;
}
