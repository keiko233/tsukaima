import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conversationMembers,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	socialProfiles,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import {
	defaultSocialPolicy,
	type HumanProfile,
	type SocialFamiliarityLevel,
} from "@tsukaima/contracts";
import { createLogger } from "../src/logging.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import {
	SocialProfileService,
	detectRefusal,
	emptyHumanProfile,
	localDayKey,
} from "../src/services/social-profile.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "tsukaima::test" });
const fixedNow = Date.UTC(2026, 10, 13, 12, 0);

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

interface Fixture {
	readonly database: TsukaimaDatabase;
	readonly policy: ConversationPolicyService;
	readonly social: SocialProfileService;
}

async function setup(): Promise<Fixture> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-6-social-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
	const social = new SocialProfileService({
		database: () => database,
		logger,
		now: () => fixedNow,
		policyService: policy,
	});
	return { database, policy, social };
}

async function seedConversation(
	database: TsukaimaDatabase,
	input: {
		readonly id: string;
		readonly kind?: "group" | "private";
		readonly adminUserId?: string;
	},
): Promise<void> {
	await database.insert(conversations).values({
		durableConversationId: `durable-${input.id}`,
		id: input.id,
		kind: input.kind ?? "private",
		title: input.id,
	});
	if (input.adminUserId !== undefined) {
		await database.insert(users).values({
			id: input.adminUserId,
			isAdmin: 1,
			kind: "human",
		});
		await database.insert(conversationMembers).values({
			conversationId: input.id,
			role: "member",
			userId: input.adminUserId,
		});
	}
}

async function seedProfile(
	social: SocialProfileService,
	conversationId: string,
	input: Partial<HumanProfile> & { readonly level: SocialFamiliarityLevel },
): Promise<HumanProfile> {
	const base = emptyHumanProfile(conversationId, fixedNow);
	return social.saveProfile({ ...base, ...input, updatedAtMs: fixedNow });
}

/** Stats that derive a stable L2 profile even after a one-step unanswered/refusal demotion. */
const closeProfile: Partial<HumanProfile> = {
	interactions: 22,
	otherFirst: 6,
	proactiveAnswered: 2,
	proactiveSent: 2,
	warm: true,
};

const adminBudget = {
	allowProactive: true,
	cooldownMs: 0,
	dailyCap: 3,
	enabled: true,
	hourlyCap: 2,
	probability: 1,
};

async function insertDirection(
	database: TsukaimaDatabase,
	input: {
		readonly conversationId: string;
		readonly direction: "inbound" | "outbound";
		readonly id: string;
		readonly atMs: number;
	},
): Promise<void> {
	await database.insert(messages).values({
		conversationId: input.conversationId,
		direction: input.direction,
		id: input.id,
		kind: "onebot-v11",
		occurredAt: new Date(input.atMs).toISOString(),
	});
}

describe("Batch 6 social familiarity profile", () => {
	test("promotes L0 -> L1 -> L2, demotes on unanswered streaks, and recovers after a reply", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-promote" });

		const first = await fixture.social.recordInbound({
			conversationId: "session-promote",
			nowMs: fixedNow,
		});
		expect(first?.level).toBe("L0");
		expect(first?.interactions).toBe(1);

		let nowMs = fixedNow;
		for (let index = 0; index < 4; index += 1) {
			nowMs += 3 * 3_600_000;
			const profile = await fixture.social.recordInbound({
				conversationId: "session-promote",
				nowMs,
			});
			expect(profile?.otherFirst).toBe(index + 1);
		}
		const normal = await fixture.social.getProfile("session-promote");
		expect(normal?.level).toBe("L1");
		expect(normal?.warm).toBe(true);

		for (let index = 0; index < 15; index += 1) {
			nowMs += 3 * 3_600_000;
			await fixture.social.recordInbound({ conversationId: "session-promote", nowMs });
		}
		const close = await fixture.social.getProfile("session-promote");
		expect(close?.level).toBe("L2");
		expect(close?.interactions).toBe(20);
		expect(close?.otherFirst).toBe(19);

		const firstProactive = await fixture.social.recordOutbound({
			conversationId: "session-promote",
			delivered: true,
			nowMs,
			proactive: true,
		});
		expect(firstProactive?.unansweredStreak).toBe(1);
		expect(firstProactive?.level).toBe("L2");

		const secondProactive = await fixture.social.recordOutbound({
			conversationId: "session-promote",
			delivered: true,
			nowMs: nowMs + 60_000,
			proactive: true,
		});
		expect(secondProactive?.unansweredStreak).toBe(2);
		expect(secondProactive?.level).toBe("L1");
		expect(secondProactive?.silentUntil).toBe(nowMs + 60_000 + 24 * 3_600_000);

		const thirdProactive = await fixture.social.recordOutbound({
			conversationId: "session-promote",
			delivered: true,
			nowMs: nowMs + 120_000,
			proactive: true,
		});
		expect(thirdProactive?.level).toBe("L0");

		const answered = await fixture.social.recordInbound({
			conversationId: "session-promote",
			nowMs: nowMs + 180_000,
		});
		expect(answered?.unansweredStreak).toBe(0);
		expect(answered?.unansweredAt).toBeNull();
		expect(answered?.silentUntil).toBeNull();
		expect(answered?.proactiveAnswered).toBe(1);
		expect(answered?.level).toBe("L1");
	});

	test("admin DMs and designated home chats resolve to L2 regardless of learned level", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, {
			adminUserId: "synthetic-admin",
			id: "session-admin-dm",
		});
		const adminCheck = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-admin-dm",
			nowMs: fixedNow,
		});
		expect(adminCheck.level).toBe("L2");
		expect(adminCheck.budget.bubbleEnabled).toBe(true);
		expect(adminCheck.gate).toEqual({ allowed: true });

		const adminInbound = await fixture.social.recordInbound({
			conversationId: "session-admin-dm",
			nowMs: fixedNow,
		});
		expect(adminInbound?.level).toBe("L2");

		await seedConversation(fixture.database, { id: "session-home-chat" });
		await fixture.policy.update({
			conversationId: "session-home-chat",
			policy: { social: { homeChat: true } },
			scope: "conversation",
		});
		const homeCheck = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-home-chat",
			nowMs: fixedNow,
		});
		expect(homeCheck.level).toBe("L2");
		expect(homeCheck.gate).toEqual({ allowed: true });

		await seedConversation(fixture.database, { id: "session-ordinary-private" });
		const ordinary = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-ordinary-private",
			nowMs: fixedNow,
		});
		expect(ordinary.level).toBe("L0");
		expect(ordinary.budget.bubbleEnabled).toBe(false);
		expect(ordinary.gate).toMatchObject({ allowed: false, reason: "daily_cap_reached" });
	});

	test("hard gates enforce quiet hours, refusal 48 h, unanswered 24 h, and self-ratio > 40%", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-gates" });
		await seedProfile(fixture.social, "session-gates", { ...closeProfile, level: "L2" });

		expect(detectRefusal("别烦我了").refused).toBe(true);
		const refusal = await fixture.social.recordInbound({
			conversationId: "session-gates",
			nowMs: fixedNow,
			text: "别烦我了",
		});
		expect(refusal?.refusedAt).toBe(fixedNow);
		expect(refusal?.silentUntil).toBe(
			fixedNow + defaultSocialPolicy.refusalCooldownHours * 3_600_000,
		);
		const refusalCheck = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: fixedNow + 10 * 3_600_000,
		});
		expect(refusalCheck.gate).toMatchObject({ allowed: false, reason: "refusal_cooldown" });
		const afterRefusal = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: fixedNow + 49 * 3_600_000,
		});
		expect(afterRefusal.gate).toEqual({ allowed: true });

		await seedProfile(fixture.social, "session-gates", {
			...closeProfile,
			level: "L2",
			silentUntil: fixedNow + 18 * 3_600_000,
			unansweredAt: fixedNow - 6 * 3_600_000,
			unansweredStreak: 2,
		});
		const unanswered = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: fixedNow,
		});
		expect(unanswered.gate).toMatchObject({ allowed: false, reason: "unanswered_silence" });
		const afterUnanswered = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: fixedNow + 19 * 3_600_000,
		});
		expect(afterUnanswered.gate).toEqual({ allowed: true });

		await fixture.policy.update({
			conversationId: "session-gates",
			policy: {
				pacing: {
					quietHours: { enabled: true, endHour: 7, startHour: 22 },
				},
			},
			scope: "conversation",
		});
		await seedProfile(fixture.social, "session-gates", { ...closeProfile, level: "L2" });
		const quiet = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: Date.UTC(2026, 10, 13, 23, 30),
		});
		expect(quiet.gate).toMatchObject({ allowed: false, reason: "quiet_hours" });
		const daytime = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: Date.UTC(2026, 10, 13, 12, 0),
		});
		expect(daytime.gate).toEqual({ allowed: true });

		await fixture.policy.update({
			conversationId: "session-gates",
			policy: { pacing: { quietHours: { enabled: false, endHour: 7, startHour: 22 } } },
			scope: "conversation",
		});
		await seedProfile(fixture.social, "session-gates", { ...closeProfile, level: "L2" });
		// 4 outbound of 6 recent messages = 67%, above the 40% ceiling.
		for (let index = 0; index < 6; index += 1) {
			await insertDirection(fixture.database, {
				atMs: fixedNow - (6 - index) * 60_000,
				conversationId: "session-gates",
				direction: index % 3 === 1 ? "inbound" : "outbound",
				id: `ratio-${index}`,
			});
		}
		const ratio = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-gates",
			nowMs: fixedNow,
		});
		expect(ratio.gate).toMatchObject({ allowed: false, reason: "self_ratio_high" });

		await seedConversation(fixture.database, { id: "session-capped" });
		await seedProfile(fixture.social, "session-capped", {
			...closeProfile,
			dayKey: localDayKey(fixedNow),
			level: "L2",
			proactiveToday: 3,
		});
		const capped = await fixture.social.checkProactive({
			adminBudget,
			conversationId: "session-capped",
			nowMs: fixedNow,
		});
		expect(capped.gate).toMatchObject({ allowed: false, reason: "daily_cap_reached" });
	});

	test("proactive quota is consumed only on delivered outbound content", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-quota" });
		await seedProfile(fixture.social, "session-quota", { level: "L2" });

		const skipped = await fixture.social.recordProactiveOutcome({
			conversationId: "session-quota",
			delivered: false,
			nowMs: fixedNow,
		});
		expect(skipped).toBeUndefined();
		const unchanged = await fixture.social.getProfile("session-quota");
		expect(unchanged?.proactiveToday).toBe(0);
		expect(unchanged?.unansweredStreak).toBe(0);

		const delivered = await fixture.social.recordProactiveOutcome({
			conversationId: "session-quota",
			delivered: true,
			nowMs: fixedNow,
		});
		expect(delivered?.proactiveToday).toBe(1);
		expect(delivered?.proactiveSent).toBe(1);
		expect(delivered?.unansweredStreak).toBe(1);
		expect(delivered?.dayKey).toBe(localDayKey(fixedNow));

		const secondDay = await fixture.social.recordProactiveOutcome({
			conversationId: "session-quota",
			delivered: true,
			nowMs: fixedNow + 24 * 3_600_000,
		});
		expect(secondDay?.proactiveToday).toBe(1);
		expect(secondDay?.proactiveSent).toBe(2);

		const rows = await fixture.database
			.select({ proactiveToday: socialProfiles.proactiveToday })
			.from(socialProfiles);
		expect(rows).toHaveLength(1);
	});
});

describe("Batch 6 social profile concurrent mutation serialization", () => {
	test("a concurrent refusal burst never loses refusedAt, silentUntil, or counts", async () => {
		const fixture = await setup();
		await seedConversation(fixture.database, { id: "session-burst" });
		await seedProfile(fixture.social, "session-burst", {
			...closeProfile,
			level: "L2",
		});
		const timezoneOffsetMinutes = 480;
		const normals = Array.from({ length: 8 }, (_, index) =>
			fixture.social.recordInbound({
				conversationId: "session-burst",
				nowMs: fixedNow,
				text: `synthetic burst message ${index}`,
				timezoneOffsetMinutes,
			}),
		);
		// The refusal is enqueued last: without per-conversation serialization an earlier
		// normal-message write could land after it and wipe the cooldown.
		const refusal = fixture.social.recordInbound({
			conversationId: "session-burst",
			nowMs: fixedNow,
			text: "别烦我了",
			timezoneOffsetMinutes,
		});
		const [normalProfiles, refusalProfile] = await Promise.all([Promise.all(normals), refusal]);
		const final = await fixture.social.getProfile("session-burst");
		expect(final).toMatchObject({
			refusedAt: fixedNow,
			refusedCount: 1,
			silentUntil: fixedNow + 48 * 3_600_000,
			unansweredStreak: 0,
		});
		expect(final?.interactions).toBe(closeProfile.interactions! + 9);
		// The local-time histogram uses the caller-supplied offset (UTC+8 -> 20:00).
		expect(final?.activeHours["20"]).toBe(9);
		expect(refusalProfile?.refusedAt).toBe(fixedNow);
		expect(normalProfiles.every((profile) => profile !== undefined)).toBe(true);
	});
});
