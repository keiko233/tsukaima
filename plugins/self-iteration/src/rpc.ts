import type { PluginContext } from "@tsukaima/sdk";
import { SELF_ITERATION_PLUGIN_ID } from "./domain.ts";
import type { SelfIterationService } from "./service.ts";

const ADMIN_ACTOR = "webui-admin";

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

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerSelfIterationRpc(
	context: PluginContext,
	service: SelfIterationService,
): void {
	context.rpc.register("overview", async () => service.overview());

	context.rpc.register("tasks.list", async (input) => {
		const body = record(input);
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
	});

	context.rpc.register("tasks.get", async (input) => {
		const body = record(input);
		return await service.status(requiredString(body, "taskId"));
	});

	context.rpc.register("tasks.create", async (input) => {
		const body = record(input);
		const goal = requiredString(body, "goal");
		const mode =
			body.mode === "analysis" ||
			body.mode === "patch" ||
			body.mode === "proposal" ||
			body.mode === "maintenance"
				? body.mode
				: undefined;
		return await service.createTask({
			goal,
			...(mode === undefined ? {} : { mode }),
			...(stringValue(body, "baseRef") === undefined
				? {}
				: { baseRef: stringValue(body, "baseRef")! }),
			...(stringValue(body, "sourceConversationId") === undefined
				? {}
				: { sourceConversationId: stringValue(body, "sourceConversationId")! }),
		});
	});

	context.rpc.register("proposals.list", async (input) => {
		const body = record(input);
		return {
			proposals: await service.listProposals(stringValue(body, "taskId")),
		};
	});

	context.rpc.register("proposals.get", async (input) => {
		const body = record(input);
		const proposal = await service.getProposal(requiredString(body, "proposalId"));
		if (proposal === null) throw new Error("proposal_not_found");
		return proposal;
	});

	context.rpc.register("approvals.list", async (input) => {
		const body = record(input);
		return { approvals: await service.listApprovals(stringValue(body, "taskId")) };
	});

	context.rpc.register("approvals.resolve", async (input) => {
		const body = record(input);
		if (body.action !== "approve" && body.action !== "reject") {
			throw new Error("action must be approve or reject");
		}
		return await service.resolveApproval({
			action: body.action,
			approvalId: requiredString(body, "approvalId"),
			...(stringValue(body, "note") === undefined ? {} : { note: stringValue(body, "note")! }),
			resolvedBy: stringValue(body, "resolvedBy") ?? ADMIN_ACTOR,
		});
	});

	context.rpc.register("deployments.list", async (input) => {
		const body = record(input);
		return {
			deployments: await service.listDeployments({
				...(stringValue(body, "proposalId") === undefined
					? {}
					: { proposalId: stringValue(body, "proposalId")! }),
				...(stringValue(body, "taskId") === undefined
					? {}
					: { taskId: stringValue(body, "taskId")! }),
			}),
		};
	});

	context.rpc.register("deployments.deploy", async (input) => {
		const body = record(input);
		return await service.deploy({
			...(stringValue(body, "approvalId") === undefined
				? {}
				: { approvalId: stringValue(body, "approvalId")! }),
			createdBy: stringValue(body, "createdBy") ?? ADMIN_ACTOR,
			dryRun: body.dryRun === true,
			proposalId: requiredString(body, "proposalId"),
		});
	});

	context.rpc.register("deployments.rollback", async (input) => {
		const body = record(input);
		return await service.rollback({
			createdBy: stringValue(body, "createdBy") ?? ADMIN_ACTOR,
			deploymentId: requiredString(body, "deploymentId"),
			dryRun: body.dryRun === true,
		});
	});

	context.rpc.register("policy.get", async () => service.policy());

	context.rpc.register("policy.update", async (input) => {
		const body = record(input);
		const patch = body.patch ?? body;
		return await service.updatePolicy(patch, stringValue(body, "updatedBy") ?? ADMIN_ACTOR);
	});

	context.logger.info("self-iteration admin RPC registered", {
		pluginId: SELF_ITERATION_PLUGIN_ID,
	});
}
