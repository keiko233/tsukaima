import { resolveToolName } from "@tsukaima/sdk";

/**
 * Canonical channel tools that post chat text themselves. Only real channel chat-send tools
 * belong here: a broad suffix match would also treat `workspace_send` or `sticker-meme_send`
 * as direct sends and wrongly suppress the final answer.
 */
const CHANNEL_CHAT_SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
	"onebot-napcat.send",
	"onebot-napcat.sendForward",
	"onebot-napcat.send_message",
]);

/** Resolve clean/hashed provider-safe names and match only the channel chat-send family. */
export function isDirectSendToolName(toolName: string): boolean {
	const canonical = resolveToolName(toolName) ?? toolName.trim();
	return CHANNEL_CHAT_SEND_TOOL_NAMES.has(canonical);
}
