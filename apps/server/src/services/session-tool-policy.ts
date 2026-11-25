import { ADMIN_OPS_TOOL_NAMES } from "./admin-ops-tools.ts";
import { ADMIN_RUNTIME_TOOL_NAMES } from "./admin-runtime-tools.ts";
import { ADMIN_SETTINGS_TOOL_NAMES } from "./admin-settings-tools.ts";
import { CHAT_SELF_TUNE_TOOL_NAMES } from "./chat-self-tune-tools.ts";
import { CODING_AGENT_TOOL_NAMES } from "./coding-agent-tools.ts";
import { PROMPT_TOOL_NAMES } from "./prompt-tools.ts";
import {
	IM_WORKSPACE_DELEGATION_TOOL_NAMES,
	WORKSPACE_CODING_TOOL_NAMES,
	WORKSPACE_TOOL_NAMES,
} from "./workspace-tools.ts";
import { SCHEDULE_TOOL_NAMES } from "./schedule-tools.ts";

export interface ComputeOmittedSessionToolsInput {
	/** Whether prompt-mutation tools are available at all (`prompts.agentAccess()`). */
	readonly agentAccess: boolean;
	readonly capabilities: readonly string[];
	/** `host.modelToolNamesNotForSurface("chat")`. */
	readonly chatSurfaceOmitted: readonly string[];
	readonly codingSurfaceOmitted: readonly string[];
	readonly kind: string | undefined;
	readonly proactiveTools: readonly string[];
	/** True when the conversation kind could not be read; forces fail-closed omissions. */
	readonly readFailed?: boolean;
	readonly workspaceDelegationEnabled: boolean;
}

/**
 * Single pure source of truth for a session's omitted model tools.
 *
 * Both `lifecycle.applySessionToolPolicy` (which writes the durable filter) and the WebUI
 * Context Inspector (which previews it) call this helper, so they can never drift. The same
 * fail-closed rules apply: unknown kinds and transient read failures lose host session tools.
 */
export function computeOmittedSessionTools(
	input: ComputeOmittedSessionToolsInput,
): readonly string[] {
	const readFailed = input.readFailed === true;
	const removed = new Set<string>();
	const surface = input.kind === "workspace" ? "coding" : "chat";
	const surfaceOmitted =
		surface === "coding" ? input.codingSurfaceOmitted : input.chatSurfaceOmitted;
	for (const name of surfaceOmitted) removed.add(name);
	const codingAllowed =
		!readFailed && input.kind === "workspace" && input.capabilities.includes("coding");
	if (!codingAllowed) {
		for (const name of CODING_AGENT_TOOL_NAMES) removed.add(name);
		for (const name of WORKSPACE_CODING_TOOL_NAMES) removed.add(name);
	}
	const isImChat = input.kind === "private" || input.kind === "group";
	// Admin terminal/file, settings, and runtime maintenance tools stay discoverable on the
	// admin-capable surfaces (WebUI, workspace, and IM) but every IM execution is additionally
	// admin-gated at runtime. Unknown kinds and transient reads must lose them so a failed lookup
	// cannot widen the surface.
	const adminOpsVisible =
		!readFailed && (input.kind === "webui" || input.kind === "workspace" || isImChat);
	if (!adminOpsVisible) {
		for (const name of ADMIN_OPS_TOOL_NAMES) removed.add(name);
		for (const name of ADMIN_SETTINGS_TOOL_NAMES) removed.add(name);
		for (const name of ADMIN_RUNTIME_TOOL_NAMES) removed.add(name);
	}
	const chatSelfTuneVisible = !readFailed && (input.kind === "webui" || isImChat);
	if (!chatSelfTuneVisible) {
		for (const name of CHAT_SELF_TUNE_TOOL_NAMES) removed.add(name);
	}
	if (input.kind === "webui" && !readFailed) {
		// Coding tools are already omitted above; the branch stays explicit so the surface rule
		// matches the documented role policy.
	} else if (input.kind === "workspace") {
		removed.add("workspace_spawn");
	} else if (isImChat && !readFailed) {
		for (const name of input.proactiveTools) removed.add(name);
		if (input.workspaceDelegationEnabled === true) {
			const delegation = new Set<string>(IM_WORKSPACE_DELEGATION_TOOL_NAMES);
			for (const name of WORKSPACE_TOOL_NAMES) {
				if (!delegation.has(name)) removed.add(name);
			}
		} else {
			for (const name of WORKSPACE_TOOL_NAMES) removed.add(name);
		}
	} else {
		for (const name of WORKSPACE_TOOL_NAMES) removed.add(name);
		for (const name of SCHEDULE_TOOL_NAMES) removed.add(name);
		for (const name of input.proactiveTools) removed.add(name);
	}
	// Prompt tools are discoverable on WebUI, coding workspaces, and IM chats. IM execution is
	// still gated at runtime to a verified administrator inside `prompt-tools.ts`; unknown
	// kinds, failed reads, and disabled agent access lose them entirely.
	const promptVisible =
		!readFailed &&
		input.agentAccess &&
		(input.kind === "webui" ||
			(input.kind === "workspace" && codingAllowed) ||
			input.kind === "private" ||
			input.kind === "group");
	if (!promptVisible) {
		for (const name of PROMPT_TOOL_NAMES) removed.add(name);
	}
	return [...removed];
}
