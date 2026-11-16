import type { PluginContext, ToolInvocationContext, PluginTool, ToolResult } from "@tsukaima/sdk";
import type { StructuredEdit } from "@tsukaima/coding";
import { SELF_ITERATION_PLUGIN_ID } from "./domain.ts";
import { elapsedMs, preview, scopedLogger, type ScopedLogger } from "./log.ts";
import type { SelfIterationService } from "./service.ts";

const text = (value: unknown): ToolResult => ({
	content: [{ text: typeof value === "string" ? value : JSON.stringify(value), type: "text" }],
});

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(input: Record<string, unknown>, key: string): string[] | undefined {
	const value = input[key];
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: undefined;
}

function numberValue(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function taskInput(
	input: Record<string, unknown>,
	invocation: ToolInvocationContext,
): {
	goal?: string;
	mode?: "analysis" | "maintenance" | "patch" | "proposal";
	sourceConversationId?: string;
	taskId?: string;
} {
	const mode = input.mode;
	return {
		...(stringValue(input, "goal") === undefined ? {} : { goal: stringValue(input, "goal")! }),
		...(mode === "analysis" || mode === "maintenance" || mode === "patch" || mode === "proposal"
			? { mode }
			: {}),
		...(invocation.conversationId === undefined
			? {}
			: { sourceConversationId: invocation.conversationId }),
		...(stringValue(input, "taskId") === undefined
			? {}
			: { taskId: stringValue(input, "taskId")! }),
	};
}

const BASE_POLICY = {
	allowedTaskKinds: ["coding"],
	conversationAllowlist: true,
	maxConcurrent: 2,
	requiredConversationCapabilities: ["coding"],
	visibility: "model" as const,
};

/** Run one tool, auditing success/failure in addition to the service's own audit entries. */
async function invoke(
	context: PluginContext,
	log: ScopedLogger,
	name: string,
	input: Record<string, unknown>,
	invocation: ToolInvocationContext,
	run: () => Promise<unknown>,
): Promise<ToolResult> {
	const startedAt = performance.now();
	const summary = summarize(input);
	log.trace("tool invoked", {
		conversationId: invocation.conversationId,
		input: preview(summary),
		tool: name,
		userId: invocation.userId,
	});
	try {
		const result = await run();
		await context.audit?.record({
			action: `${name}.invoke`,
			actorId: invocation.userId ?? "agent",
			actorKind: invocation.userId === undefined ? "agent" : "user",
			payload: { conversationId: invocation.conversationId, input: summary },
			result: "ok",
			...(typeof input.taskId === "string" ? { targetId: input.taskId } : {}),
			targetKind: "coding-task",
		});
		log.debug("tool completed", {
			durationMs: elapsedMs(startedAt),
			outcome: "ok",
			taskId: typeof input.taskId === "string" ? input.taskId : undefined,
			tool: name,
		});
		return text(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await context.audit?.record({
			action: `${name}.invoke`,
			actorId: invocation.userId ?? "agent",
			actorKind: invocation.userId === undefined ? "agent" : "user",
			payload: { conversationId: invocation.conversationId, input: summary },
			reason: message,
			result: "failed",
			...(typeof input.taskId === "string" ? { targetId: input.taskId } : {}),
			targetKind: "coding-task",
		});
		log.error("tool failed", {
			durationMs: elapsedMs(startedAt),
			error: message,
			taskId: typeof input.taskId === "string" ? input.taskId : undefined,
			tool: name,
		});
		return text({ error: message });
	}
}

function summarize(input: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of [
		"taskId",
		"goal",
		"mode",
		"path",
		"pattern",
		"command",
		"action",
		"proposalId",
	]) {
		if (typeof input[key] === "string") summary[key] = input[key];
	}
	if (Array.isArray(input.args)) summary.args = input.args.slice(0, 16);
	return summary;
}

function structuredEdit(input: Record<string, unknown>): StructuredEdit {
	const nested = record(input.edit);
	const source = Object.keys(nested).length > 0 ? nested : input;
	return {
		...(typeof source.content === "string" ? { content: source.content } : {}),
		...(typeof source.create === "boolean" ? { create: source.create } : {}),
		...(typeof source.find === "string" ? { find: source.find } : {}),
		path: typeof source.path === "string" ? source.path : "",
		...(typeof source.replace === "string" ? { replace: source.replace } : {}),
	};
}

function tool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	requiredPermissions: readonly string[],
	timeoutMs: number,
	execute: (
		input: Record<string, unknown>,
		invocation: ToolInvocationContext,
	) => Promise<ToolResult>,
): PluginTool {
	return {
		description,
		execute,
		name: `${SELF_ITERATION_PLUGIN_ID}.${name}`,
		parameters,
		policy: { ...BASE_POLICY, maxPayloadBytes: 64 * 1024, timeoutMs },
		requiredPermissions,
	};
}

const TASK_FIELDS = {
	goal: { type: "string" },
	mode: {
		enum: ["analysis", "patch", "proposal", "maintenance"],
		type: "string",
	},
	taskId: { type: "string" },
} as const;

/** Registers the eight `self-iteration.*` model tools. Maintenance verbs are intentionally absent. */
export function registerSelfIterationTools(
	context: PluginContext,
	service: SelfIterationService,
): void {
	const log = scopedLogger(context.logger, "tools");

	context.tools.register(
		tool(
			"analyze",
			"Analyze the repository with scoped reads, searches, or tests. Never writes or creates worktrees.",
			{
				properties: {
					...TASK_FIELDS,
					action: { enum: ["read", "search", "test"], type: "string" },
					args: { items: { type: "string" }, type: "array" },
					command: { type: "string" },
					maxBytes: { minimum: 1, type: "integer" },
					path: { type: "string" },
					pattern: { type: "string" },
				},
				type: "object",
			},
			["coding.read"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.analyze", input, invocation, async () =>
					service.analyze({
						...taskInput(input, invocation),
						action: input.action === "search" || input.action === "test" ? input.action : "read",
						args: stringArray(input, "args") ?? [],
						...(stringValue(input, "command") === undefined
							? {}
							: { command: stringValue(input, "command")! }),
						...(numberValue(input, "maxBytes") === undefined
							? {}
							: { maxBytes: numberValue(input, "maxBytes")! }),
						...(stringValue(input, "path") === undefined
							? {}
							: { path: stringValue(input, "path")! }),
						...(stringValue(input, "pattern") === undefined
							? {}
							: { pattern: stringValue(input, "pattern")! }),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"worktree",
			"Create a bounded git worktree for a patch task. All later writes stay inside it.",
			{
				properties: {
					...TASK_FIELDS,
					baseRef: { type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.worktree", input, invocation, async () =>
					service.worktree({
						...taskInput(input, invocation),
						...(stringValue(input, "baseRef") === undefined
							? {}
							: { baseRef: stringValue(input, "baseRef")! }),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"edit",
			"Apply one validated structured edit strictly inside the task worktree and path allowlist.",
			{
				properties: {
					...TASK_FIELDS,
					content: { type: "string" },
					create: { type: "boolean" },
					edit: {
						properties: {
							content: { type: "string" },
							create: { type: "boolean" },
							find: { type: "string" },
							path: { type: "string" },
							replace: { type: "string" },
						},
						required: ["path"],
						type: "object",
					},
					find: { type: "string" },
					path: { type: "string" },
					replace: { type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.edit", input, invocation, async () => {
					const edit = structuredEdit(input);
					return await service.edit({ ...taskInput(input, invocation), edit });
				}),
		),
	);

	context.tools.register(
		tool(
			"test",
			"Run an allowlisted test command with bounded output and a hard timeout.",
			{
				properties: {
					...TASK_FIELDS,
					args: { items: { type: "string" }, type: "array" },
					command: { type: "string" },
					pattern: { type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			120_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.test", input, invocation, async () =>
					service.test({
						...taskInput(input, invocation),
						args: stringArray(input, "args") ?? [],
						...(stringValue(input, "command") === undefined
							? {}
							: { command: stringValue(input, "command")! }),
						...(stringValue(input, "pattern") === undefined
							? {}
							: { pattern: stringValue(input, "pattern")! }),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"build",
			"Run an allowlisted build command and record artifact metadata with a checksum.",
			{
				properties: {
					...TASK_FIELDS,
					args: { items: { type: "string" }, type: "array" },
					command: { type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			180_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.build", input, invocation, async () =>
					service.build({
						...taskInput(input, invocation),
						args: stringArray(input, "args") ?? [],
						...(stringValue(input, "command") === undefined
							? {}
							: { command: stringValue(input, "command")! }),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"diff",
			"Compute a structured worktree diff with changed files, size, and sha256 checksum.",
			{ properties: { ...TASK_FIELDS }, type: "object" },
			["coding.execute"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.diff", input, invocation, async () =>
					service.diff(taskInput(input, invocation)),
				),
		),
	);

	context.tools.register(
		tool(
			"propose",
			"Submit a deployment proposal for admin approval. Requires all seven proposal field groups.",
			{
				properties: {
					...TASK_FIELDS,
					artifactMetadata: { type: "object" },
					changedFiles: { items: { type: "string" }, type: "array" },
					diff: { type: "string" },
					diffChecksum: { type: "string" },
					envChanges: { items: { type: "string" }, type: "array" },
					motivation: { type: "string" },
					requiresRestart: { type: "boolean" },
					riskAssessment: { type: "string" },
					rollbackNotes: { type: "string" },
					sourceRevision: { type: "string" },
					testResult: { type: "object" },
					title: { type: "string" },
				},
				type: "object",
			},
			["coding.execute", "tasks.create"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.propose", input, invocation, async () =>
					service.propose({
						...taskInput(input, invocation),
						...(stringValue(input, "title") === undefined
							? {}
							: { title: stringValue(input, "title")! }),
						...(stringValue(input, "motivation") === undefined
							? {}
							: { motivation: stringValue(input, "motivation")! }),
						...(stringValue(input, "riskAssessment") === undefined
							? {}
							: { riskAssessment: stringValue(input, "riskAssessment")! }),
						...(stringValue(input, "rollbackNotes") === undefined
							? {}
							: { rollbackNotes: stringValue(input, "rollbackNotes")! }),
						...(stringValue(input, "sourceRevision") === undefined
							? {}
							: { sourceRevision: stringValue(input, "sourceRevision")! }),
						...(stringValue(input, "diff") === undefined
							? {}
							: { diff: stringValue(input, "diff")! }),
						...(stringValue(input, "diffChecksum") === undefined
							? {}
							: { diffChecksum: stringValue(input, "diffChecksum")! }),
						...(stringArray(input, "changedFiles") === undefined
							? {}
							: { changedFiles: stringArray(input, "changedFiles")! }),
						...(stringArray(input, "envChanges") === undefined
							? {}
							: { envChanges: stringArray(input, "envChanges")! }),
						...(input.requiresRestart === true ? { requiresRestart: true } : {}),
						...(typeof input.artifactMetadata === "object" && input.artifactMetadata !== null
							? { artifactMetadata: input.artifactMetadata as never }
							: {}),
						...(typeof input.testResult === "object" && input.testResult !== null
							? { testResult: input.testResult as never }
							: {}),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"status",
			"Return the full task graph, worktree commit/path, timeline, tests/builds, diff, approvals, deployments, and rollback links.",
			{
				properties: {
					taskId: { type: "string" },
					goal: { type: "string" },
					mode: { enum: ["analysis", "patch", "proposal", "maintenance"], type: "string" },
				},
				required: ["taskId"],
				type: "object",
			},
			["coding.read"],
			30_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.status", input, invocation, async () => {
					const taskId = stringValue(input, "taskId");
					if (taskId === undefined) throw new Error("taskId_required");
					const bundle = await service.status(taskId);
					return {
						approvals: bundle.approvals,
						artifacts: bundle.task.artifacts,
						deployments: bundle.deployments,
						diff: bundle.task.artifacts.filter((artifact) => artifact.kind === "diff"),
						errors: bundle.task.logs.filter((entry) => entry.level === "error"),
						graph: bundle.graph,
						logs: bundle.task.logs,
						mode: bundle.task.mode,
						proposals: bundle.proposals.map((proposal) => ({
							changedFiles: proposal.changedFiles,
							diffChecksum: proposal.diffChecksum,
							id: proposal.id,
							requiresRestart: proposal.requiresRestart,
							status: proposal.status,
							title: proposal.title,
						})),
						status: bundle.task.status,
						taskId: bundle.task.id,
						timeline: bundle.task.timeline,
						worktree: bundle.worktree,
					};
				}),
		),
	);
}
