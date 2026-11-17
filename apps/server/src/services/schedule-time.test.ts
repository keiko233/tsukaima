import { describe, expect, test } from "bun:test";
import {
	catchUpDefaults,
	isValidTimeZone,
	localParts,
	nextOccurrence,
	previewOccurrences,
	zonedTimeToUtc,
} from "./schedule-time.ts";

describe("schedule recurrence", () => {
	test("validates IANA time zones", () => {
		expect(isValidTimeZone("Asia/Taipei")).toBe(true);
		expect(isValidTimeZone("America/New_York")).toBe(true);
		expect(isValidTimeZone("Not/AZone")).toBe(false);
		expect(isValidTimeZone("")).toBe(false);
	});

	test("once and interval recurrences advance without drift", () => {
		const at = "2026-12-01T09:00:00.000Z";
		expect(
			nextOccurrence({
				afterMs: Date.parse("2026-11-01T00:00:00.000Z"),
				recurrence: { at, kind: "once" },
				timeZone: "UTC",
			}),
		).toBe(Date.parse(at));
		expect(
			nextOccurrence({
				afterMs: Date.parse("2026-11-01T00:00:00.000Z"),
				recurrence: { at, kind: "once" },
				timeZone: "UTC",
			}),
		).toBe(Date.parse(at));
		const anchor = "2026-11-01T00:00:00.000Z";
		const second = nextOccurrence({
			afterMs: Date.parse(anchor),
			recurrence: { anchorAt: anchor, everyMs: 86_400_000, kind: "interval" },
			timeZone: "UTC",
		});
		expect(second).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
		expect(
			nextOccurrence({
				afterMs: second!,
				recurrence: { anchorAt: anchor, everyMs: 86_400_000, kind: "interval" },
				timeZone: "UTC",
			}),
		).toBe(Date.parse("2026-11-03T00:00:00.000Z"));
	});

	test("calendar recurrences use the configured local zone", () => {
		const recurrence = {
			daysOfWeek: [1, 3, 5],
			kind: "calendar" as const,
			startDate: "2026-11-01",
			time: "09:30",
		};
		const first = nextOccurrence({
			afterMs: Date.parse("2026-11-01T00:00:00.000Z"),
			recurrence,
			timeZone: "Asia/Taipei",
		});
		expect(first).toBe(Date.parse("2026-11-02T01:30:00.000Z"));
		expect(localParts(first!, "Asia/Taipei")).toMatchObject({
			day: 2,
			hour: 9,
			minute: 30,
			month: 11,
			year: 2026,
		});
	});

	test("calendar recurrences survive spring-forward gaps", () => {
		const next = nextOccurrence({
			afterMs: Date.parse("2026-03-07T00:00:00.000Z"),
			recurrence: {
				kind: "calendar",
				startDate: "2026-03-08",
				time: "02:30",
			},
			timeZone: "America/New_York",
		});
		expect(next).toBe(Date.parse("2026-03-08T07:00:00.000Z"));
		expect(localParts(next!, "America/New_York").hour).toBe(3);
	});

	test("ambiguous fall-back times choose the earlier instant", () => {
		const next = zonedTimeToUtc(
			{ day: 1, month: 11, year: 2026 },
			{ hour: 1, minute: 30 },
			"America/New_York",
		);
		expect(next).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
	});

	test("preview stops when a recurrence ends", () => {
		const runs = previewOccurrences({
			afterMs: Date.parse("2026-11-01T00:00:00.000Z"),
			count: 5,
			recurrence: {
				anchorAt: "2026-11-01T00:00:00.000Z",
				everyMs: 3_600_000,
				kind: "interval",
				until: "2026-11-01T02:30:00.000Z",
			},
			timeZone: "UTC",
		});
		expect(runs).toHaveLength(2);
	});

	test("catch-up defaults differ by recurrence", () => {
		expect(catchUpDefaults({ at: "2026-11-01T00:00:00.000Z", kind: "once" })).toEqual({
			catchUp: "latest",
			graceMs: 86_400_000,
		});
		expect(
			catchUpDefaults({
				anchorAt: "2026-11-01T00:00:00.000Z",
				everyMs: 60_000,
				kind: "interval",
			}),
		).toEqual({ catchUp: "latest", graceMs: 60_000 });
		expect(catchUpDefaults({ kind: "calendar", startDate: "2026-11-01", time: "09:00" })).toEqual({
			catchUp: "skip",
			graceMs: 15 * 60_000,
		});
	});
});
