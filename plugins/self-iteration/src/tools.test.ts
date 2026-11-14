import { describe, expect, test } from "bun:test";
import {
	LocalToolBridge,
	type PluginContext,
	type PluginLogger,
	type PluginTool,
	type ToolInvocationContext,
} from "@elaina/sdk";
import { registerSelfIterationTools } from "./tools.ts";
import type { SelfIterationService } from "./service.ts";

interface CapturedLog {
	readonly details: unknown;
	readonly level: "debug" | "error" | "info" | "trace" | "warn";
	readonly message: string;
}

/** In-memory logger covering the full `PluginLogger` surface, including `trace`. */
function captureLogger(logs: CapturedLog[]): PluginLogger {
	const write =
		(level: CapturedLog["level"]) =>
		(message: string, details?: unknown): void => {
			logs.push({ details, level, message });
		};
	const logger: PluginLogger = {
		debug: write("debug"),
		error: write("error"),
		info: write("info"),
		trace: write("trace"),
		warn: write("warn"),
	};
	logger.child = () => logger;
	return logger;
}

function detailsOf(entry: CapturedLog | undefined): Record<string, unknown> {
	return typeof entry?.details === "object" && entry.details !== null
		? (entry.details as Record<string, unknown>)
		: {};
}

function contextFor(logs: CapturedLog[]): PluginContext {
	return {
		audit: { record: async () => undefined },
		logger: captureLogger(logs),
		tools: { register: () => undefined },
	} as unknown as PluginContext;
}

function registeredTools(logs: CapturedLog[] = []): readonly PluginTool[] {
	const tools: PluginTool[] = [];
	registerSelfIterationTools(
		{
			...contextFor(logs),
			tools: { register: (tool: PluginTool) => void tools.push(tool) },
		} as unknown as PluginContext,
		{} as SelfIterationService,
	);
	return tools;
}

describe("self-iteration model tools", () => {
	test("all tools require the explicit coding conversation capability", () => {
		for (const tool of registeredTools()) {
			expect(tool.policy?.requiredConversationCapabilities).toEqual(["coding"]);
			expect(tool.policy?.allowedTaskKinds).toEqual(["coding"]);
			expect(tool.policy?.visibility).toBe("model");
			expect(tool.name.startsWith("self-iteration.")).toBe(true);
		}
	});

	test("registration and execution deny missing permissions", () => {
		const tool = registeredTools().find((entry) => entry.name === "self-iteration.edit");
		if (tool === undefined) throw new Error("edit tool missing");
		const deniedBridge = new LocalToolBridge("self-iteration", ["coding.read"]);
		expect(() => deniedBridge.register(tool)).toThrow();
	});

	test("denies execution without the coding conversation capability", async () => {
		const tool = registeredTools().find((entry) => entry.name === "self-iteration.analyze");
		if (tool === undefined) throw new Error("analyze tool missing");
		const bridge = new LocalToolBridge("self-iteration", [
			"coding.read",
			"coding.execute",
			"tasks.create",
		]);
		bridge.register(tool);
		const denied = await bridge.invoke("self-iteration.analyze", {}, {
			conversationId: "normal-qq",
		} satisfies ToolInvocationContext);
		expect(denied.ok).toBe(false);
		expect(denied).toEqual(
			expect.objectContaining({ message: "missing_capability:coding", reason: "unauthorized" }),
		);
	});

	test("logs a trace invocation and a timed debug completion", async () => {
		const logs: CapturedLog[] = [];
		const tools: PluginTool[] = [];
		registerSelfIterationTools(
			{
				...contextFor(logs),
				tools: { register: (tool: PluginTool) => void tools.push(tool) },
			} as unknown as PluginContext,
			{
				analyze: async () => ({ content: "readme", path: "README.md", truncated: false }),
			} as unknown as SelfIterationService,
		);
		const analyze = tools.find((entry) => entry.name === "self-iteration.analyze");
		if (analyze === undefined) throw new Error("analyze tool missing");
		const result = await analyze.execute(
			{ goal: "Read the readme", path: "README.md" },
			{ conversationId: "coding", userId: "admin" },
		);
		expect(result.content[0]?.text).toContain("readme");

		const invoked = logs.find(
			(entry) => entry.level === "trace" && entry.message === "tool invoked",
		);
		expect(invoked?.details).toEqual(
			expect.objectContaining({ tool: "self-iteration.analyze", userId: "admin" }),
		);
		expect(String(detailsOf(invoked).input)).toContain("Read the readme");

		const completed = logs.find(
			(entry) => entry.level === "debug" && entry.message === "tool completed",
		);
		expect(typeof detailsOf(completed).durationMs).toBe("number");
		expect(completed?.details).toEqual(
			expect.objectContaining({ outcome: "ok", tool: "self-iteration.analyze" }),
		);
	});

	test("bounds trace previews and logs an error outcome when a tool throws", async () => {
		const logs: CapturedLog[] = [];
		const tools: PluginTool[] = [];
		registerSelfIterationTools(
			{
				...contextFor(logs),
				tools: { register: (tool: PluginTool) => void tools.push(tool) },
			} as unknown as PluginContext,
			{
				analyze: async () => {
					throw new Error("boom");
				},
			} as unknown as SelfIterationService,
		);
		const analyze = tools.find((entry) => entry.name === "self-iteration.analyze");
		if (analyze === undefined) throw new Error("analyze tool missing");
		const result = await analyze.execute(
			{ goal: `${"y".repeat(200)}\nsecond line`, path: "README.md" },
			{ conversationId: "coding" },
		);
		expect(result.content[0]?.text).toContain("boom");

		const invoked = logs.find(
			(entry) => entry.level === "trace" && entry.message === "tool invoked",
		);
		const preview = String(detailsOf(invoked).input ?? "");
		expect(preview.length).toBeLessThanOrEqual(120);
		expect(preview).not.toContain("\n");
		expect(preview.endsWith("…")).toBe(true);

		const failed = logs.find((entry) => entry.level === "error" && entry.message === "tool failed");
		expect(failed?.details).toEqual(
			expect.objectContaining({ error: "boom", tool: "self-iteration.analyze" }),
		);
		expect(typeof detailsOf(failed).durationMs).toBe("number");
	});
});
