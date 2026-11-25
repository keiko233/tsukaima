import { describe, expect, test } from "bun:test";
import { computeOmittedSessionTools } from "../src/services/session-tool-policy.ts";
import { ADMIN_OPS_TOOL_NAMES } from "../src/services/admin-ops-tools.ts";
import { ADMIN_RUNTIME_TOOL_NAMES } from "../src/services/admin-runtime-tools.ts";
import { ADMIN_SETTINGS_TOOL_NAMES } from "../src/services/admin-settings-tools.ts";
import { CODING_AGENT_TOOL_NAMES } from "../src/services/coding-agent-tools.ts";
import { PROMPT_TOOL_NAMES } from "../src/services/prompt-tools.ts";
import { SCHEDULE_TOOL_NAMES } from "../src/services/schedule-tools.ts";
import {
	IM_WORKSPACE_DELEGATION_TOOL_NAMES,
	SANDBOX_WORKSPACE_TOOL_NAMES,
	WORKSPACE_CODING_TOOL_NAMES,
	WORKSPACE_TOOL_NAMES,
} from "../src/services/workspace-tools.ts";

const proactiveTools = ["proactive-scheduler.schedule"];
const chatSurfaceOmitted = ["sticker-meme.codingOnly"];
const codingSurfaceOmitted = ["memory.recall"];
const base = {
	agentAccess: true,
	chatSurfaceOmitted,
	codingSurfaceOmitted,
	proactiveTools,
	readFailed: false,
};

const omitted = (input: Partial<Parameters<typeof computeOmittedSessionTools>[0]>) =>
	new Set(
		computeOmittedSessionTools({
			...base,
			capabilities: [],
			kind: undefined,
			workspaceDelegationEnabled: false,
			sandboxWorkspaceEnabled: true,
			...input,
		}),
	);

describe("computeOmittedSessionTools parity", () => {
	test("webui keeps host session tools and prompt tools but never coding tools", () => {
		const tools = omitted({ kind: "webui" });
		for (const name of [...CODING_AGENT_TOOL_NAMES, ...WORKSPACE_CODING_TOOL_NAMES]) {
			expect(tools.has(name)).toBe(true);
		}
		for (const name of ["workspace_spawn", ...SCHEDULE_TOOL_NAMES, ...proactiveTools]) {
			expect(tools.has(name)).toBe(false);
		}
		for (const name of PROMPT_TOOL_NAMES) expect(tools.has(name)).toBe(false);
		expect(tools.has("sticker-meme.codingOnly")).toBe(true);
		expect(tools.has("memory.recall")).toBe(false);
	});

	test("private and group chats keep unified schedules and gate delegation tools", () => {
		for (const kind of ["private", "group"] as const) {
			const withoutDelegation = omitted({ kind });
			const sandboxNames = new Set<string>(SANDBOX_WORKSPACE_TOOL_NAMES);
			for (const name of WORKSPACE_TOOL_NAMES) {
				expect(withoutDelegation.has(name)).toBe(!sandboxNames.has(name));
			}
			for (const name of proactiveTools) expect(withoutDelegation.has(name)).toBe(true);
			for (const name of SCHEDULE_TOOL_NAMES) expect(withoutDelegation.has(name)).toBe(false);
			for (const name of PROMPT_TOOL_NAMES) expect(withoutDelegation.has(name)).toBe(false);

			const withDelegation = omitted({ kind, workspaceDelegationEnabled: true });
			const delegationNames = new Set<string>(IM_WORKSPACE_DELEGATION_TOOL_NAMES);
			for (const name of WORKSPACE_TOOL_NAMES) {
				expect(withDelegation.has(name)).toBe(
					!delegationNames.has(name) && !sandboxNames.has(name),
				);
			}
			for (const name of proactiveTools) expect(withDelegation.has(name)).toBe(true);
		}
	});

	test("sandbox tools follow the sandbox policy and never appear on workspace/task/plugin", () => {
		for (const kind of ["webui", "private", "group"] as const) {
			const enabled = omitted({ kind });
			for (const name of SANDBOX_WORKSPACE_TOOL_NAMES) expect(enabled.has(name)).toBe(false);
			const disabled = omitted({ kind, sandboxWorkspaceEnabled: false });
			for (const name of SANDBOX_WORKSPACE_TOOL_NAMES) expect(disabled.has(name)).toBe(true);
		}
		for (const input of [
			{ kind: "workspace", capabilities: ["coding"] } as const,
			{ kind: "workspace", capabilities: ["sandbox"] } as const,
			{ kind: "task" } as const,
			{ kind: "plugin" } as const,
			{ kind: undefined } as const,
			{ kind: "private", readFailed: true } as const,
		]) {
			const tools = omitted(input);
			for (const name of SANDBOX_WORKSPACE_TOOL_NAMES) expect(tools.has(name)).toBe(true);
		}
	});

	test("sandbox workspace rows lose admin and prompt tools even without coding", () => {
		const sandbox = omitted({ capabilities: ["sandbox"], kind: "workspace" });
		for (const name of [
			...ADMIN_OPS_TOOL_NAMES,
			...ADMIN_RUNTIME_TOOL_NAMES,
			...ADMIN_SETTINGS_TOOL_NAMES,
			...PROMPT_TOOL_NAMES,
			...CODING_AGENT_TOOL_NAMES,
			...WORKSPACE_CODING_TOOL_NAMES,
		]) {
			expect(sandbox.has(name)).toBe(true);
		}
	});

	test("workspace requires coding capability and omits workspace_spawn only", () => {
		const withoutCoding = omitted({ capabilities: [], kind: "workspace" });
		for (const name of [...CODING_AGENT_TOOL_NAMES, ...WORKSPACE_CODING_TOOL_NAMES]) {
			expect(withoutCoding.has(name)).toBe(true);
		}
		expect(withoutCoding.has("workspace_spawn")).toBe(true);
		expect(withoutCoding.has("memory.recall")).toBe(true);
		expect(withoutCoding.has("sticker-meme.codingOnly")).toBe(false);

		const withCoding = omitted({ capabilities: ["coding"], kind: "workspace" });
		for (const name of [...CODING_AGENT_TOOL_NAMES, ...WORKSPACE_CODING_TOOL_NAMES]) {
			expect(withCoding.has(name)).toBe(false);
		}
		expect(withCoding.has("workspace_spawn")).toBe(true);
		for (const name of SCHEDULE_TOOL_NAMES) expect(withCoding.has(name)).toBe(false);
	});

	test("admin terminal, file, settings, and runtime tools stay on admin-capable surfaces and fail closed elsewhere", () => {
		const adminTools = [
			...ADMIN_OPS_TOOL_NAMES,
			...ADMIN_SETTINGS_TOOL_NAMES,
			...ADMIN_RUNTIME_TOOL_NAMES,
		];
		for (const input of [
			{ kind: "webui" } as const,
			{ capabilities: ["coding"], kind: "workspace" } as const,
			{ kind: "private" } as const,
			{ kind: "group" } as const,
		]) {
			const tools = omitted(input);
			for (const name of adminTools) expect(tools.has(name)).toBe(false);
		}
		const sandboxWorkspace = omitted({ capabilities: ["sandbox"], kind: "workspace" });
		for (const name of adminTools) expect(sandboxWorkspace.has(name)).toBe(true);
		for (const input of [
			{ kind: "task" } as const,
			{ kind: "plugin" } as const,
			{ kind: undefined } as const,
			{ kind: "webui", readFailed: true } as const,
		]) {
			const tools = omitted(input);
			for (const name of adminTools) expect(tools.has(name)).toBe(true);
		}
	});

	test("prompt tools stay discoverable only on admin-capable chats with agent access", () => {
		for (const input of [
			{ capabilities: [], kind: "webui" } as const,
			{ capabilities: ["coding"], kind: "workspace" } as const,
			{ capabilities: [], kind: "private" } as const,
			{ capabilities: [], kind: "group" } as const,
		]) {
			const tools = omitted(input);
			for (const name of PROMPT_TOOL_NAMES) expect(tools.has(name)).toBe(false);
		}
		const sandboxWorkspace = omitted({ capabilities: ["sandbox"], kind: "workspace" });
		for (const name of PROMPT_TOOL_NAMES) expect(sandboxWorkspace.has(name)).toBe(true);
		for (const input of [
			{ kind: "workspace", capabilities: ["coding"], agentAccess: false } as const,
			{ kind: "private", readFailed: true } as const,
			{ kind: "group", readFailed: true } as const,
			{ kind: "workspace", readFailed: true } as const,
			{ kind: "task" } as const,
			{ kind: "plugin" } as const,
			{ kind: undefined } as const,
		]) {
			const tools = omitted(input);
			for (const name of PROMPT_TOOL_NAMES) expect(tools.has(name)).toBe(true);
		}
	});

	test("unknown kinds and transient read failures lose host session tools", () => {
		for (const input of [
			{ kind: "task" } as const,
			{ kind: "plugin" } as const,
			{ kind: undefined } as const,
			{ kind: "group", readFailed: true } as const,
		]) {
			const tools = omitted(input);
			for (const name of [...WORKSPACE_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...proactiveTools]) {
				expect(tools.has(name)).toBe(true);
			}
			for (const name of PROMPT_TOOL_NAMES) expect(tools.has(name)).toBe(true);
		}
	});
});
