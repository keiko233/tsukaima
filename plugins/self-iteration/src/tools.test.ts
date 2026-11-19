import { describe, expect, test } from "bun:test";
import {
	LocalToolBridge,
	type PluginContext,
	type PluginLogger,
	type PluginTool,
	type ToolInvocationContext,
} from "@tsukaima/sdk";
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
				boundTaskId: async () => "task-bound",
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
				boundTaskId: async () => "task-bound",
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

	test("offers the core Workspace tools upfront and defers upstream", () => {
		const eager = new Set(
			registeredTools()
				.filter((tool) => tool.policy?.lazy === false)
				.map((tool) => tool.name),
		);
		expect([...eager].toSorted()).toEqual([
			"self-iteration.analyze",
			"self-iteration.build",
			"self-iteration.diff",
			"self-iteration.edit",
			"self-iteration.propose",
			"self-iteration.status",
			"self-iteration.test",
			"self-iteration.worktree",
		]);
		expect(
			registeredTools().find((tool) => tool.name === "self-iteration.upstream")?.policy?.lazy,
		).toBe(true);
	});

	test("model calls take the bound task and ignore goal-driven task creation", async () => {
		const seen: unknown[] = [];
		const tools: PluginTool[] = [];
		registerSelfIterationTools(
			{
				...contextFor([]),
				tools: { register: (tool: PluginTool) => void tools.push(tool) },
			} as unknown as PluginContext,
			{
				boundTaskId: async (input: { conversationId?: string; requestedTaskId?: string }) => {
					seen.push(input);
					return "task-bound";
				},
				edit: async (input: unknown) => {
					seen.push(input);
					return { path: "src/a.ts" };
				},
			} as unknown as SelfIterationService,
		);
		const edit = tools.find((entry) => entry.name === "self-iteration.edit");
		if (edit === undefined) throw new Error("edit tool missing");
		await edit.execute(
			{ content: "x", create: true, goal: "Create a task", path: "src/a.ts" },
			{ conversationId: "durable-conversation" },
		);
		expect(seen[0]).toEqual({
			conversationId: "durable-conversation",
			tool: "self-iteration.edit",
		});
		expect(seen[1]).toEqual(
			expect.objectContaining({
				sourceConversationId: "durable-conversation",
				taskId: "task-bound",
			}),
		);
		expect(seen[1]).not.toHaveProperty("goal");
	});
});
