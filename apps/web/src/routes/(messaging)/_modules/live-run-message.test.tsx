import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Paraglide compiles messages through a Vite virtual module, which Bun's test runner cannot
// resolve. Stub the three labels this component reads so the test asserts the real render path.
mock.module("@/paraglide/messages", () => ({
	m: {
		live_run_active_label: () => "Elaina is working",
		live_run_failed: () => "\u8fd0\u884c\u5931\u8d25",
		live_run_working: () => "\u601d\u8003\u4e2d\u2026",
		message_sender_elaina: () => "Elaina",
	},
}));
import type { LiveRunState } from "@elaina/contracts";

function run(overrides: Partial<LiveRunState> = {}): LiveRunState {
	return {
		partialText: undefined,
		failure: undefined,
		startedAtMs: 1_000,
		sessionId: "session-1",
		tools: [],
		turns: 0,
		...overrides,
	};
}

// Import after the mock is registered: the component resolves `@/paraglide/messages` at module
// load, and the virtual module does not exist under Bun's test runner.
const { LiveRunMessage } = await import("./live-run-message");

const render = (state: LiveRunState, now = 5_000) =>
	renderToStaticMarkup(<LiveRunMessage now={now} run={state} />);

describe("LiveRunMessage", () => {
	// A run that has not streamed a token yet must still be visible: this is the state that
	// previously looked like a hung bot, because nothing rendered until the answer settled.
	test("renders a working state before any text arrives", () => {
		const html = render(run());
		expect(html).toContain("思考中");
		expect(html).toContain("Elaina");
	});

	test("renders streamed partial text", () => {
		const html = render(run({ partialText: "The answer streams" }));
		expect(html).toContain("The answer streams");
		expect(html).toContain("思考中");
	});

	test("renders elapsed seconds from the run start", () => {
		// 4s of wall clock from `startedAtMs` to `now`.
		const html = render(run({ startedAtMs: 1_000 }), 5_000);
		expect(html).toContain("4");
	});

	test("renders a tool call as an activity step", () => {
		const html = render(
			run({
				partialText: "searching",
				tools: [{ callId: "call-1", status: "running", toolName: "web_search" }],
			}),
		);
		expect(html).toContain("web_search");
	});

	test("renders a failure instead of the working label", () => {
		const html = render(run({ failure: "model_error: upstream 500" }));
		expect(html).toContain("运行失败");
		expect(html).toContain("model_error: upstream 500");
		expect(html).not.toContain("思考中");
	});

	// A failed run keeps whatever text it produced, so the user can see how far it got.
	test("keeps partial text on a failed run", () => {
		const html = render(run({ failure: "aborted", partialText: "half an ans" }));
		expect(html).toContain("half an ans");
		expect(html).toContain("运行失败");
	});
});
