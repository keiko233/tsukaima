import {
	ONEBOT_DEFAULT_CHANNEL_ID,
	ONEBOT_PLUGIN_ID,
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	oneBotNapCatPlugin,
} from "@elaina-plugin/onebot-napcat";
import type { ElainaPlugin } from "@elaina/sdk";

/**
 * Composition root for built-in plugins. This is the only server file that imports plugin
 * packages, so the app core depends on one place instead of scattered plugin code.
 */
export const builtinPlugins: readonly ElainaPlugin[] = [oneBotNapCatPlugin];

export { ONEBOT_DEFAULT_CHANNEL_ID, ONEBOT_PLUGIN_ID, ONEBOT_TRANSPORT_FACTORY_BINDING };
