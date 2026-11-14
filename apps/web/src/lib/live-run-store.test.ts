import { beforeEach, describe, expect, test } from "bun:test";
import type { LiveRunState } from "@elaina/contracts";
import { clearLiveRun, getLiveRun, setLiveRun, subscribeLiveRuns } from "./live-run-store";

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
