import type { TsukaimaPlugin, PluginContext } from "@tsukaima/sdk";
import {
	PROACTIVE_SCHEDULER_RUN_KIND,
	PROACTIVE_SCHEDULER_TICK_KIND,
	proactiveSchedulerManifest,
} from "./manifest.ts";
import { registerProactiveSchedulerRpc } from "./rpc.ts";
import { ProactiveSchedulerService } from "./service.ts";
import { registerProactiveSchedulerTools } from "./tools.ts";

export {
	PROACTIVE_SCHEDULER_PLUGIN_ID,
	PROACTIVE_SCHEDULER_RPC_PREFIX,
	PROACTIVE_SCHEDULER_RUN_KIND,
	PROACTIVE_SCHEDULER_TABLE_PREFIX,
	PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY,
	PROACTIVE_SCHEDULER_TICK_KIND,
	proactiveSchedulerManifest,
} from "./manifest.ts";
export * from "./domain.ts";
export { evaluateProactiveGates, nextCounters, backoffState } from "./engine.ts";
export { ProactiveSchedulerRepository } from "./repository.ts";
export {
	ProactiveSchedulerService,
	type Overview,
	type ProactiveSchedulerServiceOptions,
	type SimulationRow,
} from "./service.ts";
export { registerProactiveSchedulerRpc } from "./rpc.ts";
export { registerProactiveSchedulerTools } from "./tools.ts";

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

interface SchedulerRuntime {
	readonly disposers: (() => void)[];
	readonly service: ProactiveSchedulerService;
}

const runtimes = new WeakMap<PluginContext, SchedulerRuntime>();

async function updateStatus(
	context: PluginContext,
	service: ProactiveSchedulerService,
): Promise<void> {
	try {
		const overview = await service.overview();
		context.ui.setStatus({
			code: overview.enabled ? "ready" : "disabled",
			level: overview.enabled ? "ok" : "warning",
			metrics: {
				decisions: overview.stats.decisions,
				delivered: overview.stats.delivered,
				pending: overview.stats.pending,
				tasks: overview.stats.tasks,
			},
			summary: overview.enabled ? "Proactive scheduling enabled" : "Proactive scheduling disabled",
		});
	} catch (error) {
		context.logger.warn("proactive scheduler status refresh failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export const proactiveSchedulerPlugin: TsukaimaPlugin = {
	manifest: proactiveSchedulerManifest,
	async setup(context) {
		const database = context.database;
		const tasks = context.tasks;
		const conversations = context.conversations;
		if (database === undefined || tasks === undefined || conversations === undefined) {
			context.logger.error(
				"proactive-scheduler requires host database, tasks, and conversation bridges",
			);
			context.ui.setStatus({
				code: "host_requirements_missing",
				level: "error",
				summary: "Host scheduler or conversation bridge is unavailable",
			});
			return;
		}
		const config = recordValue((await context.settings?.get()) ?? {});
		const tickIntervalMs =
			typeof config.tickIntervalMs === "number" && Number.isFinite(config.tickIntervalMs)
				? config.tickIntervalMs
				: undefined;
		const maxPromptChars =
			typeof config.maxPromptChars === "number" && Number.isFinite(config.maxPromptChars)
				? config.maxPromptChars
				: undefined;
		const service = new ProactiveSchedulerService({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			conversations,
			database,
			logger: context.logger,
			...(maxPromptChars === undefined ? {} : { promptMaxChars: maxPromptChars }),
			...(tickIntervalMs === undefined ? {} : { tickIntervalMs }),
			tasks,
		});
		const runtime: SchedulerRuntime = { disposers: [], service };
		runtimes.set(context, runtime);
		context.logger.debug("proactive-scheduler setup", {
			maxPromptChars: maxPromptChars ?? null,
			tickIntervalMs: tickIntervalMs ?? null,
		});
		runtime.disposers.push(
			tasks.registerHandler(PROACTIVE_SCHEDULER_RUN_KIND, (task) => service.runHostTask(task)),
			tasks.registerHandler(PROACTIVE_SCHEDULER_TICK_KIND, (task) => service.runHostTask(task)),
			context.events.on("message.received", async (payload) => {
				const startedAtMs = Date.now();
				try {
					await service.handleMessageReceived(payload);
					context.logger.debug("message.received handled", {
						durationMs: Date.now() - startedAtMs,
					});
				} catch (error) {
					context.logger.warn("proactive scheduler inbound state update failed", {
						durationMs: Date.now() - startedAtMs,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
			context.events.on("after.reply", async (payload) => {
				const startedAtMs = Date.now();
				try {
					await service.handleAfterReply(payload);
					await updateStatus(context, service);
					context.logger.debug("after.reply handled", {
						durationMs: Date.now() - startedAtMs,
					});
				} catch (error) {
					context.logger.warn("proactive scheduler reply state update failed", {
						durationMs: Date.now() - startedAtMs,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		registerProactiveSchedulerTools(context, service);
		registerProactiveSchedulerRpc(context, service);
		try {
			await service.start();
			await updateStatus(context, service);
			context.logger.info("proactive-scheduler ready");
		} catch (error) {
			context.logger.error("proactive scheduler startup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			context.ui.setStatus({
				code: "startup_failed",
				level: "error",
				summary: "Scheduler startup failed",
			});
		}
	},
	async teardown(context) {
		const runtime = runtimes.get(context);
		try {
			await runtime?.service.stop();
		} catch {}
		for (const dispose of runtime?.disposers ?? []) {
			try {
				dispose();
			} catch {}
		}
		runtimes.delete(context);
		context.ui.setStatus(null);
		context.logger.info("proactive-scheduler stopped", {
			disposers: runtime?.disposers.length ?? 0,
		});
	},
};

export default proactiveSchedulerPlugin;
