import type { TsukaimaPlugin, PluginContext, ToolResult } from "@tsukaima/sdk";
import {
	ONEBOT_ACTION_METHODS,
	ONEBOT_ACTION_PERMISSIONS,
	OneBotActionFacade,
	type OneBotActionActor,
	type OneBotActionMethod,
} from "./actions.ts";
import { OneBotChannelAdapter } from "./adapter.ts";
import { oneBotPluginConfigSchema, resolveOneBotState, type OneBotPluginConfig } from "./config.ts";
import { oneBotNapCatManifest } from "./manifest.ts";
import type {
	OneBotAudioTranscribe,
	OneBotConfig,
	OneBotReverseServerFactory,
	OneBotTransportFactory,
	OneBotVideoFrameExtractor,
} from "./protocol/index.ts";

export { ONEBOT_CHANNEL_KIND, OneBotChannelAdapter } from "./adapter.ts";
export { ONEBOT_ACTION_METHODS, OneBotActionFacade } from "./actions.ts";
export {
	ONEBOT_DEFAULT_CHANNEL_ID,
	ONEBOT_DEFAULT_REVERSE_HOST,
	ONEBOT_DEFAULT_REVERSE_PORT,
	oneBotPluginConfigSchema,
	resolveOneBotState,
} from "./config.ts";
export { ONEBOT_PLUGIN_ID, oneBotNapCatManifest } from "./manifest.ts";
export { OneBotChannel, normalizeOneBotEvent, normalizeOneBotRequest } from "./protocol/index.ts";
export type {
	OneBotChannelDiagnostics,
	OneBotConfig,
	OneBotEvent,
	OneBotRequestEvent,
	OneBotReverseServerFactory,
	OneBotTransport,
	OneBotTransportEvents,
	OneBotTransportFactory,
} from "./protocol/index.ts";

/** Host bindings that inject transports, STT, or media extraction (tests and embedders). */
export const ONEBOT_TRANSPORT_FACTORY_BINDING = "onebot.transportFactory";
export const ONEBOT_REVERSE_SERVER_FACTORY_BINDING = "onebot.reverseServerFactory";
export const ONEBOT_AUDIO_TRANSCRIBE_BINDING = "onebot.audioTranscribe";
export const ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING = "onebot.videoFrameExtractor";

interface OneBotRuntime {
	adapter?: OneBotChannelAdapter | undefined;
	dispose?: (() => void) | undefined;
	facade?: OneBotActionFacade | undefined;
	settings: OneBotPluginConfig;
	unsubscribe?: (() => void) | undefined;
	/** Restart key: changes exactly when the live connection must be replaced. */
	key?: string | undefined;
	lastEventAtMs?: number | undefined;
}

const runtimes = new WeakMap<PluginContext, OneBotRuntime>();

const TOOL_DESCRIPTIONS: Record<OneBotActionMethod, string> = {
	deleteGroupFile: "Delete a NapCat group file (disabled by default; admin only).",
	deleteMessage: "Delete one platform message.",
	fetchGroupFile: "Resolve a NapCat group file URL by file id.",
	groupBan: "Mute one group member for a duration (admin only).",
	groupKick: "Remove one member from a group (admin only).",
	groupLeave: "Leave or dismiss a group (admin only).",
	groupSetAdmin: "Grant or revoke group administrator (admin only).",
	groupSetCard: "Set a group member card name (admin only).",
	groupSetName: "Rename a group (admin only).",
	groupSetSpecialTitle: "Set a group member special title (admin only).",
	groupWholeBan: "Enable or disable whole-group mute (admin only).",
	listGroupFiles: "List NapCat group files.",
	lookupMessage: "Look up one platform message by id.",
	markRead: "Mark a platform message as read.",
	poke: "Poke a user or group member.",
	rawAction: "Invoke an allowlisted raw OneBot action (disabled by default).",
	react: "Add or remove an emoji reaction on a message.",
	readHistory: "Read bounded platform history for a private chat or group.",
	send: "Send text/media parts to a private chat or group.",
	sendForward: "Send a combined/forward message bundle.",
	setAvatar: "Change the bot account avatar (disabled by default; admin only).",
	setLongnick: "Change the bot account long nickname (disabled by default; admin only).",
	setOnlineStatus: "Change the bot account online status (disabled by default; admin only).",
	setProfile: "Change bot account profile fields (disabled by default; admin only).",
	setTyping: "Publish a typing/input indicator.",
	uploadGroupFile: "Upload a file into a NapCat group.",
};

const TOOL_PARAMETERS = {
	additionalProperties: true,
	properties: {},
	type: "object",
} as const;

const endpointFor = (config: OneBotConfig): string =>
	config.mode === "reverse"
		? `ws-reverse://${config.host ?? "127.0.0.1"}:${config.port ?? 3002}`
		: (config.url ?? "");

function createStatus(
	adapter: OneBotChannelAdapter,
	config: OneBotConfig,
	state?: "connected" | "disconnected",
) {
	const diagnostics = adapter.diagnostics();
	const connected = state === "connected" || (state === undefined && diagnostics.connected);
	return {
		code: connected ? "status_connected" : "status_disconnected",
		details: {
			endpoint: endpointFor(config),
			mode: diagnostics.mode ?? config.mode ?? "forward",
			...(diagnostics.origin === undefined ? {} : { origin: diagnostics.origin }),
			...(diagnostics.remoteAddress === undefined
				? {}
				: { remoteAddress: diagnostics.remoteAddress }),
		},
		level: connected
			? ("ok" as const)
			: diagnostics.restartRequired
				? ("error" as const)
				: ("warning" as const),
		metrics: {
			events: diagnostics.eventCount ?? 0,
			reconnects: diagnostics.reconnectAttempts ?? 0,
		},
		summary: connected ? "Connected to NapCat" : "Waiting for NapCat",
		...(diagnostics.lastErrorClass === undefined
			? {}
			: { message: `Last error: ${diagnostics.lastErrorClass}` }),
	};
}

function configWithHooks(context: PluginContext, config: OneBotConfig): OneBotConfig {
	const audioTranscribe = context.dependencies?.get<OneBotAudioTranscribe>(
		ONEBOT_AUDIO_TRANSCRIBE_BINDING,
	);
	const extractVideoFrames = context.dependencies?.get<OneBotVideoFrameExtractor>(
		ONEBOT_VIDEO_FRAME_EXTRACTOR_BINDING,
	);
	const media = context.media;
	const pttEnabled = config.pttToText !== false;
	return {
		...config,
		...(audioTranscribe === undefined || !pttEnabled ? {} : { audioTranscribe }),
		...(extractVideoFrames === undefined ? {} : { extractVideoFrames }),
		...(media === undefined
			? {}
			: {
					resolveMedia: async (part) => {
						if (part.type === "text" || part.type === "channel-native") return undefined;
						const stored =
							part.mediaId === undefined
								? part.sha256 === undefined
									? undefined
									: await media.findBySha(part.sha256)
								: await media.findById(part.mediaId);
						if (stored === undefined) return undefined;
						const bytes = await media.readBytes(stored.id);
						return `base64://${Buffer.from(bytes).toString("base64")}`;
					},
				}),
	};
}

async function applySettings(
	context: PluginContext,
	runtime: OneBotRuntime,
	raw: unknown,
): Promise<void> {
	const parsed = oneBotPluginConfigSchema.parse(raw ?? {});
	const resolved = resolveOneBotState(parsed);
	runtime.settings = resolved.settings;
	if (resolved.key === runtime.key) return;
	runtime.key = resolved.key;

	await runtime.adapter?.stop();
	runtime.dispose?.();
	runtime.adapter = undefined;
	runtime.dispose = undefined;

	const registry = context.channels;
	if (resolved.channel === undefined) {
		context.logger.debug("OneBot channel is not configured");
		context.ui.setStatus({
			code: "status_unconfigured",
			level: "unknown",
			summary: "WebSocket URL is not configured",
		});
		return;
	}
	if (registry === undefined) {
		context.logger.warn("channel registry is unavailable; OneBot channel not started");
		return;
	}
	const transportFactory = context.dependencies?.get<OneBotTransportFactory>(
		ONEBOT_TRANSPORT_FACTORY_BINDING,
	);
	const reverseServerFactory = context.dependencies?.get<OneBotReverseServerFactory>(
		ONEBOT_REVERSE_SERVER_FACTORY_BINDING,
	);
	const channelConfig = configWithHooks(context, resolved.channel);
	const adapter = new OneBotChannelAdapter({
		channelId: resolved.channelId,
		config: channelConfig,
		logger: context.logger,
		...(reverseServerFactory === undefined ? {} : { reverseServerFactory }),
		...(transportFactory === undefined ? {} : { transportFactory }),
		onStateChange: (state) => {
			context.ui.setStatus(createStatus(adapter, channelConfig, state));
			void context.events
				.emit(state === "connected" ? "channel.connected" : "channel.disconnected", {
					channelId: resolved.channelId,
					kind: "onebot-v11",
				})
				.catch(() => undefined);
		},
	});
	runtime.dispose = registry.register(adapter);
	runtime.adapter = adapter;
	runtime.facade = new OneBotActionFacade({
		audit: context.audit,
		getAdapter: () => runtime.adapter,
		getSettings: () => runtime.settings,
		logger: context.logger,
	});
	context.logger.info("starting OneBot channel", {
		endpoint: endpointFor(channelConfig),
		mode: channelConfig.mode ?? "forward",
	});
	await adapter.start();
	context.logger.info("OneBot channel started", { state: adapter.diagnostics().state });
	context.ui.setStatus(createStatus(adapter, channelConfig));
}

function registerTools(context: PluginContext, runtime: OneBotRuntime): void {
	for (const method of ONEBOT_ACTION_METHODS) {
		context.tools.register({
			description: TOOL_DESCRIPTIONS[method],
			async execute(input, toolContext) {
				const facade = runtime.facade;
				if (facade === undefined) {
					return { content: [{ text: "OneBot channel is not configured", type: "text" }] };
				}
				const actor: OneBotActionActor = {
					...(toolContext.userId === undefined ? {} : { actorId: toolContext.userId }),
					actorKind: "agent",
				};
				const outcome = await facade.run(method, input, actor);
				if (!outcome.ok) throw new Error(`OneBot action denied or failed: ${outcome.reason}`);
				return {
					content: [{ text: JSON.stringify(outcome.result ?? null), type: "text" }],
				} satisfies ToolResult;
			},
			name: `onebot-napcat.${method}`,
			parameters: TOOL_PARAMETERS,
			requiredPermissions: ONEBOT_ACTION_PERMISSIONS[method],
		});
	}
}

function registerRpcs(context: PluginContext, runtime: OneBotRuntime): void {
	for (const method of ONEBOT_ACTION_METHODS) {
		context.rpc.register(method, async (input) => {
			const facade = runtime.facade;
			if (facade === undefined) return { ok: false, reason: "channel-unavailable" };
			return facade.run(method, input, {
				actorId: "webui-admin",
				actorKind: "user",
				trustedAdmin: true,
			});
		});
	}
}

export const oneBotNapCatPlugin: TsukaimaPlugin = {
	manifest: oneBotNapCatManifest,
	async setup(context) {
		const runtime: OneBotRuntime = { settings: {} };
		runtimes.set(context, runtime);
		const apply = async (next: unknown): Promise<void> => {
			try {
				await applySettings(context, runtime, next);
			} catch (error) {
				context.logger.error("OneBot settings could not be applied", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		await apply((await context.settings?.get()) ?? {});
		runtime.unsubscribe = context.settings?.onChange(async (next) => {
			await apply(next);
		});
		registerTools(context, runtime);
		registerRpcs(context, runtime);
		context.rpc.register("reconnect", async () => {
			const raw = (await context.settings?.get()) ?? {};
			runtime.key = undefined;
			await apply(raw);
			return { ok: true };
		});
	},
	async teardown(context) {
		const runtime = runtimes.get(context);
		if (runtime === undefined) return;
		runtime.unsubscribe?.();
		await runtime.adapter?.stop();
		runtime.dispose?.();
		runtimes.delete(context);
		context.ui.setStatus(null);
	},
};

export default oneBotNapCatPlugin;
