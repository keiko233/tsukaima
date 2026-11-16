import type { TsukaimaPlugin, PluginContext } from "@tsukaima/sdk";
import {
	type SelfIterationHostBinding,
	SELF_ITERATION_HOST_BINDING,
	SELF_ITERATION_PLUGIN_ID,
} from "./domain.ts";
import { SELF_ITERATION_MANIFEST } from "./manifest.ts";
import { elapsedMs } from "./log.ts";
import { registerSelfIterationRpc } from "./rpc.ts";
import { SelfIterationService } from "./service.ts";
import { registerSelfIterationTools } from "./tools.ts";

export * from "./domain.ts";
export { SELF_ITERATION_MANIFEST, SELF_ITERATION_PLUGIN_ID } from "./manifest.ts";
export { registerSelfIterationRpc } from "./rpc.ts";
export {
	buildTaskGraph,
	SelfIterationService,
	type CreateTaskRequest,
	type DeployRequest,
	type ProposalRequest,
	type RollbackRequest,
	type SelfIterationServiceOptions,
	type TaskBundle,
} from "./service.ts";
export { registerSelfIterationTools } from "./tools.ts";

interface Runtime {
	readonly service: SelfIterationService;
}

const runtimes = new WeakMap<PluginContext, Runtime>();

async function updateStatus(context: PluginContext, service: SelfIterationService): Promise<void> {
	try {
		const overview = await service.overview();
		context.ui.setStatus({
			code: "ready",
			level: "ok",
			metrics: {
				approvals: overview.stats.approvals,
				deployments: overview.stats.deployments,
				proposals: overview.stats.proposals,
				tasks: overview.stats.tasks,
			},
			summary: "Self-iteration runtime ready",
		});
	} catch (error) {
		context.logger.warn("self-iteration status refresh failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export const selfIterationPlugin: TsukaimaPlugin = {
	manifest: SELF_ITERATION_MANIFEST,
	async setup(context) {
		const startedAt = performance.now();
		context.logger.debug("self-iteration setup starting", {
			pluginId: SELF_ITERATION_PLUGIN_ID,
		});
		const binding = context.dependencies?.get<SelfIterationHostBinding>(
			SELF_ITERATION_HOST_BINDING,
		);
		if (binding === undefined) {
			context.logger.error("self-iteration requires a host binding (store/repository/reload)");
			context.ui.setStatus({
				code: "host_binding_missing",
				level: "error",
				summary: "Self-iteration host binding is unavailable",
			});
			return;
		}
		const service = new SelfIterationService({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			binding,
			logger: context.logger,
			...(context.storage === undefined ? {} : { storage: context.storage }),
		});
		runtimes.set(context, { service });
		registerSelfIterationTools(context, service);
		registerSelfIterationRpc(context, service);
		await updateStatus(context, service);
		context.logger.info("self-iteration ready", {
			durationMs: elapsedMs(startedAt),
			pluginId: SELF_ITERATION_PLUGIN_ID,
			repositoryRoot: binding.repositoryRoot,
		});
	},
	async teardown(context) {
		runtimes.delete(context);
		context.ui.setStatus(null);
		context.logger.debug("self-iteration teardown", {
			pluginId: SELF_ITERATION_PLUGIN_ID,
		});
	},
};

export default selfIterationPlugin;
