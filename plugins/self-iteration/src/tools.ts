import type { PluginContext, ToolInvocationContext, PluginTool, ToolResult } from "@tsukaima/sdk";
import type { StructuredEdit } from "@tsukaima/coding";
import { CHECK_TARGET_NAMES, SELF_ITERATION_PLUGIN_ID } from "./domain.ts";
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

/**
 * Model calls take their task from the durable Workspace binding. A supplied `taskId` is only a
 * legacy echo that must equal the binding, and `goal` never creates a task for a model call.
 */
async function boundTaskInput(
	service: SelfIterationService,
	input: Record<string, unknown>,
	invocation: ToolInvocationContext,
	toolName: string,
): Promise<{ readonly sourceConversationId?: string; readonly taskId: string }> {
	const requestedTaskId = stringValue(input, "taskId");
	const taskId = await service.boundTaskId({
		...(invocation.conversationId === undefined
			? {}
			: { conversationId: invocation.conversationId }),
		...(requestedTaskId === undefined ? {} : { requestedTaskId }),
		tool: toolName,
	});
	return {
		taskId,
		...(invocation.conversationId === undefined
			? {}
			: { sourceConversationId: invocation.conversationId }),
	};
}

/**
 * Tools offered in the first request of an authorized Workspace turn. Everything else (today,
 * `upstream`) stays deferred and is loaded through `tool_search` when the model needs it.
 */
const UPFRONT_TOOLS: ReadonlySet<string> = new Set([
	"analyze",
	"worktree",
	"edit",
	"test",
	"build",
	"diff",
	"propose",
	"status",
	// Registered only when the isolated executor is available (see registerSelfIterationTools).
	"exec",
	"check",
]);

export interface SelfIterationToolOptions {
	/**
	 * Whether the isolated executor (bubblewrap) passed its probe. Workspace exec and check tools
	 * are offered only then; without isolation they are not registered at all.
	 */
	readonly isolatedExecution?: boolean;
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
		"path",
		"pattern",
		"command",
		"action",
		"proposalId",
		"target",
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
		policy: {
			...BASE_POLICY,
			lazy: !UPFRONT_TOOLS.has(name),
			maxPayloadBytes: 64 * 1024,
			surface: "coding",
			timeoutMs,
		},
		requiredPermissions,
	};
}

const TASK_FIELDS = {
	taskId: {
		description: "Optional. The task is bound to this Workspace automatically; omit it.",
		type: "string",
	},
} as const;

/** Registers the `self-iteration.*` model tools. Maintenance verbs are intentionally absent. */
export function registerSelfIterationTools(
	context: PluginContext,
	service: SelfIterationService,
	options: SelfIterationToolOptions = {},
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
						...(await boundTaskInput(service, input, invocation, "self-iteration.analyze")),
						action: input.action === "search" || input.action === "test" ? input.action : "read",
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
			"Create the bounded git worktree for this task from its durable base revision. All later writes stay inside it.",
			{
				properties: { ...TASK_FIELDS },
				type: "object",
			},
			["coding.execute"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.worktree", input, invocation, async () =>
					service.worktree(
						await boundTaskInput(service, input, invocation, "self-iteration.worktree"),
					),
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
					return await service.edit({
						...(await boundTaskInput(service, input, invocation, "self-iteration.edit")),
						edit,
					});
				}),
		),
	);

	context.tools.register(
		tool(
			"upstream",
			"Stage a git merge from a ref inside the task worktree without committing, or abort an in-progress merge. Report conflicted files, resolve them with edit, then validate before proposing.",
			{
				properties: {
					...TASK_FIELDS,
					action: { enum: ["abort", "merge"], type: "string" },
					ref: { description: "Commit, branch, or remote-tracking ref to merge.", type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			120_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.upstream", input, invocation, async () =>
					service.upstream({
						...(await boundTaskInput(service, input, invocation, "self-iteration.upstream")),
						action: input.action === "abort" ? "abort" : "merge",
						...(stringValue(input, "ref") === undefined ? {} : { ref: stringValue(input, "ref")! }),
					}),
				),
		),
	);

	context.tools.register(
		tool(
			"test",
			"Run an allowlisted test command with bounded output and a hard timeout.",
			{
				properties: {
					...TASK_FIELDS,
					pattern: { type: "string" },
				},
				type: "object",
			},
			["coding.execute"],
			120_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.test", input, invocation, async () =>
					service.test({
						...(await boundTaskInput(service, input, invocation, "self-iteration.test")),
						...(stringValue(input, "pattern") === undefined
							? {}
							: { pattern: stringValue(input, "pattern")! }),
						...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
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
				},
				type: "object",
			},
			["coding.execute"],
			180_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.build", input, invocation, async () =>
					service.build({
						...(await boundTaskInput(service, input, invocation, "self-iteration.build")),
						...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
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
					service.diff(await boundTaskInput(service, input, invocation, "self-iteration.diff")),
				),
		),
	);

	context.tools.register(
		tool(
			"propose",
			"Submit a deployment proposal for admin approval. The patch, changed files, revision, and validation evidence are derived from the task worktree; supply only the proposal text. Evidence must come from checks run after the last edit.",
			{
				properties: {
					...TASK_FIELDS,
					envChanges: { items: { type: "string" }, type: "array" },
					motivation: { type: "string" },
					requiresRestart: { type: "boolean" },
					riskAssessment: { type: "string" },
					rollbackNotes: { type: "string" },
					title: { type: "string" },
				},
				type: "object",
			},
			["coding.execute", "tasks.create"],
			60_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.propose", input, invocation, async () =>
					service.propose({
						...(await boundTaskInput(service, input, invocation, "self-iteration.propose")),
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
						...(stringArray(input, "envChanges") === undefined
							? {}
							: { envChanges: stringArray(input, "envChanges")! }),
						...(input.requiresRestart === true ? { requiresRestart: true } : {}),
					}),
				),
		),
	);

	if (options.isolatedExecution === true) {
		context.tools.register(
			tool(
				"exec",
				"Run one bash script against a disposable snapshot of the task worktree. The snapshot has no network, a scrubbed environment, and a private /tmp. Writes are discarded when the command ends; persist source changes with self-iteration.edit.",
				{
					properties: {
						...TASK_FIELDS,
						script: {
							description: "Bash script run with -c. Keep it under 16 KiB.",
							type: "string",
						},
					},
					required: ["script"],
					type: "object",
				},
				["coding.execute"],
				300_000,
				async (input, invocation) =>
					invoke(context, log, "self-iteration.exec", input, invocation, async () =>
						service.exec({
							...(await boundTaskInput(service, input, invocation, "self-iteration.exec")),
							script: typeof input.script === "string" ? input.script : "",
							...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
						}),
					),
			),
		);

		context.tools.register(
			tool(
				"check",
				"Run one named repository check (typecheck, lint, test, or webui-build) on a disposable snapshot of the task worktree. The result records the snapshot checksum it validated. Targets are fixed by the server; only test accepts a path filter.",
				{
					properties: {
						...TASK_FIELDS,
						pattern: {
							description: "Optional path filter, only for target test.",
							type: "string",
						},
						target: { enum: [...CHECK_TARGET_NAMES], type: "string" },
					},
					required: ["target"],
					type: "object",
				},
				["coding.execute"],
				600_000,
				async (input, invocation) =>
					invoke(context, log, "self-iteration.check", input, invocation, async () =>
						service.check({
							...(await boundTaskInput(service, input, invocation, "self-iteration.check")),
							target: stringValue(input, "target") ?? "",
							...(stringValue(input, "pattern") === undefined
								? {}
								: { pattern: stringValue(input, "pattern")! }),
							...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
						}),
					),
			),
		);
	}

	context.tools.register(
		tool(
			"status",
			"Return the full task graph, worktree commit/path, timeline, tests/builds, diff, approvals, deployments, and rollback links.",
			{
				properties: { ...TASK_FIELDS },
				type: "object",
			},
			["coding.read"],
			30_000,
			async (input, invocation) =>
				invoke(context, log, "self-iteration.status", input, invocation, async () => {
					const { taskId } = await boundTaskInput(
						service,
						input,
						invocation,
						"self-iteration.status",
					);
					const bundle = await service.status(taskId);
					return {
						approvals: bundle.approvals,
						artifacts: bundle.task.artifacts,
						deployments: bundle.deployments,
						diff: bundle.task.artifacts.filter((artifact) => artifact.kind === "diff"),
						errors: bundle.task.logs.filter((entry) => entry.level === "error"),
						graph: bundle.graph,
						logs: bundle.task.logs,
						proposals: bundle.proposals.map((proposal) => ({
							changedFiles: proposal.changedFiles,
							diffChecksum: proposal.diffChecksum,
							id: proposal.id,
							requiresRestart: proposal.requiresRestart,
							status: proposal.status,
							title: proposal.title,
						})),
						executor: bundle.executor,
						status: bundle.task.status,
						taskId: bundle.task.id,
						timeline: bundle.task.timeline,
						worktree: bundle.worktree,
					};
				}),
		),
	);
}
