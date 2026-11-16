import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveRunState } from "@tsukaima/contracts";
import {
	applyRunDelta,
	clearLiveRun,
	getLiveRun,
	setLiveRun,
	subscribeLiveRuns,
} from "./live-run-store";

function run(overrides: Partial<LiveRunState> = {}): LiveRunState {
	return {
		partialText: undefined,
		failure: undefined,
		settled: false,
		startedAtMs: 1_000,
		sessionId: "session-1",
		tools: [],
		turns: 0,
		...overrides,
	};
}

describe("live run store", () => {
	beforeEach(() => {
		clearLiveRun("session-1");
		clearLiveRun("session-2");
	});

	test("stores a run per session", () => {
		setLiveRun("session-1", run({ partialText: "hel" }));
		setLiveRun("session-2", run({ partialText: "other" }));
		expect(getLiveRun("session-1")?.partialText).toBe("hel");
		expect(getLiveRun("session-2")?.partialText).toBe("other");
	});

	test("grows the partial text as commits arrive", () => {
		setLiveRun("session-1", run({ partialText: "hel" }));
		setLiveRun("session-1", run({ partialText: "hello" }));
		expect(getLiveRun("session-1")?.partialText).toBe("hello");
	});

	// The server publishes `run: null` when the answer settles. The entry must disappear rather
	// than keep rendering the last partial as a phantom in-flight turn.
	test("clears the run when the server reports it settled", () => {
		setLiveRun("session-1", run({ partialText: "done" }));
		setLiveRun("session-1", null);
		expect(getLiveRun("session-1")).toBeUndefined();
	});

	test("ignores a clear for a session with no run", () => {
		expect(() => setLiveRun("session-1", null)).not.toThrow();
		expect(getLiveRun("session-1")).toBeUndefined();
	});

	// Every ~100ms commit would otherwise notify subscribers and re-render the transcript, even
	// when a commit carries nothing new (an identical retry, a metadata-only change).
	test("does not notify subscribers for an unchanged run", () => {
		let notifications = 0;
		const unsubscribe = subscribeLiveRuns(() => {
			notifications += 1;
		});
		try {
			setLiveRun("session-1", run({ partialText: "same" }));
			expect(notifications).toBe(1);
			setLiveRun("session-1", run({ partialText: "same" }));
			expect(notifications).toBe(1);
			setLiveRun("session-1", run({ partialText: "same!" }));
			expect(notifications).toBe(2);
		} finally {
			unsubscribe();
		}
	});

	test("merges incremental deltas and ignores an older revision", () => {
		setLiveRun("session-1", run({ partialText: "a", revision: 1 }));
		applyRunDelta("session-1", { partialText: "ab", phase: "writing", revision: 2 }, 2);
		expect(getLiveRun("session-1")).toMatchObject({
			partialText: "ab",
			phase: "writing",
			revision: 2,
		});
		// A reconnect snapshot read after the delta must not rewind the view.
		applyRunDelta("session-1", { partialText: "a", revision: 1 }, 1);
		expect(getLiveRun("session-1")?.partialText).toBe("ab");
	});

	test("clears on a settled delta and keeps a failed one", () => {
		setLiveRun("session-1", run({ partialText: "done", revision: 1 }));
		applyRunDelta("session-1", { settled: true, revision: 2 }, 2);
		expect(getLiveRun("session-1")).toBeUndefined();

		setLiveRun("session-1", run({ partialText: "half", revision: 3 }));
		applyRunDelta(
			"session-1",
			{ failure: "model_error: upstream 500", settled: true, revision: 4 },
			4,
		);
		expect(getLiveRun("session-1")).toMatchObject({
			failure: "model_error: upstream 500",
			partialText: "half",
			settled: true,
		});
	});

	test("merges the call chain and clears a retry", () => {
		setLiveRun(
			"session-1",
			run({
				attempt: 1,
				revision: 1,
				retry: { at: 2_000, error: "upstream 500" },
				steps: [
					{
						attempt: 1,
						call: 1,
						endedAtMs: 1_500,
						kind: "model",
						startedAtMs: 1_000,
						status: "retry",
					},
				],
			}),
		);
		applyRunDelta(
			"session-1",
			{
				attempt: 2,
				draftTools: [{ callId: "call-1", toolName: "web_search" }],
				phase: "tool_calls",
				retry: null,
				revision: 2,
				steps: [
					{
						attempt: 1,
						call: 1,
						endedAtMs: 1_500,
						kind: "model",
						startedAtMs: 1_000,
						status: "retry",
					},
					{ attempt: 2, call: 2, kind: "model", startedAtMs: 2_000, status: "running" },
				],
			},
			2,
		);
		const stored = getLiveRun("session-1");
		expect(stored?.attempt).toBe(2);
		expect(stored?.retry).toBeUndefined();
		expect(stored?.draftTools).toHaveLength(1);
		expect(stored?.steps).toHaveLength(2);
		expect(stored?.phase).toBe("tool_calls");
	});

	test("tracks tool calls and failures", () => {
		setLiveRun(
			"session-1",
			run({
				failure: "model_error: upstream 500",
				tools: [{ callId: "call-1", status: "running", toolName: "web_search" }],
			}),
		);
		const stored = getLiveRun("session-1");
		expect(stored?.failure).toBe("model_error: upstream 500");
		expect(stored?.tools).toHaveLength(1);
		expect(stored?.tools[0]?.toolName).toBe("web_search");
	});
});
