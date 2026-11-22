import { mcpPlugin } from "@tsukaima-plugin/mcp";
import { oneBotNapCatPlugin } from "@tsukaima-plugin/onebot-napcat";
import { openAiCompatiblePlugin } from "@tsukaima-plugin/openai-compatible";
import { proactiveSchedulerPlugin } from "@tsukaima-plugin/proactive-scheduler";
import { skillsPlugin } from "@tsukaima-plugin/skills";
import { stickerMemePlugin } from "@tsukaima-plugin/sticker-meme";
import type { TsukaimaPlugin } from "@tsukaima/sdk";
import { memoryPlugin } from "./memory.ts";
import { chatHistoryPlugin } from "./chat-history.ts";

/**
 * Composition root for built-in plugins. This is the only server file that imports plugin
 * packages, so the app core depends on one place instead of scattered plugin code.
 */
export const builtinPlugins: readonly TsukaimaPlugin[] = [
	openAiCompatiblePlugin,
	oneBotNapCatPlugin,
	chatHistoryPlugin,
	memoryPlugin,
	proactiveSchedulerPlugin,
	stickerMemePlugin,
	mcpPlugin,
	skillsPlugin,
];
