import { describe, expect, test } from "bun:test";
import { createFallbackCoreLogger, previewText } from "./logger.ts";

describe("previewText", () => {
	test("collapses newlines and whitespace into a single line", () => {
		expect(previewText("hello\n\n  world\tagain")).toBe("hello world again");
	});

	test("keeps text at or under the limit untouched", () => {
		expect(previewText("short", 5)).toBe("short");
		expect(previewText("  padded  ")).toBe("padded");
	});

	test("truncates longer text with an ellipsis within the limit", () => {
		const preview = previewText("abcdefghij", 5);
		expect(preview).toBe("abcd…");
		expect(preview.length).toBe(5);
	});

	test("uses the default limit of 120 characters", () => {
		const preview = previewText("x".repeat(200));
		expect(preview.length).toBe(120);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("returns an empty preview for a non-positive limit", () => {
		expect(previewText("abc", 0)).toBe("");
		expect(previewText("abc", -1)).toBe("");
	});
});

describe("createFallbackCoreLogger", () => {
	test("reports errors to console.error and ignores lower levels", () => {
		const original = console.error;
		const calls: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};
		try {
			const logger = createFallbackCoreLogger();
			logger.trace("trace");
			logger.debug("debug");
			logger.info("info");
			logger.warn("warn");
			expect(calls).toHaveLength(0);

			logger.error("boom", { conversationId: "1" });
			expect(calls).toEqual([["boom", { conversationId: "1" }]]);

			logger.error("plain");
			expect(calls).toEqual([["boom", { conversationId: "1" }], ["plain"]]);
		} finally {
			console.error = original;
		}
	});
});
