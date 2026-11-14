import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	createDailyFileLogSink,
	createLogger,
	DEFAULT_LOG_CAPACITY,
	encodeSseEvent,
	LogBuffer,
	previewText,
	type LogEntry,
} from "../src/logging.ts";

describe("runtime logging", () => {
	test("formats tracing-style text, fields, spans, trace level, and ANSI colors", () => {
		const buffer = new LogBuffer();
		expect(buffer.capacity).toBe(5_000);
		expect(DEFAULT_LOG_CAPACITY).toBe(5_000);
		const entries: LogEntry[] = [];
		const logger = createLogger({
			buffer,
			level: "info",
			sink: (entry) => entries.push(entry),
			target: "tsukaima::test",
		});

		logger.trace("hidden-trace");
		logger.debug("hidden");
		logger.info("ready", { accessToken: "secret", stage: "ready" });
		logger
			.child("tsukaima::test::http")
			.span("request", { requestId: "req-1" })
			.warn("slow request", { durationMs: 42 });

		expect(entries).toHaveLength(2);
		expect(entries[0]?.fields).toEqual({
			accessToken: "[REDACTED]",
			stage: "ready",
		});
		expect(entries[0]?.text).toMatch(
			/^\d{4}-\d{2}-\d{2}T.*Z  INFO tsukaima::test: ready accessToken="\[REDACTED\]" stage="ready"$/,
		);
		expect(entries[0]?.ansi).toContain("\u001b[1;32m INFO\u001b[0m");
		expect(entries[1]?.text).toMatch(
			/Z  WARN request\{requestId="req-1"\}: tsukaima::test::http: slow request durationMs=42$/,
		);
		expect(entries[1]?.ansi).toContain("\u001b[1;33m WARN\u001b[0m");

		logger.setLevel("trace");
		logger.trace("visible-trace", "raw-string-detail");
		expect(entries).toHaveLength(3);
		expect(entries[2]?.level).toBe("trace");
		expect(entries[2]?.fields).toEqual({ detail: "raw-string-detail" });
		expect(entries[2]?.text).toMatch(
			/Z TRACE tsukaima::test: visible-trace detail="raw-string-detail"$/,
		);
		expect(entries[2]?.ansi).toContain("\u001b[90mTRACE\u001b[0m");
	});

	test("filters levels, sanitizes terminal input, previews text, and bounds the ring buffer", () => {
		const buffer = new LogBuffer(2);
		const logger = createLogger({
			buffer,
			level: "debug",
			sink: () => {},
			target: "tsukaima::test",
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

		expect(previewText("hello\nworld", 8)).toBe("hello\\n…");
	});

	test("writes daily date-chunked log files and prunes expired files when retentionDays is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "tsukaima-daily-logs-"));
		try {
			const oldFile = join(dir, "tsukaima-2020-01-01.log");
			writeFileSync(oldFile, "old\n", "utf8");
			const daily = createDailyFileLogSink({ dir, retentionDays: 7 });
			const logger = createLogger({
				level: "trace",
				sinks: [daily.sink],
				target: "tsukaima::test",
			});
			logger.trace("first line", { step: 1 });
			const currentPath = daily.currentPath();
			expect(currentPath).toBeDefined();
			expect(currentPath!).toMatch(/tsukaima-\d{4}-\d{2}-\d{2}\.log$/);
			const content = readFileSync(currentPath!, "utf8");
			expect(content).toContain("TRACE tsukaima::test: first line step=1");
			expect(() => readFileSync(oldFile, "utf8")).toThrow();
			daily.close();
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	test("encodes SSE frames", () => {
		expect(encodeSseEvent("log", { message: "ready" })).toBe(
			'event: log\ndata: {"message":"ready"}\n\n',
		);
	});
});
