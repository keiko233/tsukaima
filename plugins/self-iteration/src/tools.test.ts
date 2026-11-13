import { describe, expect, test } from "bun:test";
import {
	LocalToolBridge,
	type PluginContext,
	type PluginTool,
	type ToolInvocationContext,
} from "@elaina/sdk";
import { registerSelfIterationTools } from "./tools.ts";
import type { SelfIterationService } from "./service.ts";

function registeredTools(): readonly PluginTool[] {
	const tools: PluginTool[] = [];
	registerSelfIterationTools(
		{
			audit: { record: async () => undefined },
			logger: { error: () => undefined, info: () => undefined, warn: () => undefined },
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
});
