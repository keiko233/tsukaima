import type { OneBotTransportFactory } from "@elaina/onebot";
import type { ElainaPlugin, PluginContext } from "@elaina/sdk";
import { OneBotChannelAdapter } from "./adapter.ts";
import { oneBotPluginConfigSchema, resolveOneBotState } from "./config.ts";
import { oneBotNapCatManifest } from "./manifest.ts";

export { ONEBOT_CHANNEL_KIND, OneBotChannelAdapter } from "./adapter.ts";
export { ONEBOT_DEFAULT_CHANNEL_ID, oneBotPluginConfigSchema } from "./config.ts";
export { ONEBOT_PLUGIN_ID, oneBotNapCatManifest } from "./manifest.ts";

/** Host binding that injects a transport factory (tests and custom networking). */
export const ONEBOT_TRANSPORT_FACTORY_BINDING = "onebot.transportFactory";

interface OneBotRuntime {
	adapter?: OneBotChannelAdapter | undefined;
	dispose?: (() => void) | undefined;
	unsubscribe?: (() => void) | undefined;
	/** Restart key: changes exactly when the live connection must be replaced. */
	key?: string | undefined;
}

const runtimes = new WeakMap<PluginContext, OneBotRuntime>();

async function applySettings(
	context: PluginContext,
	runtime: OneBotRuntime,
	raw: unknown,
): Promise<void> {
	const resolved = resolveOneBotState(oneBotPluginConfigSchema.parse(raw ?? {}));
	if (resolved.key === runtime.key) return;
	runtime.key = resolved.key;

	await runtime.adapter?.stop();
	runtime.dispose?.();
	runtime.adapter = undefined;
	runtime.dispose = undefined;

	const registry = context.channels;
	if (resolved.channel === undefined) {
		context.logger.debug("OneBot channel is not configured");
		return;
	}
	if (registry === undefined) {
		context.logger.warn("channel registry is unavailable; OneBot channel not started");
		return;
	}
	const transportFactory = context.dependencies?.get<OneBotTransportFactory>(
		ONEBOT_TRANSPORT_FACTORY_BINDING,
	);
	const adapter = new OneBotChannelAdapter({
		channelId: resolved.channelId,
		config: resolved.channel,
		logger: context.logger,
		...(transportFactory === undefined ? {} : { transportFactory }),
		onStateChange: (state) => {
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
	context.logger.info("starting OneBot channel", { url: resolved.channel.url });
	await adapter.start();
	context.logger.info("OneBot channel started", { state: adapter.diagnostics().state });
}

export const oneBotNapCatPlugin: ElainaPlugin = {
	manifest: oneBotNapCatManifest,
	async setup(context) {
		const runtime: OneBotRuntime = {};
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
	},
	async teardown(context) {
		const runtime = runtimes.get(context);
		if (runtime === undefined) return;
		runtime.unsubscribe?.();
		await runtime.adapter?.stop();
		runtime.dispose?.();
		runtimes.delete(context);
	},
};

export default oneBotNapCatPlugin;
