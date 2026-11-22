import type { PluginContext, PluginLogger, PluginRpcHandler } from "@tsukaima/sdk";
import { isPlainObject, omit } from "es-toolkit";
import {
	CONVERSATION_POLICY_SCOPE,
	GLOBAL_POLICY_SCOPE,
	PERSONA_POLICY_SCOPE,
	proactivePolicyPatchSchema,
	scheduledTaskKindSchema,
	scheduledTaskStatusSchema,
} from "./domain.ts";
import type { ProactiveSchedulerService } from "./service.ts";

const ADMIN_ACTOR = "webui-admin";

function record(input: unknown): Record<string, unknown> {
	return isPlainObject(input) ? input : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function scopeValue(value: unknown): "global" | "conversation" | "persona" {
	if (value === CONVERSATION_POLICY_SCOPE) return "conversation";
	if (value === PERSONA_POLICY_SCOPE) return "persona";
	return "global";
}

/** Wraps an admin procedure with trace/debug timing; rethrows failures for the host. */
function tracedRpc(
	context: PluginContext,
	method: string,
	handler: PluginRpcHandler,
): PluginRpcHandler {
	const logger: PluginLogger = context.logger.child?.("rpc") ?? context.logger;
	return async (input) => {
		const startedAtMs = Date.now();
		const body = record(input);
		const conversationId = stringValue(body.conversationId ?? body.sessionId) ?? null;
		const taskId = stringValue(body.taskId) ?? null;
		logger.trace("rpc invoked", {
			actor: ADMIN_ACTOR,
			conversationId,
			inputKeys: Object.keys(body),
			method,
			taskId,
		});
		try {
			const result = await handler(input);
			logger.debug("rpc finished", {
				conversationId,
				durationMs: Date.now() - startedAtMs,
				method,
				ok: true,
				taskId,
			});
			return result;
		} catch (error) {
			logger.debug("rpc failed", {
				conversationId,
				durationMs: Date.now() - startedAtMs,
				error: error instanceof Error ? error.message : String(error),
				method,
				ok: false,
				taskId,
			});
			throw error;
		}
	};
}

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerProactiveSchedulerRpc(
	context: PluginContext,
	service: ProactiveSchedulerService,
): void {
	const register = (method: string, handler: PluginRpcHandler): void => {
		context.rpc.register(method, tracedRpc(context, method, handler));
	};
	register("overview", async () => {
		const [overview, tasks] = await Promise.all([
			service.overview(),
			service.listTasks({ status: ["scheduled", "running"], limit: 20 }),
		]);
		return { ...overview, recentTasks: tasks };
	});

	register("policies.save", async (input) => {
		const body = record(input);
		const scope = scopeValue(body.scope);
		const scopeId = stringValue(body.scopeId ?? body.id) ?? "";
		if (scope !== GLOBAL_POLICY_SCOPE && scopeId.length === 0) {
			throw new Error(`${scope} policy requires scopeId`);
		}
		const patchSource = body.patch ?? omit(body, ["scope", "scopeId", "id", "confirm"]);
		const patch = proactivePolicyPatchSchema.parse(patchSource);
		return await service.savePolicy(scope, scopeId, patch, ADMIN_ACTOR);
	});

	register("policies.reset", async (input) => {
		const body = record(input);
		if (body.confirm !== true) throw new Error("policies.reset requires confirm: true");
		await service.resetPolicies(ADMIN_ACTOR);
		return { reset: true };
	});

	register("tasks.list", async (input) => {
		const body = record(input);
		const status = scheduledTaskStatusSchema.safeParse(body.status);
		const kind = scheduledTaskKindSchema.safeParse(body.kind);
		const tasks = await service.listTasks({
			...(stringValue(body.conversationId) === undefined
				? {}
				: { conversationId: stringValue(body.conversationId)! }),
			...(kind.success ? { kind: kind.data } : {}),
			...(status.success ? { status: status.data } : {}),
			limit: typeof body.limit === "number" ? Math.max(1, Math.floor(body.limit)) : 100,
		});
		return { tasks };
	});

	register("tasks.create", async (input) => {
		return await service.createTask(input, undefined, { id: ADMIN_ACTOR, kind: "admin" });
	});

	register("tasks.cancel", async (input) => {
		const body = record(input);
		const taskId = stringValue(body.taskId);
		if (taskId !== undefined) {
			const task = await service.cancelTask(taskId, ADMIN_ACTOR);
			if (task === undefined) throw new Error("Task not found");
			return task;
		}
		const conversationId = stringValue(body.conversationId);
		if (conversationId === undefined) {
			throw new Error("tasks.cancel requires taskId or conversationId");
		}
		const cancelled = await service.cancelConversation(conversationId, ADMIN_ACTOR);
		return { cancelled: cancelled.map((task) => task.id) };
	});

	register("tasks.updatePrompt", async (input) => {
		const body = record(input);
		const taskId = stringValue(body.taskId);
		const prompt = stringValue(body.prompt);
		if (taskId === undefined || prompt === undefined) {
			throw new Error("tasks.updatePrompt requires taskId and prompt");
		}
		const task = await service.updatePrompt(taskId, prompt, ADMIN_ACTOR);
		if (task === undefined) throw new Error("Task not found");
		return task;
	});

	register("decisions.list", async (input) => {
		const body = record(input);
		const decisions = await service.listDecisions({
			...(stringValue(body.conversationId) === undefined
				? {}
				: { conversationId: stringValue(body.conversationId)! }),
			...(stringValue(body.taskId) === undefined ? {} : { taskId: stringValue(body.taskId)! }),
			limit: typeof body.limit === "number" ? Math.max(1, Math.floor(body.limit)) : 50,
		});
		return { decisions };
	});

	register("simulate", async (input) => {
		const body = record(input);
		const nowMs =
			typeof body.nowMs === "number" && Number.isFinite(body.nowMs) ? body.nowMs : undefined;
		const rows = await service.simulate({
			...(stringValue(body.conversationId) === undefined
				? {}
				: { conversationId: stringValue(body.conversationId)! }),
			...(nowMs === undefined ? {} : { nowMs }),
		});
		return { dryRun: true, rows };
	});

	register("tick", async () => {
		return await service.runTick();
	});
}
