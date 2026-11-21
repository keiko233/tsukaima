import { describe, expect, test } from "bun:test";
import { computeOmittedSessionTools } from "../src/services/session-tool-policy.ts";
import { CODING_AGENT_TOOL_NAMES } from "../src/services/coding-agent-tools.ts";
import { PROMPT_TOOL_NAMES } from "../src/services/prompt-tools.ts";
import { SCHEDULE_TOOL_NAMES } from "../src/services/schedule-tools.ts";
import {
	IM_WORKSPACE_DELEGATION_TOOL_NAMES,
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
			for (const name of WORKSPACE_TOOL_NAMES) expect(withoutDelegation.has(name)).toBe(true);
			for (const name of proactiveTools) expect(withoutDelegation.has(name)).toBe(true);
			for (const name of SCHEDULE_TOOL_NAMES) expect(withoutDelegation.has(name)).toBe(false);
			for (const name of PROMPT_TOOL_NAMES) expect(withoutDelegation.has(name)).toBe(true);

			const withDelegation = omitted({ kind, workspaceDelegationEnabled: true });
			const delegationNames = new Set<string>(IM_WORKSPACE_DELEGATION_TOOL_NAMES);
			for (const name of WORKSPACE_TOOL_NAMES) {
				expect(withDelegation.has(name)).toBe(!delegationNames.has(name));
			}
			for (const name of proactiveTools) expect(withDelegation.has(name)).toBe(true);
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
