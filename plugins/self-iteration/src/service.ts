import { relative, sep } from "node:path";
import {
	ANALYSIS_MOUNT,
	applyStructuredEdit,
	assertSafeWorktreePath,
	CodingRunner,
	CodingTools,
	createBubblewrapSandbox,
	DomainCodingStore,
	missingProposalFields,
	sha256Hex,
	SupervisedReloadController,
	validateStructuredEdit,
	WorktreeManager,
	type ArtifactMetadata,
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
	constraintsFromPolicy,
	DEFAULT_CODING_POLICY,
	type CodingPolicy,
	type SelfIterationHostBinding,
	type TaskMode,
	mergePolicy,
	modeAllows,
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

export interface ProposalRequest {
	readonly artifactMetadata?: ArtifactMetadata | null;
	readonly changedFiles?: readonly string[];
	readonly diff?: string;
	readonly diffChecksum?: string;
	readonly envChanges?: readonly string[];
	readonly motivation?: string;
	readonly requiresRestart?: boolean;
	readonly riskAssessment?: string;
	readonly rollbackNotes?: string;
	readonly sourceRevision?: string;
	readonly testResult?: TestRunResult;
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

export interface TaskBundle {
	readonly approvals: readonly Awaited<ReturnType<DomainCodingStore["listApprovals"]>>[number][];
	readonly deployments: readonly DeploymentRecord[];
	readonly graph: TaskGraph;
	readonly proposals: readonly DeploymentProposal[];
	readonly task: IterationTask;
	readonly worktree: { readonly commit: string | null; readonly path: string | null };
}

const APPROVAL_TTL_MS = 30 * 60_000;
/** Bound on a model-supplied search pattern, so one argument cannot become a payload. */
const MAX_SEARCH_PATTERN_CHARS = 4_000;
const MAX_SEARCH_RESULTS = 100;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

	constructor(options: SelfIterationServiceOptions) {
		this.#audit = options.audit;
		this.#binding = options.binding;
		this.#logger = scopedLogger(options.logger);
		this.#now = options.now ?? Date.now;
		this.#sandbox =
			options.sandbox ??
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
		const mode = input.mode ?? "analysis";
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
		const [policy, tasks, proposals, approvals, deployments] = await Promise.all([
			this.policy(),
			this.store.listTasks({ limit: 20 }),
			this.store.listProposals(),
			this.store.listApprovals(),
			this.store.listDeployments({ limit: 20 }),
		]);
		const stats = {
			approvals: approvals.length,
			deployments: deployments.length,
			proposals: proposals.length,
			tasks: tasks.length,
		};
		this.#logger.debug("overview built", { durationMs: elapsedMs(startedAt), ...stats });
		return { policy, stats, tasks };
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

	async #requireMode(task: IterationTask, required: TaskMode, tool: string): Promise<void> {
		if (modeAllows(task.mode, required)) {
			this.#logger.trace("mode gate passed", { mode: task.mode, required, taskId: task.id, tool });
			return;
		}
		this.#logger.warn("mode gate denied", { mode: task.mode, required, taskId: task.id, tool });
		await this.#recordTimeline(task, `${tool}:mode_denied`, "denied");
		await this.#auditDenied(task.id, tool, `mode_denied:${task.mode}<${required}`);
		throw new Error(`mode_denied: task mode "${task.mode}" cannot run "${tool}"`);
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
						...(task.worktreePath === undefined ? { exportAnalysis: true } : {}),
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
					...(task.worktreePath === undefined ? { exportAnalysis: true } : {}),
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

	async worktree(
		input: ToolTaskInput & { readonly baseRef?: string },
	): Promise<Record<string, unknown>> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.worktree");
		await this.#requireMode(task, "patch", "self-iteration.worktree");
		const existing = this.#binding.store.getTask(task.id);
		if ((await existing)?.worktreePath !== undefined) {
			this.#logger.debug("worktree already present", {
				path: task.worktreePath,
				taskId: task.id,
			});
			return { baseRef: task.baseRef, path: task.worktreePath, taskId: task.id };
		}
		try {
			const policy = await this.policy();
			const manager = this.#managerFor(task.id, policy);
			this.#logger.debug("worktree create started", {
				baseRef: input.baseRef ?? task.baseRef,
				taskId: task.id,
			});
			const info = await manager.create(task.id, input.baseRef ?? task.baseRef);
			await this.store.updateTask(task.id, {
				status: "in_progress",
				timeline: [
					...task.timeline,
					{
						atMs: this.#now(),
						detail: info.path,
						outcome: "success" as const,
						tool: "self-iteration.worktree",
					},
				],
				worktreePath: info.path,
			});
			await this.#log(task, "info", `worktree created at ${info.path}`);
			this.#logger.debug("worktree created", {
				baseRef: info.baseRef,
				branchName: info.branchName,
				durationMs: elapsedMs(startedAt),
				path: info.path,
				status: "in_progress",
				taskId: task.id,
			});
			await this.#auditRecord({
				action: "self-iteration.worktree.create",
				actorId: input.sourceConversationId ?? "agent",
				actorKind: "agent",
				payload: { baseRef: info.baseRef, branch: info.branchName, path: info.path },
				result: "ok",
				targetId: task.id,
				targetKind: "coding-task",
			});
			return {
				baseRef: info.baseRef,
				branchName: info.branchName,
				path: info.path,
				taskId: task.id,
			};
		} catch (error) {
			this.#logger.error("worktree creation failed", {
				baseRef: input.baseRef ?? task.baseRef,
				durationMs: elapsedMs(startedAt),
				error: errorMessage(error),
				taskId: task.id,
			});
			await this.#auditFailure(task.id, "self-iteration.worktree", error);
			throw error;
		}
	}

	async edit(
		input: ToolTaskInput & { readonly edit?: StructuredEdit } & Partial<StructuredEdit>,
	): Promise<EditResult & { readonly taskId: string }> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.edit");
		await this.#requireMode(task, "patch", "self-iteration.edit");
		const current = await this.#taskWithWorktree(task);
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
			const result = await applyStructuredEdit(
				current.worktreePath!,
				current.constraints.pathAllowlist,
				edit,
				{ maxBytes: policy.maxOutputBytes },
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
		const current = await this.#taskWithWorktree(task);
		const policy = await this.policy();
		const action = input.action === "abort" ? "abort" : "merge";
		const worktreePath = current.worktreePath!;
		const runner = this.#runner(worktreePath, policy);
		this.#logger.trace("upstream action requested", {
			action,
			ref: preview(input.ref ?? ""),
			taskId: task.id,
		});
		try {
			if (action === "abort") {
				const result = await runner.exec("git", ["merge", "--abort"]);
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
			const result = await runner.exec("git", ["merge", "--no-ff", "--no-commit", ref]);
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
		},
	): Promise<TestRunResult & { readonly taskId: string }> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.test");
		const policy = await this.policy();
		// Test and build never run against the live tree: a command that can write (or read the
		// repository's own dotenv files) must stay inside the disposable worktree.
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
			const result = await sandbox.exec({
				args,
				command,
				cwd: worktreePath,
				maxOutputBytes: policy.maxOutputBytes,
				timeoutMs: policy.timeoutMs,
				writable: true,
			});
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
				command,
				durationMs: result.durationMs,
				exitCode: result.exitCode,
				failed: parsed.failed,
				passed: parsed.passed,
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
		const task = await this.resolveTask(input, "proposal", "self-iteration.build");
		await this.#requireMode(task, "proposal", "self-iteration.build");
		const policy = await this.policy();
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
			const result = await sandbox.exec({
				args,
				command,
				cwd: worktreePath,
				maxOutputBytes: policy.maxOutputBytes,
				timeoutMs: policy.timeoutMs,
				writable: true,
			});
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
			const metadata = { ...artifactMetadata, exitCode: result.exitCode };
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

	async diff(input: ToolTaskInput): Promise<{
		readonly changedFiles: readonly string[];
		readonly diffChecksum: string;
		readonly raw: string;
		readonly taskId: string;
		readonly totalDeletions: number;
		readonly totalInsertions: number;
	}> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "patch", "self-iteration.diff");
		await this.#requireMode(task, "patch", "self-iteration.diff");
		const current = await this.#taskWithWorktree(task);
		const policy = await this.policy();
		this.#logger.trace("diff started", {
			taskId: task.id,
			worktreePath: current.worktreePath,
		});
		try {
			const result = await new CodingTools(this.#runner(current.worktreePath!, policy)).diff();
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
		readonly missing: readonly string[];
		readonly proposal: DeploymentProposal;
	}> {
		const startedAt = performance.now();
		const task = await this.resolveTask(input, "proposal", "self-iteration.propose");
		await this.#requireMode(task, "proposal", "self-iteration.propose");
		const policy = await this.policy();
		this.#logger.trace("proposal requested", {
			changedFiles: input.changedFiles,
			hasDiff: input.diff !== undefined && input.diff.length > 0,
			motivation: preview(input.motivation ?? ""),
			requiresRestart: input.requiresRestart,
			taskId: task.id,
			title: preview(input.title ?? ""),
		});
		const latest = (await this.store.getTask(task.id)) ?? task;
		const diffArtifact = [...latest.artifacts]
			.toReversed()
			.find((artifact) => artifact.kind === "diff");
		const buildArtifact = [...latest.artifacts]
			.toReversed()
			.find((artifact) => artifact.kind === "build");
		const testArtifact = [...latest.artifacts]
			.toReversed()
			.find((artifact) => artifact.kind === "test");
		const diffMetadata = recordValue(diffArtifact?.metadata);
		let changedFiles: readonly string[] =
			input.changedFiles ?? (diffMetadata.changedFiles as readonly string[] | undefined) ?? [];
		let diffText = input.diff ?? "";
		let diffChecksum = input.diffChecksum ?? diffArtifact?.checksum;
		let sourceRevision = input.sourceRevision ?? "";
		if (diffText.length === 0 && task.worktreePath !== undefined) {
			const diff = await this.diff({
				taskId: task.id,
				...(input.sourceConversationId === undefined
					? {}
					: { sourceConversationId: input.sourceConversationId }),
			});
			if (changedFiles.length === 0) changedFiles = diff.changedFiles;
			diffText = diff.raw;
			diffChecksum = diff.diffChecksum;
		}
		if (sourceRevision.length === 0) sourceRevision = await this.#sourceRevision(task);
		const artifactMetadata =
			input.artifactMetadata ??
			(buildArtifact?.metadata === undefined
				? null
				: (buildArtifact.metadata as unknown as ArtifactMetadata));
		const testResult =
			input.testResult ??
			(testArtifact?.metadata === undefined
				? undefined
				: testMetadataToTestResult(testArtifact.metadata));
		const proposalInput: DeploymentProposalInput = {
			artifactMetadata,
			changedFiles,
			diff: diffText,
			...(diffChecksum === undefined ? {} : { diffChecksum }),
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
			return { approvalId: "", missing, proposal: null as never };
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
				...latest.timeline,
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
		};
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
		const worktree = await this.#worktreeSummary(task);
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

	#runner(worktreePath: string, policy: CodingPolicy): CodingRunner {
		return new CodingRunner({
			allowedCommands: policy.allowedCommands,
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

	/** A test-name filter stays positional and cannot smuggle a flag. */
	#testPatternArgs(pattern: string | undefined): readonly string[] {
		const trimmed = pattern?.trim();
		if (trimmed === undefined || trimmed.length === 0) return [];
		if (trimmed.startsWith("-") || trimmed.includes("\0")) {
			throw new Error("invalid_test_pattern");
		}
		return [trimmed];
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
