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
		conversationId: "1",
		failure: undefined,
		partialText: undefined,
		partialThinking: undefined,
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
				tools: [{ callId: "call-1", output: "search hit", status: "done", toolName: "web_search" }],
			}),
		);
		const final = await live.finalizeAnswer("session-1", "entry-42");
		expect(final?.steps.map((step) => step.kind)).toEqual(["thinking", "tool", "text"]);
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
		expect(final?.steps.map((step) => step.kind)).toEqual(["thinking", "text"]);
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
