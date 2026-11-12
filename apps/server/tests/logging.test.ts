import { describe, expect, test } from "bun:test";
import { createLogger, encodeSseEvent, LogBuffer, type LogEntry } from "../src/logging.ts";

describe("runtime logging", () => {
	test("formats tracing-style text, fields, spans, and ANSI colors", () => {
		const buffer = new LogBuffer();
		const entries: LogEntry[] = [];
		const logger = createLogger({
			buffer,
			level: "info",
			sink: (entry) => entries.push(entry),
			target: "elaina::test",
		});

		logger.debug("hidden");
		logger.info("ready", { accessToken: "secret", stage: "ready" });
		logger
			.child("elaina::test::http")
			.span("request", { requestId: "req-1" })
			.warn("slow request", { durationMs: 42 });

		expect(entries).toHaveLength(2);
		expect(entries[0]?.fields).toEqual({
			accessToken: "[REDACTED]",
			stage: "ready",
		});
		expect(entries[0]?.text).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*Z  INFO elaina::test: ready accessToken="\[REDACTED\]" stage="ready"$/,
		);
		expect(entries[0]?.ansi).toContain("\u001b[1;32m INFO\u001b[0m");
		expect(entries[1]?.text).toMatch(
			/Z  WARN request\{requestId="req-1"\}: elaina::test::http: slow request durationMs=42$/,
		);
		expect(entries[1]?.ansi).toContain("\u001b[1;33m WARN\u001b[0m");
	});

	test("filters levels, sanitizes terminal input, and bounds the ring buffer", () => {
		const buffer = new LogBuffer(2);
		const logger = createLogger({
			buffer,
			level: "debug",
			sink: () => {},
			target: "elaina::test",
		});

		logger.info("one");
		logger.warn("two");
		logger.error("bad\n\u001b[31mline", { error: new Error("boom") });

		const snapshot = buffer.snapshot();
		expect(snapshot.capacity).toBe(2);
		expect(snapshot.dropped).toBe(1);
		expect(snapshot.entries.map((entry) => entry.id)).toEqual([2, 3]);
		expect(snapshot.entries[1]?.text).not.toContain("\u001b");
		expect(snapshot.entries[1]?.text).not.toContain("\n");
		expect(snapshot.entries[1]?.text).toContain("bad\\n\\u001b[31mline");
		expect(buffer.list({ afterId: 2 }).map((entry) => entry.id)).toEqual([3]);
		expect(buffer.list({ level: "warn" })).toHaveLength(1);

		logger.setLevel("error");
		logger.warn("hidden");
		logger.error("visible");
		expect(buffer.size).toBe(2);
		expect(buffer.list().at(-1)?.message).toBe("visible");
	});

	test("encodes SSE frames", () => {
		expect(encodeSseEvent("log", { message: "ready" })).toBe(
			'event: log\ndata: {"message":"ready"}\n\n',
		);
	});
});
