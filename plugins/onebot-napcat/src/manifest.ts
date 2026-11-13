import { pluginManifestSchema, type PluginManifest } from "@elaina/sdk";

export const ONEBOT_PLUGIN_ID = "onebot-napcat";

const configProperties = {
	accessToken: { type: "string" },
	actionTimeoutMs: { type: "number" },
	adminTitles: { items: { type: "string" }, type: "array" },
	adminUsers: { items: { type: "string" }, type: "array" },
	botAccountId: { type: "string" },
	channelId: { type: "string" },
	deleteGroupFile: { type: "boolean" },
	forwardExpand: {
		anyOf: [
			{ type: "boolean" },
			{
				properties: {
					maxChars: { type: "number" },
					maxNodes: { type: "number" },
					timeoutMs: { type: "number" },
				},
				type: "object",
			},
		],
	},
	groupManage: { type: "boolean" },
	host: { type: "string" },
	mode: { enum: ["forward", "reverse"], type: "string" },
	pendingGraceMs: { type: "number" },
	port: { type: "number" },
	pttToText: {
		anyOf: [
			{ type: "boolean" },
			{
				properties: {
					minIntervalMs: { type: "number" },
					timeoutMs: { type: "number" },
				},
				type: "object",
			},
		],
	},
	rawActionAllowlist: { items: { type: "string" }, type: "array" },
	reconnect: {
		properties: {
			initialDelayMs: { type: "number" },
			jitterRatio: { type: "number" },
			maxDelayMs: { type: "number" },
		},
		type: "object",
	},
	replyAsQuote: { type: "boolean" },
	selfManage: { type: "boolean" },
	sendIntervalMs: { type: "number" },
	splitMaxChars: { type: "number" },
	wsUrl: { type: "string" },
} as const;

/** Plugin id used by the host to address this plugin's configuration. */
export const oneBotNapCatManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		accessToken: "ELAINA_ONEBOT_ACCESS_TOKEN",
		wsUrl: "ELAINA_ONEBOT_WS_URL",
	},
	configSchema: {
		properties: configProperties,
		type: "object",
	},
	hooks: [{ name: "channel.connected" }, { name: "channel.disconnected" }],
	kind: "builtin",
	name: ONEBOT_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"channel.send",
		"channel.interact",
		"channel.manage",
		"channel.raw",
		"conversation.read",
		"audit.write",
	],
	secretKeys: ["accessToken"],
	version: "0.2.0",
});
