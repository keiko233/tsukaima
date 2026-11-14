import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

const { ToolCallRow } = await import("./tool-call-row");

const render = (props: Parameters<typeof ToolCallRow>[0]) =>
	renderToStaticMarkup(<ToolCallRow {...props} />);

describe("ToolCallRow", () => {
	// The point of the card: the full payload must be reachable, not ellipsized away. The
	// disclosure keeps its content mounted (collapsed to height 0), so it is in the markup.
	test("keeps the full arguments and output in the expandable card", () => {
		const payload = "long ".repeat(200);
		const html = render({
			argumentsText: `{"content":"${payload}"}`,
			output: "Memory saved: abc",
			toolName: "memory_save",
		});
		expect(html).toContain("memory_save");
		// SSR escapes quotes; the payload itself must survive untruncated.
		expect(html).toContain(payload);
		expect(html).toContain("Memory saved: abc");
		expect(html).toContain('aria-expanded="false"');
	});

	test("pretty-prints compact JSON arguments in the card", () => {
		const html = render({ argumentsText: '{"a":1,"b":[1,2]}', toolName: "t" });
		// SSR escapes quotes; the indented key/value shows the JSON was formatted.
		expect(html).toContain("&quot;a&quot;: 1");
		expect(html).toContain("&quot;b&quot;: [");
	});

	test("passes non-JSON arguments through unchanged", () => {
		const html = render({ argumentsText: "plain words", toolName: "t" });
		expect(html).toContain("plain words");
	});

	test("shows the output as a preview row while collapsed", () => {
		const html = render({ output: "hit", toolName: "web_search" });
		expect(html).toContain("hit");
	});

	test("is not expandable when there is nothing to show", () => {
		const html = render({ toolName: "noop" });
		expect(html).not.toContain("<button");
		expect(html).toContain("noop");
	});

	test("marks a failing call as an error", () => {
		const html = render({ isError: true, output: "not found", toolName: "read_file" });
		expect(html).toContain("text-destructive");
		expect(html).toContain("not found");
	});
});
