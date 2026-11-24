import type { ToolInvocationContext } from "@tsukaima/sdk";

/** Fail-closed runtime gate shared by MCP management and admin-scoped MCP tools. */
export function isAdminMcpCaller(invocation: ToolInvocationContext): boolean {
	const kind = invocation.chatKind;
	if (kind === "webui" || kind === "workspace") return true;
	if ((kind === "private" || kind === "group") && invocation.isAdmin === true) {
		return invocation.senderPlatformId !== undefined;
	}
	return false;
}

/** Audit-safe caller metadata for MCP authorization decisions. */
export function mcpCallerIdentity(invocation: ToolInvocationContext): Record<string, unknown> {
	return {
		...(invocation.chatKind === undefined ? {} : { chatKind: invocation.chatKind }),
		...(invocation.conversationId === undefined
			? {}
			: { conversationId: invocation.conversationId }),
		...(invocation.senderPlatformId === undefined
			? {}
			: { senderPlatformId: invocation.senderPlatformId }),
		...(invocation.isAdmin === undefined ? {} : { isAdmin: invocation.isAdmin }),
	};
}
