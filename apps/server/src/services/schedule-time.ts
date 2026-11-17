import type { ScheduleRecurrence } from "@tsukaima/contracts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

interface LocalParts {
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly month: number;
	readonly year: number;
}

export interface NextOccurrenceInput {
	readonly afterMs: number;
	readonly recurrence: ScheduleRecurrence;
	readonly timeZone: string;
}

export function isValidTimeZone(timeZone: string): boolean {
	if (timeZone.trim().length === 0) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return true;
	} catch {
		return false;
	}
}

export function localParts(atMs: number, timeZone: string): LocalParts {
	const parts = new Intl.DateTimeFormat("en-US", {
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		minute: "2-digit",
		month: "2-digit",
		timeZone,
		year: "numeric",
	}).formatToParts(new Date(atMs));
	const value = (type: Intl.DateTimeFormatPartTypes): number => {
		const part = parts.find((entry) => entry.type === type)?.value;
		return part === undefined ? 0 : Number(part);
	};
	return {
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
		month: value("month"),
		year: value("year"),
	};
}

function dateKey(parts: Pick<LocalParts, "day" | "month" | "year">): string {
	return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function parseDateKey(value: string): { day: number; month: number; year: number } {
	const [year, month, day] = value.split("-").map(Number);
	return { day: day ?? 1, month: month ?? 1, year: year ?? 1970 };
}

function addDays(date: { day: number; month: number; year: number }, days: number) {
	const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return {
		day: next.getUTCDate(),
		month: next.getUTCMonth() + 1,
		year: next.getUTCFullYear(),
	};
}

function weekday(date: { day: number; month: number; year: number }): number {
	return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Convert a local wall-clock time to an absolute instant. A wall time may be missing
 * (spring-forward) or repeated (fall-back). Repeated times use the earlier instant; a missing
 * time advances to the first valid local minute after the gap.
 */
export function zonedTimeToUtc(
	date: { day: number; month: number; year: number },
	time: { hour: number; minute: number },
	timeZone: string,
): number {
	const localAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
	const candidates = new Set<number>();
	for (const probe of [localAsUtc - DAY_MS, localAsUtc, localAsUtc + DAY_MS]) {
		const parts = localParts(probe, timeZone);
		const offset =
			Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
			Math.floor(probe / MINUTE_MS) * MINUTE_MS;
		const candidate = localAsUtc - offset;
		const actual = localParts(candidate, timeZone);
		if (
			actual.year === date.year &&
			actual.month === date.month &&
			actual.day === date.day &&
			actual.hour === time.hour &&
			actual.minute === time.minute
		) {
			candidates.add(candidate);
		}
	}
	if (candidates.size > 0) return Math.min(...candidates);

	const requestedMinute = time.hour * 60 + time.minute;
	for (
		let candidate = localAsUtc - 3 * 60 * MINUTE_MS;
		candidate <= localAsUtc + 6 * 60 * MINUTE_MS;
	) {
		const actual = localParts(candidate, timeZone);
		if (
			actual.year === date.year &&
			actual.month === date.month &&
			actual.day === date.day &&
			actual.hour * 60 + actual.minute >= requestedMinute
		) {
			return candidate;
		}
		candidate += MINUTE_MS;
	}
	return localAsUtc;
}

function nextInterval(
	recurrence: Extract<ScheduleRecurrence, { kind: "interval" }>,
	afterMs: number,
) {
	const anchorMs = Date.parse(recurrence.anchorAt);
	if (!Number.isFinite(anchorMs)) return undefined;
	const steps = Math.max(1, Math.floor((afterMs - anchorMs) / recurrence.everyMs) + 1);
	const next = anchorMs + steps * recurrence.everyMs;
	if (recurrence.until !== undefined && next > Date.parse(recurrence.until)) return undefined;
	return next;
}

function nextCalendar(
	recurrence: Extract<ScheduleRecurrence, { kind: "calendar" }>,
	timeZone: string,
	afterMs: number,
): number | undefined {
	const [hour, minute] = recurrence.time.split(":").map(Number);
	const local = localParts(afterMs, timeZone);
	let date = parseDateKey(dateKey(local));
	const start = parseDateKey(recurrence.startDate);
	if (dateKey(date) < recurrence.startDate) date = start;
	const weekdays = recurrence.daysOfWeek === undefined ? undefined : new Set(recurrence.daysOfWeek);
	const untilMs = recurrence.until === undefined ? undefined : Date.parse(recurrence.until);
	for (let index = 0; index < 800; index += 1) {
		const candidateDate = addDays(date, index);
		if (weekdays !== undefined && !weekdays.has(weekday(candidateDate))) continue;
		const candidate = zonedTimeToUtc(
			candidateDate,
			{ hour: hour ?? 0, minute: minute ?? 0 },
			timeZone,
		);
		if (candidate > afterMs && (untilMs === undefined || candidate <= untilMs)) return candidate;
	}
	return undefined;
}

export function nextOccurrence(input: NextOccurrenceInput): number | undefined {
	if (!isValidTimeZone(input.timeZone)) throw new Error(`Invalid time zone: ${input.timeZone}`);
	switch (input.recurrence.kind) {
		case "once": {
			const atMs = Date.parse(input.recurrence.at);
			return Number.isFinite(atMs) && atMs > input.afterMs ? atMs : undefined;
		}
		case "interval":
			return nextInterval(input.recurrence, input.afterMs);
		case "calendar":
			return nextCalendar(input.recurrence, input.timeZone, input.afterMs);
	}
}

export function previewOccurrences(input: {
	readonly count: number;
	readonly recurrence: ScheduleRecurrence;
	readonly timeZone: string;
	readonly afterMs?: number;
}): number[] {
	const occurrences: number[] = [];
	let cursor = input.afterMs ?? Date.now() - 1;
	for (let index = 0; index < input.count; index += 1) {
		const next = nextOccurrence({
			afterMs: cursor,
			recurrence: input.recurrence,
			timeZone: input.timeZone,
		});
		if (next === undefined) break;
		occurrences.push(next);
		cursor = next;
	}
	return occurrences;
}

export function catchUpDefaults(recurrence: ScheduleRecurrence): {
	readonly catchUp: "skip" | "latest" | "all";
	readonly graceMs: number;
} {
	switch (recurrence.kind) {
		case "once":
			return { catchUp: "latest", graceMs: DAY_MS };
		case "interval":
			return { catchUp: "latest", graceMs: Math.min(recurrence.everyMs, 60 * MINUTE_MS) };
		case "calendar":
			return { catchUp: "skip", graceMs: 15 * MINUTE_MS };
	}
}
