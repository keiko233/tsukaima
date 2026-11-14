import { describe, expect, test } from "bun:test";
import { collectRunSteps, runStepsFromEntries, type StepEntry } from "./run-steps";

const assistant = (id: string, content: readonly unknown[]): StepEntry => ({
	id,
	kind: "pi.assistant",
	model: [{ content, role: "assistant" }],
});

const toolResult = (
	id: string,
	toolCallId: string,
	text: string,
	options: { isError?: boolean; toolName?: string } = {},
): StepEntry => ({
	id,
	kind: "pi.tool-result",
	model: [
		{
			content: text.length === 0 ? [] : [{ text, type: "text" }],
			isError: options.isError ?? false,
			role: "toolResult",
			toolCallId,
			toolName: options.toolName ?? "web_search",
		},
	],
});

const userTurn = (id: string): StepEntry => ({
	id,
	kind: "elaina.activityWindow",
	model: [{ content: "hi", role: "user" }],
});

const text = (value: string) => ({ text: value, type: "text" });
const thinking = (value: string) => ({ thinking: value, type: "thinking" });
const call = (id: string, name: string, args: unknown = {}) => ({
	arguments: args,
	id,
	name,
	type: "toolCall",
});

describe("run steps from durable entries", () => {
	// The live `pi.live` document is cleared when a run settles, so this is the only source a
	// transcript can use to keep showing what the agent did.
	test("keeps reasoning, tool calls, and the answer in transcript order", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [thinking("Let me look this up."), call("c1", "web_search", { q: "x" })]),
			toolResult("3", "c1", "search hit"),
			assistant("4", [text("Here is the answer.")]),
		];
		const steps = runStepsFromEntries(entries, "4");
		expect(steps).toEqual([
			{ kind: "thinking", text: "Let me look this up." },
			{
				argumentsText: '{"q":"x"}',
				isError: false,
				kind: "tool",
				output: "search hit",
				toolName: "web_search",
			},
			{ kind: "text", text: "Here is the answer." },
		]);
	});

	// A tool row must be one row: the call and its result are the same step to a reader.
	test("pairs a tool result with the call it answers", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [call("c1", "read_file", { path: "/tmp/a" })]),
			toolResult("3", "c1", "file contents"),
			assistant("4", [text("done")]),
		];
		const steps = runStepsFromEntries(entries, "4");
		const tools = steps.filter((step) => step.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ output: "file contents", toolName: "read_file" });
	});

	test("marks a failing tool and keeps its error text", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [call("c1", "run_command")]),
			toolResult("3", "c1", "command not found", { isError: true, toolName: "run_command" }),
			assistant("4", [text("that failed")]),
		];
		const [tool] = runStepsFromEntries(entries, "4").filter((step) => step.kind === "tool");
		expect(tool).toMatchObject({ isError: true, output: "command not found" });
	});

	test("shows a tool call that never produced a result", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [call("c1", "web_search")]),
			assistant("3", [text("no result came back")]),
		];
		const [tool] = runStepsFromEntries(entries, "3").filter((step) => step.kind === "tool");
		expect(tool).toMatchObject({ isError: false, output: "" });
	});

	// A turn is one activity window. Each window is a separate message in the transcript, so
	// expanding one answer must not repeat the work of an earlier window.
	test("scopes steps to the activity window that contains the entry", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [text("first answer")]),
			userTurn("3"),
			assistant("4", [text("second answer")]),
		];
		expect(runStepsFromEntries(entries, "4")).toEqual([{ kind: "text", text: "second answer" }]);
		expect(runStepsFromEntries(entries, "2")).toEqual([{ kind: "text", text: "first answer" }]);
	});

	// Several assistant entries in one window are the tool rounds of a single answer, so the
	// steps of every round belong together.
	test("keeps multiple assistant entries of one window in one step list", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [thinking("round one")]),
			assistant("3", [thinking("round two")]),
			assistant("4", [text("answer")]),
		];
		expect(runStepsFromEntries(entries, "4")).toEqual([
			{ kind: "thinking", text: "round one" },
			{ kind: "thinking", text: "round two" },
			{ kind: "text", text: "answer" },
		]);
	});

	test("returns nothing for an entry that is not in the transcript", () => {
		expect(runStepsFromEntries([userTurn("1")], "missing")).toEqual([]);
	});

	// A multi-round run has several assistant entries; every round's work belongs to the answer.
	test("collects every tool round of one run", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [call("c1", "a")]),
			toolResult("3", "c1", "one"),
			assistant("4", [call("c2", "b")]),
			toolResult("5", "c2", "two"),
			assistant("6", [text("final")]),
		];
		const steps = runStepsFromEntries(entries, "6");
		expect(steps.filter((step) => step.kind === "tool")).toHaveLength(2);
		expect(steps.at(-1)).toEqual({ kind: "text", text: "final" });
	});

	test("clips oversized tool output and arguments", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			assistant("2", [call("c1", "big", { body: "x".repeat(5_000) })]),
			toolResult("3", "c1", "y".repeat(50_000)),
			assistant("4", [text("done")]),
		];
		const [tool] = runStepsFromEntries(entries, "4").filter((step) => step.kind === "tool");
		if (tool?.kind !== "tool") throw new Error("expected a tool step");
		expect(tool.output.length).toBeLessThan(2_100);
		expect(tool.argumentsText.length).toBeLessThan(500);
	});

	test("ignores a malformed entry instead of throwing", () => {
		const entries: StepEntry[] = [
			{ id: "1", kind: "pi.assistant" },
			{ data: { anything: true }, id: "2", kind: "pi.assistant" },
			{ id: "3", kind: "pi.assistant", model: [null] },
			assistant("4", [text("still works")]),
		];
		expect(runStepsFromEntries(entries, "4")).toEqual([{ kind: "text", text: "still works" }]);
	});

	// The panel shows the turn's elapsed time. The transcript has no wall clock for the turn, so
	// the duration is the sum of the per-message `durationMs` the provider reports.
	test("sums the model and tool time of the turn", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			{
				id: "2",
				kind: "pi.assistant",
				model: [{ content: [call("c1", "a")], durationMs: 1_200, role: "assistant" }],
			},
			{
				id: "3",
				kind: "pi.tool-result",
				model: [
					{
						content: [{ text: "done", type: "text" }],
						durationMs: 300,
						isError: false,
						role: "toolResult",
						toolCallId: "c1",
						toolName: "a",
					},
				],
			},
			{
				id: "4",
				kind: "pi.assistant",
				model: [{ content: [text("answer")], durationMs: 500, role: "assistant" }],
			},
		];
		const result = collectRunSteps(entries, "4");
		expect(result.durationSeconds).toBe(2);
	});

	test("omits the duration when the entries carry no timing", () => {
		const entries: StepEntry[] = [userTurn("1"), assistant("2", [text("answer")])];
		expect(collectRunSteps(entries, "2").durationSeconds).toBeUndefined();
	});

	test("ignores timing of an earlier turn", () => {
		const entries: StepEntry[] = [
			userTurn("1"),
			{ id: "2", kind: "pi.assistant", model: [{ content: [text("old")], durationMs: 9_000 }] },
			userTurn("3"),
			{ id: "4", kind: "pi.assistant", model: [{ content: [text("new")], durationMs: 400 }] },
		];
		expect(collectRunSteps(entries, "4").durationSeconds).toBe(0.4);
	});
});
