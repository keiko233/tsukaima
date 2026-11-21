import { describe, expect, test } from "bun:test";
import { defaultConversationPolicy } from "@tsukaima/contracts";
import { flushStreamLines } from "./stream-lines.ts";

const flush = (
	partialText: string,
	options: Partial<{ afterLine: number; enabled: boolean; repetitionRewriteEnabled: boolean }> = {},
) =>
	flushStreamLines({
		afterLine: options.afterLine ?? 0,
		enabled: options.enabled ?? true,
		partialText,
		repetitionRewriteEnabled: options.repetitionRewriteEnabled ?? false,
	});

describe("flushStreamLines", () => {
	test("returns only completed newline-terminated lines", () => {
		const result = flush("first line\nsecond line\nstill typing");
		expect(result.lines).toEqual([
			{ index: 0, text: "first line" },
			{ index: 1, text: "second line" },
		]);
		expect(result.afterLine).toBe(2);

		const next = flush("first line\nsecond line\nstill typing\nand done\n", {
			afterLine: result.afterLine,
		});
		expect(next.lines).toEqual([
			{ index: 2, text: "still typing" },
			{ index: 3, text: "and done" },
		]);
		expect(next.afterLine).toBe(4);
	});

	test("skips blank lines but keeps their absolute positions", () => {
		expect(flush("a\n\nb\n").lines).toEqual([
			{ index: 0, text: "a" },
			{ index: 2, text: "b" },
		]);
	});

	test("flushes a closed fenced block but nothing while a fence is open", () => {
		const open = flush("before\n```ts\nconst value = 1;\n");
		expect(open.lines).toEqual([]);
		expect(open.afterLine).toBe(3);

		// Lines withheld inside the open fence are never re-sent after it closes.
		const closed = flush("before\n```ts\nconst value = 1;\n```\nafter\n", { afterLine: 3 });
		expect(closed.lines).toEqual([{ index: 4, text: "after" }]);

		const nested = flush("```\ncode\n~~~\nmore\n");
		expect(nested.lines).toEqual([]);
	});

	test("returns nothing when the turn may lurk or internal tags leaked", () => {
		for (const partial of [
			"I might stay quiet\nTSUKAIMA_LURK\n",
			"<think>hidden reasoning</think>\nvisible\n",
			"<turn-context>clock</turn-context>\nvisible\n",
			"<previous-summary>old</previous-summary>\nvisible\n",
		]) {
			const result = flush(partial);
			expect(result.lines).toEqual([]);
			expect(result.afterLine).toBe(partial.split("\n").length - 1);
		}
	});

	test("returns nothing when disabled or a repetition rewrite is active", () => {
		expect(flush("hello\n", { enabled: false })).toEqual({ afterLine: 1, lines: [] });
		expect(flush("hello\n", { repetitionRewriteEnabled: true })).toEqual({
			afterLine: 1,
			lines: [],
		});
	});

	test("policy enables the flush by default", () => {
		expect(defaultConversationPolicy.pacing.streamingLineFlushEnabled).toBe(true);
	});
});
