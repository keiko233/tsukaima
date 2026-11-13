import { describe, expect, test } from "bun:test";
import { LocalToolBridge, createPluginToolsExtension } from "./bridges.ts";
import { DEFAULT_TOOL_POLICY, resolveToolPolicy, resolveToolPolicyAccess } from "./policy.ts";
import type { AuditEntry } from "./host.ts";
import type { PluginTool } from "./types.ts";

function tool(overrides: Partial<PluginTool> = {}): PluginTool {
	return {
		description: "Test tool",
		execute: () => ({ content: [{ text: "ok", type: "text" }] }),
		name: "demo.run",
		parameters: { type: "object" },
		requiredPermissions: ["conversation.read"],
		...overrides,
	};
}

describe("tool policy", () => {
	test("resolves layered permissions, allowlists, capabilities, roles, and task kinds", () => {
		expect(resolveToolPolicy(tool())).toEqual(DEFAULT_TOOL_POLICY);
		expect(
			resolveToolPolicyAccess(tool(), {
				grantedPermissions: ["conversation.read"],
			}),
		).toEqual(expect.objectContaining({ allowed: true, visible: true }));

		expect(resolveToolPolicyAccess(tool(), { grantedPermissions: [] }).reason).toBe(
			"permission_denied:conversation.read",
		);

		const restricted = tool({
			policy: {
				maxConcurrent: 1,
				requiredConversationCapabilities: ["send.image"],
				timeoutMs: 100,
				visibility: "admin",
			},
		});
		expect(
			resolveToolPolicyAccess(restricted, {
				channelCapabilities: [],
				grantedPermissions: ["conversation.read"],
			}).reason,
		).toBe("missing_capability:send.image");
		expect(
			resolveToolPolicyAccess(restricted, {
				channelCapabilities: ["send.image"],
				grantedPermissions: ["conversation.read"],
			}).reason,
		).toBe("admin_required");
		expect(
			resolveToolPolicyAccess(restricted, {
				channelCapabilities: ["send.image"],
				grantedPermissions: ["conversation.read"],
				isAdmin: true,
			}),
		).toEqual(expect.objectContaining({ allowed: true, visible: false }));

		expect(
			resolveToolPolicyAccess(tool({ policy: { allowedTaskKinds: ["coding"] } }), {
				grantedPermissions: ["conversation.read"],
				taskKind: "scheduled",
			}).reason,
		).toBe("task_kind_denied");
		expect(
			resolveToolPolicyAccess(tool({ policy: { destructive: true } }), {
				grantedPermissions: ["conversation.read"],
				taskKind: "proactive",
			}).reason,
		).toBe("destructive_task_kind_denied");
	});

	test("hides non-model tools from the model while keeping explicit denials visible", async () => {
		const audits: AuditEntry[] = [];
		const adminTool = tool({ name: "demo.admin", policy: { visibility: "admin" } });
		const extension = createPluginToolsExtension(
			() => [adminTool],
			async () => ({ ok: true, result: { content: [] } }),
			{ audit: (entry) => void audits.push(entry) },
		);
		expect(extension.tools).toEqual([]);

		const bridge = new LocalToolBridge("demo", []);
		expect(await bridge.invoke("demo.missing", {})).toEqual(
			expect.objectContaining({ ok: false, reason: "unknown_tool" }),
		);
	});

	test("enforces payload size and timeout with audit entries", async () => {
		const audits: AuditEntry[] = [];
		const large = tool({
			name: "demo.large",
			policy: { maxPayloadBytes: 8 },
		});
		const largeExtension = createPluginToolsExtension(
			() => [large],
			async () => ({ ok: true, result: { content: [] } }),
			{ audit: (entry) => void audits.push(entry) },
		);
		const oversized = await largeExtension.tools[0]?.execute(
			{ text: "far too large" },
			{ conversationId: 1 },
			{},
		);
		expect(oversized?.isError).toBe(true);
		expect(audits.at(-1)).toEqual(
			expect.objectContaining({ result: "denied", reason: "payload_too_large:8" }),
		);

		const slow = tool({ name: "demo.slow", policy: { timeoutMs: 20 } });
		const slowExtension = createPluginToolsExtension(
			() => [slow],
			async () => await new Promise(() => {}),
			{ audit: (entry) => void audits.push(entry) },
		);
		const timedOut = await slowExtension.tools[0]?.execute({}, { conversationId: 1 }, {});
		expect(timedOut?.isError).toBe(true);
		expect(timedOut?.output[0]?.text).toContain("timed out");
		expect(audits.at(-1)).toEqual(
			expect.objectContaining({ result: "failed", reason: "timeout:20" }),
		);
	});

	test("serializes invocations with the maxConcurrent semaphore", async () => {
		let active = 0;
		let maxActive = 0;
		const releases: Array<() => void> = [];
		const serialized = tool({
			execute: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => releases.push(resolve));
				active -= 1;
				return { content: [{ text: "done", type: "text" }] };
			},
			name: "demo.serialized",
			policy: { maxConcurrent: 1, timeoutMs: 1_000 },
		});
		const extension = createPluginToolsExtension(
			() => [serialized],
			async (_name, input, context) => ({
				ok: true,
				result: await serialized.execute(input, context ?? {}),
			}),
		);
		const registration = extension.tools[0];
		if (registration === undefined) throw new Error("tool missing");
		const first = registration.execute({}, { conversationId: 1 }, {});
		await Bun.sleep(1);
		const second = registration.execute({}, { conversationId: 1 }, {});
		await Bun.sleep(1);
		expect(maxActive).toBe(1);
		releases.shift()?.();
		await first;
		await Bun.sleep(1);
		releases.shift()?.();
		await second;
		expect(maxActive).toBe(1);
	});

	test("treats explicit empty allowlists as denying all tools while undefined remains unrestricted", () => {
		expect(
			resolveToolPolicyAccess(tool(), {
				conversationAllowedTools: [],
				grantedPermissions: ["conversation.read"],
			}),
		).toEqual(expect.objectContaining({ allowed: false, reason: "conversation_tool_denied" }));
		expect(
			resolveToolPolicyAccess(tool(), {
				grantedPermissions: ["conversation.read"],
				toolAllowlist: [],
			}),
		).toEqual(expect.objectContaining({ allowed: false, reason: "tool_not_allowlisted" }));
	});
});
