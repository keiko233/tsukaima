import { afterEach, describe, expect, test } from "bun:test";
import { KeyvCache } from "@elaina/cache";
import type { LiveRunSnapshot } from "@elaina/core";
import { LiveRunCache } from "../src/services/live-run-cache.ts";

const caches: KeyvCache[] = [];

afterEach(async () => {
	await Promise.all(caches.splice(0).map((cache) => cache.close()));
});

function setup() {
	const cache = new KeyvCache();
	caches.push(cache);
	return { cache, live: new LiveRunCache(cache) };
}

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

describe("LiveRunCache", () => {
	test("stores a snapshot and publishes only changed fields as a delta", async () => {
		const { live } = setup();
		const updates: string[] = [];
		live.subscribe((update) => updates.push(JSON.stringify(update.patch)));
		await live.record("session-1", snapshot());
		await live.record("session-1", snapshot({ partialText: "Hello", partialThinking: "Planning" }));

		const state = await live.snapshot("session-1");
		expect(state).toMatchObject({
			partialText: "Hello",
			partialThinking: "Planning",
			phase: "writing",
			revision: 2,
			settled: false,
		});
		const second = JSON.parse(updates[1] ?? "{}") as Record<string, unknown>;
		expect(second).toMatchObject({ partialText: "Hello", partialThinking: "Planning" });
		expect(second).not.toHaveProperty("tools");
		expect(second).not.toHaveProperty("turns");
	});

	test("accumulates model calls, reasoning, and tool rounds into one activity chain", async () => {
		const { live } = setup();
		const model = { modelId: "model-1", providerId: "provider-1" };
		await live.record("session-1", snapshot({ attempt: 1, generationStartedAtMs: 1_100, model }));
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 1_100,
				model,
				partialThinking: "I should search.",
			}),
		);
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				draftTools: [
					{
						argumentsText: '{"query":"elaina"}',
						callId: "call-1",
						toolName: "web_search",
					},
				],
				generationStartedAtMs: 1_100,
				model,
				partialThinking: "I should search.",
			}),
		);
		await live.record(
			"session-1",
			snapshot({
				tools: [
					{
						argumentsText: '{"query":"elaina"}',
						callId: "call-1",
						output: "two hits",
						status: "running",
						toolName: "web_search",
					},
				],
				turns: 1,
			}),
		);

		// The tool round is still live, but the model call and its reasoning are already steps.
		let state = await live.snapshot("session-1");
		expect(state?.steps).toMatchObject([
			{ attempt: 1, call: 1, kind: "model", modelId: "model-1", status: "done" },
			{ kind: "thinking", text: "I should search." },
		]);

		// The next model request closes the tool round and opens model call 2.
		await live.record(
			"session-1",
			snapshot({ attempt: 1, generationStartedAtMs: 2_000, model, turns: 1 }),
		);
		state = await live.snapshot("session-1");
		expect(state?.steps).toMatchObject([
			{ kind: "model", status: "done" },
			{ kind: "thinking", text: "I should search." },
			{
				argumentsText: '{"query":"elaina"}',
				kind: "tool",
				output: "two hits",
				toolName: "web_search",
			},
			{ attempt: 1, call: 2, kind: "model", status: "running" },
		]);

		// A retry is a new attempt after the failed row, not a replacement of it.
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 2_000,
				model,
				retry: { at: 2_500, error: "upstream 500" },
				turns: 1,
			}),
		);
		await live.record(
			"session-1",
			snapshot({ attempt: 2, generationStartedAtMs: 2_600, model, turns: 1 }),
		);
		state = await live.snapshot("session-1");
		expect(state?.steps).toMatchObject([
			{ kind: "model", status: "done" },
			{ kind: "thinking" },
			{ kind: "tool" },
			{ attempt: 1, call: 2, error: "upstream 500", kind: "model", status: "retry" },
			{ attempt: 2, call: 3, kind: "model", status: "running" },
		]);

		// The final answer closes the last model call and keeps it in the cached process chain.
		await live.record(
			"session-1",
			snapshot({
				attempt: 2,
				generationStartedAtMs: 2_600,
				partialText: "Here is the answer.",
				model,
				settled: true,
				turns: 1,
			}),
		);
		const final = await live.finalizeAnswer("session-1", "entry-1");
		expect(final?.steps.at(-1)).toMatchObject({ kind: "text", text: "Here is the answer." });
		expect(final?.steps.some((step) => step.kind === "model")).toBe(true);
	});

	test("lists only in-flight runs and removes a settled run from reconnect snapshots", async () => {
		const { live } = setup();
		await live.record("session-1", snapshot({ partialText: "working" }));
		await live.record("session-2", snapshot({ settled: true, startedAtMs: 2_000 }));
		expect((await live.snapshots()).map((state) => state.sessionId)).toEqual(["session-1"]);
	});

	test("keeps the final process chain keyed by durable answer id", async () => {
		const { live } = setup();
		await live.record(
			"session-1",
			snapshot({
				partialThinking: "I should search.",
				partialText: "Here is the answer.",
				tools: [
					{
						argumentsText: '{"query":"x"}',
						callId: "call-1",
						output: "search hit",
						status: "done",
						toolName: "web_search",
					},
				],
			}),
		);
		const final = await live.finalizeAnswer("session-1", "entry-42");
		expect(final?.steps.map((step) => step.kind)).toEqual(["thinking", "text", "tool"]);
		expect(await live.final("entry-42")).toEqual(final);
	});

	test("keeps the process chain even when a clean settle arrives first", async () => {
		const { live } = setup();
		await live.record(
			"session-1",
			snapshot({ partialThinking: "reasoning", partialText: "answer" }),
		);
		// The core host reports an empty settled snapshot before the durable answer callback.
		await live.record("session-1", snapshot({ settled: true }));
		const final = await live.finalizeAnswer("session-1", "entry-43");
		expect(final?.steps.map((step) => step.kind)).toEqual(["model", "thinking", "text"]);
	});

	test("replays deltas after a revision", async () => {
		const { live } = setup();
		await live.record("session-1", snapshot());
		await live.record("session-1", snapshot({ partialText: "a" }));
		await live.record("session-1", snapshot({ partialText: "ab" }));
		const history = await live.history("session-1", 2);
		expect(history.map((entry) => entry.revision)).toEqual([3]);
		expect(history[0]?.patch.partialText).toBe("ab");
	});
});
