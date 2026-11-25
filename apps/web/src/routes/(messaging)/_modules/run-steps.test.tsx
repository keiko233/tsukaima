import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunRound, RunSegmentSummary, RunStep } from "@tsukaima/contracts";

mock.module("@/paraglide/messages", () => ({
	m: {
		live_run_model_failed: () => "Failed",
		live_run_model_retry: () => "Retrying",
		live_run_model_running: () => "Running",
		live_run_tool_preparing: () => "Preparing…",
		live_run_working: () => "Working…",
		run_round_label: ({ n }: { n: number }) => `Round ${n}`,
		run_round_model: () => "Model",
		run_round_stop_aborted: () => "Aborted",
		run_round_stop_error: () => "Error",
		run_round_tools: () => "Tools",
		run_segment_status_completed: () => "Completed",
		run_segment_status_failed: () => "Failed",
		run_segment_status_interrupted: () => "Interrupted",
		run_segment_status_running: () => "Running",
		run_segment_status_steered: () => "Steered",
		run_segment_status_suppressed: () => "Shown inline",
		run_segment_title: () => "Run",
		run_segment_trigger_follow_up: () => "Follow-up",
		run_segment_trigger_initial: () => "Initial",
		run_segment_trigger_steer: () => "Steer",
		run_step_failed: () => "Run failed",
		run_step_model: () => "Model call",
		run_step_text: () => "Output",
		run_step_thinking: () => "Thinking",
		run_steps_empty: () => "No steps.",
		run_steps_loading: () => "Loading…",
		run_steps_show: () => "Show steps",
		run_steps_summary: () => "Steps",
	},
}));

mock.module("@/lib/api", () => ({
	orpc: {
		admin: {
			sessions: {
				runSteps: {
					queryOptions: () => ({
						queryFn: async () => ({ rounds: [], steps: [] }),
						queryKey: ["run-steps"],
					}),
				},
			},
		},
	},
}));

const { RunRoundsView, runSegmentStatusLabel, toStepRows } = await import(
	"./run-step-items"
);
const { RunSegmentCard } = await import("./run-steps");

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

	test("renders a model call before the work it produced", () => {
		const rows = toStepRows([
			{
				attempt: 2,
				call: 2,
				endedAtMs: 3_000,
				kind: "model",
				modelId: "model-1",
				startedAtMs: 1_000,
				status: "done",
			},
			{ kind: "thinking", text: "checking" },
		]);
		expect(JSON.stringify(rows[0]?.label)).toContain("Model call");
		expect(rows[0]?.body).toContain("model-1");
		expect(JSON.stringify(rows[1]?.label)).toContain("Thinking");
	});

	test("hides a model call when it is the only step", () => {
		expect(
			toStepRows([
				{
					attempt: 1,
					call: 1,
					kind: "model",
					startedAtMs: 1_000,
					status: "done",
				},
			]),
		).toEqual([]);
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

const round = (roundIndex: number, overrides: Partial<RunRound> = {}): RunRound => ({
	roundIndex,
	stopReason: "stop",
	toolCalls: [],
	...overrides,
});

describe("run rounds view", () => {
	test("groups rounds by roundIndex and keeps each round's thinking, tools, and text together", () => {
		const html = renderToStaticMarkup(
			<RunRoundsView
				rounds={[
					round(1, { thinking: "second thought" }),
					round(0, {
						intermediateText: "first output",
						thinking: "first thought",
						toolCalls: [
							{
								argumentsText: '{"q":"x"}',
								isError: false,
								output: "hit",
								toolName: "web_search",
							},
						],
					}),
				]}
			/>,
		);
		expect(html).toContain("Round 1");
		expect(html).toContain("Round 2");
		expect(html).toContain("first thought");
		expect(html).toContain("first output");
		expect(html).toContain("web_search");
		expect(html).toContain("second thought");
		expect(html.indexOf("first thought")).toBeLessThan(html.indexOf("first output"));
		expect(html.indexOf("first output")).toBeLessThan(html.indexOf("second thought"));
	});

	test("renders a failure notice and an aborted stop reason", () => {
		const html = renderToStaticMarkup(
			<RunRoundsView
				rounds={[
					round(0, {
						failure: "model_error: upstream 500",
						stopReason: "aborted",
						thinking: "partial thought",
					}),
				]}
			/>,
		);
		expect(html).toContain("Aborted");
		expect(html).toContain("model_error: upstream 500");
	});

	test("renders the active live round after completed rounds", () => {
		const html = renderToStaticMarkup(
			<RunRoundsView
				activeRound={{
					draftTools: [{ callId: "draft-1", toolName: "web_search" }],
					model: { modelId: "model-1", providerId: "provider-1" },
					text: "streaming answer",
					thinking: "streaming thought",
					tools: [],
					working: true,
				}}
				rounds={[round(0, { thinking: "finished thought" })]}
			/>,
		);
		expect(html).toContain("Round 2");
		expect(html).toContain("finished thought");
		expect(html).toContain("streaming thought");
		expect(html).toContain("streaming answer");
		expect(html).toContain("web_search");
		expect(html.indexOf("finished thought")).toBeLessThan(html.indexOf("streaming thought"));
	});

	test("labels every persisted segment status", () => {
		expect(runSegmentStatusLabel("running")).toBe("Running");
		expect(runSegmentStatusLabel("steered")).toBe("Steered");
		expect(runSegmentStatusLabel("completed")).toBe("Completed");
		expect(runSegmentStatusLabel("interrupted")).toBe("Interrupted");
		expect(runSegmentStatusLabel("suppressed")).toBe("Shown inline");
		expect(runSegmentStatusLabel("failed")).toBe("Failed");
	});
});

function segment(overrides: Partial<RunSegmentSummary> = {}): RunSegmentSummary {
	return {
		durationMs: 1_200,
		endedAt: "2026-01-01T00:00:02.000Z",
		failureDetail: null,
		finalMessageId: null,
		id: "segment-1",
		rounds: [round(0, { thinking: "preserved thought" })],
		runId: "run-1",
		segmentIndex: 0,
		seq: 2,
		startedAt: "2026-01-01T00:00:00.000Z",
		status: "steered",
		triggerKind: "initial",
		triggerMessageId: null,
		...overrides,
	};
}

describe("run segment card", () => {
	test("shows a steered segment at its own anchor with expandable rounds", () => {
		const html = renderToStaticMarkup(<RunSegmentCard segment={segment()} />);
		expect(html).toContain("Run");
		expect(html).toContain("Initial");
		expect(html).toContain("Steered");
		expect(html).toContain("Show steps");
		expect(html).not.toContain("preserved thought");
	});

	test("opens an interrupted segment with its preserved rounds and stop reason", () => {
		const html = renderToStaticMarkup(
			<RunSegmentCard
				segment={segment({
					rounds: [round(0, { stopReason: "aborted", thinking: "preserved thought" })],
					status: "interrupted",
				})}
			/>,
		);
		expect(html).toContain("Interrupted");
		expect(html).toContain("preserved thought");
		expect(html).toContain("Aborted");
	});

	test("renders failure detail on a failed segment", () => {
		const html = renderToStaticMarkup(
			<RunSegmentCard
				segment={segment({
					failureDetail: "model_error: upstream 500",
					rounds: [],
					status: "failed",
				})}
			/>,
		);
		expect(html).toContain("Failed");
		expect(html).toContain("model_error: upstream 500");
	});
});
