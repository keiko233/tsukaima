import { and, desc, eq, ne } from "drizzle-orm";
import {
	defaultConversationPolicy,
	humanProfileSchema,
	SOCIAL_PROFILE_BINDING,
	type ConversationPolicy,
	type HumanProfile,
	type QuietHoursPolicy,
	type SocialBudget,
	type SocialFamiliarityLevel,
	type SocialHardGateDecision,
	type SocialPolicy,
	type SocialProactiveCheckInput,
	type SocialProactiveCheckResult,
	type SocialProfileBridge,
} from "@tsukaima/contracts";
import {
	conversationMembers,
	conversations,
	messages,
	socialProfiles,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";

export { SOCIAL_PROFILE_BINDING };

const HOUR_MS = 3_600_000;
/** Idle gap after which a new inbound message counts as the other party re-initiating. */
const REOPEN_IDLE_GAP_MS = 2 * HOUR_MS;
/** Minimum recent messages before the outbound self-message ratio gate engages. */
const MIN_SELF_RATIO_SAMPLE = 4;

/** Explicit user refusal phrases that trigger the 48 h proactive cooldown. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
	/(?:别|不要|别再|不用|请勿)(?:烦我|发了|发消息|找我|打扰|主动找我|说话了|理我|私聊我)/u,
	/(?:闭嘴|滚开|走开|不想聊|别来烦我)/u,
	/\b(?:stop\s+(?:messaging|texting|bothering|pinging)\s+me|leave\s+me\s+alone|don'?t\s+(?:message|text|bother|ping)\s+me|shut\s+up)\b/iu,
];

export interface RefusalDetectionResult {
	readonly matched?: string;
	readonly refused: boolean;
}

export function detectRefusal(text: string): RefusalDetectionResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { refused: false };
	for (const pattern of REFUSAL_PATTERNS) {
		const match = pattern.exec(trimmed);
		if (match !== null) {
			return { matched: match[0], refused: true };
		}
	}
	return { refused: false };
}

export function localDayKey(nowMs: number, timezoneOffsetMinutes = 0): string {
	return new Date(nowMs + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function localHourBucket(nowMs: number, timezoneOffsetMinutes = 0): string {
	return String(new Date(nowMs + timezoneOffsetMinutes * 60_000).getUTCHours());
}

export function emptyHumanProfile(conversationId: string, nowMs = Date.now()): HumanProfile {
	return {
		activeHours: {},
		conversationId,
		dayKey: null,
		interactions: 0,
		level: "L0",
		otherFirst: 0,
		proactiveAnswered: 0,
		proactiveSent: 0,
		proactiveToday: 0,
		refusedAt: null,
		refusedCount: 0,
		selfFirst: 0,
		silentUntil: null,
		unansweredAt: null,
		unansweredStreak: 0,
		updatedAtMs: nowMs,
		warm: false,
	};
}

export interface JudgeLevelOptions {
	readonly isAdminDm?: boolean;
	readonly isHomeChat?: boolean;
	readonly nowMs?: number;
	readonly refusalCooldownHours?: number;
}

/**
 * Derive per-conversation social familiarity (`L0` cold / `L1` normal / `L2` close).
 * Admin DMs and explicitly configured home chats default to `L2`.
 *
 * Promotion curves are interaction/answer-rate based. Recent refusals and unanswered proactive
 * streaks demote; a refusal cooldown still active forces `L0`. Once an old refusal cooldown has
 * expired the cumulative count only caps the recovered level instead of pinning it to `L0`
 * forever, so a repaired relationship can climb back through `L1` to `L2`.
 */
export function judgeLevel(
	profile: HumanProfile,
	options: JudgeLevelOptions = {},
): SocialFamiliarityLevel {
	if (options.isAdminDm === true || options.isHomeChat === true) {
		return "L2";
	}
	const nowMs = options.nowMs ?? profile.updatedAtMs;
	const refusalCooldownMs = (options.refusalCooldownHours ?? 48) * HOUR_MS;
	const inRefusalCooldown =
		profile.refusedAt !== null &&
		refusalCooldownMs > 0 &&
		nowMs - profile.refusedAt < refusalCooldownMs;

	if (inRefusalCooldown || profile.unansweredStreak >= 3) {
		return "L0";
	}

	const answerRate =
		profile.proactiveSent === 0 ? 1 : profile.proactiveAnswered / profile.proactiveSent;
	// One or two unanswered proactive attempts are already covered by the streak demotion. Only a
	// meaningful sample lets a low answer rate block L2, so a single cold bubble cannot erase a
	// long familiarity history.
	const answerRateHealthy = profile.proactiveSent < 3 || answerRate >= 0.4;

	let level: SocialFamiliarityLevel = "L0";
	if (
		(profile.interactions >= 20 && profile.otherFirst >= 5 && answerRateHealthy) ||
		(profile.warm && profile.interactions >= 15 && answerRateHealthy)
	) {
		level = "L2";
	} else if (profile.interactions >= 5 || profile.otherFirst >= 2 || profile.warm) {
		level = "L1";
	}

	// Demote one step when proactive attempts went unanswered or the user refused before. Historical
	// refusals therefore cap recovered familiarity at `L1` instead of pinning it to `L0` forever.
	if (profile.unansweredStreak >= 2 || profile.refusedCount >= 1) {
		if (level === "L2") return "L1";
		if (level === "L1") return "L0";
	}
	return level;
}

const LEVEL_BUDGETS: Readonly<Record<SocialFamiliarityLevel, SocialBudget>> = {
	L0: {
		bubbleEnabled: false,
		cooldownMs: 6 * HOUR_MS,
		dailyCap: 0,
		hourlyCap: 0,
		probability: 0,
	},
	L1: {
		bubbleEnabled: true,
		cooldownMs: 2 * HOUR_MS,
		dailyCap: 2,
		hourlyCap: 1,
		probability: 0.15,
	},
	L2: {
		bubbleEnabled: true,
		cooldownMs: 30 * 60_000,
		dailyCap: 5,
		hourlyCap: 2,
		probability: 0.35,
	},
};

export interface AdminProactiveBudget {
	readonly allowProactive: boolean;
	readonly cooldownMs: number;
	readonly dailyCap: number;
	readonly enabled: boolean;
	readonly hourlyCap: number;
	readonly probability: number;
}

/**
 * Derive proactive/bubble budget from familiarity level, strictly capped downward by admin policy.
 * A higher familiarity level can never exceed what the operator configured.
 */
export function budgetForLevel(
	level: SocialFamiliarityLevel,
	adminPolicy: AdminProactiveBudget,
): SocialBudget {
	const base = LEVEL_BUDGETS[level];
	const bubbleEnabled = base.bubbleEnabled && adminPolicy.enabled && adminPolicy.allowProactive;
	if (!bubbleEnabled) {
		return {
			bubbleEnabled: false,
			cooldownMs: Math.max(base.cooldownMs, adminPolicy.cooldownMs),
			dailyCap: 0,
			hourlyCap: 0,
			probability: 0,
		};
	}
	return {
		bubbleEnabled: true,
		cooldownMs: Math.max(base.cooldownMs, adminPolicy.cooldownMs),
		dailyCap: Math.min(base.dailyCap, adminPolicy.dailyCap),
		hourlyCap: Math.min(base.hourlyCap, adminPolicy.hourlyCap),
		probability: Math.min(base.probability, adminPolicy.probability),
	};
}

function insideSimpleQuietHours(
	quietHours: QuietHoursPolicy | undefined,
	nowMs: number,
	timezoneOffsetMinutes = 0,
): boolean {
	if (quietHours?.enabled !== true) return false;
	const hour = new Date(nowMs + timezoneOffsetMinutes * 60_000).getUTCHours();
	if (quietHours.startHour === quietHours.endHour) return true;
	if (quietHours.startHour < quietHours.endHour) {
		return hour >= quietHours.startHour && hour < quietHours.endHour;
	}
	return hour >= quietHours.startHour || hour < quietHours.endHour;
}

export interface EvaluateSocialHardGateInput {
	/** Optional effective daily cap to check against `profile.proactiveToday`. */
	readonly dailyCap?: number;
	readonly nowMs: number;
	readonly policy: SocialPolicy;
	readonly profile: HumanProfile;
	readonly quietHours?: QuietHoursPolicy;
	/** Pre-evaluated quiet hours flag (e.g. from proactive-scheduler's richer range schema). */
	readonly quietHoursBlocked?: boolean;
	/** Directions of recent non-system messages in this conversation (`inbound` / `outbound`). */
	readonly recentDirections?: readonly ("inbound" | "outbound" | "system")[];
	readonly timezoneOffsetMinutes?: number;
}

/**
 * Enforce hard safety gates on proactive/bubble turns regardless of familiarity level (even `L2`):
 * 1. Quiet hours
 * 2. Explicit refusal cooldown (default 48 h)
 * 3. Consecutive unanswered silence (default 24 h)
 * 4. Recent self-message ratio ceiling (> 40% outbound in recent window)
 * 5. Daily cap check when supplied
 */
export function evaluateSocialHardGate(input: EvaluateSocialHardGateInput): SocialHardGateDecision {
	const { nowMs, policy, profile } = input;
	const tz = input.timezoneOffsetMinutes ?? 0;

	// 1. Quiet hours.
	if (input.quietHoursBlocked === true || insideSimpleQuietHours(input.quietHours, nowMs, tz)) {
		return { allowed: false, reason: "quiet_hours" };
	}

	// 2. Explicit refusal cooldown (default 48 h).
	const refusalCooldownMs = policy.refusalCooldownHours * HOUR_MS;
	if (profile.refusedAt !== null && refusalCooldownMs > 0) {
		const refusalUntil = profile.refusedAt + refusalCooldownMs;
		if (nowMs < refusalUntil) {
			return {
				allowed: false,
				detail: `refusal cooldown active (${policy.refusalCooldownHours}h)`,
				reason: "refusal_cooldown",
				untilMs: refusalUntil,
			};
		}
	}

	// 3. Consecutive unanswered silence (default 24 h).
	const unansweredSilenceMs = policy.unansweredSilenceHours * HOUR_MS;
	if (
		profile.unansweredAt !== null &&
		profile.unansweredStreak >= policy.unansweredThreshold &&
		unansweredSilenceMs > 0
	) {
		const unansweredUntil = profile.unansweredAt + unansweredSilenceMs;
		if (nowMs < unansweredUntil) {
			return {
				allowed: false,
				detail: `unanswered streak ${profile.unansweredStreak} (${policy.unansweredSilenceHours}h silence)`,
				reason: "unanswered_silence",
				untilMs: unansweredUntil,
			};
		}
	}
	if (profile.silentUntil !== null && nowMs < profile.silentUntil) {
		return {
			allowed: false,
			reason: profile.refusedAt !== null ? "refusal_cooldown" : "unanswered_silence",
			untilMs: profile.silentUntil,
		};
	}

	// 4. Recent self-message ratio ceiling (> 40% by default).
	const directions = (input.recentDirections ?? [])
		.filter((dir) => dir === "inbound" || dir === "outbound")
		.slice(-policy.selfRatioWindowMessages);
	if (directions.length >= MIN_SELF_RATIO_SAMPLE) {
		const outboundCount = directions.filter((dir) => dir === "outbound").length;
		const ratio = outboundCount / directions.length;
		if (ratio > policy.maxSelfMessageRatio) {
			return {
				allowed: false,
				detail: `self ratio ${outboundCount}/${directions.length} (${Math.round(ratio * 100)}%) exceeds ${Math.round(policy.maxSelfMessageRatio * 100)}%`,
				reason: "self_ratio_high",
			};
		}
	}

	// 5. Daily cap against persisted same-day proactive count.
	if (input.dailyCap !== undefined) {
		const day = localDayKey(nowMs, tz);
		const todayCount = profile.dayKey === day ? profile.proactiveToday : 0;
		if (input.dailyCap === 0 || todayCount >= input.dailyCap) {
			return {
				allowed: false,
				detail: `${todayCount}/${input.dailyCap}`,
				reason: "daily_cap_reached",
			};
		}
	}

	return { allowed: true };
}

function dshNonNegativeInt(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function dshTimestampMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
	}
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Normalize a DSH `human-profiles.json` entry into a Tsukaima {@link HumanProfile}.
 * Keeps field compatibility with `packages/migration/src/memory-import.ts`.
 */
export function humanProfileFromDsh(
	conversationId: string,
	raw: Readonly<Record<string, unknown>>,
	nowMs = Date.now(),
): HumanProfile {
	const activeHours: Record<string, number> = {};
	if (Array.isArray(raw.activeHours)) {
		const hours = raw.activeHours.filter(
			(v): v is number => typeof v === "number" && Number.isFinite(v),
		);
		if (hours.length === 2) {
			const start = Math.max(0, Math.min(23, Math.floor(hours[0]!)));
			const end = Math.max(0, Math.min(23, Math.floor(hours[1]!)));
			if (start <= end) {
				for (let h = start; h <= end; h += 1) activeHours[String(h)] = 1;
			} else {
				for (let h = start; h <= 23; h += 1) activeHours[String(h)] = 1;
				for (let h = 0; h <= end; h += 1) activeHours[String(h)] = 1;
			}
		} else {
			for (const h of hours) activeHours[String(Math.max(0, Math.min(23, Math.floor(h))))] = 1;
		}
	} else if (typeof raw.activeHours === "object" && raw.activeHours !== null) {
		for (const [k, v] of Object.entries(raw.activeHours as Record<string, unknown>)) {
			if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
				activeHours[k] = Math.floor(v);
			}
		}
	}
	const rawLevel = raw.level;
	const level: SocialFamiliarityLevel =
		rawLevel === "L2" || rawLevel === 2 ? "L2" : rawLevel === "L1" || rawLevel === 1 ? "L1" : "L0";
	return humanProfileSchema.parse({
		activeHours,
		conversationId,
		dayKey: typeof raw.dayKey === "string" && raw.dayKey.length > 0 ? raw.dayKey : null,
		interactions: dshNonNegativeInt(raw.interactions),
		level,
		otherFirst: dshNonNegativeInt(raw.otherFirst),
		proactiveAnswered: dshNonNegativeInt(raw.proactiveAnswered),
		proactiveSent: dshNonNegativeInt(raw.proactiveSent),
		proactiveToday: dshNonNegativeInt(raw.proactiveToday),
		refusedAt: dshTimestampMs(raw.refusedAt),
		refusedCount: dshNonNegativeInt(raw.refusedCount),
		selfFirst: dshNonNegativeInt(raw.selfFirst),
		silentUntil: dshTimestampMs(raw.silentUntil),
		unansweredAt: dshTimestampMs(raw.unansweredAt),
		unansweredStreak: dshNonNegativeInt(raw.unansweredStreak),
		updatedAtMs: dshTimestampMs(raw.updatedAt) ?? nowMs,
		warm: raw.warm === true,
	});
}

function parseActiveHours(json: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
				out[key] = Math.floor(value);
			}
		}
		return out;
	} catch {
		return {};
	}
}

function rowToProfile(row: typeof socialProfiles.$inferSelect): HumanProfile {
	const updatedAtMs = Date.parse(row.updatedAt);
	return {
		activeHours: parseActiveHours(row.activeHoursJson),
		conversationId: row.conversationId,
		dayKey: row.dayKey,
		interactions: row.interactions,
		level: row.level,
		otherFirst: row.otherFirst,
		proactiveAnswered: row.proactiveAnswered,
		proactiveSent: row.proactiveSent,
		proactiveToday: row.proactiveToday,
		refusedAt: row.refusedAt,
		refusedCount: row.refusedCount,
		selfFirst: row.selfFirst,
		silentUntil: row.silentUntil,
		unansweredAt: row.unansweredAt,
		unansweredStreak: row.unansweredStreak,
		updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
		warm: row.warm,
	};
}

export interface SocialProfileServiceOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly now?: () => number;
	readonly policyService?: ConversationPolicyService;
}

/**
 * Durable per-conversation social familiarity store and gate evaluator.
 *
 * Invariant: proactive quota (`proactiveToday`, `proactiveSent`, `unansweredStreak`, `selfFirst`)
 * is consumed ONLY when a proactive turn actually delivers outbound content — never on gate skip,
 * `__SKIP__`/`TSUKAIMA_LURK`, or provider error.
 */
export class SocialProfileService implements SocialProfileBridge {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #policyService: ConversationPolicyService | undefined;

	constructor(options: SocialProfileServiceOptions) {
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::social");
		this.#now = options.now ?? Date.now;
		this.#policyService = options.policyService;
	}

	async getProfile(conversationId: string): Promise<HumanProfile | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const [row] = await database
			.select()
			.from(socialProfiles)
			.where(eq(socialProfiles.conversationId, conversationId))
			.limit(1);
		return row === undefined ? undefined : rowToProfile(row);
	}

	async saveProfile(profile: HumanProfile): Promise<HumanProfile> {
		const database = this.#database();
		if (database === undefined) return profile;
		const validated = humanProfileSchema.parse(profile);
		const nowIso = new Date(validated.updatedAtMs || this.#now()).toISOString();
		await database
			.insert(socialProfiles)
			.values({
				activeHoursJson: JSON.stringify(validated.activeHours),
				conversationId: validated.conversationId,
				createdAt: nowIso,
				dayKey: validated.dayKey,
				interactions: validated.interactions,
				level: validated.level,
				otherFirst: validated.otherFirst,
				proactiveAnswered: validated.proactiveAnswered,
				proactiveSent: validated.proactiveSent,
				proactiveToday: validated.proactiveToday,
				refusedAt: validated.refusedAt,
				refusedCount: validated.refusedCount,
				selfFirst: validated.selfFirst,
				silentUntil: validated.silentUntil,
				unansweredAt: validated.unansweredAt,
				unansweredStreak: validated.unansweredStreak,
				updatedAt: nowIso,
				warm: validated.warm,
			})
			.onConflictDoUpdate({
				set: {
					activeHoursJson: JSON.stringify(validated.activeHours),
					dayKey: validated.dayKey,
					interactions: validated.interactions,
					level: validated.level,
					otherFirst: validated.otherFirst,
					proactiveAnswered: validated.proactiveAnswered,
					proactiveSent: validated.proactiveSent,
					proactiveToday: validated.proactiveToday,
					refusedAt: validated.refusedAt,
					refusedCount: validated.refusedCount,
					selfFirst: validated.selfFirst,
					silentUntil: validated.silentUntil,
					unansweredAt: validated.unansweredAt,
					unansweredStreak: validated.unansweredStreak,
					updatedAt: nowIso,
					warm: validated.warm,
				},
				target: socialProfiles.conversationId,
			});
		return validated;
	}

	async resetProfile(conversationId: string): Promise<void> {
		const database = this.#database();
		if (database === undefined) return;
		await database.delete(socialProfiles).where(eq(socialProfiles.conversationId, conversationId));
	}

	/**
	 * Record an inbound user message: increments interaction stats, tracks active hour histogram,
	 * resets `unansweredStreak` (and credits `proactiveAnswered` if answering a pending proactive),
	 * and applies refusal cooldown if the message contains an explicit refusal.
	 */
	async recordInbound(input: {
		readonly conversationId: string;
		readonly nowMs?: number;
		readonly text?: string;
		readonly timezoneOffsetMinutes?: number;
	}): Promise<HumanProfile | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const nowMs = input.nowMs ?? this.#now();
		const policy = await this.#effectivePolicy(input.conversationId);
		if (!policy.social.enabled) return undefined;
		const existing =
			(await this.getProfile(input.conversationId)) ??
			emptyHumanProfile(input.conversationId, nowMs);
		const tz = input.timezoneOffsetMinutes ?? 0;
		const bucket = localHourBucket(nowMs, tz);
		const activeHours = {
			...existing.activeHours,
			[bucket]: (existing.activeHours[bucket] ?? 0) + 1,
		};

		const reopened =
			existing.updatedAtMs === 0 || nowMs - existing.updatedAtMs >= REOPEN_IDLE_GAP_MS;
		const answeredProactive = existing.unansweredStreak > 0;
		const refusal = input.text === undefined ? { refused: false } : detectRefusal(input.text);
		const refusalCooldownMs = policy.social.refusalCooldownHours * HOUR_MS;
		const nextRefusedAt = refusal.refused ? nowMs : existing.refusedAt;
		// A real inbound message answers the unanswered streak, so its silence lifts. A new refusal
		// (re)arms the cooldown instead; `refusedAt` still gates an expired cooldown independently.
		const nextSilentUntil = refusal.refused
			? Math.max(existing.silentUntil ?? 0, nowMs + refusalCooldownMs)
			: null;

		const isAdminDm = await this.#isAdminPrivateConversation(database, input.conversationId);
		const draft: HumanProfile = {
			...existing,
			activeHours,
			interactions: existing.interactions + 1,
			otherFirst: existing.otherFirst + (reopened ? 1 : 0),
			proactiveAnswered: existing.proactiveAnswered + (answeredProactive ? 1 : 0),
			refusedAt: nextRefusedAt,
			refusedCount: existing.refusedCount + (refusal.refused ? 1 : 0),
			silentUntil: nextSilentUntil,
			unansweredAt: null,
			unansweredStreak: 0,
			updatedAtMs: nowMs,
			warm: existing.warm || existing.interactions + 1 >= 5,
		};
		const level = judgeLevel(draft, {
			isAdminDm,
			isHomeChat: policy.social.homeChat,
			nowMs,
			refusalCooldownHours: policy.social.refusalCooldownHours,
		});
		const saved = await this.saveProfile({ ...draft, level });
		if (refusal.refused) {
			this.#logger.info("explicit refusal recorded; proactive silence activated", {
				conversationId: input.conversationId,
				refusalCooldownHours: policy.social.refusalCooldownHours,
				silentUntil: saved.silentUntil,
			});
		}
		return saved;
	}

	/**
	 * Record an outbound delivery outcome.
	 *
	 * Proactive counters (`proactiveToday`, `proactiveSent`, `selfFirst`, `unansweredStreak`) are
	 * incremented ONLY when `proactive === true && delivered === true`. Skipped, lurked, or failed
	 * turns never consume proactive quota.
	 */
	async recordOutbound(input: {
		readonly conversationId: string;
		readonly delivered: boolean;
		readonly nowMs?: number;
		readonly proactive: boolean;
		readonly timezoneOffsetMinutes?: number;
	}): Promise<HumanProfile | undefined> {
		if (!input.delivered) return undefined;
		const database = this.#database();
		if (database === undefined) return undefined;
		const nowMs = input.nowMs ?? this.#now();
		const policy = await this.#effectivePolicy(input.conversationId);
		if (!policy.social.enabled) return undefined;
		const existing =
			(await this.getProfile(input.conversationId)) ??
			emptyHumanProfile(input.conversationId, nowMs);
		if (!input.proactive) {
			return existing;
		}
		const tz = input.timezoneOffsetMinutes ?? 0;
		const day = localDayKey(nowMs, tz);
		const proactiveToday = (existing.dayKey === day ? existing.proactiveToday : 0) + 1;
		const unansweredStreak = existing.unansweredStreak + 1;
		const reachedThreshold = unansweredStreak >= policy.social.unansweredThreshold;
		const silenceMs = policy.social.unansweredSilenceHours * HOUR_MS;
		const nextUnansweredAt = reachedThreshold ? nowMs : existing.unansweredAt;
		const nextSilentUntil = reachedThreshold
			? Math.max(existing.silentUntil ?? 0, nowMs + silenceMs)
			: existing.silentUntil;

		const isAdminDm = await this.#isAdminPrivateConversation(database, input.conversationId);
		const draft: HumanProfile = {
			...existing,
			dayKey: day,
			proactiveSent: existing.proactiveSent + 1,
			proactiveToday,
			selfFirst: existing.selfFirst + 1,
			silentUntil: nextSilentUntil,
			unansweredAt: nextUnansweredAt,
			unansweredStreak,
			updatedAtMs: nowMs,
		};
		const level = judgeLevel(draft, {
			isAdminDm,
			isHomeChat: policy.social.homeChat,
			nowMs,
			refusalCooldownHours: policy.social.refusalCooldownHours,
		});
		return this.saveProfile({ ...draft, level });
	}

	async recordProactiveOutcome(input: {
		readonly conversationId: string;
		readonly delivered: boolean;
		readonly nowMs: number;
		readonly timezoneOffsetMinutes?: number;
	}): Promise<HumanProfile | undefined> {
		return this.recordOutbound({
			conversationId: input.conversationId,
			delivered: input.delivered,
			nowMs: input.nowMs,
			proactive: true,
			...(input.timezoneOffsetMinutes === undefined
				? {}
				: { timezoneOffsetMinutes: input.timezoneOffsetMinutes }),
		});
	}

	async checkProactive(input: SocialProactiveCheckInput): Promise<SocialProactiveCheckResult> {
		const database = this.#database();
		const policy = await this.#effectivePolicy(input.conversationId);
		const profile =
			(await this.getProfile(input.conversationId)) ??
			emptyHumanProfile(input.conversationId, input.nowMs);
		const isAdminDm =
			database === undefined
				? false
				: await this.#isAdminPrivateConversation(database, input.conversationId);
		const level = judgeLevel(profile, {
			isAdminDm,
			isHomeChat: policy.social.homeChat,
			nowMs: input.nowMs,
			refusalCooldownHours: policy.social.refusalCooldownHours,
		});
		const budget = budgetForLevel(level, input.adminBudget);
		const recentDirections =
			database === undefined
				? []
				: await this.#recentMessageDirections(
						database,
						input.conversationId,
						policy.social.selfRatioWindowMessages,
					);
		const gate = evaluateSocialHardGate({
			dailyCap: budget.dailyCap,
			nowMs: input.nowMs,
			policy: policy.social,
			profile: { ...profile, level },
			...(policy.pacing.quietHours === undefined ? {} : { quietHours: policy.pacing.quietHours }),
			...(input.quietHoursBlocked === undefined
				? {}
				: { quietHoursBlocked: input.quietHoursBlocked }),
			recentDirections,
			...(input.timezoneOffsetMinutes === undefined
				? {}
				: { timezoneOffsetMinutes: input.timezoneOffsetMinutes }),
		});
		return {
			budget,
			gate,
			level,
			profile: { ...profile, level },
		};
	}

	async #effectivePolicy(conversationId: string): Promise<ConversationPolicy> {
		if (this.#policyService === undefined) return defaultConversationPolicy;
		try {
			return await this.#policyService.effectivePolicy(conversationId);
		} catch {
			return defaultConversationPolicy;
		}
	}

	async #recentMessageDirections(
		database: TsukaimaDatabase,
		conversationId: string,
		limit: number,
	): Promise<("inbound" | "outbound" | "system")[]> {
		const rows = await database
			.select({ direction: messages.direction })
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), ne(messages.kind, "tool")))
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(Math.max(1, limit));
		return rows.toReversed().map((row) => row.direction);
	}

	/** True when `conversationId` is a private chat with an admin user. */
	async #isAdminPrivateConversation(
		database: TsukaimaDatabase,
		conversationId: string,
	): Promise<boolean> {
		try {
			const [conv] = await database
				.select({ kind: conversations.kind })
				.from(conversations)
				.where(eq(conversations.id, conversationId))
				.limit(1);
			if (conv?.kind !== "private") return false;
			const [member] = await database
				.select({ isAdmin: users.isAdmin })
				.from(conversationMembers)
				.innerJoin(users, eq(users.id, conversationMembers.userId))
				.where(and(eq(conversationMembers.conversationId, conversationId), eq(users.isAdmin, 1)))
				.limit(1);
			if (member !== undefined) return true;
			const [sender] = await database
				.select({ isAdmin: users.isAdmin })
				.from(messages)
				.innerJoin(users, eq(users.id, messages.senderUserId))
				.where(
					and(
						eq(messages.conversationId, conversationId),
						eq(messages.direction, "inbound"),
						eq(users.isAdmin, 1),
					),
				)
				.limit(1);
			return sender !== undefined;
		} catch {
			return false;
		}
	}
}
