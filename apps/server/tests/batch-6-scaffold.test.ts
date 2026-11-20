import { describe, expect, test } from "bun:test";
import { defaultSocialPolicy } from "@tsukaima/contracts";
import {
	budgetForLevel,
	detectRefusal,
	emptyHumanProfile,
	evaluateSocialHardGate,
	humanProfileFromDsh,
	judgeLevel,
} from "../src/services/social-profile.ts";

describe("Batch 6 social profile scaffold", () => {
	test("judgeLevel promotes L0 -> L1 -> L2, demotes on refusal/unanswered, and honors admin DM / homeChat", () => {
		const nowMs = Date.UTC(2026, 5, 1, 12, 0);
		const cold = emptyHumanProfile("conv-1", nowMs);
		expect(judgeLevel(cold, { nowMs })).toBe("L0");
		expect(judgeLevel(cold, { isAdminDm: true, nowMs })).toBe("L2");
		expect(judgeLevel(cold, { isHomeChat: true, nowMs })).toBe("L2");

		const normal = { ...cold, interactions: 6, otherFirst: 2, warm: true };
		expect(judgeLevel(normal, { nowMs })).toBe("L1");

		const close = { ...normal, interactions: 22, otherFirst: 6 };
		expect(judgeLevel(close, { nowMs })).toBe("L2");

		const unanswered = { ...close, unansweredStreak: 2 };
		expect(judgeLevel(unanswered, { nowMs })).toBe("L1");

		const refused = { ...close, refusedAt: nowMs - 1_000, refusedCount: 1 };
		expect(judgeLevel(refused, { nowMs })).toBe("L0");
	});

	test("budgetForLevel caps downward by admin policy", () => {
		const adminCap = {
			allowProactive: true,
			cooldownMs: 3_600_000,
			dailyCap: 1,
			enabled: true,
			hourlyCap: 1,
			probability: 0.1,
		};
		expect(budgetForLevel("L0", adminCap)).toMatchObject({ bubbleEnabled: false, dailyCap: 0 });
		expect(budgetForLevel("L2", adminCap)).toEqual({
			bubbleEnabled: true,
			cooldownMs: 3_600_000,
			dailyCap: 1,
			hourlyCap: 1,
			probability: 0.1,
		});
	});

	test("evaluateSocialHardGate enforces refusal 48h, unanswered 24h, quiet hours, and self-ratio >40%", () => {
		const nowMs = Date.UTC(2026, 5, 1, 14, 0);
		const base = { ...emptyHumanProfile("conv-1", nowMs), level: "L2" as const };

		expect(detectRefusal("别烦我了").refused).toBe(true);
		expect(detectRefusal("今天天气真好").refused).toBe(false);

		expect(
			evaluateSocialHardGate({
				nowMs,
				policy: defaultSocialPolicy,
				profile: { ...base, refusedAt: nowMs - 10 * 3_600_000, refusedCount: 1 },
			}),
		).toMatchObject({ allowed: false, reason: "refusal_cooldown" });

		expect(
			evaluateSocialHardGate({
				nowMs,
				policy: defaultSocialPolicy,
				profile: { ...base, unansweredAt: nowMs - 6 * 3_600_000, unansweredStreak: 2 },
			}),
		).toMatchObject({ allowed: false, reason: "unanswered_silence" });

		expect(
			evaluateSocialHardGate({
				nowMs,
				policy: defaultSocialPolicy,
				profile: base,
				quietHoursBlocked: true,
			}),
		).toMatchObject({ allowed: false, reason: "quiet_hours" });

		// 3 outbound out of 6 = 50% > 40% ceiling
		expect(
			evaluateSocialHardGate({
				nowMs,
				policy: defaultSocialPolicy,
				profile: base,
				recentDirections: ["inbound", "outbound", "inbound", "outbound", "inbound", "outbound"],
			}),
		).toMatchObject({ allowed: false, reason: "self_ratio_high" });

		// 2 outbound out of 6 = 33% <= 40% ceiling
		expect(
			evaluateSocialHardGate({
				nowMs,
				policy: defaultSocialPolicy,
				profile: base,
				recentDirections: ["inbound", "inbound", "outbound", "inbound", "inbound", "outbound"],
			}),
		).toEqual({ allowed: true });
	});

	test("humanProfileFromDsh parses legacy DSH human-profiles.json records", () => {
		const profile = humanProfileFromDsh(
			"conv-dsh",
			{
				activeHours: [9, 11],
				dayKey: "2026-05-01",
				interactions: 12,
				level: 1,
				otherFirst: 4,
				proactiveAnswered: 2,
				proactiveSent: 3,
				proactiveToday: 1,
				refusedCount: 0,
				selfFirst: 3,
				unansweredStreak: 0,
				warm: true,
			},
			1_700_000_000_000,
		);
		expect(profile.level).toBe("L1");
		expect(profile.interactions).toBe(12);
		expect(profile.activeHours).toEqual({ "9": 1, "10": 1, "11": 1 });
	});
});
