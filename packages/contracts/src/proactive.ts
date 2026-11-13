/**
 * Model-visible proactive output markers. They are consumed before persistence and delivery;
 * none of them may ever reach a channel or the outbound message table.
 */
export const PROACTIVE_SKIP_MARKER = "ELAINA_SKIP";
export const PROACTIVE_LURK_MARKER = "ELAINA_LURK";
export const PROACTIVE_SCHEDULE_LATER_MARKER = "ELAINA_SCHEDULE_LATER";

export const DEFAULT_SCHEDULE_LATER_MS = 30 * 60_000;
export const MIN_SCHEDULE_LATER_MS = 60_000;
export const MAX_SCHEDULE_LATER_MS = 24 * 60 * 60_000;

export type ProactiveMarker = "skip" | "lurk" | "schedule-later";

export interface ConsumedProactiveMarkers {
	readonly marker?: ProactiveMarker;
	readonly scheduleLaterMs?: number;
	readonly text: string;
}

function clampDelay(value: number, unit: string | undefined): number {
	const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
	return Math.min(
		MAX_SCHEDULE_LATER_MS,
		Math.max(MIN_SCHEDULE_LATER_MS, Math.round(value * multiplier)),
	);
}

/**
 * Removes every proactive marker from assistant text and reports the highest-priority one.
 * `ELAINA_SKIP` wins over `ELAINA_LURK`, which wins over `ELAINA_SCHEDULE_LATER`.
 */
export function consumeProactiveMarkers(text: string): ConsumedProactiveMarkers {
	const hasSkip = text.includes(PROACTIVE_SKIP_MARKER);
	const hasLurk = text.includes(PROACTIVE_LURK_MARKER);
	const schedulePattern = new RegExp(
		`${PROACTIVE_SCHEDULE_LATER_MARKER}(?:\\s*[:\\s]\\s*(\\d+)\\s*(ms|s|m|h)?)?`,
		"iu",
	);
	const schedule = schedulePattern.exec(text);
	let scheduleLaterMs: number | undefined;
	if (schedule !== null) {
		const amount = Number(schedule[1] ?? "30");
		scheduleLaterMs = clampDelay(
			Number.isFinite(amount) && amount > 0 ? amount : 30,
			schedule[2]?.toLowerCase(),
		);
	}
	const cleaned = text
		.replace(new RegExp(`${PROACTIVE_SKIP_MARKER}`, "gu"), "")
		.replace(new RegExp(`${PROACTIVE_LURK_MARKER}`, "gu"), "")
		.replace(new RegExp(schedulePattern.source, "giu"), "")
		.replace(/\s{2,}/gu, " ")
		.trim();
	const marker: ProactiveMarker | undefined = hasSkip
		? "skip"
		: hasLurk
			? "lurk"
			: schedule !== null
				? "schedule-later"
				: undefined;
	return {
		...(marker === undefined ? {} : { marker }),
		...(scheduleLaterMs === undefined ? {} : { scheduleLaterMs }),
		text: cleaned,
	};
}
