import type { ConversationPolicy } from "@tsukaima/contracts";
import type { ResolvedImCallerContext } from "./im-caller-context.ts";
import {
	IM_WORKSPACE_DELEGATION_TOOL_NAMES,
	SANDBOX_WORKSPACE_TOOL_NAMES,
} from "./workspace-tools.ts";

export interface WorkspaceCallerAuthorization {
	readonly allowed: boolean;
	readonly callerId?: string;
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly isAdmin?: boolean;
	readonly platformConversationId?: string;
	readonly reason?: string;
	readonly sessionId?: string;
}

export const SANDBOX_MAX_ACTIVE_PER_PARENT = 5;

const IM_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(IM_WORKSPACE_DELEGATION_TOOL_NAMES);

/**
 * Fail-closed host-tool authorization shared by the workspace tool extension.
 *
 * Only `webui` and `workspace` conversations run without an IM delegation check. `private` and
 * `group` need both the conversation-level delegation switch and a trusted admin caller. Any
 * other or unknown kind (including a transient DB failure that leaves `chatKind` undefined)
 * is denied instead of falling through to a permissive branch.
 */
export function authorizeWorkspaceToolCall(input: {
	readonly caller: ResolvedImCallerContext;
	readonly delegationToolNames?: ReadonlySet<string>;
	readonly policy?: Pick<ConversationPolicy, "workspaceDelegationEnabled"> | undefined;
	readonly toolName: string;
}): WorkspaceCallerAuthorization {
	const { caller, toolName } = input;
	const chatKind = caller.chatKind;
	const base: Omit<WorkspaceCallerAuthorization, "allowed"> = {
		...(caller.senderPlatformId === undefined ? {} : { callerId: caller.senderPlatformId }),
		...(caller.channelId === undefined ? {} : { channelId: caller.channelId }),
		...(chatKind === undefined ? {} : { chatKind }),
		...(caller.isAdmin === undefined ? {} : { isAdmin: caller.isAdmin }),
		...(caller.platformConversationId === undefined
			? {}
			: { platformConversationId: caller.platformConversationId }),
		...(caller.domainConversationId === undefined
			? {}
			: { sessionId: caller.domainConversationId }),
	};
	if (toolName === "workspace_git_identity" && chatKind !== "workspace") {
		return { ...base, allowed: false, reason: "workspace_coding_tool_denied" };
	}
	// A workspace turn edits an existing checkout; it never spawns another workspace. The
	// durable tool filter already omits it, and this runtime check closes the bypass.
	if (toolName === "workspace_spawn" && chatKind === "workspace") {
		return { ...base, allowed: false, reason: "workspace_spawn_not_permitted" };
	}
	// Sandbox workspaces are deliberately a smaller execution surface than coding workspaces.
	// The durable filter already removes this family; the runtime check closes direct calls.
	if (chatKind === "workspace" && caller.workspaceKind === "sandbox") {
		return { ...base, allowed: false, reason: "sandbox_workspace_tool_denied" };
	}
	if (chatKind === "webui" || chatKind === "workspace") {
		return { ...base, allowed: true };
	}
	if (chatKind !== "private" && chatKind !== "group") {
		return { ...base, allowed: false, reason: "disallowed_chat_kind" };
	}
	const delegationTools = input.delegationToolNames ?? IM_DELEGATION_TOOL_NAMES;
	if (!delegationTools.has(toolName)) {
		return { ...base, allowed: false, reason: "im_tool_not_permitted" };
	}
	if (input.policy === undefined) {
		return { ...base, allowed: false, reason: "policy_unavailable" };
	}
	if (caller.domainConversationId === undefined) {
		return { ...base, allowed: false, reason: "session_not_found" };
	}
	if (input.policy.workspaceDelegationEnabled !== true) {
		return { ...base, allowed: false, reason: "workspace_delegation_disabled" };
	}
	if (caller.isAdmin !== true || caller.senderPlatformId === undefined) {
		return { ...base, allowed: false, reason: "admin_required" };
	}
	return { ...base, allowed: true };
}

/**
 * Runtime gate for the sandbox tool family. This is intentionally separate from the admin
 * workspace delegation check: ordinary private/group participants may spawn a sandbox when the
 * conversation policy allows it, but a sandbox is never a path to coding, admin, DB, or restart
 * tools. Ownership and parent-session checks happen in the workspace service against the target
 * row; this function only decides whether the caller may attempt the family at all.
 */
export function authorizeSandboxToolCall(input: {
	readonly caller: ResolvedImCallerContext;
	readonly policy?: Pick<ConversationPolicy, "sandboxWorkspaceEnabled"> | undefined;
	readonly toolName: string;
}): WorkspaceCallerAuthorization {
	const { caller, toolName } = input;
	const chatKind = caller.chatKind;
	const base: Omit<WorkspaceCallerAuthorization, "allowed"> = {
		...(caller.senderPlatformId === undefined ? {} : { callerId: caller.senderPlatformId }),
		...(caller.channelId === undefined ? {} : { channelId: caller.channelId }),
		...(chatKind === undefined ? {} : { chatKind }),
		...(caller.isAdmin === undefined ? {} : { isAdmin: caller.isAdmin }),
		...(caller.platformConversationId === undefined
			? {}
			: { platformConversationId: caller.platformConversationId }),
		...(caller.domainConversationId === undefined
			? {}
			: { sessionId: caller.domainConversationId }),
	};
	if (!(SANDBOX_WORKSPACE_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return { ...base, allowed: false, reason: "sandbox_tool_not_permitted" };
	}
	if (chatKind === "workspace") {
		return { ...base, allowed: false, reason: "sandbox_spawn_not_permitted" };
	}
	if (chatKind !== "webui" && chatKind !== "private" && chatKind !== "group") {
		return { ...base, allowed: false, reason: "disallowed_chat_kind" };
	}
	if (input.policy === undefined) {
		return { ...base, allowed: false, reason: "policy_unavailable" };
	}
	if (input.policy.sandboxWorkspaceEnabled !== true) {
		return { ...base, allowed: false, reason: "sandbox_workspace_disabled" };
	}
	if (caller.domainConversationId === undefined) {
		return { ...base, allowed: false, reason: "session_not_found" };
	}
	if (
		(chatKind === "private" || chatKind === "group") &&
		(caller.senderPlatformId === undefined || caller.senderPlatformId.trim().length === 0)
	) {
		return { ...base, allowed: false, reason: "sender_required" };
	}
	return { ...base, allowed: true };
}
