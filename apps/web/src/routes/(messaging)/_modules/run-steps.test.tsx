import { describe, expect, mock, test } from "bun:test";
import type { RunStep } from "@tsukaima/contracts";

mock.module("@/paraglide/messages", () => ({
	m: {
		run_step_failed: () => "Run failed",
		run_step_thinking: () => "Thinking",
		run_steps_empty: () => "No steps.",
		run_steps_loading: () => "Loading…",
		run_steps_show: () => "Show steps",
		run_steps_summary: () => "Steps",
	},
}));

const { toStepRows } = await import("./run-step-items");

const tool = (overrides: Partial<Extract<RunStep, { kind: "tool" }>> = {}): RunStep => ({
	argumentsText: '{"q":"x"}',
	isError: false,
	kind: "tool",
	output: "hit",
	toolName: "web_search",
	...overrides,
});

const labels = (steps: readonly RunStep[]) =>
	toStepRows(steps)
		.filter((row) => row.node !== undefined || row.label !== null)
		.map((row) => JSON.stringify(row.node ?? row.label));

const bodies = (steps: readonly RunStep[]) =>
	toStepRows(steps)
		.filter((row) => row.body !== undefined)
		.map((row) => String(row.body));

describe("run step rows", () => {
	test("puts reasoning in its own row above its body", () => {
		const rows = toStepRows([{ kind: "thinking", text: "let me check the logs" }]);
		expect(rows).toHaveLength(2);
		expect(JSON.stringify(rows[0]?.label)).toContain("Thinking");
		expect(rows[1]?.body).toBe("let me check the logs");
	});

	test("renders a tool call as one expandable row carrying arguments and output", () => {
		const rows = toStepRows([tool()]);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0]?.node)).toContain("web_search");
		expect(JSON.stringify(rows[0]?.node)).toContain("q");
		expect(JSON.stringify(rows[0]?.node)).toContain("hit");
	});

	test("marks a failing tool and its output as errors", () => {
		const rows = toStepRows([tool({ isError: true, output: "not found" })]);
		expect(rows.every((row) => row.isError === true)).toBe(true);
		expect(JSON.stringify(rows[0]?.node)).toContain("not found");
	});

	// A call that produced nothing still renders its header, with no output in the card.
	test("keeps a single row for a tool with no output", () => {
		expect(toStepRows([tool({ output: "" })])).toHaveLength(1);
	});

	// The answer already renders in the bubble; repeating it as a step would duplicate it.
	test("omits answer text because the bubble already shows it", () => {
		expect(toStepRows([{ kind: "text", text: "the answer" }])).toEqual([]);
	});

	test("renders a run failure as a labelled row with its detail", () => {
		const rows = toStepRows([{ detail: "model_error: 500", kind: "failure" }]);
		expect(JSON.stringify(rows[0]?.label)).toContain("Run failed");
		expect(rows[1]?.body).toBe("model_error: 500");
	});

	test("keeps step order as the model produced it", () => {
		const order = labels([
			{ kind: "thinking", text: "first" },
			tool({ toolName: "a" }),
			tool({ toolName: "b" }),
		]);
		expect(order[0]).toContain("Thinking");
		expect(order[1]).toContain('"a"');
		expect(order[2]).toContain('"b"');
	});

	test("preserves newlines in reasoning text", () => {
		expect(bodies([{ kind: "thinking", text: "line one\nline two" }])[0]).toContain(
			"line one\nline two",
		);
	});

	test("returns no rows for an empty step list", () => {
		expect(toStepRows([])).toEqual([]);
	});
});
