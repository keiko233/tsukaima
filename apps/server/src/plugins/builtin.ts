import {
	ONEBOT_DEFAULT_CHANNEL_ID,
	ONEBOT_PLUGIN_ID,
	oneBotNapCatPlugin,
} from "@tsukaima-plugin/onebot-napcat";
import type { TsukaimaPlugin } from "@tsukaima/sdk";

/**
 * Composition root for built-in plugins. This is the only server file that imports plugin
 * packages, so the app core depends on one place instead of scattered plugin code.
 */
export const builtinPlugins: readonly TsukaimaPlugin[] = [oneBotNapCatPlugin];

export { ONEBOT_DEFAULT_CHANNEL_ID, ONEBOT_PLUGIN_ID };
