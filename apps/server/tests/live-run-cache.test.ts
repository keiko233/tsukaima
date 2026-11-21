import { afterEach, describe, expect, test } from "bun:test";
import { KeyvCache } from "@tsukaima/cache";
import type { LiveRunSnapshot } from "@tsukaima/core";
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
						argumentsText: '{"query":"tsukaima"}',
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
						argumentsText: '{"query":"tsukaima"}',
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
				argumentsText: '{"query":"tsukaima"}',
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

	test("keeps earlier reasoning when a fast tool round was never observed", async () => {
		const { live } = setup();
		const model = { modelId: "model-1", providerId: "provider-1" };
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 1_100,
				model,
				partialThinking: "first thought",
				runId: "run-1",
			}),
		);
		// The tool round and the next request both completed between two polls: no `tools` or
		// `draftTools` observation exists, but `turns` proves the round happened.
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 2_000,
				model,
				partialThinking: "second thought",
				runId: "run-1",
				turns: 1,
			}),
		);

		const state = await live.snapshot("session-1");
		expect(state?.steps).toMatchObject([
			{ attempt: 1, call: 1, kind: "model", status: "done" },
			{ kind: "thinking", text: "first thought" },
			{ attempt: 1, call: 2, kind: "model", status: "running" },
		]);
		expect(state?.partialThinking).toBe("second thought");
	});

	test("continues one timeline when a newer watcher observes the same run", async () => {
		const { live } = setup();
		const model = { modelId: "model-1", providerId: "provider-1" };
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 1_100,
				model,
				partialThinking: "first thought",
				runId: "run-1",
			}),
		);
		await live.record(
			"session-1",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 1_100,
				model,
				partialText: "an answer",
				runId: "run-1",
				startedAtMs: 2_000,
			}),
		);

		const state = await live.snapshot("session-1");
		expect(state?.startedAtMs).toBe(1_000);
		expect(state?.steps).toMatchObject([{ attempt: 1, call: 1, kind: "model" }]);
		// The second watcher's snapshot omitted the thinking it had not committed; the
		// accumulated round text must survive for the live view.
		expect(state?.partialThinking).toBe("first thought");
		expect(state?.partialText).toBe("an answer");
	});

	test("starts a fresh timeline when the stable run identity changes", async () => {
		const { live } = setup();
		await live.record("session-1", snapshot({ partialThinking: "previous run", runId: "run-1" }));
		await live.record(
			"session-1",
			snapshot({
				partialThinking: "new run",
				runId: "run-2",
				startedAtMs: 2_000,
			}),
		);
		const state = await live.snapshot("session-1");
		expect(state?.steps).toMatchObject([{ kind: "model" }]);
		expect(state?.partialThinking).toBe("new run");
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

	test("coalesces a same-tick record burst without losing the settled answer", async () => {
		const { cache, live } = setup();
		const model = { modelId: "model-1", providerId: "provider-1" };
		const burst = Array.from({ length: 20 }, (_, index) =>
			live.record(
				"session-burst",
				snapshot({
					attempt: 1,
					generationStartedAtMs: 1_100,
					model,
					partialText: "x".repeat(index + 1),
				}),
			),
		);
		const settled = live.record(
			"session-burst",
			snapshot({
				attempt: 1,
				generationStartedAtMs: 1_100,
				model,
				partialText: "the final answer is complete.",
				settled: true,
			}),
		);
		// Finalization must flush everything still pending, not just the last awaited record.
		const final = await live.finalizeAnswer("session-burst", "entry-burst");
		await Promise.all([...burst, settled]);

		expect(final?.steps.at(-1)).toMatchObject({
			kind: "text",
			text: "the final answer is complete.",
		});
		const state = await live.snapshot("session-burst");
		expect(state).toMatchObject({ settled: true });
		expect(state?.steps?.at(-1)).toMatchObject({
			kind: "text",
			text: "the final answer is complete.",
		});
		expect(cache.stats().streamAppends).toBeLessThan(burst.length + 1);
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
