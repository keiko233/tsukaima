import type { ConversationPolicy } from "@elaina/contracts";
import type { PluginConversationSummary } from "@elaina/sdk";
import {
	dailyKey,
	type GateResult,
	isQuietHours,
	type ProactivePolicy,
	type ProactiveState,
} from "./domain.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface CandidateContext {
	readonly conversation: PluginConversationSummary;
	readonly policy: ProactivePolicy;
	readonly conversationPolicy: ConversationPolicy;
	readonly state: ProactiveState;
	/** Gates recorded by the service after evaluation (never used while evaluating). */
	readonly gatesForRecord?: readonly GateResult[];
}

export interface GateEvaluation {
	readonly gates: readonly GateResult[];
	readonly blocked: boolean;
	readonly reason?: string;
	readonly effectiveState: ProactiveState;
}

function gate(
	name: string,
	status: GateResult["status"],
	reason?: string,
	detail?: string,
): GateResult {
	return {
		gate: name,
		status,
		...(reason === undefined ? {} : { reason }),
		...(detail === undefined ? {} : { detail }),
	};
}

export interface EvaluateInput {
	readonly candidate: CandidateContext;
	readonly nowMs: number;
	readonly random: () => number;
	/** Simulate stops after all policy gates and never claims a model decision. */
	readonly dryRun?: boolean;
}

/**
 * Implements proactive steps 1-8 (candidate, policy, quiet hours, caps, cooldown/backoff,
 * activity, warmness/probability, bubble gate). Model marker handling and audit happen in the
 * service after this returns an eligible result.
 */
export function evaluateProactiveGates(input: EvaluateInput): GateEvaluation {
	const { candidate, nowMs, random } = input;
	const { conversation, policy, conversationPolicy, state } = candidate;
	const gates: GateResult[] = [];

	// 1. Candidate conversation.
	if (conversation.status !== "active") {
		return {
			blocked: true,
			gates: [gate("candidate", "blocked", "conversation_inactive")],
			reason: "conversation_inactive",
			effectiveState: state,
		};
	}
	const access =
		conversation.kind === "group"
			? conversationPolicy.trigger.groupAccess
			: conversation.kind === "private"
				? conversationPolicy.trigger.privateAccess
				: "open";
	if (access === "disabled") {
		return {
			blocked: true,
			gates: [gate("candidate", "blocked", "access_disabled")],
			reason: "access_disabled",
			effectiveState: state,
		};
	}
	gates.push(gate("candidate", "passed", undefined, `${conversation.kind}:${access}`));

	// 2. Policy enablement and per-kind allowance.
	if (!policy.enabled) {
		return {
			blocked: true,
			gates: [...gates, gate("policy", "blocked", "disabled")],
			reason: "disabled",
			effectiveState: state,
		};
	}
	if (!policy.allowProactive) {
		return {
			blocked: true,
			gates: [...gates, gate("policy", "blocked", "proactive_disabled")],
			reason: "proactive_disabled",
			effectiveState: state,
		};
	}
	gates.push(gate("policy", "passed"));

	// 3. Quiet hours, including ranges that wrap midnight.
	if (isQuietHours(policy.quietHours, nowMs)) {
		return {
			blocked: true,
			gates: [...gates, gate("quiet_hours", "blocked", "quiet_hours")],
			reason: "quiet_hours",
			effectiveState: state,
		};
	}
	gates.push(gate("quiet_hours", "passed"));

	// 4. Independent per-conversation daily/hourly caps.
	const day = dailyKey(nowMs, policy.quietHours.timezoneOffsetMinutes);
	const dailyCount = state.dailyCountDate === day ? state.dailyCount : 0;
	const hourlyWindow = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
	const hourlyCount = state.hourlyWindowMs === hourlyWindow ? state.hourlyCount : 0;
	if (policy.dailyCap === 0 || dailyCount >= policy.dailyCap) {
		return {
			blocked: true,
			gates: [
				...gates,
				gate("daily_cap", "blocked", "daily_cap_reached", `${dailyCount}/${policy.dailyCap}`),
			],
			reason: "daily_cap_reached",
			effectiveState: state,
		};
	}
	if (policy.hourlyCap === 0 || hourlyCount >= policy.hourlyCap) {
		return {
			blocked: true,
			gates: [
				...gates,
				gate("hourly_cap", "blocked", "hourly_cap_reached", `${hourlyCount}/${policy.hourlyCap}`),
			],
			reason: "hourly_cap_reached",
			effectiveState: state,
		};
	}
	gates.push(gate("daily_cap", "passed", undefined, `${dailyCount}/${policy.dailyCap}`));
	gates.push(gate("hourly_cap", "passed", undefined, `${hourlyCount}/${policy.hourlyCap}`));

	// 5. Cooldown plus refusal/silence backoff.
	if (state.silenceUntilMs !== null && state.silenceUntilMs > nowMs) {
		return {
			blocked: true,
			gates: [...gates, gate("cooldown", "blocked", "silence_backoff")],
			reason: "silence_backoff",
			effectiveState: state,
		};
	}
	const lastOutbound = state.lastOutboundAtMs;
	if (lastOutbound !== null && nowMs - lastOutbound < policy.cooldownMs) {
		return {
			blocked: true,
			gates: [...gates, gate("cooldown", "blocked", "cooldown")],
			reason: "cooldown",
			effectiveState: state,
		};
	}
	gates.push(gate("cooldown", "passed"));

	// 6. Activity: enough messages and an idle window, but not abandoned forever.
	const lastActivity = state.lastMessageAtMs ?? state.lastInboundAtMs;
	if (state.inboundCount < policy.minMessages) {
		return {
			blocked: true,
			gates: [...gates, gate("activity", "blocked", "min_messages")],
			reason: "min_messages",
			effectiveState: state,
		};
	}
	if (lastActivity === null) {
		return {
			blocked: true,
			gates: [...gates, gate("activity", "blocked", "no_activity")],
			reason: "no_activity",
			effectiveState: state,
		};
	}
	const idleMs = nowMs - lastActivity;
	if (idleMs < policy.minIdleMs) {
		return {
			blocked: true,
			gates: [...gates, gate("activity", "blocked", "too_soon")],
			reason: "too_soon",
			effectiveState: state,
		};
	}
	if (idleMs > policy.maxIdleMs) {
		return {
			blocked: true,
			gates: [...gates, gate("activity", "blocked", "too_idle")],
			reason: "too_idle",
			effectiveState: state,
		};
	}
	gates.push(gate("activity", "passed", undefined, `${Math.round(idleMs / 60_000)}m idle`));

	// 7. Warmness/interest and deterministic probability.
	if (state.warmness < policy.minWarmness) {
		return {
			blocked: true,
			gates: [...gates, gate("warmness", "blocked", "warmness_low")],
			reason: "warmness_low",
			effectiveState: state,
		};
	}
	gates.push(gate("warmness", "passed", undefined, state.warmness.toFixed(2)));
	if (policy.probability <= 0 || random() >= policy.probability) {
		return {
			blocked: true,
			gates: [...gates, gate("probability", "blocked", "probability")],
			reason: "probability",
			effectiveState: state,
		};
	}
	gates.push(gate("probability", "passed"));

	// 8. Optional bubble/reply gate: do not stack a proactive turn onto an unanswered one.
	if (policy.bubbleGate && state.unansweredStreak > 0) {
		return {
			blocked: true,
			gates: [...gates, gate("bubble_gate", "blocked", "unanswered_streak")],
			reason: "unanswered_streak",
			effectiveState: state,
		};
	}
	gates.push(gate("bubble_gate", "passed"));

	if (input.dryRun === true) {
		gates.push(gate("model_decision", "info", "dry_run"));
		gates.push(gate("marker_handling", "info", "dry_run"));
		gates.push(gate("audit", "info", "dry_run"));
	}
	return { blocked: false, effectiveState: state, gates };
}

export function nextCounters(input: {
	readonly policy: ProactivePolicy;
	readonly state: ProactiveState;
	readonly nowMs: number;
}): ProactiveState {
	const day = dailyKey(input.nowMs, input.policy.quietHours.timezoneOffsetMinutes);
	const hourlyWindow = Math.floor(input.nowMs / HOUR_MS) * HOUR_MS;
	const dailyCount = input.state.dailyCountDate === day ? input.state.dailyCount : 0;
	const hourlyCount = input.state.hourlyWindowMs === hourlyWindow ? input.state.hourlyCount : 0;
	return {
		...input.state,
		dailyCount: dailyCount + 1,
		dailyCountDate: day,
		hourlyCount: hourlyCount + 1,
		hourlyWindowMs: hourlyWindow,
	};
}

export function backoffState(input: {
	readonly policy: ProactivePolicy;
	readonly state: ProactiveState;
	readonly nowMs: number;
	readonly hard?: boolean;
}): ProactiveState {
	const refused = input.state.refusedCount + 1;
	const multiplier = Math.min(5, Math.max(1, refused));
	return {
		...input.state,
		refusedCount: refused,
		silenceUntilMs: input.nowMs + input.policy.backoffMs * multiplier,
		warmness: Math.max(0, input.state.warmness - (input.hard === true ? 0.15 : 0.05)),
		updatedAtMs: input.nowMs,
	};
}

export function nextDailyCountReset(
	state: ProactiveState,
	nowMs: number,
	offset: number,
): ProactiveState {
	const day = dailyKey(nowMs, offset);
	if (state.dailyCountDate === day) return state;
	return { ...state, dailyCount: 0, dailyCountDate: day };
}

export const PROACTIVE_DAY_MS = DAY_MS;
