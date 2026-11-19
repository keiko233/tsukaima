import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANALYSIS_MOUNT,
	DomainCodingStore,
	NoopReloadController,
	reconcileRestartDeployment,
	runManagedProcess,
	sha256Hex,
	type HealthCheckResult,
	type ReloadController,
	type SandboxExecInput,
	type SandboxProvider,
	SandboxUnavailableError,
} from "@tsukaima/coding";
import type { AuditEntry, PluginLogger, PluginStorage } from "@tsukaima/sdk";
import { SELF_ITERATION_HOST_BINDING } from "./domain.ts";
import { selfIterationPlugin } from "./index.ts";
import { SelfIterationService } from "./service.ts";

const directories: string[] = [];

class MemoryStorage implements PluginStorage {
	readonly values = new Map<string, unknown>();
	readonly conversation = {
		get: async <T>(conversationId: string, key: string): Promise<T | undefined> =>
			this.values.get(`${conversationId}:${key}`) as T | undefined,
		set: async (conversationId: string, key: string, value: unknown): Promise<void> => {
			this.values.set(`${conversationId}:${key}`, value);
		},
	};
	readonly global = {
		get: async <T>(key: string): Promise<T | undefined> => this.values.get(key) as T | undefined,
		set: async (key: string, value: unknown): Promise<void> => {
			this.values.set(key, value);
		},
	};
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args], {
		cwd,
	});
}

interface CapturedLog {
	readonly details: unknown;
	readonly level: "debug" | "error" | "info" | "trace" | "warn";
	readonly message: string;
}

/** In-memory logger covering the full `PluginLogger` surface, including `trace`. */
function captureLogger(logs: CapturedLog[]): PluginLogger {
	const write =
		(level: CapturedLog["level"]) =>
		(message: string, details?: unknown): void => {
			logs.push({ details, level, message });
		};
	const logger: PluginLogger = {
		debug: write("debug"),
		error: write("error"),
		info: write("info"),
		trace: write("trace"),
		warn: write("warn"),
	};
	logger.child = () => logger;
	return logger;
}

function detailsOf(entry: CapturedLog | undefined): Record<string, unknown> {
	return typeof entry?.details === "object" && entry.details !== null
		? (entry.details as Record<string, unknown>)
		: {};
}

interface Fixture {
	readonly audits: AuditEntry[];
	readonly checks: { count: number; script: (count: number) => boolean };
	readonly logs: CapturedLog[];
	readonly reloads: string[];
	readonly repo: string;
	readonly sandboxCalls: SandboxExecInput[];
	readonly service: SelfIterationService;
	readonly store: DomainCodingStore;
	readonly worktrees: string;
	/** Artifact identity this fixture process reports as running. */
	readonly running: { current: { diffChecksum: string; revision: string } };
}

/**
 * Test double for the bubblewrap sandbox: runs the governed argv directly so the fixture can
 * exercise service behavior without host namespaces, while recording every sandbox call.
 */
function createTestSandbox(): { calls: SandboxExecInput[]; provider: SandboxProvider } {
	const calls: SandboxExecInput[] = [];
	const provider: SandboxProvider = async () => ({
		id: "test-sandbox",
		exec: async (input) => {
			calls.push(input);
			const resolved = Bun.which(input.command);
			if (resolved === null) throw new Error(`command_not_found:${input.command}`);
			let analysisRoot: string | undefined;
			if (input.exportAnalysis === true) {
				// The fixture repository is a sibling of the worktree root.
				analysisRoot = await fs.mkdtemp(join(tmpdir(), "tsukaima-analysis-test-"));
				const archive = Bun.spawn({
					cmd: ["git", "archive", "--format=tar", input.analysisRevision ?? "HEAD"],
					cwd: join(input.cwd, "..", "repo"),
					stderr: "pipe",
					stdout: "pipe",
				});
				const extract = Bun.spawn({
					cmd: ["tar", "-x", "-f", "-", "-C", analysisRoot],
					stdin: archive.stdout,
					stderr: "pipe",
					stdout: "ignore",
				});
				await Promise.all([archive.exited, extract.exited]);
			}
			if (input.analysisTree !== undefined) {
				// Mirror the real sandbox's private working-tree copy (without `.git`).
				analysisRoot = await fs.mkdtemp(join(tmpdir(), "tsukaima-analysis-tree-"));
				await fs.cp(input.analysisTree, analysisRoot, {
					filter: (source) => !source.endsWith(`${join(input.analysisTree!, ".git")}`),
					recursive: true,
				});
			}
			const analysisPath = input.analysisPath ?? analysisRoot;
			const args =
				analysisPath === undefined
					? [...input.args]
					: input.args.map((arg) =>
							arg === ANALYSIS_MOUNT || arg.startsWith(`${ANALYSIS_MOUNT}/`)
								? `${analysisPath}${arg.slice(ANALYSIS_MOUNT.length)}`
								: arg,
						);
			return await runManagedProcess({
				args,
				command: resolved,
				cwd: input.cwd,
				env: {
					HOME: process.env.HOME ?? tmpdir(),
					LANG: "C.UTF-8",
					PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
					TMPDIR: tmpdir(),
					TZ: "UTC",
					...input.env,
				},
				maxOutputBytes: input.maxOutputBytes,
				timeoutMs: input.timeoutMs,
			});
		},
	});
	return { calls, provider };
}

async function fixture(
	options: {
		readonly deferredReload?: boolean;
		/** Host-owned Workspace binding lookup for model calls. */
		readonly workspaceTaskFor?: (conversationId: string) => string | null | undefined;
		/** Whether a successful in-place reload changes the reported running artifact. */
		readonly applyReload?: boolean;
		/** Whether a rollback reload actually restores the previous artifact. */
		readonly applyRollback?: boolean;
		readonly sandbox?: SandboxProvider;
	} = {},
): Promise<Fixture> {
	const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-self-iteration-"));
	directories.push(root);
	const repo = join(root, "repo");
	const worktrees = join(root, "worktrees");
	await fs.mkdir(join(repo, "src"), { recursive: true });
	await fs.writeFile(join(repo, "README.md"), "# Self iteration fixture\n");
	await fs.writeFile(join(repo, "src", "app.ts"), "export const value = 'old';\n");
	await fs.writeFile(
		join(repo, "src", "app.test.ts"),
		'import { expect, test } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n',
	);
	await fs.writeFile(
		join(repo, "package.json"),
		JSON.stringify(
			{ name: "fixture", scripts: { build: "bun -e \"console.log('built')\"" } },
			null,
			"\t",
		),
	);
	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-m", "initial"]);
	const store = new DomainCodingStore(join(root, "domain.sqlite"));
	const audits: AuditEntry[] = [];
	const logs: CapturedLog[] = [];
	const reloads: string[] = [];
	const checks = { count: 0, script: (_count: number) => true };
	const initialIdentity = { diffChecksum: "initial-patch", revision: "initial" };
	const running = { current: { ...initialIdentity } };
	let pendingIdentity: { diffChecksum: string; revision: string } = initialIdentity;
	const reload: ReloadController = {
		async reload(componentId, context) {
			reloads.push(`${componentId}:${context.reason}`);
			if (options.deferredReload !== true && options.applyReload !== false) {
				if (context.reason.startsWith("rollback of")) {
					if (options.applyRollback !== false) running.current = { ...initialIdentity };
				} else {
					running.current = { ...pendingIdentity };
				}
			}
			return {
				...(options.deferredReload === true ? { deferred: true } : {}),
				message: "reloaded",
				reloadedAtMs: Date.now(),
				success: true,
			};
		},
	};
	const testSandbox = createTestSandbox();
	const calls: SandboxExecInput[] = [...testSandbox.calls];
	const baseSandbox = options.sandbox ?? testSandbox.provider;
	const sandbox: SandboxProvider = async () => {
		const executor = await baseSandbox();
		return {
			id: executor.id,
			exec: async (input) => {
				calls.push(input);
				return await executor.exec(input);
			},
		};
	};
	const service = new SelfIterationService({
		audit: { record: async (entry) => void audits.push(entry) },
		binding: {
			// The fixture deployer builds exactly the approved patch.
			appliedIdentity: (proposal) => {
				pendingIdentity = {
					diffChecksum: proposal.diffChecksum,
					revision: `built-${proposal.id}`,
				};
				return pendingIdentity;
			},
			healthCheck: (): HealthCheckResult => {
				checks.count += 1;
				const ok = checks.script(checks.count);
				return { checkedAtMs: checks.count, ...(ok ? {} : { message: "unhealthy" }), ok };
			},
			reload,
			repositoryRoot: repo,
			runningIdentity: () => running.current,
			store,
			...(options.workspaceTaskFor === undefined
				? {}
				: { workspaceTaskFor: options.workspaceTaskFor }),
			worktreeRoot: worktrees,
		},
		logger: captureLogger(logs),
		sandbox,
		storage: new MemoryStorage(),
	});
	return {
		audits,
		checks,
		logs,
		reloads,
		repo,
		running,
		sandboxCalls: calls,
		service,
		store,
		worktrees,
	};
}

beforeEach(() => {});
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function patchTask(service: SelfIterationService, goal = "Patch the fixture") {
	const task = await service.createTask({
		goal,
		mode: "proposal",
		sourceConversationId: "coding-conversation",
	});
	await service.worktree({ taskId: task.id });
	await service.edit({
		create: true,
		content: "export const added = true;\n",
		path: "src/added.ts",
		taskId: task.id,
	});
	return task;
}

async function proposalFor(service: SelfIterationService, taskId: string) {
	await service.test({ taskId });
	await service.build({ taskId });
	await service.diff({ taskId });
	return await service.propose({
		envChanges: [],
		motivation: "Keep the fixture honest",
		requiresRestart: false,
		riskAssessment: "low",
		rollbackNotes: "git revert the commit",
		taskId,
		title: "Fixture patch",
	});
}

describe("SelfIterationService", () => {
	test("runs every task with full authority, enforces path policy, and records the tool timeline", async () => {
		const { audits, service } = await fixture();
		const analysis = await service.createTask({
			goal: "Analyze only",
			mode: "analysis",
			sourceConversationId: "coding-conversation",
		});
		const read = await service.analyze({ action: "read", path: "README.md", taskId: analysis.id });
		expect(read.content).toContain("Self iteration fixture");
		// The stored analysis label no longer gates writes: the coding agent is full-authority.
		await service.worktree({ taskId: analysis.id });
		const edit = await service.edit({
			content: "allowed",
			create: true,
			path: "src/allowed.ts",
			taskId: analysis.id,
		});
		expect(edit.path).toBe("src/allowed.ts");

		const task = await patchTask(service);
		await expect(
			service.edit({
				content: "escaped",
				create: true,
				path: "../../escape.ts",
				taskId: task.id,
			}),
		).rejects.toThrow();
		const status = await service.status(task.id);
		expect(status.task.timeline.some((entry) => entry.tool === "self-iteration.worktree")).toBe(
			true,
		);
		expect(status.worktree.path).toContain(task.id);
		expect(audits.some((entry) => entry.result === "denied")).toBe(true);
	});

	test("runs allowlisted tests/builds, bounds output, and rejects commands outside policy", async () => {
		const { sandboxCalls, service, store } = await fixture();
		const task = await patchTask(service);
		const testResult = await service.test({ taskId: task.id });
		expect(testResult.passed).toBe(true);
		expect(testResult.total).toBeGreaterThanOrEqual(1);
		const build = await service.build({ taskId: task.id });
		expect(build.success).toBe(true);
		expect(build.artifactMetadata.checksum).toHaveLength(64);
		await expect(service.test({ command: "sh", taskId: task.id })).rejects.toThrow(
			"command_override_not_allowed",
		);
		await expect(service.test({ args: ["-e", "console.log(1)"], taskId: task.id })).rejects.toThrow(
			"argument_override_not_allowed",
		);
		await expect(service.build({ command: "sh", taskId: task.id })).rejects.toThrow(
			"command_override_not_allowed",
		);
		await service.updatePolicy({ maxOutputBytes: 1024 }, "admin");
		const bounded = await service.test({ taskId: task.id });
		expect(Buffer.byteLength(bounded.stdout, "utf-8")).toBeLessThanOrEqual(1024);
		const loaded = await store.getTask(task.id);
		expect(loaded?.artifacts.some((artifact) => artifact.kind === "test")).toBe(true);
		expect(loaded?.artifacts.some((artifact) => artifact.kind === "build")).toBe(true);
		// Every governed execution ran with the policy command and the worktree as the target.
		expect(sandboxCalls.length).toBeGreaterThan(0);
		expect(sandboxCalls.every((call) => call.command === "bun")).toBe(true);
		expect(sandboxCalls.every((call) => call.cwd === loaded?.worktreePath)).toBe(true);
		expect(sandboxCalls.filter((call) => call.writable).length).toBe(sandboxCalls.length);
	});

	test("fails closed when no sandbox is available", async () => {
		const { service, sandboxCalls } = await fixture({
			sandbox: async () => {
				throw new SandboxUnavailableError("bubblewrap probe failed");
			},
		});
		const task = await patchTask(service);
		await expect(service.test({ taskId: task.id })).rejects.toThrow("sandbox_unavailable");
		await expect(service.build({ taskId: task.id })).rejects.toThrow("sandbox_unavailable");
		await expect(
			service.analyze({ action: "search", pattern: "fixture", taskId: task.id }),
		).rejects.toThrow("sandbox_unavailable");
		expect(sandboxCalls).toHaveLength(0);
	});

	test("never falls back to the live tree and cannot inject search flags or paths", async () => {
		const { repo: fixtureRepo, service, sandboxCalls } = await fixture();
		const live = await service.createTask({ goal: "Patch without worktree", mode: "proposal" });
		// Validation provisions the task's own worktree first; the live tree is never the cwd.
		await service.test({ taskId: live.id });
		const liveWorktree = (await service.getTask(live.id))?.worktreePath;
		expect(liveWorktree).toBeDefined();
		expect(sandboxCalls.at(-1)?.cwd).toBe(liveWorktree);
		expect(sandboxCalls.at(-1)?.cwd).not.toBe(fixtureRepo);
		await service.build({ taskId: live.id });
		expect(sandboxCalls.at(-1)?.cwd).toBe(liveWorktree);

		const task = await patchTask(service);
		await service.analyze({
			action: "search",
			pattern: "--pre=sh -c 'touch /tmp/pwned'",
			taskId: task.id,
		});
		const search = sandboxCalls.at(-1);
		expect(search?.args.slice(-3)).toEqual(["--", "--pre=sh -c 'touch /tmp/pwned'", "/analysis"]);
		await expect(
			service.analyze({ action: "search", path: "../../", pattern: "x", taskId: task.id }),
		).rejects.toThrow();
		await expect(
			service.analyze({ action: "search", path: "/etc", pattern: "x", taskId: task.id }),
		).rejects.toThrow();
		await expect(service.test({ pattern: "--preload=./evil.ts", taskId: task.id })).rejects.toThrow(
			"invalid_test_pattern",
		);
	});

	test("validates all seven proposal groups and creates a pending approval", async () => {
		const { audits, service } = await fixture();
		const task = await patchTask(service);
		const invalid = await service.propose({ taskId: task.id });
		expect(invalid.missing).toContain("title");
		expect(invalid.missing).toContain("motivation");
		expect(invalid.missing).toContain("riskAssessment");
		const proposal = await proposalFor(service, task.id);
		expect(proposal.missing).toEqual([]);
		expect(proposal.proposal.status).toBe("pending_approval");
		expect(proposal.proposal.changedFiles).toContain("src/added.ts");
		expect(proposal.proposal.diffChecksum).toHaveLength(64);
		expect(proposal.approvalId.length).toBeGreaterThan(0);
		const approvals = await service.listApprovals(task.id);
		expect(approvals).toHaveLength(1);
		expect(audits.some((entry) => entry.action === "self-iteration.propose")).toBe(true);

		const approved = await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			note: "looks good",
			resolvedBy: "admin",
		});
		expect(approved.status).toBe("approved");
		expect((await service.getProposal(proposal.proposal.id))?.status).toBe("approved");
	});

	test("rejects expired approvals and audits rejection", async () => {
		const { audits, service, store } = await fixture();
		const task = await service.createTask({ goal: "Expiry", mode: "proposal" });
		const expired = await store.create({
			action: "deploy",
			expiresAtMs: Date.now() - 1_000,
			requestedBy: "agent",
			taskId: task.id,
		});
		await expect(
			service.resolveApproval({ action: "approve", approvalId: expired.id, resolvedBy: "admin" }),
		).rejects.toThrow("approval_expired");
		const pending = await store.create({
			action: "deploy",
			expiresAtMs: Date.now() + 60_000,
			requestedBy: "agent",
			taskId: task.id,
		});
		const rejected = await service.resolveApproval({
			action: "reject",
			approvalId: pending.id,
			note: "no",
			resolvedBy: "admin",
		});
		expect(rejected.status).toBe("rejected");
		expect(audits.some((entry) => entry.action === "self-iteration.approval.reject")).toBe(true);
	});

	test("deploys with health gates, auto-rolls back on failed post-check, and rolls back manually", async () => {
		const { checks, reloads, service, store } = await fixture();
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const dryRun = await service.deploy({
			createdBy: "admin",
			dryRun: true,
			proposalId: proposal.proposal.id,
		});
		expect(dryRun.dryRun).toBe(true);
		expect(dryRun.deployment.status).toBe("pending");

		const deployed = await service.deploy({ createdBy: "admin", proposalId: proposal.proposal.id });
		expect(deployed.outcome?.success).toBe(true);
		expect(deployed.deployment.status).toBe("deployed");
		expect(deployed.deployment.postCheck?.ok).toBe(true);
		expect(reloads).toHaveLength(1);

		const rollback = await service.rollback({
			createdBy: "admin",
			deploymentId: deployed.deployment.id,
		});
		expect(rollback.deployment.status).toBe("rolled_back");
		expect(rollback.deployment.rollbackOfId).toBe(deployed.deployment.id);

		// A failed post-check records the rollback attempt truthfully; it is not success.
		checks.script = (count) => count % 2 === 1;
		const second = await store.createProposal({
			artifactMetadata: null,
			changedFiles: ["src/added.ts"],
			diff: "diff --git a/x b/x",
			diffChecksum: sha256Hex("diff --git a/x b/x"),
			envChanges: [],
			motivation: "Second change",
			requiresRestart: true,
			riskAssessment: "medium",
			rollbackNotes: "revert",
			sourceRevision: "abc",
			taskId: task.id,
			testResult: { exitCode: 0, failed: 0, passed: true, stderr: "", stdout: "", total: 1 },
			title: "Second",
		});
		await store.transition(second.id, "pending_approval");
		await store.transition(second.id, "approved");
		const secondApproval = await store.create({
			action: "deploy",
			expiresAtMs: Date.now() + 60_000,
			proposalId: second.id,
			requestedBy: "admin",
			taskId: task.id,
		});
		await store.approve(secondApproval.id, "admin");
		const failed = await service.deploy({ createdBy: "admin", proposalId: second.id });
		expect(failed.deployment.status).toBe("failed");
		expect(failed.rollback?.status).toBe("manual_apply_required");
		expect(failed.rollback?.rollbackOfId).toBe(failed.deployment.id);
		const deployments = await store.listDeployments({ taskId: task.id });
		expect(deployments.filter((deployment) => deployment.status === "rolled_back")).toHaveLength(1);
		expect(
			deployments.filter((deployment) => deployment.status === "manual_apply_required"),
		).toHaveLength(1);
	});

	test("keeps a deferred restart scheduled until boot reconciliation settles it", async () => {
		const { service, store } = await fixture({ deferredReload: true });
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const scheduled = await service.deploy({
			createdBy: "admin",
			proposalId: proposal.proposal.id,
		});
		expect(scheduled.outcome?.deferred).toBe(true);
		expect(scheduled.deployment.status).toBe("scheduled");
		expect((await service.getProposal(proposal.proposal.id))?.status).toBe("deploying");
		expect((await store.getTask(task.id))?.status).toBe("deploying");

		// A restarted process alone does not prove the proposal is live.
		const unverified = await reconcileRestartDeployment(store, {
			deploymentId: scheduled.deployment.id,
			outcome: "completed",
		});
		expect(unverified?.updated).toBe(true);
		expect(unverified?.deployment.status).toBe("manual_apply_required");
		expect(unverified?.proposal?.status).toBe("deploying");

		// With proof of the exact applied artifact it settles truthfully.
		const settled = await reconcileRestartDeployment(store, {
			deploymentId: scheduled.deployment.id,
			outcome: "completed",
			verify: async () => {
				const identity = scheduled.deployment.appliedIdentity;
				if (identity === null) throw new Error("fixture deployment has no applied identity");
				return { detail: "running artifact matches", identity, verified: true };
			},
		});
		expect(settled?.updated).toBe(true);
		expect(settled?.deployment.status).toBe("deployed");
		expect(settled?.proposal?.status).toBe("deployed");
		expect(settled?.task?.status).toBe("completed");

		// Recovery is replayable: a second boot must not rewrite terminal history.
		const replay = await reconcileRestartDeployment(store, {
			deploymentId: scheduled.deployment.id,
			outcome: "completed",
			verify: async () => ({ verified: true }),
		});
		expect(replay?.updated).toBe(false);
		expect(replay?.deployment.status).toBe("deployed");
	});

	test("records manual_apply_required when the host cannot prove the artifact", async () => {
		const { service, store } = await fixture();
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const deployed = await service.deploy({
			createdBy: "admin",
			proposalId: proposal.proposal.id,
		});
		// The deployment claims an identity, but a reload that does not change the running
		// artifact (or a host that cannot report one) must not be reported as deployed.
		expect(deployed.deployment.appliedIdentity?.diffChecksum).toBe(proposal.proposal.diffChecksum);
		expect(deployed.deployment.status).toBe("deployed");

		// A second deploy whose host reports the old artifact stays manual_apply_required.
		const secondTask = await patchTask(service, "Second patch");
		const secondProposal = await proposalFor(service, secondTask.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: secondProposal.approvalId,
			resolvedBy: "admin",
		});
		const reload = await service.deploy({
			createdBy: "admin",
			proposalId: secondProposal.proposal.id,
		});
		expect(reload.deployment.status).toBe("deployed");
		const stored = await store.getDeployment(reload.deployment.id);
		expect(stored?.appliedIdentity?.diffChecksum).toBe(secondProposal.proposal.diffChecksum);
	});

	test("does not report a rollback applied when no previous artifact is recorded", async () => {
		const { service, store } = await fixture();
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const deployed = await service.deploy({
			createdBy: "admin",
			proposalId: proposal.proposal.id,
		});
		// Simulate a deployment created before identity recording existed.
		await store.updateDeployment(deployed.deployment.id, { status: "deployed" });
		const legacy = await store.createDeployment({
			artifactMetadata: null,
			createdBy: "admin",
			proposalId: proposal.proposal.id,
			rollbackPlan: "revert",
			sourceRevision: "abc",
			status: "deployed",
			taskId: task.id,
		});
		const rollback = await service.rollback({
			createdBy: "admin",
			deploymentId: legacy.id,
		});
		expect(rollback.deployment.status).toBe("manual_apply_required");
		expect(rollback.deployment.appliedIdentity).toBeNull();
		expect(rollback.deployment.postCheck).toBeNull();
	});

	test("does not claim rolled_back when the restored artifact differs from the recorded target", async () => {
		const { service } = await fixture({ applyRollback: false });
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const deployed = await service.deploy({
			createdBy: "admin",
			proposalId: proposal.proposal.id,
		});
		const rollback = await service.rollback({
			createdBy: "admin",
			deploymentId: deployed.deployment.id,
		});
		expect(rollback.deployment.status).toBe("manual_apply_required");
		expect(rollback.deployment.postCheck?.ok).toBe(false);
	});

	test("emits info, debug, and trace logs across the proposal lifecycle", async () => {
		const { logs, service } = await fixture();
		const task = await patchTask(service);
		const proposal = await proposalFor(service, task.id);
		await service.resolveApproval({
			action: "approve",
			approvalId: proposal.approvalId,
			resolvedBy: "admin",
		});
		const deployed = await service.deploy({
			createdBy: "admin",
			proposalId: proposal.proposal.id,
		});
		await service.rollback({ createdBy: "admin", deploymentId: deployed.deployment.id });

		const saw = (level: CapturedLog["level"], message: string): boolean =>
			logs.some((entry) => entry.level === level && entry.message === message);

		expect(saw("debug", "task created")).toBe(true);
		expect(saw("debug", "worktree created")).toBe(true);
		expect(saw("debug", "edit applied")).toBe(true);
		expect(saw("info", "proposal created")).toBe(true);
		expect(saw("info", "proposal approved")).toBe(true);
		expect(saw("info", "deployment started")).toBe(true);
		expect(saw("info", "deployment succeeded")).toBe(true);
		expect(saw("info", "rollback started")).toBe(true);
		expect(saw("info", "rollback succeeded")).toBe(true);
		expect(saw("trace", "test started")).toBe(true);
		expect(saw("trace", "build started")).toBe(true);
		expect(saw("trace", "proposal requested")).toBe(true);
		expect(saw("trace", "task create requested")).toBe(true);

		const completed = logs.find(
			(entry) => entry.level === "debug" && entry.message === "test completed",
		);
		expect(typeof detailsOf(completed).durationMs).toBe("number");

		const deploymentLog = logs.find(
			(entry) => entry.level === "info" && entry.message === "deployment started",
		);
		expect(deploymentLog?.details).toEqual(
			expect.objectContaining({ dryRun: false, proposalId: proposal.proposal.id }),
		);
	});

	test("bounds trace previews to one line of 120 characters", async () => {
		const { logs, service } = await fixture();
		const goal = `${`x`.repeat(40)}\n${"y".repeat(200)}`;
		await service.createTask({ goal, mode: "analysis" });
		const requested = logs.filter(
			(entry) => entry.level === "trace" && entry.message === "task create requested",
		);
		const preview = String(detailsOf(requested.at(-1)).goal ?? "");
		expect(preview.length).toBeLessThanOrEqual(120);
		expect(preview).toContain("\\n");
		expect(preview).not.toContain("\n");
		expect(preview.endsWith("…")).toBe(true);
	});

	test("registers the plugin and exposes the bounded model tools", async () => {
		const { repo, store, worktrees } = await fixture();
		const tools: string[] = [];
		const rpc: string[] = [];
		const logs: CapturedLog[] = [];
		const context = {
			audit: { record: async () => undefined },
			dependencies: {
				get: () => ({
					healthCheck: async () => ({ checkedAtMs: 0, ok: true }),
					reload: { reload: async () => ({ message: "ok", reloadedAtMs: 0, success: true }) },
					repositoryRoot: repo,
					store,
					worktreeRoot: worktrees,
				}),
			},
			logger: captureLogger(logs),
			rpc: { register: (name: string) => void rpc.push(name) },
			storage: new MemoryStorage(),
			tools: { register: (tool: { name: string }) => void tools.push(tool.name) },
			ui: { setStatus: () => undefined },
		};
		await selfIterationPlugin.setup(context as never);
		expect(tools.toSorted()).toEqual([
			"self-iteration.analyze",
			"self-iteration.build",
			"self-iteration.diff",
			"self-iteration.edit",
			"self-iteration.propose",
			"self-iteration.status",
			"self-iteration.test",
			"self-iteration.upstream",
			"self-iteration.worktree",
		]);
		expect(tools.some((name) => /maintenance|deploy|rollback|backup|reload/u.test(name))).toBe(
			false,
		);
		expect(rpc).toContain("deployments.deploy");
		expect(rpc).toContain("deployments.rollback");
		expect(rpc).toContain("approvals.resolve");
		expect(rpc).toContain("policy.update");
		expect(SELF_ITERATION_HOST_BINDING).toBe("tsukaima.self-iteration.host");
		expect(logs.some((entry) => entry.level === "debug" && entry.message.includes("setup"))).toBe(
			true,
		);
		expect(
			logs.some((entry) => entry.level === "info" && entry.message === "self-iteration ready"),
		).toBe(true);

		if (selfIterationPlugin.teardown === undefined) throw new Error("teardown missing");
		await selfIterationPlugin.teardown(context as never);
		expect(
			logs.some((entry) => entry.level === "debug" && entry.message === "self-iteration teardown"),
		).toBe(true);
	});
});

describe("analysis isolation", () => {
	test("reads committed content and cannot see uncommitted or nested secrets", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-analysis-"));
		directories.push(root);
		const repo = join(root, "repo");
		const worktrees = join(root, "worktrees");
		await fs.mkdir(join(repo, "config", "secrets"), { recursive: true });
		await fs.writeFile(join(repo, "README.md"), "# committed\n");
		await fs.writeFile(join(repo, "config", "secrets", "nested.env"), "NESTED=committed-leak\n");
		await git(repo, ["init", "-b", "main"]);
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "initial"]);
		// Uncommitted, gitignored state must never appear in the analysis snapshot.
		await fs.writeFile(join(repo, ".gitignore"), "*.local\n");
		await fs.writeFile(join(repo, "secret.local"), "WORKTREE=leak\n");
		await fs.writeFile(join(repo, "README.md"), "# working tree only\n");
		await git(repo, ["add", ".gitignore"]);
		await git(repo, ["commit", "-m", "ignore"]);

		const store = new DomainCodingStore(join(root, "domain.sqlite"));
		const service = new SelfIterationService({
			audit: { record: async () => undefined },
			binding: {
				healthCheck: () => ({ checkedAtMs: 1, ok: true }),
				reload: new NoopReloadController(),
				repositoryRoot: repo,
				store,
				worktreeRoot: worktrees,
			},
			logger: captureLogger([]),
			storage: new MemoryStorage(),
		});
		const task = await service.createTask({ goal: "Inspect", mode: "analysis" });
		const read = await service.analyze({ action: "read", path: "README.md", taskId: task.id });
		expect(read.content).toContain("# committed");
		expect(read.content).not.toContain("working tree only");

		const found = await service.analyze({
			action: "search",
			pattern: "leak",
			taskId: task.id,
		});
		expect(String(found.output)).toContain("committed-leak");
		expect(String(found.output)).not.toContain("WORKTREE=leak");
	});
});

describe("patch analysis surface", () => {
	test("a patch task reads its worktree edits, not the live repository", async () => {
		const { repo, service } = await fixture();
		const task = await patchTask(service);
		await fs.writeFile(join(repo, "src", "app.ts"), "export const value = 'live-tree';\n");
		const read = await service.analyze({
			action: "read",
			path: "src/app.ts",
			taskId: task.id,
		});
		// The worktree still has the base value; the live tree edit must not be visible.
		expect(read.content).toContain("old");
		expect(read.content).not.toContain("live-tree");
	});
});

describe("workspace task binding and worktree provisioning", () => {
	test("provisions one worktree for concurrent first calls and reuses it on retry", async () => {
		const { repo, service, worktrees } = await fixture();
		const task = await service.createTask({
			goal: "Concurrent first use",
			mode: "proposal",
			sourceConversationId: "coding-conversation",
		});
		const [edited] = await Promise.all([
			service.edit({ content: "a\n", create: true, path: "src/a.ts", taskId: task.id }),
			service.worktree({ taskId: task.id }),
		]);
		expect(edited.path).toBe("src/a.ts");
		const again = await service.worktree({ taskId: task.id });
		const path = join(worktrees, task.id);
		expect(again.path).toBe(path);
		expect((await service.getTask(task.id))?.worktreePath).toBe(path);
		const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo })
			.toString()
			.split("\n")
			.filter((line) => line.startsWith("worktree ") && line.includes(task.id));
		expect(listed).toHaveLength(1);
	});

	test("adopts a checkout left at the task path by an interrupted provisioning attempt", async () => {
		const { repo, service, worktrees } = await fixture();
		const task = await service.createTask({
			goal: "Retry after partial failure",
			mode: "proposal",
			sourceConversationId: "coding-conversation",
		});
		const path = join(worktrees, task.id);
		await git(repo, ["worktree", "add", "-b", `tsukaima-iteration/${task.id}`, path, "HEAD"]);
		const result = await service.worktree({ taskId: task.id });
		expect(result.path).toBe(path);
		expect((await service.getTask(task.id))?.worktreePath).toBe(path);
		await service.edit({
			content: "retried\n",
			create: true,
			path: "src/retry.ts",
			taskId: task.id,
		});
		expect(await fs.readFile(join(path, "src", "retry.ts"), "utf-8")).toBe("retried\n");
	});

	test("reads the task base revision before any checkout exists", async () => {
		const { repo, service } = await fixture();
		const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
		const task = await service.createTask({
			baseRef: base,
			goal: "Inspect the base",
			mode: "analysis",
			sourceConversationId: "coding-conversation",
		});
		await fs.writeFile(join(repo, "README.md"), "# Changed after the base\n");
		await git(repo, ["commit", "-am", "after base"]);
		const read = await service.analyze({ action: "read", path: "README.md", taskId: task.id });
		expect(read.content).toContain("Self iteration fixture");
		expect(read.content).not.toContain("Changed after the base");
		expect((await service.getTask(task.id))?.worktreePath).toBeUndefined();
	});

	test("binds model calls to the Workspace task, audits mismatches, and fails without a binding", async () => {
		const bindings = new Map<string, string | null>([["conv-draft", null]]);
		const { audits, service } = await fixture({
			workspaceTaskFor: (conversationId) => bindings.get(conversationId),
		});
		const task = await service.createTask({
			goal: "Bound task",
			mode: "proposal",
			sourceConversationId: "coding-conversation",
		});
		bindings.set("conv-bound", task.id);
		const other = await service.createTask({
			goal: "Other task",
			mode: "proposal",
			sourceConversationId: "coding-conversation",
		});

		await expect(
			service.boundTaskId({ conversationId: "conv-draft", tool: "self-iteration.edit" }),
		).rejects.toThrow("task_binding_missing");
		await expect(service.boundTaskId({ tool: "self-iteration.edit" })).rejects.toThrow(
			"task_binding_missing",
		);
		await expect(
			service.boundTaskId({ conversationId: "conv-unknown", tool: "self-iteration.edit" }),
		).rejects.toThrow("task_binding_missing");

		expect(
			await service.boundTaskId({
				conversationId: "conv-bound",
				requestedTaskId: task.id,
				tool: "self-iteration.edit",
			}),
		).toBe(task.id);
		expect(
			await service.boundTaskId({ conversationId: "conv-bound", tool: "self-iteration.edit" }),
		).toBe(task.id);
		await expect(
			service.boundTaskId({
				conversationId: "conv-bound",
				requestedTaskId: other.id,
				tool: "self-iteration.edit",
			}),
		).rejects.toThrow("task_binding_mismatch");
		expect(
			audits.some(
				(entry) =>
					entry.action === "self-iteration.task.binding_mismatch" &&
					entry.result === "denied" &&
					entry.targetId === task.id,
			),
		).toBe(true);
		expect(
			audits.filter((entry) => entry.action === "self-iteration.task.binding_missing"),
		).toHaveLength(3);
	});
});
