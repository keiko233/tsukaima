import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const ONEBOT_PLUGIN_ID = "onebot-napcat";

/**
 * Config schema for the plugin settings panel.
 *
 * Every field carries a `titleKey`/`descriptionKey` pair that the panel resolves through the
 * plugin's own message catalog (`messages/*.json`). The English `title`/`description` stay as
 * the fallback for hosts that render the schema without the plugin's translator.
 */
const configProperties = {
	accessToken: {
		description:
			"Token NapCat requires for this connection. Falls back to TSUKAIMA_ONEBOT_ACCESS_TOKEN when empty.",
		descriptionKey: "config_access_token_hint",
		title: "Access token",
		titleKey: "config_access_token",
		type: "string",
	},
	actionTimeoutMs: {
		description: "How long one NapCat API call may take before it fails. Defaults to 5000.",
		descriptionKey: "config_action_timeout_hint",
		title: "Action timeout (ms)",
		titleKey: "config_action_timeout",
		type: "number",
	},
	adminTitles: {
		description:
			"Group member titles that count as administrators. Reserved for the legacy configuration; the runtime does not read it yet.",
		descriptionKey: "config_admin_titles_hint",
		items: { type: "string" },
		title: "Admin group titles",
		titleKey: "config_admin_titles",
		type: "array",
	},
	adminUsers: {
		description:
			"OneBot user ids allowed to run destructive actions such as group management and raw calls.",
		descriptionKey: "config_admin_users_hint",
		items: { type: "string" },
		title: "Admin user ids",
		titleKey: "config_admin_users",
		type: "array",
	},
	botAccountId: {
		description:
			"The bot's own account id, used to recognise its own messages. Defaults to tsukaima-server.",
		descriptionKey: "config_bot_account_hint",
		title: "Bot account id",
		titleKey: "config_bot_account",
		type: "string",
	},
	channelId: {
		description:
			"Identifier for this channel instance. Incoming events and chat objects are stored under it; defaults to onebot.",
		descriptionKey: "config_channel_id_hint",
		title: "Channel id",
		titleKey: "config_channel_id",
		type: "string",
	},
	deleteGroupFile: {
		description: "Allow administrators to delete files from NapCat group storage.",
		descriptionKey: "config_delete_group_file_hint",
		title: "Allow deleting group files",
		titleKey: "config_delete_group_file",
		type: "boolean",
	},
	forwardExpand: {
		// Expanded by default: the channel only skips expansion when this is explicitly false.
		default: true,
		anyOf: [
			{ type: "boolean" },
			{
				properties: {
					maxChars: {
						description: "Character budget for one expanded bundle.",
						descriptionKey: "config_forward_max_chars_hint",
						title: "Max characters",
						titleKey: "config_forward_max_chars",
						type: "number",
					},
					maxNodes: {
						description: "Maximum number of nested messages to expand.",
						descriptionKey: "config_forward_max_nodes_hint",
						title: "Max nodes",
						titleKey: "config_forward_max_nodes",
						type: "number",
					},
					timeoutMs: {
						description: "How long fetching one forwarded bundle may take.",
						descriptionKey: "config_forward_timeout_hint",
						title: "Timeout (ms)",
						titleKey: "config_forward_timeout",
						type: "number",
					},
				},
				type: "object",
			},
		],
		description:
			"Download and expand forwarded message bundles before the model sees them. Enable it, or switch it off to keep only the summary node.",
		descriptionKey: "config_forward_expand_hint",
		title: "Expand forwarded chats",
		titleKey: "config_forward_expand",
	},
	groupManage: {
		description:
			"Allow administrators to run group actions: mute, kick, rename, card, title, and whole-group mute.",
		descriptionKey: "config_group_manage_hint",
		title: "Allow group management",
		titleKey: "config_group_manage",
		type: "boolean",
	},
	host: {
		description:
			"Interface the reverse WebSocket server binds to. Reverse mode only; defaults to 127.0.0.1.",
		descriptionKey: "config_host_hint",
		title: "Reverse listen host",
		titleKey: "config_host",
		type: "string",
	},
	mode: {
		default: "forward",
		description: "Forward: Tsukaima dials NapCat. Reverse: NapCat dials Tsukaima. Defaults to forward.",
		descriptionKey: "config_mode_hint",
		enum: ["forward", "reverse"],
		enumLabels: {
			forward: "config_mode_forward",
			reverse: "config_mode_reverse",
		},
		title: "Connection mode",
		titleKey: "config_mode",
		type: "string",
	},
	pendingGraceMs: {
		description:
			"Grace period in milliseconds before an unconfirmed delivery is reconciled. Defaults to 15000.",
		descriptionKey: "config_pending_grace_hint",
		title: "Pending delivery grace (ms)",
		titleKey: "config_pending_grace",
		type: "number",
	},
	port: {
		description:
			"Port the reverse WebSocket server listens on. Reverse mode only; defaults to 3002.",
		descriptionKey: "config_port_hint",
		title: "Reverse listen port",
		titleKey: "config_port",
		type: "number",
	},
	pttToText: {
		// Transcribed by default: the channel only skips voice transcription on `false`.
		default: true,
		anyOf: [
			{ type: "boolean" },
			{
				properties: {
					minIntervalMs: {
						description: "Minimum gap between two transcriptions.",
						descriptionKey: "config_ptt_min_interval_hint",
						title: "Min interval (ms)",
						titleKey: "config_ptt_min_interval",
						type: "number",
					},
					timeoutMs: {
						description: "How long one transcription may take.",
						descriptionKey: "config_ptt_timeout_hint",
						title: "Timeout (ms)",
						titleKey: "config_ptt_timeout",
						type: "number",
					},
				},
				type: "object",
			},
		],
		description:
			"Turn voice messages into text when a transcriber is available. Enable it, or switch it off to ignore voice content.",
		descriptionKey: "config_ptt_hint",
		title: "Transcribe voice messages",
		titleKey: "config_ptt",
	},
	rawActionAllowlist: {
		description:
			"Raw OneBot action names the agent may call through rawAction. Empty disables raw calls entirely.",
		descriptionKey: "config_raw_allowlist_hint",
		items: { type: "string" },
		title: "Raw action allowlist",
		titleKey: "config_raw_allowlist",
		type: "array",
	},
	reconnect: {
		description: "Exponential backoff used while NapCat is unreachable.",
		descriptionKey: "config_reconnect_hint",
		properties: {
			initialDelayMs: {
				description: "First retry delay. Defaults to 1000.",
				descriptionKey: "config_reconnect_initial_hint",
				title: "Initial delay (ms)",
				titleKey: "config_reconnect_initial",
				type: "number",
			},
			jitterRatio: {
				description: "Random spread applied to each delay, between 0 and 1. Defaults to 0.1.",
				descriptionKey: "config_reconnect_jitter_hint",
				title: "Jitter ratio",
				titleKey: "config_reconnect_jitter",
				type: "number",
			},
			maxDelayMs: {
				description: "Upper bound for the retry delay. Defaults to 30000.",
				descriptionKey: "config_reconnect_max_hint",
				title: "Max delay (ms)",
				titleKey: "config_reconnect_max",
				type: "number",
			},
		},
		title: "Reconnect backoff",
		titleKey: "config_reconnect",
		type: "object",
	},
	replyAsQuote: {
		description: "Quote the message being answered instead of sending a standalone reply.",
		descriptionKey: "config_reply_as_quote_hint",
		title: "Reply with a quote",
		titleKey: "config_reply_as_quote",
		type: "boolean",
	},
	selfManage: {
		description:
			"Allow administrators to change the bot account itself: avatar, profile, long nickname, online status.",
		descriptionKey: "config_self_manage_hint",
		title: "Allow bot account changes",
		titleKey: "config_self_manage",
		type: "boolean",
	},
	sendIntervalMs: {
		description: "Delay in milliseconds between consecutive reply chunks. Defaults to 400.",
		descriptionKey: "config_send_interval_hint",
		title: "Delay between chunks (ms)",
		titleKey: "config_send_interval",
		type: "number",
	},
	splitMaxChars: {
		description: "Maximum characters per reply chunk; longer replies are split. Defaults to 2000.",
		descriptionKey: "config_split_max_chars_hint",
		title: "Max characters per chunk",
		titleKey: "config_split_max_chars",
		type: "number",
	},
	wsUrl: {
		description:
			"NapCat forward WebSocket address, for example ws://127.0.0.1:3001. Falls back to TSUKAIMA_ONEBOT_WS_URL when empty.",
		descriptionKey: "config_ws_url_hint",
		title: "WebSocket URL",
		titleKey: "config_ws_url",
		type: "string",
	},
} as const;

/** Plugin id used by the host to address this plugin's configuration. */
export const oneBotNapCatManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		accessToken: "TSUKAIMA_ONEBOT_ACCESS_TOKEN",
		wsUrl: "TSUKAIMA_ONEBOT_WS_URL",
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
		"media.read",
	],
	secretKeys: ["accessToken"],
	version: "0.2.0",
});
