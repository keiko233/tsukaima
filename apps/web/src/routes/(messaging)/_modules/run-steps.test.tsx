import { describe, expect, mock, test } from "bun:test";
import type { RunStep } from "@tsukaima/contracts";

mock.module("@/paraglide/messages", () => ({
	m: {
		run_step_failed: () => "Run failed",
		run_step_thinking: () => "Thinking",
		run_steps_empty: () => "No steps.",
		run_steps_loading: () => "Loading…",
		run_steps_show: () => "Show steps",
	},
}));

const { toActivityItems } = await import("./run-step-items");

/** Narrow to the step variant, which is the only one this module produces. */
function stepOf(item: unknown) {
	if (typeof item !== "object" || item === null) throw new Error("expected a step item");
	if (!("type" in item) || item.type !== "step") throw new Error("expected a step item");
	return item as { label?: unknown; meta?: unknown; status?: unknown };
}

const tool = (overrides: Partial<Extract<RunStep, { kind: "tool" }>> = {}): RunStep => ({
	argumentsText: '{"q":"x"}',
	isError: false,
	kind: "tool",
	output: "hit",
	toolName: "web_search",
	...overrides,
});

describe("run step rows", () => {
	test("renders a tool call with its arguments and output", () => {
		const item = stepOf(toActivityItems([tool()])[0]);
		expect(item.status).toBe("complete");
		expect(JSON.stringify(item.label)).toContain("web_search");
		expect(JSON.stringify(item.meta)).toContain("hit");
	});

	test("renders reasoning as its own row", () => {
		const item = stepOf(toActivityItems([{ kind: "thinking", text: "let me check" }])[0]);
		expect(JSON.stringify(item.label)).toContain("Thinking");
		expect(JSON.stringify(item.meta)).toContain("let me check");
	});

	test("marks a failing tool", () => {
		const item = stepOf(toActivityItems([tool({ isError: true, output: "not found" })])[0]);
		expect(JSON.stringify(item.meta)).toContain("not found");
		expect(JSON.stringify(item.label)).toContain("destructive");
	});

	// The answer already renders in the bubble below; repeating it as a step would duplicate it.
	test("omits answer text because the bubble already shows it", () => {
		expect(toActivityItems([{ kind: "text", text: "the answer" }])).toEqual([]);
	});

	test("renders a run failure as a step", () => {
		const item = stepOf(toActivityItems([{ detail: "model_error: 500", kind: "failure" }])[0]);
		expect(JSON.stringify(item.label)).toContain("Run failed");
		expect(JSON.stringify(item.meta)).toContain("model_error: 500");
	});

	test("keeps step order as the model produced it", () => {
		const items = toActivityItems([
			{ kind: "thinking", text: "first" },
			tool({ toolName: "a" }),
			{ kind: "thinking", text: "second" },
			tool({ toolName: "b" }),
		]);
		expect(items).toHaveLength(4);
		expect(JSON.stringify(stepOf(items[1]).label)).toContain('"a"');
		expect(JSON.stringify(stepOf(items[3]).label)).toContain('"b"');
	});

	test("returns no rows for an empty step list", () => {
		expect(toActivityItems([])).toEqual([]);
	});
});
