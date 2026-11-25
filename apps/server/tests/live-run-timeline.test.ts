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
});
