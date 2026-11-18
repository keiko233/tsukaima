import type { PluginContext, PluginRpcHandler } from "@tsukaima/sdk";
import { SELF_ITERATION_PLUGIN_ID } from "./domain.ts";
import { elapsedMs, preview, scopedLogger, type ScopedLogger } from "./log.ts";
import type { SelfIterationService } from "./service.ts";

const ADMIN_ACTOR = "webui-admin";

/** Keys worth including in a `trace` preview of an RPC body. Never includes secrets or diffs. */
const SUMMARY_KEYS = [
	"action",
	"approvalId",
	"baseRef",
	"createdBy",
	"deploymentId",
	"goal",
	"mode",
	"note",
	"proposalId",
	"resolvedBy",
	"taskId",
	"updatedBy",
] as const;

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = stringValue(input, key);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

function summarize(input: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of SUMMARY_KEYS) {
		if (typeof input[key] === "string") summary[key] = input[key];
	}
	if (typeof input.dryRun === "boolean") summary.dryRun = input.dryRun;
	if (typeof input.limit === "number") summary.limit = input.limit;
	return summary;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps one admin procedure with `trace` invocation and `debug`/`error` completion logging.
 * Errors are rethrown so the host keeps its existing failure semantics.
 */
function procedure(
	log: ScopedLogger,
	method: string,
	handler: (body: Record<string, unknown>) => unknown,
): PluginRpcHandler {
	return async (input) => {
		const startedAt = performance.now();
		const body = record(input);
		log.trace("rpc invoked", { input: preview(summarize(body)), method });
		try {
			const result = await handler(body);
			log.debug("rpc completed", {
				durationMs: elapsedMs(startedAt),
				method,
				outcome: result === null || result === undefined ? "empty" : "ok",
			});
			return result;
		} catch (error) {
			log.error("rpc failed", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				method,
			});
			throw error;
		}
	};
}

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerSelfIterationRpc(
	context: PluginContext,
	service: SelfIterationService,
): void {
	const log = scopedLogger(context.logger, "rpc");

	context.rpc.register(
		"overview",
		procedure(log, "overview", async () => service.overview()),
	);

	context.rpc.register(
		"tasks.list",
		procedure(log, "tasks.list", async (body) => {
			const limit = typeof body.limit === "number" ? Math.max(1, Math.floor(body.limit)) : 100;
			const mode =
				body.mode === "analysis" ||
				body.mode === "patch" ||
				body.mode === "proposal" ||
				body.mode === "maintenance"
					? body.mode
					: undefined;
			return {
				tasks: await service.listTasks({ limit, ...(mode === undefined ? {} : { mode }) }),
			};
		}),
	);

	context.rpc.register(
		"tasks.get",
		procedure(log, "tasks.get", async (body) => service.status(requiredString(body, "taskId"))),
	);

	context.rpc.register(
		"tasks.create",
		procedure(log, "tasks.create", async (body) => {
			const goal = requiredString(body, "goal");
			return service.createTask({
				goal,
				...(stringValue(body, "baseRef") === undefined
					? {}
					: { baseRef: stringValue(body, "baseRef")! }),
				...(stringValue(body, "sourceConversationId") === undefined
					? {}
					: { sourceConversationId: stringValue(body, "sourceConversationId")! }),
			});
		}),
	);

	context.rpc.register(
		"proposals.list",
		procedure(log, "proposals.list", async (body) => ({
			proposals: await service.listProposals(stringValue(body, "taskId")),
		})),
	);

	context.rpc.register(
		"proposals.get",
		procedure(log, "proposals.get", async (body) => {
			const proposal = await service.getProposal(requiredString(body, "proposalId"));
			if (proposal === null) throw new Error("proposal_not_found");
			return proposal;
		}),
	);

	context.rpc.register(
		"approvals.list",
		procedure(log, "approvals.list", async (body) => ({
			approvals: await service.listApprovals(stringValue(body, "taskId")),
		})),
	);

	context.rpc.register(
		"approvals.resolve",
		procedure(log, "approvals.resolve", async (body) => {
			if (body.action !== "approve" && body.action !== "reject") {
				throw new Error("action must be approve or reject");
			}
			return service.resolveApproval({
				action: body.action,
				approvalId: requiredString(body, "approvalId"),
				...(stringValue(body, "note") === undefined ? {} : { note: stringValue(body, "note")! }),
				resolvedBy: stringValue(body, "resolvedBy") ?? ADMIN_ACTOR,
			});
		}),
	);

	context.rpc.register(
		"deployments.list",
		procedure(log, "deployments.list", async (body) => ({
			deployments: await service.listDeployments({
				...(stringValue(body, "proposalId") === undefined
					? {}
					: { proposalId: stringValue(body, "proposalId")! }),
				...(stringValue(body, "taskId") === undefined
					? {}
					: { taskId: stringValue(body, "taskId")! }),
			}),
		})),
	);

	context.rpc.register(
		"deployments.deploy",
		procedure(log, "deployments.deploy", async (body) =>
			service.deploy({
				...(stringValue(body, "approvalId") === undefined
					? {}
					: { approvalId: stringValue(body, "approvalId")! }),
				createdBy: stringValue(body, "createdBy") ?? ADMIN_ACTOR,
				dryRun: body.dryRun === true,
				proposalId: requiredString(body, "proposalId"),
			}),
		),
	);

	context.rpc.register(
		"deployments.rollback",
		procedure(log, "deployments.rollback", async (body) =>
			service.rollback({
				createdBy: stringValue(body, "createdBy") ?? ADMIN_ACTOR,
				deploymentId: requiredString(body, "deploymentId"),
				dryRun: body.dryRun === true,
			}),
		),
	);

	context.rpc.register(
		"policy.get",
		procedure(log, "policy.get", async () => service.policy()),
	);

	context.rpc.register(
		"policy.update",
		procedure(log, "policy.update", async (body) => {
			const patch = body.patch ?? body;
			return service.updatePolicy(patch, stringValue(body, "updatedBy") ?? ADMIN_ACTOR);
		}),
	);

	log.info("self-iteration admin RPC registered", {
		pluginId: SELF_ITERATION_PLUGIN_ID,
	});
}
