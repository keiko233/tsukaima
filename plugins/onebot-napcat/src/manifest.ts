import { pluginManifestSchema, type PluginManifest } from "@elaina/sdk";

export const ONEBOT_PLUGIN_ID = "onebot-napcat";

/** Plugin id used by the host to address this plugin's configuration. */
export const oneBotNapCatManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		accessToken: "ELAINA_ONEBOT_ACCESS_TOKEN",
		wsUrl: "ELAINA_ONEBOT_WS_URL",
	},
	configSchema: {
		properties: {
			accessToken: { type: "string" },
			botAccountId: { type: "string" },
			channelId: { type: "string" },
			reconnect: {
				properties: {
					initialDelayMs: { type: "number" },
					jitterRatio: { type: "number" },
					maxDelayMs: { type: "number" },
				},
				type: "object",
			},
			wsUrl: { type: "string" },
		},
		type: "object",
	},
	hooks: [{ name: "channel.connected" }, { name: "channel.disconnected" }],
	kind: "builtin",
	name: ONEBOT_PLUGIN_ID,
	permissions: ["ui.panel", "channel.send", "channel.interact", "conversation.read", "audit.write"],
	secretKeys: ["accessToken"],
	version: "0.1.0",
});
