import { describe, expect, test } from "bun:test";
import type { LiveRunSnapshot } from "@tsukaima/core";
import {
	LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS,
	LIVE_RUN_TOOL_OUTPUT_MAX_CHARS,
	LiveRunTimeline,
} from "../src/services/live-run-timeline.ts";

function snapshot(overrides: Partial<LiveRunSnapshot> = {}): LiveRunSnapshot {
	return {
		attempt: undefined,
		conversationId: "1",
		draftTools: [],
		failure: undefined,
		generationStartedAtMs: undefined,
		model: undefined,
		partialText: undefined,
		partialThinking: undefined,
		retry: undefined,
		settled: false,
		startedAtMs: 1_000,
		tools: [],
		turns: 0,
		...overrides,
	};
}

function tool(callId: string, overrides: Partial<LiveRunSnapshot["tools"][number]> = {}) {
	return {
		argumentsText: JSON.stringify({ path: "docs/fixture.txt" }),
		callId,
		output: "short output",
		status: "done" as const,
		toolName: "read",
		...overrides,
	};
}

describe("LiveRunTimeline", () => {
	test("commits each tool callId once even when a snapshot repeats it across turns", () => {
		const timeline = new LiveRunTimeline(1_000);
		const repeated = tool("call-1", {
			argumentsText: "a".repeat(LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS * 3),
			output: "o".repeat(LIVE_RUN_TOOL_OUTPUT_MAX_CHARS * 3),
		});

		timeline.observe(snapshot({ attempt: 1, tools: [repeated], turns: 1 }), 1_100);
		timeline.observe(snapshot({ attempt: 1, tools: [repeated], turns: 2 }), 1_200);
		timeline.observe(snapshot({ attempt: 1, tools: [repeated], turns: 3 }), 1_300);
		timeline.observe(snapshot({ attempt: 1, settled: true, tools: [repeated], turns: 3 }), 1_400);

		const toolSteps = timeline.steps.filter((step) => step.kind === "tool");
		expect(toolSteps).toHaveLength(1);
		expect(toolSteps[0]).toMatchObject({ toolName: "read" });
		expect(toolSteps[0]?.kind === "tool" ? toolSteps[0].output.length : 0).toBeLessThanOrEqual(
			LIVE_RUN_TOOL_OUTPUT_MAX_CHARS,
		);
		expect(
			toolSteps[0]?.kind === "tool" ? toolSteps[0].argumentsText.length : 0,
		).toBeLessThanOrEqual(LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS);
	});

	test("keeps distinct tool callIds and caps their committed output", () => {
		const timeline = new LiveRunTimeline(1_000);
		const first = tool("call-1", { output: "1".repeat(8_000) });
		const second = tool("call-2", { output: "2".repeat(8_000) });

		timeline.observe(snapshot({ attempt: 1, tools: [first], turns: 1 }), 1_100);
		timeline.observe(snapshot({ attempt: 1, tools: [first, second], turns: 2 }), 1_200);
		timeline.observe(snapshot({ attempt: 1, settled: true, tools: [second], turns: 3 }), 1_300);

		const toolSteps = timeline.steps.filter((step) => step.kind === "tool");
		expect(toolSteps).toHaveLength(2);
		for (const step of toolSteps) {
			if (step.kind !== "tool") continue;
			expect(step.output.length).toBeLessThanOrEqual(LIVE_RUN_TOOL_OUTPUT_MAX_CHARS);
		}
	});
	test("groups model reasoning and tool calls into structured rounds", () => {
		const timeline = new LiveRunTimeline(1_000);
		const model = { modelId: "model-1", providerId: "provider-1" };
		timeline.observe(snapshot({ attempt: 1, model, partialThinking: "inspect first" }), 1_100);
		timeline.observe(
			snapshot({
				attempt: 1,
				draftTools: [
					{
						argumentsText: '{"path":"README.md"}',
						callId: "call-1",
						toolName: "read",
					},
				],
				model,
				partialThinking: "inspect first",
			}),
			1_200,
		);
		timeline.observe(snapshot({ attempt: 1, model, turns: 1, tools: [tool("call-1")] }), 1_300);
		timeline.observe(snapshot({ attempt: 1, model, settled: true, turns: 1 }), 1_400);

		expect(timeline.rounds).toMatchObject([
			{
				model,
				roundIndex: 0,
				stopReason: "toolUse",
				thinking: "inspect first",
				toolCalls: [{ callId: "call-1", output: "short output", status: "done", toolName: "read" }],
			},
		]);
	});

	// `rounds` is the closed-round list the WebUI renders below the active round. Exposing the
	// round still streaming there as well makes every token show twice.
	test("keeps the streaming round out of closed rounds and preserves it after it ends", () => {
		const timeline = new LiveRunTimeline(1_000);
		const model = { modelId: "model-1", providerId: "provider-1" };

		timeline.observe(
			snapshot({ attempt: 1, model, partialText: "half an answer", partialThinking: "working" }),
			1_100,
		);
		expect(timeline.rounds).toEqual([]);
		expect(timeline.currentThinking).toBe("working");
		expect(timeline.currentText).toBe("half an answer");

		// The next request means the first round closed; its content moves into `rounds` and the
		// new request owns the partials again.
		timeline.observe(
			snapshot({
				attempt: 1,
				model,
				partialThinking: "second thought",
				turns: 1,
			}),
			1_200,
		);
		expect(timeline.rounds).toMatchObject([{ thinking: "working", roundIndex: 0 }]);
		expect(timeline.currentThinking).toBe("second thought");
		expect(timeline.currentText).toBe("");
	});

	// A tool round that starts and ends between two polls leaves the next snapshot holding the
	// previous round's partial. Copying it into the new round made consecutive rounds show the
	// same reasoning in the WebUI.
	test("does not copy the previous round's partial into the next round", () => {
		const timeline = new LiveRunTimeline(1_000);
		const model = { modelId: "model-1", providerId: "provider-1" };

		timeline.observe(
			snapshot({ attempt: 1, model, partialThinking: "first thought", partialText: "first text" }),
			1_100,
		);
		// The tool round and its next request both happened between polls: one `turns` bump.
		timeline.observe(
			snapshot({
				attempt: 1,
				model,
				partialThinking: "first thought",
				partialText: "first text",
				turns: 1,
			}),
			1_200,
		);

		expect(timeline.rounds).toMatchObject([{ roundIndex: 0, thinking: "first thought" }]);
		expect(timeline.currentThinking).toBe("");
		expect(timeline.currentText).toBe("");

		// Once the new round streams something of its own, only that remainder is kept.
		timeline.observe(
			snapshot({
				attempt: 1,
				model,
				partialThinking: "first thought\nsecond thought",
				partialText: "first text\nsecond text",
				turns: 1,
			}),
			1_300,
		);
		expect(timeline.currentThinking).toBe("second thought");
		expect(timeline.currentText).toBe("second text");
	});
});
