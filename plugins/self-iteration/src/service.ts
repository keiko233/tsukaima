import { stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	ANALYSIS_MOUNT,
	applyStructuredEdit,
	assertSafeWorktreePath,
	CodingRunner,
	CodingTools,
	createBubblewrapSandbox,
	describeSandboxAvailability,
	DomainCodingStore,
	ISOLATED_BACKEND_REMEDY,
	measureTaskSnapshot,
	missingProposalFields,
	sha256Hex,
	SandboxUnavailableError,
	SupervisedReloadController,
	validateStructuredEdit,
	WorktreeManager,
	type ArtifactMetadata,
	type ProposalEvidence,
	type ProposalEvidenceItem,
	type SandboxAvailability,
	type SandboxExecutor,
	type TaskSnapshotManifest,
	type DeploymentProposal,
	type DeploymentProposalInput,
	type DeploymentRecord,
	type DeploymentIdentity,
	type EditResult,
	type IterationTask,
	type SandboxProvider,
	type StructuredEdit,
	type TaskArtifact,
	type TaskGraph,
	type TaskGraphNode,
	type TaskLogEntry,
	type TaskTimelineEntry,
	type TestRunResult,
} from "@tsukaima/coding";
import type { PluginAuditApi, PluginLogger, PluginStorage } from "@tsukaima/sdk";
import { elapsedMs, preview, previewCommand, scopedLogger, type ScopedLogger } from "./log.ts";
import {
	CHECK_TARGET_ARGV,
	constraintsFromPolicy,
	DEFAULT_CODING_POLICY,
	isCheckTargetName,
	type CheckTargetName,
	type CodingPolicy,
	type SelfIterationHostBinding,
	type TaskMode,
	mergePolicy,
	normalizePolicy,
	SELF_ITERATION_POLICY_KEY,
} from "./domain.ts";

export interface SelfIterationServiceOptions {
	readonly audit?: PluginAuditApi;
	readonly binding: SelfIterationHostBinding;
	readonly logger?: PluginLogger;
	readonly now?: () => number;
	/** Isolation boundary for model-influenced commands; defaults to a bubblewrap sandbox. */
	readonly sandbox?: SandboxProvider;
	readonly storage?: PluginStorage;
}

export interface CreateTaskRequest {
	readonly baseRef?: string;
	readonly goal: string;
	readonly mode?: TaskMode;
	readonly sourceConversationId?: string;
}

export interface ToolTaskInput {
	readonly goal?: string;
	readonly mode?: TaskMode;
	readonly sourceConversationId?: string;
	readonly taskId?: string;
}

/**
 * Model-authored proposal text only. The patch, changed files, revision, checksums, and validation
 * evidence are derived by the server from the task worktree and never accepted from the caller.
 */
export interface ProposalRequest {
	readonly envChanges?: readonly string[];
	readonly motivation?: string;
	readonly requiresRestart?: boolean;
	readonly riskAssessment?: string;
	readonly rollbackNotes?: string;
	readonly title?: string;
}

export interface DeployRequest {
	readonly approvalId?: string;
	readonly createdBy: string;
	readonly dryRun?: boolean;
	readonly proposalId: string;
}

export interface RollbackRequest {
	readonly createdBy: string;
	readonly deploymentId: string;
	readonly dryRun?: boolean;
}

/** Outcome of one Workspace shell run. Source writes are discarded; only the outcome is kept. */
export interface ExecResult {
	readonly cancelled: boolean;
	readonly durationMs: number;
	readonly exitCode: number | null;
	readonly passed: boolean;
	readonly signal: string | null;
	readonly snapshot: TaskSnapshotManifest;
	readonly stderr: string;
	readonly stderrTruncated: boolean;
	readonly stdout: string;
	readonly stdoutTruncated: boolean;
	readonly taskId: string;
	readonly timedOut: boolean;
}

/** Outcome of one named check target, bound to the snapshot checksum it validated. */
export interface CheckResult extends ExecResult {
	readonly argv: readonly string[];
	readonly summary?: { readonly failed: number; readonly total: number };
	readonly target: CheckTargetName;
}

/** Diff of one worktree state, with the snapshot identity that state was measured as. */
export interface DiffOutcome {
	readonly changedFiles: readonly string[];
	readonly diffChecksum: string;
	readonly raw: string;
	readonly snapshotChecksum: string;
	readonly taskId: string;
	readonly totalDeletions: number;
	readonly totalInsertions: number;
}

/**
 * How a validation result is bound to task content. `checksum` is the snapshot identity the result
 * validated; an absent checksum means the result is unbound and cannot be proposal evidence.
 */
export interface ArtifactProvenance {
	readonly checksum?: string;
	readonly kind: "live" | "snapshot";
	readonly reason?: string;
}

export interface TaskBundle {
	readonly approvals: readonly Awaited<ReturnType<DomainCodingStore["listApprovals"]>>[number][];
	readonly deployments: readonly DeploymentRecord[];
	readonly executor: SandboxAvailability;
	readonly graph: TaskGraph;
	readonly proposals: readonly DeploymentProposal[];
	readonly task: IterationTask;
	readonly worktree: { readonly commit: string | null; readonly path: string | null };
}

const APPROVAL_TTL_MS = 30 * 60_000;
/** Shell used for the Workspace exec tool. It runs with no rc files and no profile. */
const SHELL_COMMAND = "bash";
const SHELL_FLAGS: readonly string[] = ["--noprofile", "--norc"];
/** Artifact kind a check target records, so the proposal evidence can tell checks apart. */
const CHECK_ARTIFACT_KIND: Readonly<Record<CheckTargetName, "build" | "log" | "test">> = {
	lint: "log",
	test: "test",
	typecheck: "log",
	"webui-build": "build",
	"db-generate": "log",
	"check-all": "log",
};
/** Bound on a model-supplied search pattern, so one argument cannot become a payload. */
const MAX_SEARCH_PATTERN_CHARS = 4_000;
const MAX_SEARCH_RESULTS = 100;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Short, stable label for a finished command; cancellation and timeout are never "failed" alone. */
function commandOutcomeLabel(result: {
	readonly cancelled?: boolean;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
}): "cancelled" | "failed" | "passed" | "timed_out" {
	if (result.cancelled === true) return "cancelled";
	if (result.timedOut) return "timed_out";
	return result.exitCode === 0 ? "passed" : "failed";
}

/** A linked worktree has a `.git` file (not a directory) pointing back at the repository. */
async function isWorktreeCheckout(path: string): Promise<boolean> {
	try {
		return (await stat(join(path, ".git"))).isFile();
	} catch {
		return false;
	}
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export class SelfIterationService {
	readonly #audit: PluginAuditApi | undefined;
	readonly #binding: SelfIterationHostBinding;
	readonly #logger: ScopedLogger;
	readonly #now: () => number;
	readonly #sandbox: SandboxProvider;
	readonly #storage: PluginStorage | undefined;
	readonly #worktrees = new Map<string, WorktreeManager>();
	/** In-flight provisioning per task, so concurrent first calls share one `git worktree add`. */
	readonly #provisioning = new Map<string, Promise<IterationTask>>();
	/** Tail of each task's mutation queue; worktree writes and evidence reads run in arrival order. */
	readonly #taskLocks = new Map<string, Promise<void>>();
	/** Counts worktree mutations made through this service, so a live run can prove none happened. */
	readonly #generations = new Map<string, number>();

	constructor(options: SelfIterationServiceOptions) {
		this.#audit = options.audit;
		this.#binding = options.binding;
		this.#logger = scopedLogger(options.logger);
		this.#now = options.now ?? Date.now;
		this.#sandbox =
			options.sandbox ??
			options.binding.sandbox ??
			createBubblewrapSandbox({
				repositoryPath: options.binding.repositoryRoot,
				worktreeRoot: options.binding.worktreeRoot,
			});
		this.#storage = options.storage;
		this.#logger.debug("service created", {
			repositoryRoot: options.binding.repositoryRoot,
			worktreeRoot: options.binding.worktreeRoot,
		});
	}

	get store(): DomainCodingStore {
		return this.#binding.store;
	}

	async policy(): Promise<CodingPolicy> {
		const startedAt = performance.now();
		try {
			const stored = await this.#storage?.global.get<unknown>(SELF_ITERATION_POLICY_KEY);
			const policy =
				stored === undefined ? normalizePolicy(DEFAULT_CODING_POLICY) : normalizePolicy(stored);
			this.#logger.trace("policy loaded", {
				durationMs: elapsedMs(startedAt),
				policy: preview(policy),
				source: stored === undefined ? "default" : "storage",
			});
			return policy;
		} catch (error) {
			this.#logger.warn("policy load failed, using defaults", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
			});
			return normalizePolicy(DEFAULT_CODING_POLICY);
		}
	}

	async updatePolicy(patch: unknown, actor: string): Promise<CodingPolicy> {
		this.#logger.trace("policy update requested", { actor, patch: preview(patch) });
		const next = mergePolicy(await this.policy(), patch);
		await this.#storage?.global.set(SELF_ITERATION_POLICY_KEY, next as never);
		this.#logger.info("policy updated", { actor, policy: preview(next) });
		await this.#auditRecord({
			action: "self-iteration.policy.update",
			actorId: actor,
			actorKind: "user",
			payload: next,
			result: "ok",
			targetKind: "coding-policy",
		});
		return next;
	}

	async createTask(input: CreateTaskRequest): Promise<IterationTask> {
		const startedAt = performance.now();
		const mode = input.mode ?? "maintenance";
		const baseRef = input.baseRef ?? "HEAD";
		this.#logger.trace("task create requested", {
			baseRef,
			goal: preview(input.goal),
			mode,
			sourceConversationId: input.sourceConversationId ?? "system",
		});
		try {
			const policy = await this.policy();
			const task = await this.store.createTask({
				baseRef,
				constraints: constraintsFromPolicy(policy),
				goal: input.goal,
				mode,
				sourceConversationId: input.sourceConversationId ?? "system",
			});
			await this.#recordTimeline(task, "task.create", "success");
			this.#logger.debug("task created", {
				durationMs: elapsedMs(startedAt),
				mode: task.mode,
				status: task.status,
				taskId: task.id,
			});
			await this.#auditRecord({
				action: "self-iteration.task.create",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { goal: task.goal, mode: task.mode },
				result: "ok",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return task;
		} catch (error) {
			this.#logger.error("task creation failed", {
				baseRef,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				mode,
			});
			throw error;
		}
	}

	async getTask(taskId: string): Promise<IterationTask | null> {
		const task = await this.store.getTask(taskId);
		this.#logger.trace("task lookup", { found: task !== null, status: task?.status, taskId });
		return task;
	}

	async listTasks(
		options: { readonly limit?: number; readonly mode?: TaskMode } = {},
	): Promise<readonly IterationTask[]> {
		const tasks = await this.store.listTasks(options);
		this.#logger.trace("task list", {
			count: tasks.length,
			limit: options.limit,
			mode: options.mode,
		});
		return tasks;
	}

	async listProposals(taskId?: string): Promise<readonly DeploymentProposal[]> {
		const proposals = await this.store.listProposals(taskId);
		this.#logger.trace("proposal list", { count: proposals.length, taskId });
		return proposals;
	}

	async getProposal(id: string): Promise<DeploymentProposal | null> {
		const proposal = await this.store.getProposal(id);
		this.#logger.trace("proposal lookup", {
			found: proposal !== null,
			proposalId: id,
			status: proposal?.status,
		});
		return proposal;
	}

	async listApprovals(taskId?: string) {
		const approvals = await this.store.listApprovals(taskId === undefined ? {} : { taskId });
		this.#logger.trace("approval list", { count: approvals.length, taskId });
		return approvals;
	}

	async listDeployments(options: { readonly proposalId?: string; readonly taskId?: string } = {}) {
		const deployments = await this.store.listDeployments(options);
		this.#logger.trace("deployment list", { count: deployments.length, ...options });
		return deployments;
	}

	async overview(): Promise<{
		readonly executor: SandboxAvailability;
		readonly policy: CodingPolicy;
		readonly stats: {
			readonly approvals: number;
			readonly deployments: number;
			readonly proposals: number;
			readonly tasks: number;
		};
		readonly tasks: readonly IterationTask[];
	}> {
		const startedAt = performance.now();
		const [policy, tasks, proposals, approvals, deployments, executor] = await Promise.all([
			this.policy(),
			this.store.listTasks({ limit: 20 }),
			this.store.listProposals(),
			this.store.listApprovals(),
			this.store.listDeployments({ limit: 20 }),
			this.isolatedExecutorStatus(),
		]);
		const stats = {
			approvals: approvals.length,
			deployments: deployments.length,
			proposals: proposals.length,
			tasks: tasks.length,
		};
		this.#logger.debug("overview built", {
			durationMs: elapsedMs(startedAt),
			executor: executor.backend,
			isolated: executor.isolated,
			...stats,
		});
		return { executor, policy, stats, tasks };
	}

	async resolveTask(
		input: ToolTaskInput,
		defaultMode: TaskMode,
		tool: string,
	): Promise<IterationTask> {
		this.#logger.trace("task resolution", {
			goal: preview(input.goal ?? ""),
			mode: input.mode ?? defaultMode,
			taskId: input.taskId,
			tool,
		});
		if (input.taskId !== undefined) {
			const task = await this.store.getTask(input.taskId);
			if (task === null) {
				this.#logger.warn("task resolution failed", {
					reason: "unknown_task",
					taskId: input.taskId,
					tool,
				});
				throw new Error(`unknown_task:${input.taskId}`);
			}
			this.#logger.debug("task resolved", {
				mode: task.mode,
				status: task.status,
				taskId: task.id,
				tool,
			});
			return task;
		}
		const goal = input.goal?.trim();
		if (goal === undefined || goal.length === 0) {
			this.#logger.warn("task resolution failed", { reason: "missing_task_id_and_goal", tool });
			throw new Error("taskId or goal is required");
		}
		const task = await this.createTask({
			goal,
			mode: input.mode ?? defaultMode,
			sourceConversationId: input.sourceConversationId ?? "agent",
		});
		await this.#recordTimeline(task, tool, "success");
		this.#logger.debug("task created for tool", { mode: task.mode, taskId: task.id, tool });
		return task;
	}

	/**
	 * Task a model tool call operates on. The durable Workspace binding is authoritative; a
	 * supplied `taskId` is only a legacy echo and must equal it. Model calls never create tasks,
	 * so a conversation without a bound task cannot reach coding state by accident.
	 */
	async boundTaskId(input: {
		readonly conversationId?: string;
		readonly requestedTaskId?: string;
		readonly tool: string;
	}): Promise<string> {
		const conversationId = input.conversationId;
		const lookup = this.#binding.workspaceTaskFor;
		const bound =
			conversationId === undefined || lookup === undefined
				? undefined
				: await lookup(conversationId);
		if (bound === null || bound === undefined) {
			this.#logger.warn("task binding missing", { tool: input.tool });
			await this.#auditRecord({
				action: "self-iteration.task.binding_missing",
				actorId: conversationId ?? "agent",
				actorKind: "agent",
				payload: { tool: input.tool },
				reason: "task_binding_missing",
				result: "denied",
				targetKind: "workspace",
			});
			throw new Error("task_binding_missing");
		}
		if (input.requestedTaskId !== undefined && input.requestedTaskId !== bound) {
			this.#logger.warn("task binding mismatch", {
				requested: input.requestedTaskId,
				tool: input.tool,
			});
			await this.#auditRecord({
				action: "self-iteration.task.binding_mismatch",
				actorId: conversationId ?? "agent",
				actorKind: "agent",
				payload: { requestedTaskId: input.requestedTaskId, tool: input.tool },
				reason: "task_binding_mismatch",
				result: "denied",
				targetId: bound,
				targetKind: "coding-task",
			});
			throw new Error("task_binding_mismatch");
		}
		return bound;
	}

	/**
	 * Provision the task worktree exactly once. First edit, validation, and the explicit worktree
	 * tool all converge here. Concurrent callers share one in-flight creation, and a retry after a
	 * partial failure adopts the checkout already at the task's deterministic path.
	 */
	async #ensureWorktree(
		task: IterationTask,
		options: { readonly actor: string; readonly tool: string },
	): Promise<IterationTask> {
		const current = (await this.store.getTask(task.id)) ?? task;
		if (current.worktreePath !== undefined) return current;
		const pending = this.#provisioning.get(task.id);
		if (pending !== undefined) return pending;
		const provisioning = this.#provisionWorktree(current, options).finally(() => {
			this.#provisioning.delete(task.id);
		});
		this.#provisioning.set(task.id, provisioning);
		return provisioning;
	}

	async #provisionWorktree(
		task: IterationTask,
		options: { readonly actor: string; readonly tool: string },
	): Promise<IterationTask> {
		const startedAt = performance.now();
		const policy = await this.policy();
		const manager = this.#managerFor(task.id, policy);
		const path = manager.pathFor(task.id);
		// The durable task base is the only baseline: model calls cannot choose another revision.
		const baseRef = task.baseRef;
		try {
			const adopted = await isWorktreeCheckout(path);
			if (adopted) {
				this.#logger.debug("worktree adopted from earlier attempt", { path, taskId: task.id });
			} else {
				this.#logger.debug("worktree create started", { baseRef, taskId: task.id });
				const info = await manager.create(task.id, baseRef);
				this.#logger.debug("worktree created", {
					baseRef: info.baseRef,
					branchName: info.branchName,
					durationMs: elapsedMs(startedAt),
					path: info.path,
					taskId: task.id,
				});
				await this.#auditRecord({
					action: "self-iteration.worktree.create",
					actorId: options.actor,
					actorKind: "agent",
					payload: { baseRef: info.baseRef, branch: info.branchName, path: info.path },
					result: "ok",
					targetId: task.id,
					targetKind: "coding-task",
				});
			}
			const latest = (await this.store.getTask(task.id)) ?? task;
			await this.store.updateTask(task.id, {
				status: "in_progress",
				timeline: [
					...latest.timeline,
					{
						atMs: this.#now(),
						detail: path,
						outcome: "success" as const,
						tool: options.tool,
					},
				],
				worktreePath: path,
			});
			await this.#log(task, "info", `worktree ready at ${path}`);
			return (await this.store.getTask(task.id)) ?? task;
		} catch (error) {
			this.#logger.error("worktree provisioning failed", {
				baseRef,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditFailure(task.id, options.tool, error);
			throw error;
		}
	}

	async #requireMode(task: IterationTask, required: TaskMode, tool: string): Promise<void> {
		// Workspaces are the full-authority coding surface. The stored mode is lineage only;
		// legacy rows created under the old gated model keep exactly the same tool access.
		this.#logger.trace("mode gate bypassed", {
			mode: task.mode,
			required,
			taskId: task.id,
			tool,
		});
	}

	async analyze(
		input: ToolTaskInput & {
			readonly action?: "read" | "search" | "test";
			readonly args?: readonly string[];
			readonly command?: string;
			readonly maxBytes?: number;
			readonly path?: string;
			readonly pattern?: string;
		},
	): Promise<Record<string, unknown>> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "analysis", "self-iteration.analyze");
		const action = input.action ?? "read";
		const policy = await this.policy();
		this.#logger.trace("analyze requested", {
			action,
			maxBytes: input.maxBytes,
			path: input.path,
			pattern: preview(input.pattern ?? ""),
			taskId: task.id,
		});
		try {
			if (action === "read" || action === "search") {
				// Analysis reads a committed snapshot mounted read-only in the sandbox. The live
				// repository (dotenv files, data/, nested secrets) is never an analysis surface.
				const sandbox = await this.#sandbox();
				// Analysis runs from a worktree so the sandbox never binds the live repository. A
				// patch task reads its own worktree (with edits); a read-only task reads the
				// committed snapshot. Neither surface is the live repository.
				const analysisCwd = task.worktreePath ?? (await this.#analysisCwd());
				const analysisSource =
					task.worktreePath === undefined ? {} : { analysisTree: task.worktreePath };
				if (action === "read") {
					if (input.path === undefined) throw new Error("path is required for read");
					const analysisPath = await this.#analysisPath(policy, input.path);
					const maxBytes = input.maxBytes ?? policy.maxOutputBytes;
					const result = await sandbox.exec({
						// `head` reads only the requested prefix; the path stays positional after `--`.
						args: ["-c", String(maxBytes), "--", `${ANALYSIS_MOUNT}/${analysisPath}`],
						command: "head",
						cwd: analysisCwd,
						...analysisSource,
						...(task.worktreePath === undefined
							? { analysisRevision: task.baseRef, exportAnalysis: true }
							: {}),
						maxOutputBytes: maxBytes,
						timeoutMs: policy.timeoutMs,
						writable: false,
					});
					if (result.exitCode !== 0) {
						throw new Error(`analysis_read_failed:${result.stderr.trim() || result.exitCode}`);
					}
					const content = result.stdout;
					await this.#recordTimeline(task, "self-iteration.analyze:read", "success", analysisPath);
					this.#logger.debug("analyze read completed", {
						bytes: Buffer.byteLength(content, "utf-8"),
						durationMs: elapsedMs(startedAt),
						path: analysisPath,
						sandbox: sandbox.id,
						taskId: task.id,
						truncated: result.stdoutTruncated,
					});
					return {
						action,
						content,
						path: analysisPath,
						truncated: result.stdoutTruncated,
					};
				}
				if (input.pattern === undefined || input.pattern.length === 0) {
					throw new Error("pattern is required for search");
				}
				if (input.pattern.length > MAX_SEARCH_PATTERN_CHARS) {
					throw new Error(`pattern_too_long:${input.pattern.length}>${MAX_SEARCH_PATTERN_CHARS}`);
				}
				if (!policy.allowedCommands.includes("rg")) {
					throw new Error("command_not_allowed:rg");
				}
				const analysisPath =
					input.path === undefined ? undefined : await this.#analysisPath(policy, input.path);
				// The pattern and path are positional arguments after `--`: a leading dash can
				// never turn into an `rg` flag such as `--pre`, which executes a command.
				const result = await sandbox.exec({
					args: [
						"--line-number",
						"--max-count",
						String(MAX_SEARCH_RESULTS),
						"--color",
						"never",
						"--",
						input.pattern,
						...(analysisPath === undefined
							? [ANALYSIS_MOUNT]
							: [`${ANALYSIS_MOUNT}/${analysisPath}`]),
					],
					command: "rg",
					cwd: analysisCwd,
					...analysisSource,
					...(task.worktreePath === undefined
						? { analysisRevision: task.baseRef, exportAnalysis: true }
						: {}),
					maxOutputBytes: policy.maxOutputBytes,
					timeoutMs: policy.timeoutMs,
					writable: false,
				});
				await this.#recordTimeline(task, "self-iteration.analyze:search", "success", input.pattern);
				this.#logger.debug("analyze search completed", {
					durationMs: elapsedMs(startedAt),
					exitCode: result.exitCode,
					pattern: preview(input.pattern),
					sandbox: sandbox.id,
					taskId: task.id,
					truncated: result.stdoutTruncated || result.stderrTruncated,
				});
				return {
					action,
					exitCode: result.exitCode,
					output: result.stdout,
					truncated: result.stdoutTruncated || result.stderrTruncated,
				};
			}
			if (action === "test") {
				const result = await this.test({ ...input, taskId: task.id });
				return { ...result, action };
			}
			this.#logger.warn("analyze action denied", { action, taskId: task.id });
			await this.#recordTimeline(task, `self-iteration.analyze:${action}`, "denied");
			await this.#auditDenied(task.id, "self-iteration.analyze", `action_denied:${action}`);
			throw new Error(`analysis only permits read/search/test, received "${action}"`);
		} catch (error) {
			this.#logger.error("analyze failed", {
				action,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditFailure(task.id, "self-iteration.analyze", error);
			throw error;
		}
	}

	async worktree(input: ToolTaskInput): Promise<Record<string, unknown>> {
		const task = await this.resolveTask(input, "patch", "self-iteration.worktree");
		await this.#requireMode(task, "patch", "self-iteration.worktree");
		const provisioned = await this.#ensureWorktree(task, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.worktree",
		});
		return { baseRef: provisioned.baseRef, path: provisioned.worktreePath, taskId: task.id };
	}

	async edit(
		input: ToolTaskInput & { readonly edit?: StructuredEdit } & Partial<StructuredEdit>,
	): Promise<EditResult & { readonly taskId: string }> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.edit");
		await this.#requireMode(task, "patch", "self-iteration.edit");
		const current = await this.#ensureWorktree(task, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.edit",
		});
		const policy = await this.policy();
		const edit: StructuredEdit = input.edit ?? {
			...(input.content === undefined ? {} : { content: input.content }),
			...(input.create === undefined ? {} : { create: input.create }),
			...(input.find === undefined ? {} : { find: input.find }),
			path: input.path ?? "",
			...(input.replace === undefined ? {} : { replace: input.replace }),
		};
		this.#logger.trace("edit requested", {
			create: edit.create,
			find: preview(edit.find ?? ""),
			path: edit.path,
			replace: preview(edit.replace ?? ""),
			taskId: task.id,
		});
		try {
			validateStructuredEdit(edit, { maxBytes: policy.maxOutputBytes });
			const result = await this.#mutateWorktree(task.id, () =>
				applyStructuredEdit(current.worktreePath!, current.constraints.pathAllowlist, edit, {
					maxBytes: policy.maxOutputBytes,
				}),
			);
			this.#logger.debug("edit applied", {
				bytesWritten: result.bytesWritten,
				checksum: result.checksum,
				created: result.created,
				durationMs: elapsedMs(startedAt),
				path: result.path,
				taskId: task.id,
			});
			const artifact: TaskArtifact = {
				checksum: result.checksum,
				kind: "patch",
				name: result.path,
				path: result.path,
				sizeBytes: result.bytesWritten,
			};
			const latest = (await this.store.getTask(task.id)) ?? current;
			await this.store.updateTask(task.id, {
				artifacts: [...latest.artifacts, artifact],
				timeline: [
					...latest.timeline,
					{
						atMs: this.#now(),
						detail: result.path,
						outcome: "success" as const,
						tool: "self-iteration.edit",
					},
				],
			});
			await this.#auditRecord({
				action: "self-iteration.edit",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { checksum: result.checksum, created: result.created, path: result.path },
				result: "ok",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return { ...result, taskId: task.id };
		} catch (error) {
			this.#logger.error("edit failed", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				path: edit.path,
				taskId: task.id,
			});
			await this.#recordTimeline(task, "self-iteration.edit", "denied", errorMessage(error));
			await this.#auditDenied(task.id, "self-iteration.edit", errorMessage(error));
			throw error;
		}
	}

	/**
	 * Stage an upstream merge inside the task worktree without committing it. The proposal
	 * diff is computed against HEAD, so committing here would hide every merged change from
	 * review. Conflicts are reported so the agent can resolve them with `edit`; finalize
	 * commits the staged merge state.
	 */
	async upstream(
		input: ToolTaskInput & {
			readonly action?: "abort" | "merge";
			readonly ref?: string;
		},
	): Promise<Record<string, unknown>> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.upstream");
		await this.#requireMode(task, "patch", "self-iteration.upstream");
		const current = await this.#ensureWorktree(task, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.upstream",
		});
		const policy = await this.policy();
		const action = input.action === "abort" ? "abort" : "merge";
		const worktreePath = current.worktreePath!;
		const runner = await this.#runner(worktreePath, policy);
		this.#logger.trace("upstream action requested", {
			action,
			ref: preview(input.ref ?? ""),
			taskId: task.id,
		});
		try {
			if (action === "abort") {
				const result = await this.#mutateWorktree(task.id, () =>
					runner.exec("git", ["merge", "--abort"]),
				);
				await this.#recordTimeline(
					task,
					"self-iteration.upstream:abort",
					result.exitCode === 0 ? "success" : "failure",
				);
				return {
					action,
					exitCode: result.exitCode,
					stderr: result.stderr,
					stdout: result.stdout,
					taskId: task.id,
				};
			}
			const ref = input.ref?.trim();
			if (ref === undefined || ref.length === 0) throw new Error("ref is required");
			const resolved = await runner.exec("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
			if (resolved.exitCode !== 0) {
				throw new Error(`unknown_ref:${ref}`);
			}
			const result = await this.#mutateWorktree(task.id, () =>
				runner.exec("git", ["merge", "--no-ff", "--no-commit", ref]),
			);
			const conflicts = await runner.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
			const conflicted = conflicts.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			const alreadyMerged = result.stdout.includes("Already up to date");
			await this.#recordTimeline(
				task,
				"self-iteration.upstream:merge",
				conflicted.length > 0 ? "denied" : "success",
				conflicted.length > 0 ? conflicted.join(",") : ref,
			);
			await this.#auditRecord({
				action: "self-iteration.upstream",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: {
					action,
					conflicted: conflicted.length,
					exitCode: result.exitCode,
					ref,
				},
				result: conflicted.length > 0 ? "failed" : "ok",
				targetId: task.id,
				targetKind: "coding-task",
			});
			this.#logger.debug("upstream merge staged", {
				action,
				alreadyMerged,
				conflicted: conflicted.length,
				durationMs: elapsedMs(startedAt),
				exitCode: result.exitCode,
				taskId: task.id,
			});
			return {
				action,
				alreadyMerged,
				conflicted,
				exitCode: result.exitCode,
				stderr: result.stderr,
				stdout: result.stdout,
				taskId: task.id,
			};
		} catch (error) {
			this.#logger.error("upstream action failed", {
				action,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.upstream", errorMessage(error));
			throw error;
		}
	}

	async test(
		input: ToolTaskInput & {
			readonly args?: readonly string[];
			readonly command?: string;
			readonly pattern?: string;
			readonly signal?: AbortSignal;
		},
	): Promise<TestRunResult & { readonly taskId: string }> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "patch", "self-iteration.test");
		const policy = await this.policy();
		// Test and build never run against the live tree: a command that can write (or read the
		// repository's own dotenv files) must stay inside the disposable worktree.
		const task = await this.#ensureWorktree(resolved, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.test",
		});
		const worktreePath = task.worktreePath;
		const command = policy.testCommand[0] ?? "bun";
		let args: readonly string[] = [];
		try {
			if (worktreePath === undefined) throw new Error("worktree_required");
			this.#rejectCommandOverride(input.command, input.args, command, "test");
			args = [...policy.testCommand.slice(1), ...this.#testPatternArgs(input.pattern)];
			this.#logger.trace("test started", {
				command: previewCommand(command, args),
				worktreePath,
			});
			if (!policy.allowedCommands.includes(command)) {
				this.#logger.warn("test command not allowed", { command, taskId: task.id });
				throw new Error(`command_not_allowed:${command}`);
			}
			const sandbox = await this.#sandbox();
			const { provenance, result } = await this.#measuredLiveRun(task.id, worktreePath, () =>
				sandbox.exec({
					args,
					command,
					cwd: worktreePath,
					maxOutputBytes: policy.maxOutputBytes,
					...(input.signal === undefined ? {} : { signal: input.signal }),
					timeoutMs: policy.timeoutMs,
					writable: true,
				}),
			);
			const parsed = parseTest(result);
			this.#logger.debug("test completed", {
				command,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				failed: parsed.failed,
				passed: parsed.passed,
				passedCount: parsed.total - parsed.failed,
				sandbox: sandbox.id,
				taskId: task.id,
				timedOut: result.timedOut,
				total: parsed.total,
			});
			const artifacts = [...((await this.store.getTask(task.id))?.artifacts ?? [])];
			const metadata = {
				args,
				cancelled: result.cancelled === true,
				command,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				failed: parsed.failed,
				passed: parsed.passed && !result.timedOut && result.cancelled !== true,
				provenance,
				timedOut: result.timedOut,
				total: parsed.total,
			};
			await this.store.updateTask(task.id, {
				artifacts: [
					...artifacts,
					{
						kind: "test",
						metadata,
						name: `${command} ${args.join(" ")}`.trim(),
					},
				],
				timeline: [
					...((await this.store.getTask(task.id))?.timeline ?? []),
					{
						atMs: this.#now(),
						detail: parsed.passed ? "passed" : "failed",
						outcome: parsed.passed ? "success" : "failure",
						tool: "self-iteration.test",
					},
				],
			});
			await this.#log(
				task,
				parsed.passed ? "info" : "error",
				`test ${parsed.passed ? "passed" : "failed"}`,
			);
			await this.#auditRecord({
				action: "self-iteration.test",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { args, command, exitCode: result.exitCode, timedOut: result.timedOut },
				result: parsed.passed ? "ok" : "failed",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return { ...parsed, taskId: task.id };
		} catch (error) {
			this.#logger.error("test failed to run", {
				command: previewCommand(command, args),
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.test", errorMessage(error));
			throw error;
		}
	}

	async build(
		input: ToolTaskInput & {
			readonly args?: readonly string[];
			readonly command?: string;
			readonly signal?: AbortSignal;
		},
	): Promise<{
		readonly artifactMetadata: ArtifactMetadata;
		readonly exitCode: number | null;
		readonly stderr: string;
		readonly stdout: string;
		readonly success: boolean;
		readonly taskId: string;
	}> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "proposal", "self-iteration.build");
		await this.#requireMode(resolved, "proposal", "self-iteration.build");
		const policy = await this.policy();
		const task = await this.#ensureWorktree(resolved, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.build",
		});
		const worktreePath = task.worktreePath;
		const command = policy.buildCommand[0] ?? "bun";
		const args = policy.buildCommand.slice(1);
		this.#logger.trace("build started", {
			command: previewCommand(command, args),
			worktreePath,
		});
		try {
			if (worktreePath === undefined) throw new Error("worktree_required");
			this.#rejectCommandOverride(input.command, input.args, command, "build");
			if (!policy.allowedCommands.includes(command)) {
				this.#logger.warn("build command not allowed", { command, taskId: task.id });
				throw new Error(`command_not_allowed:${command}`);
			}
			const sandbox = await this.#sandbox();
			const { provenance, result } = await this.#measuredLiveRun(task.id, worktreePath, () =>
				sandbox.exec({
					args,
					command,
					cwd: worktreePath,
					maxOutputBytes: policy.maxOutputBytes,
					...(input.signal === undefined ? {} : { signal: input.signal }),
					timeoutMs: policy.timeoutMs,
					writable: true,
				}),
			);
			this.#logger.debug("build command completed", {
				command,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				sandbox: sandbox.id,
				taskId: task.id,
				timedOut: result.timedOut,
			});
			const artifactMetadata: ArtifactMetadata = {
				builtAtMs: this.#now(),
				checksum: sha256Hex(`${command}\0${args.join("\0")}\0${result.stdout}\0${result.stderr}`),
				command: [command, ...args].join(" "),
				sizeBytes: Buffer.byteLength(result.stdout, "utf-8"),
			};
			const latest = (await this.store.getTask(task.id)) ?? task;
			const metadata = {
				...artifactMetadata,
				cancelled: result.cancelled === true,
				exitCode: result.exitCode,
				passed: result.exitCode === 0 && !result.timedOut && result.cancelled !== true,
				provenance,
				timedOut: result.timedOut,
			};
			await this.store.updateTask(task.id, {
				artifacts: [
					...latest.artifacts,
					{
						checksum: artifactMetadata.checksum,
						kind: "build",
						metadata,
						name: artifactMetadata.command,
					},
				],
				timeline: [
					...latest.timeline,
					{
						atMs: this.#now(),
						detail: artifactMetadata.checksum,
						outcome: result.exitCode === 0 ? "success" : "failure",
						tool: "self-iteration.build",
					},
				],
			});
			this.#logger.debug("build artifact recorded", {
				checksum: artifactMetadata.checksum,
				durationMs: elapsedMs(startedAt),
				sizeBytes: artifactMetadata.sizeBytes,
				success: result.exitCode === 0,
				taskId: task.id,
			});
			await this.#auditRecord({
				action: "self-iteration.build",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { args, checksum: artifactMetadata.checksum, command, exitCode: result.exitCode },
				result: result.exitCode === 0 ? "ok" : "failed",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				...result,
				artifactMetadata,
				success: result.exitCode === 0,
				taskId: task.id,
			};
		} catch (error) {
			this.#logger.error("build failed", {
				command: previewCommand(command, args),
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.build", errorMessage(error));
			throw error;
		}
	}

	/** Whether commands can run isolated right now, and the operator action when they cannot. */
	async isolatedExecutorStatus(): Promise<SandboxAvailability> {
		return await describeSandboxAvailability(this.#sandbox);
	}

	/**
	 * The only executor a Workspace shell or check may use. The host backend and any provider
	 * failure stop here, before a worktree command is prepared, so no ungoverned process starts.
	 */
	async #isolatedExecutor(): Promise<SandboxExecutor> {
		const executor = await this.#sandbox();
		if (!executor.isolated) {
			throw new SandboxUnavailableError(
				`the ${executor.id} backend runs commands without OS isolation`,
				{ code: "backend_not_isolated", remedy: ISOLATED_BACKEND_REMEDY },
			);
		}
		return executor;
	}

	/** Gate before any worktree is provisioned, so a refused request leaves no checkout behind. */
	async #requireIsolatedExecutor(taskId: string, tool: string): Promise<SandboxExecutor> {
		try {
			return await this.#isolatedExecutor();
		} catch (error) {
			await this.#auditDenied(taskId, tool, errorMessage(error));
			throw error;
		}
	}

	/**
	 * Run a shell script against a disposable snapshot of the task worktree. The script is one
	 * `bash -c` argument; its writes, temporary files, and generated outputs are discarded when
	 * it ends, and persistent changes must go through the path-checked edit tool.
	 */
	async exec(
		input: ToolTaskInput & { readonly script: string; readonly signal?: AbortSignal },
	): Promise<ExecResult> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "patch", "self-iteration.exec");
		const policy = await this.policy();
		const scriptBytes = Buffer.byteLength(input.script, "utf-8");
		const scriptSha256 = sha256Hex(input.script);
		if (input.script.trim().length === 0) throw new Error("script is required");
		if (input.script.includes("\0")) throw new Error("invalid_script");
		if (scriptBytes > policy.maxScriptBytes) {
			throw new Error(`script_too_large:${scriptBytes}>${policy.maxScriptBytes}`);
		}
		const executor = await this.#requireIsolatedExecutor(resolved.id, "self-iteration.exec");
		const task = await this.#ensureWorktree(resolved, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.exec",
		});
		try {
			if (task.worktreePath === undefined) throw new Error("worktree_required");
			const result = await executor.exec({
				args: [...SHELL_FLAGS, "-c", input.script],
				command: SHELL_COMMAND,
				cwd: task.worktreePath,
				...(policy.execNetwork === "outbound" ? { network: "outbound" as const } : {}),
				maxOutputBytes: policy.maxOutputBytes,
				snapshot: true,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				timeoutMs: policy.execTimeoutMs,
				writable: true,
			});
			if (result.snapshot === undefined) throw new Error("snapshot_provenance_missing");
			const passed = result.exitCode === 0 && !result.timedOut && result.cancelled !== true;
			const outcome = commandOutcomeLabel(result);
			await this.#recordTimeline(
				task,
				"self-iteration.exec",
				passed ? "success" : "failure",
				outcome,
			);
			this.#logger.debug("exec completed", {
				cancelled: result.cancelled === true,
				durationMs: elapsedMs(startedAt),
				exitCode: result.exitCode,
				scriptBytes,
				snapshotChecksum: result.snapshot.checksum,
				taskId: task.id,
				timedOut: result.timedOut,
			});
			await this.#auditRecord({
				action: "self-iteration.exec",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: {
					cancelled: result.cancelled === true,
					exitCode: result.exitCode,
					scriptBytes,
					scriptSha256,
					snapshotChecksum: result.snapshot.checksum,
					timedOut: result.timedOut,
				},
				...(passed ? { result: "ok" as const } : { reason: outcome, result: "failed" as const }),
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				cancelled: result.cancelled === true,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				passed,
				signal: result.signal,
				snapshot: result.snapshot,
				stderr: result.stderr,
				stderrTruncated: result.stderrTruncated,
				stdout: result.stdout,
				stdoutTruncated: result.stdoutTruncated,
				taskId: task.id,
				timedOut: result.timedOut,
			};
		} catch (error) {
			this.#logger.error("exec failed", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.exec", errorMessage(error));
			throw error;
		}
	}

	/**
	 * Run one command from the policy allowlist against a disposable snapshot of the task
	 * worktree. The model picks the program and its arguments; governance comes from the fixed
	 * allowlist, the OS sandbox, and the same discarded-snapshot semantics as exec. Built for
	 * targeted git and bun invocations that the fixed check targets cannot express.
	 */
	async shell(
		input: ToolTaskInput & {
			readonly args?: readonly string[];
			readonly command: string;
			readonly signal?: AbortSignal;
		},
	): Promise<ExecResult> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "patch", "self-iteration.shell");
		const policy = await this.policy();
		const command = input.command.trim();
		if (command.length === 0) throw new Error("command is required");
		if (!policy.allowedCommands.includes(command)) {
			this.#logger.warn("shell command not allowed", { command, taskId: resolved.id });
			await this.#auditDenied(
				resolved.id,
				"self-iteration.shell",
				`command_not_allowed:${command}`,
			);
			throw new Error(`command_not_allowed:${command}`);
		}
		const args = (input.args ?? []).map((arg) => {
			if (typeof arg !== "string") throw new Error("invalid_args");
			if (arg.includes("\0")) throw new Error("invalid_args");
			return arg;
		});
		const executor = await this.#requireIsolatedExecutor(resolved.id, "self-iteration.shell");
		const task = await this.#ensureWorktree(resolved, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.shell",
		});
		try {
			if (task.worktreePath === undefined) throw new Error("worktree_required");
			const result = await executor.exec({
				args,
				command,
				cwd: task.worktreePath,
				...(policy.execNetwork === "outbound" ? { network: "outbound" as const } : {}),
				maxOutputBytes: policy.maxOutputBytes,
				snapshot: true,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				timeoutMs: policy.execTimeoutMs,
				writable: true,
			});
			if (result.snapshot === undefined) throw new Error("snapshot_provenance_missing");
			const passed = result.exitCode === 0 && !result.timedOut && result.cancelled !== true;
			const outcome = commandOutcomeLabel(result);
			await this.#recordTimeline(
				task,
				"self-iteration.shell",
				passed ? "success" : "failure",
				`${command}:${outcome}`,
			);
			this.#logger.debug("shell completed", {
				argsCount: args.length,
				cancelled: result.cancelled === true,
				command,
				durationMs: elapsedMs(startedAt),
				exitCode: result.exitCode,
				snapshotChecksum: result.snapshot.checksum,
				taskId: task.id,
				timedOut: result.timedOut,
			});
			await this.#auditRecord({
				action: "self-iteration.shell",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: {
					argsCount: args.length,
					cancelled: result.cancelled === true,
					command,
					exitCode: result.exitCode,
					snapshotChecksum: result.snapshot.checksum,
					timedOut: result.timedOut,
				},
				...(passed ? { result: "ok" as const } : { reason: outcome, result: "failed" as const }),
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				cancelled: result.cancelled === true,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				passed,
				signal: result.signal,
				snapshot: result.snapshot,
				stderr: result.stderr,
				stderrTruncated: result.stderrTruncated,
				stdout: result.stdout,
				stdoutTruncated: result.stdoutTruncated,
				taskId: task.id,
				timedOut: result.timedOut,
			};
		} catch (error) {
			this.#logger.error("shell failed", {
				command,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.shell", errorMessage(error));
			throw error;
		}
	}

	/**
	 * Run one named check on a disposable snapshot of the task worktree. The recorded artifact
	 * carries the snapshot checksum, so later proposal evidence can tell which content was checked.
	 */
	async check(
		input: ToolTaskInput & {
			readonly pattern?: string;
			readonly signal?: AbortSignal;
			readonly target: string;
		},
	): Promise<CheckResult> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "patch", "self-iteration.check");
		if (!isCheckTargetName(input.target)) {
			this.#logger.warn("check target rejected", {
				target: preview(input.target),
				taskId: resolved.id,
			});
			await this.#auditDenied(
				resolved.id,
				"self-iteration.check",
				`unknown_check_target:${input.target}`,
			);
			throw new Error(`unknown_check_target:${input.target}`);
		}
		const target = input.target;
		const argv: readonly string[] =
			target === "test"
				? [...CHECK_TARGET_ARGV.test, ...this.#testPatternArgs(input.pattern)]
				: input.pattern === undefined
					? CHECK_TARGET_ARGV[target]
					: (() => {
							throw new Error(`pattern_not_supported:${target}`);
						})();
		const policy = await this.policy();
		if (!policy.allowedCommands.includes(argv[0] ?? "")) {
			throw new Error(`command_not_allowed:${argv[0] ?? ""}`);
		}
		const executor = await this.#requireIsolatedExecutor(resolved.id, "self-iteration.check");
		const task = await this.#ensureWorktree(resolved, {
			actor: input.sourceConversationId ?? "agent",
			tool: "self-iteration.check",
		});
		try {
			if (task.worktreePath === undefined) throw new Error("worktree_required");
			const result = await executor.exec({
				args: argv.slice(1),
				command: argv[0] ?? "bun",
				cwd: task.worktreePath,
				maxOutputBytes: policy.maxOutputBytes,
				snapshot: true,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				timeoutMs: policy.checkTimeoutMs,
				writable: true,
			});
			if (result.snapshot === undefined) throw new Error("snapshot_provenance_missing");
			const passed = result.exitCode === 0 && !result.timedOut && result.cancelled !== true;
			const parsed = target === "test" ? parseTest(result) : undefined;
			const summary =
				parsed === undefined ? undefined : { failed: parsed.failed, total: parsed.total };
			const checksum = sha256Hex(
				`${target}\0${result.snapshot.checksum}\0${result.exitCode ?? "null"}\0${result.stdout}\0${result.stderr}`,
			);
			const outcome = commandOutcomeLabel(result);
			const latest = (await this.store.getTask(task.id)) ?? task;
			await this.store.updateTask(task.id, {
				artifacts: [
					...latest.artifacts,
					{
						checksum,
						kind: CHECK_ARTIFACT_KIND[target],
						metadata: {
							argv: [...argv],
							builtAtMs: this.#now(),
							cancelled: result.cancelled === true,
							command: argv.join(" "),
							durationMs: result.durationMs,
							exitCode: result.exitCode,
							passed,
							provenance: { checksum: result.snapshot.checksum, kind: "snapshot" },
							snapshot: { ...result.snapshot },
							target,
							timedOut: result.timedOut,
							...(summary === undefined ? {} : { failed: summary.failed, total: summary.total }),
						},
						name: `check:${target}`,
					},
				],
			});
			await this.#recordTimeline(
				task,
				"self-iteration.check",
				passed ? "success" : "failure",
				`${target}:${outcome}`,
			);
			await this.#log(task, passed ? "info" : "error", `check ${target} ${outcome}`);
			this.#logger.debug("check completed", {
				durationMs: elapsedMs(startedAt),
				exitCode: result.exitCode,
				snapshotChecksum: result.snapshot.checksum,
				target,
				taskId: task.id,
			});
			await this.#auditRecord({
				action: "self-iteration.check",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: {
					argv: [...argv],
					cancelled: result.cancelled === true,
					exitCode: result.exitCode,
					snapshotChecksum: result.snapshot.checksum,
					target,
					timedOut: result.timedOut,
				},
				...(passed ? { result: "ok" as const } : { reason: outcome, result: "failed" as const }),
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				argv: [...argv],
				cancelled: result.cancelled === true,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				passed,
				signal: result.signal,
				snapshot: result.snapshot,
				stderr: result.stderr,
				stderrTruncated: result.stderrTruncated,
				stdout: result.stdout,
				stdoutTruncated: result.stdoutTruncated,
				taskId: task.id,
				target,
				timedOut: result.timedOut,
				...(summary === undefined ? {} : { summary }),
			};
		} catch (error) {
			this.#logger.error("check failed to run", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				target,
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.check", errorMessage(error));
			throw error;
		}
	}

	async diff(input: ToolTaskInput): Promise<DiffOutcome> {
		const task = await this.resolveTask(input, "patch", "self-iteration.diff");
		return this.#withTaskLock(task.id, () => this.#diffUnlocked(task, input));
	}

	/**
	 * Diff and snapshot identity of one worktree state. The caller holds the task lock, so no edit
	 * can land between the diff and the identity that describes it.
	 */
	async #diffUnlocked(task: IterationTask, input: ToolTaskInput): Promise<DiffOutcome> {
		const startedAt = performance.now();
		await this.#requireMode(task, "patch", "self-iteration.diff");
		const current = await this.#taskWithWorktree(task);
		const policy = await this.policy();
		this.#logger.trace("diff started", {
			taskId: task.id,
			worktreePath: current.worktreePath,
		});
		try {
			const result = await new CodingTools(
				await this.#runner(current.worktreePath!, policy),
			).diff();
			if (result.untrackedTruncated === true) {
				// Untracked files past the expansion bound would be missing from the proposal while the
				// snapshot still carries them, so the diff must not describe this state as complete.
				throw new Error("diff_incomplete:untracked_limit");
			}
			if (result.files.length > policy.maxDiffFiles) {
				this.#logger.warn("diff exceeds file limit", {
					files: result.files.length,
					maxDiffFiles: policy.maxDiffFiles,
					taskId: task.id,
				});
				throw new Error(`diff_too_large:${result.files.length}>${policy.maxDiffFiles}`);
			}
			const bytes = Buffer.byteLength(result.raw, "utf-8");
			if (bytes > policy.maxDiffBytes) {
				this.#logger.warn("diff exceeds byte limit", {
					bytes,
					maxDiffBytes: policy.maxDiffBytes,
					taskId: task.id,
				});
				throw new Error(`diff_too_large:${bytes}>${policy.maxDiffBytes}`);
			}
			const changedFiles = result.files.map((file) => file.path);
			const diffChecksum = sha256Hex(result.raw);
			// A passing check validates the snapshot, so every changed path must exist in it with the
			// same presence as the live tree. Otherwise the check did not validate this diff.
			const measured = await measureTaskSnapshot({
				paths: changedFiles,
				repositoryPath: this.#binding.repositoryRoot,
				sourcePath: current.worktreePath!,
			});
			const uncovered = measured.uncoveredPaths[0];
			if (uncovered !== undefined) throw new Error(`diff_not_covered_by_snapshot:${uncovered}`);
			const snapshotChecksum = measured.manifest.checksum;
			this.#logger.debug("diff computed", {
				changedFiles,
				diffBytes: bytes,
				diffChecksum,
				durationMs: elapsedMs(startedAt),
				taskId: task.id,
				totalDeletions: result.totalDeletions,
				totalInsertions: result.totalInsertions,
			});
			const latest = (await this.store.getTask(task.id)) ?? current;
			await this.store.updateTask(task.id, {
				artifacts: [
					...latest.artifacts,
					{
						checksum: diffChecksum,
						kind: "diff",
						metadata: {
							changedFiles,
							diffBytes: bytes,
							snapshotChecksum,
							totalDeletions: result.totalDeletions,
							totalInsertions: result.totalInsertions,
						},
						name: "diff",
					},
				],
				timeline: [
					...latest.timeline,
					{
						atMs: this.#now(),
						detail: diffChecksum,
						outcome: "success",
						tool: "self-iteration.diff",
					},
				],
			});
			await this.#auditRecord({
				action: "self-iteration.diff",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { changedFiles, diffBytes: bytes, diffChecksum },
				result: "ok",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				changedFiles,
				diffChecksum,
				raw: result.raw,
				snapshotChecksum,
				taskId: task.id,
				totalDeletions: result.totalDeletions,
				totalInsertions: result.totalInsertions,
			};
		} catch (error) {
			this.#logger.error("diff failed", {
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditDenied(task.id, "self-iteration.diff", errorMessage(error));
			throw error;
		}
	}

	async propose(input: ToolTaskInput & ProposalRequest): Promise<{
		readonly approvalId: string;
		readonly hint?: string;
		readonly missing: readonly string[];
		readonly proposal: DeploymentProposal;
		readonly reused: boolean;
	}> {
		const startedAt = performance.now();
		const resolved = await this.resolveTask(input, "proposal", "self-iteration.propose");
		await this.#requireMode(resolved, "proposal", "self-iteration.propose");
		const policy = await this.policy();
		this.#logger.trace("proposal requested", {
			motivation: preview(input.motivation ?? ""),
			requiresRestart: input.requiresRestart,
			taskId: resolved.id,
			title: preview(input.title ?? ""),
		});
		// Patch, checksums, changed files, revision, and validation all describe one worktree state.
		// The task lock keeps edits out until the proposal is recorded or refused.
		return this.#withTaskLock(resolved.id, async () => {
			const task = (await this.store.getTask(resolved.id)) ?? resolved;
			const diff =
				task.worktreePath === undefined
					? undefined
					: await this.#diffUnlocked(task, {
							taskId: task.id,
							...(input.sourceConversationId === undefined
								? {}
								: { sourceConversationId: input.sourceConversationId }),
						});
			const fresh =
				diff === undefined ? undefined : this.#freshEvidence(task.artifacts, diff.snapshotChecksum);
			const sourceRevision = diff === undefined ? "" : await this.#sourceRevision(task);
			const testResult =
				fresh?.test === undefined
					? undefined
					: testMetadataToTestResult(recordValue(fresh.test.metadata));
			const artifactMetadata =
				fresh?.build === undefined ? null : buildArtifactMetadata(fresh.build);
			const evidence: ProposalEvidence | null =
				diff === undefined || fresh === undefined
					? null
					: {
							diffChecksum: diff.diffChecksum,
							items: [fresh.test, fresh.build].flatMap((artifact) =>
								artifact === undefined ? [] : [evidenceItem(artifact)],
							),
							snapshotChecksum: diff.snapshotChecksum,
						};
			const proposalInput: DeploymentProposalInput = {
				artifactMetadata,
				changedFiles: diff?.changedFiles ?? [],
				diff: diff?.raw ?? "",
				...(diff === undefined ? {} : { diffChecksum: diff.diffChecksum }),
				evidence,
				envChanges: input.envChanges ?? [],
				motivation: input.motivation ?? "",
				requiresRestart: input.requiresRestart ?? false,
				riskAssessment: input.riskAssessment ?? "",
				rollbackNotes: input.rollbackNotes ?? "",
				sourceRevision,
				taskId: task.id,
				...(testResult === undefined ? {} : { testResult }),
				title: input.title ?? "",
			};
			const missing = missingProposalFields(proposalInput);
			if (missing.length > 0) {
				this.#logger.warn("proposal rejected for missing fields", {
					missing,
					taskId: task.id,
				});
				await this.#recordTimeline(
					task,
					"self-iteration.propose:invalid",
					"denied",
					missing.join(","),
				);
				await this.#auditDenied(task.id, "self-iteration.propose", `missing:${missing.join(",")}`);
				const hint = verificationHint(missing, diff !== undefined);
				return {
					approvalId: "",
					...(hint === undefined ? {} : { hint }),
					missing,
					proposal: null as never,
					reused: false,
				};
			}
			// A retry for unchanged content returns the proposal already awaiting approval.
			const existing = await this.#pendingProposalFor(task.id, evidence);
			if (existing !== undefined) {
				this.#logger.debug("proposal reused for unchanged evidence", {
					approvalId: existing.approvalId,
					proposalId: existing.proposal.id,
					taskId: task.id,
				});
				return {
					approvalId: existing.approvalId,
					missing: [],
					proposal: existing.proposal,
					reused: true,
				};
			}
			const proposal = await this.store.createProposal(proposalInput);
			await this.store.transition(proposal.id, "pending_approval");
			this.#logger.debug("proposal transitioned", {
				durationMs: elapsedMs(startedAt),
				proposalId: proposal.id,
				status: "pending_approval",
				taskId: task.id,
			});
			const approval = await this.store.create({
				action: "deploy",
				expiresAtMs: this.#now() + APPROVAL_TTL_MS,
				proposalId: proposal.id,
				requestedBy: input.sourceConversationId ?? "agent",
				taskId: task.id,
			});
			await this.store.updateTask(task.id, {
				status: "awaiting_approval",
				timeline: [
					...task.timeline,
					{
						atMs: this.#now(),
						detail: proposal.id,
						outcome: "success",
						tool: "self-iteration.propose",
					},
				],
			});
			await this.#log(task, "info", `proposal ${proposal.id} awaiting approval`);
			this.#logger.info("proposal created", {
				approvalId: approval.id,
				autoApply: policy.autoApply,
				changedFiles: proposal.changedFiles.length,
				diffChecksum: proposal.diffChecksum,
				durationMs: elapsedMs(startedAt),
				proposalId: proposal.id,
				requiresRestart: proposal.requiresRestart,
				taskId: task.id,
			});
			await this.#auditRecord({
				action: "self-iteration.propose",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: {
					approvalId: approval.id,
					autoApply: policy.autoApply,
					diffChecksum: proposal.diffChecksum,
					proposalId: proposal.id,
				},
				result: "ok",
				targetId: proposal.id,
				targetKind: "coding-proposal",
			});
			return {
				approvalId: approval.id,
				missing: [],
				proposal: { ...proposal, status: "pending_approval" },
				reused: false,
			};
		});
	}

	async resolveApproval(input: {
		readonly action: "approve" | "reject";
		readonly approvalId: string;
		readonly note?: string;
		readonly resolvedBy: string;
	}) {
		const startedAt = performance.now();
		this.#logger.trace("approval resolution requested", {
			action: input.action,
			approvalId: input.approvalId,
			note: preview(input.note ?? ""),
			resolvedBy: input.resolvedBy,
		});
		const existing = await this.store.getApproval(input.approvalId);
		if (existing === null) {
			this.#logger.warn("approval resolution failed", {
				approvalId: input.approvalId,
				reason: "approval_not_found",
			});
			throw new Error("approval_not_found");
		}
		if (existing.status === "expired" || this.#now() > existing.expiresAtMs) {
			this.#logger.warn("approval expired", {
				approvalId: existing.id,
				expiresAtMs: existing.expiresAtMs,
				nowMs: this.#now(),
			});
			await this.#auditRecord({
				action: "self-iteration.approval.expired",
				actorId: input.resolvedBy,
				actorKind: "user",
				payload: { approvalId: existing.id },
				result: "denied",
				targetId: existing.id,
				targetKind: "coding-approval",
			});
			throw new Error("approval_expired");
		}
		if (existing.status !== "pending") {
			this.#logger.warn("approval not pending", {
				approvalId: existing.id,
				status: existing.status,
			});
			throw new Error(`approval_not_pending:${existing.status}`);
		}
		const resolved =
			input.action === "approve"
				? await this.store.approve(input.approvalId, input.resolvedBy, input.note)
				: await this.store.reject(input.approvalId, input.resolvedBy, input.note);
		if (existing.proposalId !== undefined) {
			const proposal = await this.store.getProposal(existing.proposalId);
			if (proposal !== null) {
				const target = input.action === "approve" ? "approved" : "rejected";
				if (
					(input.action === "approve" && proposal.status === "pending_approval") ||
					(input.action === "reject" && proposal.status === "pending_approval")
				) {
					await this.store.transition(proposal.id, target);
				}
			}
		}
		await this.#auditRecord({
			action: `self-iteration.approval.${input.action}`,
			actorId: input.resolvedBy,
			actorKind: "user",
			payload: { approvalId: resolved.id, note: input.note },
			result: "ok",
			targetId: resolved.id,
			targetKind: "coding-approval",
		});
		this.#logger.info(input.action === "approve" ? "proposal approved" : "proposal rejected", {
			action: input.action,
			approvalId: resolved.id,
			durationMs: elapsedMs(startedAt),
			note: preview(input.note ?? ""),
			proposalId: existing.proposalId,
			resolvedBy: input.resolvedBy,
			status: resolved.status,
		});
		return resolved;
	}

	async deploy(input: DeployRequest): Promise<{
		readonly deployment: DeploymentRecord;
		readonly dryRun: boolean;
		readonly outcome?: Awaited<ReturnType<SupervisedReloadController["reload"]>>;
		readonly rollback?: DeploymentRecord;
	}> {
		const startedAt = performance.now();
		const proposal = await this.store.getProposal(input.proposalId);
		if (proposal === null) {
			this.#logger.warn("deployment rejected", {
				proposalId: input.proposalId,
				reason: "proposal_not_found",
			});
			throw new Error("proposal_not_found");
		}
		if (proposal.status !== "approved") {
			this.#logger.warn("deployment rejected", {
				proposalId: proposal.id,
				reason: "proposal_not_approved",
				status: proposal.status,
			});
			throw new Error(`proposal_not_approved:${proposal.status}`);
		}
		this.#logger.trace("deployment gate checks", {
			approvalId: input.approvalId,
			dryRun: input.dryRun === true,
			proposalId: proposal.id,
			sourceRevision: proposal.sourceRevision,
			taskId: proposal.taskId,
		});
		const approval = await this.#requireApproval(proposal, input.approvalId);
		this.#logger.debug("deployment approval gate passed", {
			approvalId: approval.id,
			durationMs: elapsedMs(startedAt),
			proposalId: proposal.id,
		});
		const deployment = await this.store.createDeployment({
			appliedIdentity: await this.#appliedIdentity(proposal),
			artifactMetadata: proposal.artifactMetadata as unknown as Record<string, unknown> | null,
			createdBy: input.createdBy,
			previousIdentity: await this.#runningIdentity(),
			proposalId: proposal.id,
			rollbackPlan: proposal.rollbackNotes,
			sourceRevision: proposal.sourceRevision,
			status: "pending",
			taskId: proposal.taskId,
		});
		await this.store.updateTask(proposal.taskId, { status: "deploying" });
		this.#logger.info("deployment started", {
			approvalId: approval.id,
			createdBy: input.createdBy,
			deploymentId: deployment.id,
			dryRun: input.dryRun === true,
			proposalId: proposal.id,
			requiresRestart: proposal.requiresRestart,
			taskId: proposal.taskId,
		});
		await this.#auditRecord({
			action: "self-iteration.deployment.create",
			actorId: input.createdBy,
			actorKind: "user",
			payload: {
				approvalId: approval.id,
				deploymentId: deployment.id,
				dryRun: input.dryRun === true,
			},
			result: "ok",
			targetId: deployment.id,
			targetKind: "coding-deployment",
		});
		if (input.dryRun === true) {
			this.#logger.info("deployment dry run completed", {
				deploymentId: deployment.id,
				durationMs: elapsedMs(startedAt),
				proposalId: proposal.id,
			});
			return { deployment, dryRun: true };
		}
		let rollbackRecord: DeploymentRecord | undefined;
		const supervised = new SupervisedReloadController({
			healthCheck: async () =>
				this.#binding.healthCheck === undefined
					? { checkedAtMs: this.#now(), ok: true }
					: this.#binding.healthCheck(),
			reload: this.#binding.reload,
			rollback: async (outcome) => {
				this.#logger.warn("deployment rollback triggered", {
					deploymentId: deployment.id,
					postCheckOk: outcome.postCheck?.ok,
					preCheckOk: outcome.preCheck?.ok,
					proposalId: proposal.id,
				});
				// The rollback record may only claim `rolled_back` when the exact artifact that was
				// live before this deployment is known. Otherwise the rollback hook writes a truthful
				// `manual_apply_required` record instead of inventing a restore target.
				const restoreIdentity = deployment.previousIdentity;
				rollbackRecord = await this.store.createDeployment({
					appliedIdentity: restoreIdentity,
					artifactMetadata: proposal.artifactMetadata as unknown as Record<string, unknown> | null,
					createdBy: "system",
					postCheck: outcome.postCheck,
					preCheck: outcome.preCheck,
					proposalId: proposal.id,
					reloadedAtMs: this.#now(),
					rollbackOfId: deployment.id,
					rollbackPlan: proposal.rollbackNotes,
					sourceRevision: proposal.sourceRevision,
					// The post-check failed, so nothing proves the previous artifact is live again.
					// Record the attempt truthfully; only a verified boot may settle it.
					status: "manual_apply_required",
					taskId: proposal.taskId,
				});
				await this.#auditRecord({
					action: "self-iteration.deployment.rollback",
					actorId: "system",
					actorKind: "system",
					payload: { deploymentId: deployment.id, rollbackId: rollbackRecord.id },
					result: "ok",
					targetId: rollbackRecord.id,
					targetKind: "coding-deployment",
				});
				this.#logger.info("deployment rolled back", {
					deploymentId: deployment.id,
					proposalId: proposal.id,
					rollbackId: rollbackRecord.id,
				});
			},
		});
		this.#logger.debug("supervised reload started", {
			deploymentId: deployment.id,
			proposalId: proposal.id,
			taskId: proposal.taskId,
		});
		const outcome = await supervised.reload("tsukaima", {
			deploymentId: deployment.id,
			proposalId: proposal.id,
			reason: "self-iteration deployment",
		});
		// An in-place reload does not change this process's artifact by itself. Success is only
		// recorded when the host can report that the exact approved artifact is now running;
		// otherwise the deployment needs manual verification.
		const inPlaceVerified =
			outcome.success && !outcome.deferred
				? await this.#inPlaceMatches(deployment.appliedIdentity)
				: false;
		// A deferred reload persisted a restart intent: the process still runs the old revision,
		// so the deployment stays `scheduled` until boot recovery confirms the supervisor acted.
		const updated = await this.store.updateDeployment(
			deployment.id,
			outcome.deferred && outcome.success
				? {
						preCheck: outcome.preCheck,
						status: "scheduled",
					}
				: {
						postCheck:
							outcome.success && !inPlaceVerified
								? {
										checkedAtMs: outcome.postCheck.checkedAtMs,
										message:
											"reload completed but the running artifact could not be proven to contain the approved patch",
										ok: false,
									}
								: outcome.postCheck,
						preCheck: outcome.preCheck,
						reloadedAtMs: outcome.reloadedAtMs,
						status: outcome.success
							? inPlaceVerified
								? "deployed"
								: "manual_apply_required"
							: "failed",
					},
		);
		if (outcome.deferred && outcome.success) {
			await this.#markProposalDeploying(proposal.id);
		} else if (outcome.success && inPlaceVerified) {
			await this.#transitionProposal(proposal.id, "deployed");
			await this.store.updateTask(proposal.taskId, { status: "completed" });
		} else if (!outcome.success) {
			await this.#transitionProposal(proposal.id, "failed");
			await this.store.updateTask(proposal.taskId, { status: "failed" });
		}
		await this.#auditRecord({
			action: "self-iteration.deployment.reload",
			actorId: input.createdBy,
			actorKind: "user",
			payload: {
				deferred: outcome.deferred && outcome.success,
				deploymentId: deployment.id,
				success: outcome.success,
			},
			result: updated.status === "deployed" || updated.status === "scheduled" ? "ok" : "failed",
			targetId: deployment.id,
			targetKind: "coding-deployment",
		});
		if (outcome.deferred && outcome.success) {
			this.#logger.info("deployment scheduled for supervised restart", {
				deploymentId: deployment.id,
				proposalId: proposal.id,
				status: updated.status,
				taskId: proposal.taskId,
			});
		}
		if (outcome.success && !outcome.deferred) {
			this.#logger.info("deployment succeeded", {
				deploymentId: deployment.id,
				durationMs: elapsedMs(startedAt),
				postCheckOk: outcome.postCheck?.ok,
				preCheckOk: outcome.preCheck?.ok,
				proposalId: proposal.id,
				reloadedAtMs: outcome.reloadedAtMs,
				status: updated.status,
				taskId: proposal.taskId,
			});
		} else {
			this.#logger.error("deployment failed", {
				deploymentId: deployment.id,
				durationMs: elapsedMs(startedAt),
				message: preview(outcome.message),
				postCheckOk: outcome.postCheck?.ok,
				preCheckOk: outcome.preCheck?.ok,
				proposalId: proposal.id,
				reloadedAtMs: outcome.reloadedAtMs,
				rollbackAttempted: outcome.rollbackAttempted,
				rollbackId: rollbackRecord?.id,
				status: updated.status,
				taskId: proposal.taskId,
			});
		}
		return {
			deployment: updated,
			dryRun: false,
			outcome,
			...(rollbackRecord === undefined ? {} : { rollback: rollbackRecord }),
		};
	}

	async rollback(input: RollbackRequest): Promise<{
		readonly deployment: DeploymentRecord;
		readonly dryRun: boolean;
		readonly outcome?: Awaited<ReturnType<SupervisedReloadController["reload"]>>;
	}> {
		const startedAt = performance.now();
		this.#logger.trace("rollback requested", {
			createdBy: input.createdBy,
			deploymentId: input.deploymentId,
			dryRun: input.dryRun === true,
		});
		const target = await this.store.getDeployment(input.deploymentId);
		if (target === null) {
			this.#logger.warn("rollback rejected", {
				deploymentId: input.deploymentId,
				reason: "deployment_not_found",
			});
			throw new Error("deployment_not_found");
		}
		if (target.status !== "deployed" && target.status !== "failed") {
			this.#logger.warn("rollback rejected", {
				deploymentId: target.id,
				reason: "deployment_not_rollbackable",
				status: target.status,
			});
			throw new Error(`deployment_not_rollbackable:${target.status}`);
		}
		const proposal = await this.store.getProposal(target.proposalId);
		if (proposal === null) {
			this.#logger.warn("rollback rejected", {
				deploymentId: target.id,
				proposalId: target.proposalId,
				reason: "proposal_not_found",
			});
			throw new Error("proposal_not_found");
		}
		const record = await this.store.createDeployment({
			appliedIdentity: target.previousIdentity,
			artifactMetadata: target.artifactMetadata,
			createdBy: input.createdBy,
			proposalId: target.proposalId,
			rollbackOfId: target.id,
			rollbackPlan: proposal.rollbackNotes,
			sourceRevision: target.sourceRevision,
			// Without a recorded previous artifact there is no exact restore target, so this
			// rollback can never be reported as `rolled_back`.
			status: target.previousIdentity === null ? "manual_apply_required" : "pending",
			taskId: target.taskId,
		});
		await this.#auditRecord({
			action: "self-iteration.deployment.rollback.create",
			actorId: input.createdBy,
			actorKind: "user",
			payload: { deploymentId: record.id, rollbackOf: target.id },
			result: "ok",
			targetId: record.id,
			targetKind: "coding-deployment",
		});
		this.#logger.info("rollback started", {
			createdBy: input.createdBy,
			deploymentId: record.id,
			dryRun: input.dryRun === true,
			proposalId: target.proposalId,
			rollbackOf: target.id,
			taskId: target.taskId,
		});
		if (target.previousIdentity === null) {
			this.#logger.warn("rollback cannot be verified; no exact previous artifact is recorded", {
				deploymentId: record.id,
				rollbackOf: target.id,
				status: record.status,
			});
			await this.#auditRecord({
				action: "self-iteration.deployment.rollback",
				actorId: input.createdBy,
				actorKind: "user",
				payload: { deploymentId: record.id, rollbackOf: target.id },
				reason: "missing_previous_artifact_identity",
				result: "failed",
				targetId: record.id,
				targetKind: "coding-deployment",
			});
			return { deployment: record, dryRun: input.dryRun === true };
		}
		if (input.dryRun === true) {
			this.#logger.info("rollback dry run completed", {
				durationMs: elapsedMs(startedAt),
				rollbackOf: target.id,
			});
			return { deployment: record, dryRun: true };
		}
		const supervised = new SupervisedReloadController({
			healthCheck: async () =>
				this.#binding.healthCheck === undefined
					? { checkedAtMs: this.#now(), ok: true }
					: this.#binding.healthCheck(),
			reload: this.#binding.reload,
		});
		const outcome = await supervised.reload("tsukaima", {
			deploymentId: record.id,
			proposalId: target.proposalId,
			reason: `rollback of ${target.id}`,
		});
		const deferred = outcome.deferred && outcome.success;
		// A rollback that ran in place still cannot prove the restored artifact is live without
		// evidence, so it settles `manual_apply_required` until verification confirms it.
		const inPlaceVerified =
			outcome.success && !deferred ? await this.#inPlaceMatches(record.appliedIdentity) : false;
		const updated = await this.store.updateDeployment(
			record.id,
			deferred
				? { preCheck: outcome.preCheck, status: "scheduled" }
				: {
						postCheck:
							outcome.success && !inPlaceVerified
								? {
										checkedAtMs: outcome.postCheck.checkedAtMs,
										message:
											"rollback reload completed but the restored artifact could not be proven live",
										ok: false,
									}
								: outcome.postCheck,
						preCheck: outcome.preCheck,
						reloadedAtMs: outcome.reloadedAtMs,
						status: outcome.success
							? inPlaceVerified
								? "rolled_back"
								: "manual_apply_required"
							: "failed",
					},
		);
		if (outcome.success && !deferred && inPlaceVerified)
			await this.#transitionProposal(target.proposalId, "rolled_back");
		await this.#auditRecord({
			action: "self-iteration.deployment.rollback",
			actorId: input.createdBy,
			actorKind: "user",
			payload: { deferred, deploymentId: record.id, success: outcome.success },
			// A reload that ran but was not verified is recorded as a failure, matching the row.
			result: updated.status === "rolled_back" ? "ok" : "failed",
			targetId: record.id,
			targetKind: "coding-deployment",
		});
		if (deferred) {
			this.#logger.info("rollback scheduled for supervised restart", {
				deploymentId: record.id,
				proposalId: target.proposalId,
				rollbackOf: target.id,
				status: updated.status,
			});
		} else if (outcome.success) {
			this.#logger.info("rollback succeeded", {
				durationMs: elapsedMs(startedAt),
				deploymentId: record.id,
				postCheckOk: outcome.postCheck?.ok,
				proposalId: target.proposalId,
				reloadedAtMs: outcome.reloadedAtMs,
				rollbackOf: target.id,
				status: updated.status,
			});
		} else {
			this.#logger.error("rollback failed", {
				durationMs: elapsedMs(startedAt),
				deploymentId: record.id,
				message: preview(outcome.message),
				postCheckOk: outcome.postCheck?.ok,
				proposalId: target.proposalId,
				rollbackOf: target.id,
				status: updated.status,
			});
		}
		return { deployment: updated, dryRun: false, outcome };
	}

	async status(taskId: string): Promise<TaskBundle> {
		const startedAt = performance.now();
		const task = await this.store.getTask(taskId);
		if (task === null) {
			this.#logger.warn("status lookup failed", { reason: "task_not_found", taskId });
			throw new Error("task_not_found");
		}
		const [proposals, approvals, deployments] = await Promise.all([
			this.store.listProposals(taskId),
			this.store.listApprovals({ taskId }),
			this.store.listDeployments({ taskId }),
		]);
		const [worktree, executor] = await Promise.all([
			this.#worktreeSummary(task),
			this.isolatedExecutorStatus(),
		]);
		this.#logger.debug("status assembled", {
			approvals: approvals.length,
			deployments: deployments.length,
			durationMs: elapsedMs(startedAt),
			proposals: proposals.length,
			status: task.status,
			taskId: task.id,
			worktreePath: worktree.path,
		});
		return {
			approvals,
			deployments,
			executor,
			graph: buildTaskGraph(task, proposals, deployments),
			proposals,
			task,
			worktree,
		};
	}

	async #requireApproval(proposal: DeploymentProposal, approvalId?: string) {
		if (approvalId !== undefined) {
			this.#logger.trace("approval gate check", {
				approvalId,
				proposalId: proposal.id,
				source: "explicit",
			});
			const approval = await this.store.getApproval(approvalId);
			if (approval === null) {
				this.#logger.warn("approval gate denied", { approvalId, reason: "approval_not_found" });
				throw new Error("approval_not_found");
			}
			if (approval.status !== "approved") {
				this.#logger.warn("approval gate denied", {
					approvalId: approval.id,
					reason: "approval_not_approved",
					status: approval.status,
				});
				throw new Error(`approval_not_approved:${approval.status}`);
			}
			if (this.#now() > approval.expiresAtMs) {
				this.#logger.warn("approval gate denied", {
					approvalId: approval.id,
					expiresAtMs: approval.expiresAtMs,
					nowMs: this.#now(),
					reason: "approval_expired",
				});
				throw new Error("approval_expired");
			}
			if (approval.proposalId !== undefined && approval.proposalId !== proposal.id) {
				this.#logger.warn("approval gate denied", {
					approvalId: approval.id,
					approvalProposalId: approval.proposalId,
					proposalId: proposal.id,
					reason: "approval_proposal_mismatch",
				});
				throw new Error("approval_proposal_mismatch");
			}
			this.#logger.trace("approval gate passed", {
				approvalId: approval.id,
				proposalId: proposal.id,
			});
			return approval;
		}
		const approvals = await this.store.listApprovals({ taskId: proposal.taskId });
		const approval = approvals.find(
			(entry) =>
				entry.status === "approved" &&
				entry.proposalId === proposal.id &&
				this.#now() <= entry.expiresAtMs,
		);
		if (approval === undefined) {
			this.#logger.warn("approval gate denied", {
				candidates: approvals.length,
				proposalId: proposal.id,
				reason: "approval_required",
				taskId: proposal.taskId,
			});
			throw new Error("approval_required");
		}
		this.#logger.trace("approval gate passed", {
			approvalId: approval.id,
			proposalId: proposal.id,
			source: "task_scan",
		});
		return approval;
	}

	async #transitionProposal(
		proposalId: string,
		target: "deployed" | "failed" | "rolled_back",
	): Promise<void> {
		this.#logger.trace("proposal transition requested", { proposalId, target });
		const move = async (to: "deployed" | "deploying" | "failed" | "rolled_back") => {
			await this.store.transition(proposalId, to);
			this.#logger.debug("proposal transitioned", { proposalId, status: to });
		};
		try {
			const proposal = await this.store.getProposal(proposalId);
			if (proposal === null) {
				this.#logger.warn("proposal transition skipped", {
					proposalId,
					reason: "proposal_not_found",
					target,
				});
				return;
			}
			if (target === "deployed" && proposal.status === "approved") {
				await move("deploying");
			}
			if (target === "failed" && proposal.status === "deploying") {
				await move("failed");
				return;
			}
			if (target === "rolled_back" && proposal.status === "deployed") {
				await move("rolled_back");
				return;
			}
			const current = await this.store.getProposal(proposalId);
			if (
				current !== null &&
				((target === "deployed" && current.status === "deploying") ||
					(target === "failed" && current.status === "approved") ||
					(target === "rolled_back" && current.status === "deploying"))
			) {
				await move(target);
			} else {
				this.#logger.trace("proposal transition skipped", {
					proposalId,
					reason: "no_valid_transition",
					status: current?.status,
					target,
				});
			}
		} catch (error) {
			this.#logger.warn("proposal transition failed", {
				error: errorMessage(error),
				proposalId,
				target,
			});
		}
	}

	/**
	 * Move an approved proposal to `deploying` for a deferred (scheduled) restart. Boot recovery
	 * performs the terminal transition once the supervisor confirms the process was replaced.
	 */
	async #markProposalDeploying(proposalId: string): Promise<void> {
		try {
			const proposal = await this.store.getProposal(proposalId);
			if (proposal === null || proposal.status !== "approved") return;
			await this.store.transition(proposalId, "deploying");
			this.#logger.debug("proposal transitioned", { proposalId, status: "deploying" });
		} catch (error) {
			this.#logger.warn("proposal transition failed", {
				error: errorMessage(error),
				proposalId,
				target: "deploying",
			});
		}
	}

	/** Serialize one task's worktree mutations and evidence reads, in arrival order. Never nest. */
	async #withTaskLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#taskLocks.get(taskId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.#taskLocks.set(taskId, tail);
		await previous;
		try {
			return await work();
		} finally {
			release();
			if (this.#taskLocks.get(taskId) === tail) this.#taskLocks.delete(taskId);
		}
	}

	/** A worktree write under the task lock; every completed write advances the task generation. */
	async #mutateWorktree<T>(taskId: string, mutate: () => Promise<T>): Promise<T> {
		return this.#withTaskLock(taskId, async () => {
			try {
				return await mutate();
			} finally {
				this.#generations.set(taskId, (this.#generations.get(taskId) ?? 0) + 1);
			}
		});
	}

	/**
	 * Run a compatibility command on the live worktree. Its result is bound to the snapshot identity
	 * only when the content and the task generation are unchanged across the whole run; otherwise the
	 * result is recorded unbound and can never become proposal evidence.
	 */
	async #measuredLiveRun<T>(
		taskId: string,
		worktreePath: string,
		run: () => Promise<T>,
	): Promise<{ readonly provenance: ArtifactProvenance; readonly result: T }> {
		const generation = this.#generations.get(taskId) ?? 0;
		const before = await this.#identityOf(worktreePath);
		const result = await run();
		const after = await this.#identityOf(worktreePath);
		if ((this.#generations.get(taskId) ?? 0) !== generation) {
			return { provenance: { kind: "live", reason: "concurrent_edit" }, result };
		}
		if (before !== undefined && before === after) {
			return { provenance: { checksum: before, kind: "live" }, result };
		}
		return {
			provenance: {
				kind: "live",
				reason:
					before === undefined || after === undefined ? "identity_unavailable" : "content_changed",
			},
			result,
		};
	}

	/** Snapshot identity of the worktree as a snapshot run would record it. */
	async #identityOf(worktreePath: string): Promise<string | undefined> {
		try {
			const measured = await measureTaskSnapshot({
				paths: [],
				repositoryPath: this.#binding.repositoryRoot,
				sourcePath: worktreePath,
			});
			return measured.manifest.checksum;
		} catch (error) {
			this.#logger.warn("snapshot identity unavailable", {
				error: errorMessage(error),
				worktreePath,
			});
			return undefined;
		}
	}

	/**
	 * The newest validation of each kind that carries provenance. It counts only when it passed on
	 * exactly the content the diff describes, so a newer failed, cancelled, unbound, or stale run
	 * blocks an older passing one.
	 */
	#freshEvidence(artifacts: readonly TaskArtifact[], snapshotChecksum: string): FreshEvidence {
		const newest = (kind: "build" | "test") =>
			[...artifacts]
				.toReversed()
				.find(
					(artifact) =>
						artifact.kind === kind && recordValue(artifact.metadata).provenance !== undefined,
				);
		const fresh = (artifact: TaskArtifact | undefined) =>
			artifact !== undefined && isFreshPass(artifact, snapshotChecksum) ? artifact : undefined;
		return { build: fresh(newest("build")), test: fresh(newest("test")) };
	}

	/** A pending proposal already recorded for this exact evidence, with its approval. */
	async #pendingProposalFor(
		taskId: string,
		evidence: ProposalEvidence | null,
	): Promise<{ readonly approvalId: string; readonly proposal: DeploymentProposal } | undefined> {
		if (evidence === null) return undefined;
		const match = (await this.store.listProposals(taskId)).find(
			(proposal) =>
				proposal.status === "pending_approval" &&
				proposal.evidence?.snapshotChecksum === evidence.snapshotChecksum &&
				proposal.diffChecksum === evidence.diffChecksum,
		);
		if (match === undefined) return undefined;
		const approval = (await this.store.listApprovals({ taskId })).find(
			(item) => item.proposalId === match.id && item.status === "pending",
		);
		return approval === undefined ? undefined : { approvalId: approval.id, proposal: match };
	}

	async #taskWithWorktree(task: IterationTask): Promise<IterationTask> {
		const current = (await this.store.getTask(task.id)) ?? task;
		if (current.worktreePath === undefined) {
			this.#logger.warn("worktree required", { taskId: task.id });
			throw new Error("worktree_required");
		}
		this.#logger.trace("task worktree resolved", {
			status: current.status,
			taskId: current.id,
			worktreePath: current.worktreePath,
		});
		return current;
	}

	#managerFor(taskId: string, policy: CodingPolicy): WorktreeManager {
		const existing = this.#worktrees.get(taskId);
		if (existing !== undefined) return existing;
		const manager = new WorktreeManager({
			pathAllowlist: [...policy.pathAllowlist],
			repositoryPath: this.#binding.repositoryRoot,
			worktreeRoot: this.#binding.worktreeRoot,
		});
		this.#worktrees.set(taskId, manager);
		this.#logger.debug("worktree manager created", {
			pathAllowlist: policy.pathAllowlist,
			repositoryPath: this.#binding.repositoryRoot,
			taskId,
			worktreeRoot: this.#binding.worktreeRoot,
		});
		return manager;
	}

	async #runner(worktreePath: string, policy: CodingPolicy): Promise<CodingRunner> {
		const identity = await this.#binding.gitIdentity?.();
		return new CodingRunner({
			allowedCommands: policy.allowedCommands,
			...(identity === undefined
				? {}
				: {
						env: {
							GIT_AUTHOR_EMAIL: identity.email,
							GIT_AUTHOR_NAME: identity.name,
							GIT_COMMITTER_EMAIL: identity.email,
							GIT_COMMITTER_NAME: identity.name,
						},
					}),
			executor: () => this.#sandbox(),
			maxOutputBytes: policy.maxOutputBytes,
			timeoutMs: policy.timeoutMs,
			worktreePath,
			writable: false,
		});
	}

	/**
	 * Model-supplied `command`/`args` are refused, not filtered. The governed policy owns the
	 * exact argv, so no model input can reach an interpreter flag (`bun -e`, `rg --pre`).
	 */
	#rejectCommandOverride(
		command: string | undefined,
		args: readonly string[] | undefined,
		expected: string,
		tool: string,
	): void {
		if (command !== undefined && command !== expected) {
			this.#logger.warn("command override denied", { expected, received: command, tool });
			throw new Error(`command_override_not_allowed:${command}`);
		}
		if (args !== undefined && args.length > 0) {
			this.#logger.warn("argument override denied", { count: args.length, tool });
			throw new Error("argument_override_not_allowed");
		}
	}

	/** A test-name filter stays positional and cannot smuggle a flag. Multiple paths are allowed. */
	#testPatternArgs(pattern: string | undefined): readonly string[] {
		const trimmed = pattern?.trim();
		if (trimmed === undefined || trimmed.length === 0) return [];
		if (trimmed.includes("\0")) throw new Error("invalid_test_pattern");
		const paths = trimmed
			.split(/[\s,]+/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (paths.length === 0) return [];
		for (const path of paths) {
			if (path.startsWith("-") || path.startsWith("/")) throw new Error("invalid_test_pattern");
		}
		return paths.slice(0, 8);
	}

	async #analysisCwd(): Promise<string> {
		// A read-only task may not have a worktree yet; the sandbox still needs an existing,
		// non-repository working directory.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(this.#binding.worktreeRoot, { recursive: true });
		return this.#binding.worktreeRoot;
	}

	/**
	 * Resolve an analysis path inside the committed snapshot. The policy allowlist is enforced on
	 * the logical path before it is translated to the read-only `/analysis` mount. The returned
	 * value is relative to the snapshot root; the caller prefixes it with the mount.
	 */
	async #analysisPath(policy: CodingPolicy, candidatePath: string): Promise<string> {
		const root = this.#binding.repositoryRoot;
		const target = await assertSafeWorktreePath(root, policy.pathAllowlist, candidatePath);
		return relative(root, target).split(sep).join("/");
	}

	async #worktreeSummary(
		task: IterationTask,
	): Promise<{ readonly commit: string | null; readonly path: string | null }> {
		if (task.worktreePath === undefined) return { commit: null, path: null };
		const commit = await this.#sourceRevision(task);
		this.#logger.trace("worktree summary", {
			commit: preview(commit),
			path: task.worktreePath,
			taskId: task.id,
		});
		return { commit: commit.length === 0 ? null : commit, path: task.worktreePath };
	}

	async #sourceRevision(task: IterationTask): Promise<string> {
		const cwd = task.worktreePath ?? this.#binding.repositoryRoot;
		try {
			const result = await new CodingRunner({
				allowedCommands: ["git"],
				executor: () => this.#sandbox(),
				maxOutputBytes: 4096,
				timeoutMs: 10_000,
				worktreePath: cwd,
				writable: false,
			}).exec("git", ["rev-parse", "HEAD"]);
			const revision = result.stdout.trim();
			this.#logger.trace("source revision resolved", { cwd, revision: preview(revision) });
			return revision;
		} catch (error) {
			this.#logger.debug("source revision unavailable", { cwd, error: errorMessage(error) });
			return "";
		}
	}

	/**
	 * Exact artifact this deployment claims to apply.
	 *
	 * The host may know the built image digest and the approved patch it contains. Without that
	 * hook there is no verifiable identity, so the deployment is recorded with `null` and must
	 * settle `manual_apply_required` rather than claiming the diff is live.
	 */
	async #appliedIdentity(proposal: DeploymentProposal): Promise<DeploymentIdentity | null> {
		const identity = await this.#binding.appliedIdentity?.(proposal);
		if (identity === undefined) return null;
		if (identity.revision.trim().length === 0) return null;
		// An identity whose checksum does not match the approved patch would verify some other
		// artifact; refuse it instead of recording misleading evidence.
		if (identity.diffChecksum !== proposal.diffChecksum) return null;
		return identity;
	}

	/** Artifact this process is running, when the host can report it exactly. */
	async #runningIdentity(): Promise<DeploymentIdentity | null> {
		const identity = await this.#binding.runningIdentity?.();
		if (identity === undefined) return null;
		if (identity.revision.trim().length === 0 || identity.diffChecksum.trim().length === 0) {
			return null;
		}
		return identity;
	}

	/**
	 * Whether this process now runs exactly the expected artifact.
	 *
	 * Used for reloads that complete in place. Without a host-reported identity there is no
	 * evidence, so the caller must record `manual_apply_required` rather than success.
	 */
	async #inPlaceMatches(expected: DeploymentIdentity | null): Promise<boolean> {
		if (expected === null) return false;
		const running = await this.#runningIdentity();
		if (running === null) return false;
		return running.revision === expected.revision && running.diffChecksum === expected.diffChecksum;
	}

	async #recordTimeline(
		task: IterationTask,
		tool: string,
		outcome: TaskTimelineEntry["outcome"],
		detail?: string,
	): Promise<void> {
		const latest = (await this.store.getTask(task.id)) ?? task;
		await this.store.updateTask(task.id, {
			timeline: [
				...latest.timeline,
				{ atMs: this.#now(), ...(detail === undefined ? {} : { detail }), outcome, tool },
			],
		});
		this.#logger.trace("task timeline recorded", {
			detail: preview(detail ?? ""),
			outcome,
			taskId: task.id,
			tool,
		});
	}

	async #log(task: IterationTask, level: TaskLogEntry["level"], message: string): Promise<void> {
		const latest = (await this.store.getTask(task.id)) ?? task;
		await this.store.updateTask(task.id, {
			logs: [...latest.logs, { atMs: this.#now(), level, message }],
		});
		this.#logger.trace("task log recorded", {
			level,
			message: preview(message),
			taskId: task.id,
		});
	}

	async #auditRecord(entry: Parameters<PluginAuditApi["record"]>[0]): Promise<void> {
		try {
			await this.#audit?.record(entry);
		} catch (error) {
			this.#logger.warn("self-iteration audit failed", { error: errorMessage(error) });
		}
	}

	async #auditDenied(taskId: string, tool: string, reason: string): Promise<void> {
		await this.#auditRecord({
			action: `${tool}.denied`,
			actorId: "agent",
			actorKind: "agent",
			payload: { reason, tool },
			reason,
			result: "denied",
			targetId: taskId,
			targetKind: "coding-task",
		});
	}

	async #auditFailure(taskId: string, tool: string, error: unknown): Promise<void> {
		this.#logger.warn("tool execution failed", {
			error: errorMessage(error),
			taskId,
			tool,
		});
		await this.#auditRecord({
			action: `${tool}.failed`,
			actorId: "agent",
			actorKind: "agent",
			payload: { error: errorMessage(error), tool },
			reason: errorMessage(error),
			result: "failed",
			targetId: taskId,
			targetKind: "coding-task",
		});
	}
}

function parseTest(result: Awaited<ReturnType<CodingRunner["exec"]>>): TestRunResult {
	const combined = `${result.stdout}\n${result.stderr}`;
	const pass = combined.match(/(\d+)\s+pass/u);
	const fail = combined.match(/(\d+)\s+fail/u);
	const failed = fail === null ? 0 : Number.parseInt(fail[1] ?? "0", 10);
	const passedCount = pass === null ? 0 : Number.parseInt(pass[1] ?? "0", 10);
	return {
		exitCode: result.exitCode,
		failed,
		passed: result.exitCode === 0,
		stderr: result.stderr,
		stdout: result.stdout,
		total: passedCount + failed,
	};
}

interface FreshEvidence {
	readonly build: TaskArtifact | undefined;
	readonly test: TaskArtifact | undefined;
}

/** A passing validation of exactly this snapshot identity; failed, cancelled, or timed-out runs never count. */
function isFreshPass(artifact: TaskArtifact, snapshotChecksum: string): boolean {
	const metadata = recordValue(artifact.metadata);
	const provenance = recordValue(metadata.provenance);
	return (
		provenance.checksum === snapshotChecksum &&
		metadata.passed === true &&
		metadata.cancelled !== true &&
		metadata.timedOut !== true
	);
}

function buildArtifactMetadata(artifact: TaskArtifact): ArtifactMetadata {
	const metadata = recordValue(artifact.metadata);
	return {
		builtAtMs: typeof metadata.builtAtMs === "number" ? metadata.builtAtMs : 0,
		checksum: artifact.checksum ?? "",
		command: typeof metadata.command === "string" ? metadata.command : artifact.name,
		...(typeof metadata.sizeBytes === "number" ? { sizeBytes: metadata.sizeBytes } : {}),
	};
}

function evidenceItem(artifact: TaskArtifact): ProposalEvidenceItem {
	const provenance = recordValue(recordValue(artifact.metadata).provenance);
	return {
		kind: artifact.kind === "build" ? "build" : "test",
		name: artifact.name,
		provenance: provenance.kind === "snapshot" ? "snapshot" : "live",
	};
}

/** Actionable next step for a refused proposal; the missing list alone does not say what to run. */
function verificationHint(missing: readonly string[], hasWorktree: boolean): string | undefined {
	if (missing.length === 0) return undefined;
	if (!hasWorktree) return "The task has no worktree yet. Edit the task, then propose again.";
	if (missing.includes("changedFiles")) return "The worktree has no changes to propose.";
	if (missing.includes("testResult") || missing.includes("artifactMetadata")) {
		return "Run self-iteration.check for test and webui-build after the last edit, then propose again. Evidence from earlier content, failed, cancelled, or unbound runs is not attached.";
	}
	return undefined;
}

function testMetadataToTestResult(metadata: Readonly<Record<string, unknown>>): TestRunResult {
	return {
		exitCode: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
		failed: typeof metadata.failed === "number" ? metadata.failed : 0,
		passed: metadata.passed === true,
		stderr: "",
		stdout: "",
		total: typeof metadata.total === "number" ? metadata.total : 0,
	};
}

export function buildTaskGraph(
	task: IterationTask,
	proposals: readonly DeploymentProposal[],
	deployments: readonly DeploymentRecord[],
): TaskGraph {
	const tested = task.timeline.some(
		(entry) => entry.tool === "self-iteration.test" && entry.outcome === "success",
	);
	const deployed = deployments.find((deployment) => deployment.status === "deployed");
	const failed = deployments.find((deployment) => deployment.status === "failed");
	const rolledBack = deployments.find((deployment) => deployment.status === "rolled_back");
	const nodes: TaskGraphNode[] = [
		{
			dependsOn: [],
			id: "prepare",
			kind: "prepare",
			label: task.goal,
			status: "done",
		},
		{
			dependsOn: ["prepare"],
			id: "implement",
			kind: "implement",
			label: "Apply scoped patch",
			status:
				task.worktreePath === undefined ? (task.mode === "analysis" ? "done" : "pending") : "done",
		},
		{
			dependsOn: ["implement"],
			id: "test",
			kind: "test",
			label: "Run tests",
			status: tested ? "done" : task.mode === "analysis" ? "skipped" : "pending",
		},
		{
			dependsOn: ["test"],
			id: "review",
			kind: "review",
			label: "Approval review",
			status:
				proposals.length === 0
					? "pending"
					: proposals.some((proposal) => proposal.status === "approved")
						? "done"
						: "running",
		},
		{
			dependsOn: ["review"],
			id: "deploy",
			kind: "deploy",
			label: "Supervised deployment",
			status: deployed === undefined ? (failed === undefined ? "pending" : "failed") : "done",
		},
		{
			dependsOn: ["deploy"],
			id: "verify",
			kind: "verify",
			label: "Post-deploy health",
			status:
				deployed?.postCheck?.ok === true ? "done" : deployed === undefined ? "pending" : "failed",
		},
		{
			dependsOn: ["verify"],
			id: "cleanup",
			kind: "cleanup",
			label: "Worktree cleanup",
			status: rolledBack === undefined ? "pending" : "done",
		},
	];
	return { nodes, taskId: task.id };
}
