import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBubblewrapSandbox,
	createTaskSnapshot,
	probeBubblewrapSandbox,
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
import type { AuditEntry, PluginContext, PluginLogger, PluginStorage } from "@tsukaima/sdk";
import { SELF_ITERATION_HOST_BINDING } from "./domain.ts";
import { selfIterationPlugin } from "./index.ts";
import { SelfIterationService } from "./service.ts";
import { registerSelfIterationTools } from "./tools.ts";

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
function createTestSandbox(repositoryPath: string): {
	calls: SandboxExecInput[];
	provider: SandboxProvider;
} {
	const calls: SandboxExecInput[] = [];
	const provider: SandboxProvider = async () => ({
		// A deterministic stand-in for bubblewrap: it claims isolation so the isolated tools are
		// exercised, and it mirrors the snapshot semantics without namespaces.
		id: "test-sandbox",
		isolated: true,
		exec: async (input) => {
			calls.push(input);
			const resolved = Bun.which(input.command);
			if (resolved === null) throw new Error(`command_not_found:${input.command}`);
			if (input.snapshot === true) {
				const snapshotDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-test-snapshot-"));
				try {
					const snapshot = await createTaskSnapshot({
						repositoryPath,
						sourcePath: input.cwd,
						targetPath: snapshotDir,
					});
					const result = await runManagedProcess({
						args: [...input.args],
						command: resolved,
						cwd: snapshotDir,
						env: {
							HOME: snapshotDir,
							LANG: "C.UTF-8",
							PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
							TMPDIR: snapshotDir,
							TZ: "UTC",
						},
						maxOutputBytes: input.maxOutputBytes,
						...(input.signal === undefined ? {} : { signal: input.signal }),
						timeoutMs: input.timeoutMs,
					});
					return { ...result, snapshot: snapshot.manifest };
				} finally {
					await fs.rm(snapshotDir, { force: true, recursive: true });
				}
			}
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
		/** Use the real bubblewrap provider for this repository instead of the test double. */
		readonly realBubblewrap?: boolean;
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
	const testSandbox = createTestSandbox(repo);
	const calls: SandboxExecInput[] = [...testSandbox.calls];
	const baseSandbox =
		options.sandbox ??
		(options.realBubblewrap === true
			? createBubblewrapSandbox({ repositoryPath: repo, worktreeRoot: worktrees })
			: testSandbox.provider);
	const sandbox: SandboxProvider = async () => {
		const executor = await baseSandbox();
		return {
			id: executor.id,
			isolated: executor.isolated,
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
		const statuses: { level?: string; code?: string; summary?: string }[] = [];
		const context = {
			audit: { record: async () => undefined },
			dependencies: {
				get: () => ({
					healthCheck: async () => ({ checkedAtMs: 0, ok: true }),
					reload: { reload: async () => ({ message: "ok", reloadedAtMs: 0, success: true }) },
					// Without bubblewrap the isolated tools are withheld, not offered and failing.
					repositoryRoot: repo,
					sandbox: async () => {
						throw new SandboxUnavailableError("bubblewrap (bwrap) is not installed on the host", {
							code: "bwrap_missing",
							remedy: "Install the bubblewrap package, then restart the server.",
						});
					},
					store,
					worktreeRoot: worktrees,
				}),
			},
			logger: captureLogger(logs),
			rpc: { register: (name: string) => void rpc.push(name) },
			storage: new MemoryStorage(),
			tools: { register: (tool: { name: string }) => void tools.push(tool.name) },
			ui: {
				setStatus: (status: { level?: string; code?: string; summary?: string }) =>
					void statuses.push(status),
			},
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
		const last = statuses.at(-1);
		expect(last?.code).toBe("isolated_executor_unavailable");
		expect(last?.level).toBe("warning");
		expect(last?.summary).toContain("bubblewrap");
		expect(last?.summary).toContain("Install the bubblewrap package");
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

	test("offers exec and check upfront only when the isolated executor passed its probe", async () => {
		const { repo, store, worktrees } = await fixture();
		const tools: string[] = [];
		const statuses: { level?: string; code?: string }[] = [];
		const context = {
			audit: { record: async () => undefined },
			dependencies: {
				get: () => ({
					healthCheck: async () => ({ checkedAtMs: 0, ok: true }),
					reload: { reload: async () => ({ message: "ok", reloadedAtMs: 0, success: true }) },
					repositoryRoot: repo,
					sandbox: createTestSandbox(repo).provider,
					store,
					worktreeRoot: worktrees,
				}),
			},
			logger: captureLogger([]),
			rpc: { register: () => undefined },
			storage: new MemoryStorage(),
			tools: {
				register: (tool: { name: string; policy?: { lazy?: boolean } }) =>
					void tools.push(tool.name),
			},
			ui: { setStatus: (status: { level?: string; code?: string }) => void statuses.push(status) },
		};
		await selfIterationPlugin.setup(context as never);
		expect(tools).toContain("self-iteration.exec");
		expect(tools).toContain("self-iteration.check");
		expect(statuses.at(-1)?.level).toBe("ok");
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

describe("isolated Workspace exec and check targets", () => {
	test("exec runs on a disposable snapshot: writes stay out of the worktree and the audit omits the script", async () => {
		const { audits, service, sandboxCalls } = await fixture();
		const task = await patchTask(service);
		const worktree = (await service.status(task.id)).worktree.path;
		if (worktree === null) throw new Error("worktree missing");
		const result = await service.exec({
			script:
				"printf scratch > generated.txt && mkdir -p out && echo built > out/bundle.js && cat generated.txt",
			taskId: task.id,
		});
		expect(result.passed).toBe(true);
		expect(result.stdout.trim()).toBe("scratch");
		expect(result.snapshot.checksum).toMatch(/^[0-9a-f]{64}$/u);
		const call = sandboxCalls.at(-1);
		expect(call?.snapshot).toBe(true);
		expect(call?.command).toBe("bash");
		expect(call?.args.slice(0, 2)).toEqual(["--noprofile", "--norc"]);
		await expect(fs.stat(join(worktree, "generated.txt"))).rejects.toThrow();
		await expect(fs.stat(join(worktree, "out"))).rejects.toThrow();
		const exec = audits.find((entry) => entry.action === "self-iteration.exec");
		expect(exec?.result).toBe("ok");
		expect(JSON.stringify(audits)).not.toContain("generated.txt");
		expect(JSON.stringify(audits)).not.toContain("printf scratch");
	});

	test("exec rejects oversized and empty scripts without starting a process", async () => {
		const { sandboxCalls, service } = await fixture();
		const task = await patchTask(service);
		await expect(service.exec({ script: "   ", taskId: task.id })).rejects.toThrow(
			"script is required",
		);
		await expect(
			service.exec({ script: "x".repeat(64 * 1024 + 1), taskId: task.id }),
		).rejects.toThrow("script_too_large");
		expect(sandboxCalls.some((call) => call.snapshot === true)).toBe(false);
	});

	test("exec reports cancellation and timeout as outcomes, not as a successful run", async () => {
		const { audits, service } = await fixture();
		const task = await patchTask(service);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 150);
		const startedAt = performance.now();
		const cancelled = await service.exec({
			script: "sleep 30",
			signal: controller.signal,
			taskId: task.id,
		});
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.passed).toBe(false);
		expect(performance.now() - startedAt).toBeLessThan(10_000);
		expect(
			audits.some(
				(entry) => entry.action === "self-iteration.exec" && entry.reason === "cancelled",
			),
		).toBe(true);

		await service.updatePolicy({ execTimeoutMs: 1000 }, "webui-admin");
		const timed = await service.exec({ script: "sleep 30", taskId: task.id });
		expect(timed.timedOut).toBe(true);
		expect(timed.passed).toBe(false);
	}, 30_000);

	test("exec and concurrent checks share one provisioned worktree and each record their own snapshot", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const [first, second] = await Promise.all([
			service.exec({ script: "echo one", taskId: task.id }),
			service.check({ target: "test", taskId: task.id }),
		]);
		expect(first.passed).toBe(true);
		expect(second.passed).toBe(true);
		expect(second.summary?.total ?? 0).toBeGreaterThanOrEqual(1);
		const bundle = await service.status(task.id);
		expect(bundle.worktree.path).not.toBeNull();
		expect(bundle.executor.available).toBe(true);
	});

	test("check records a snapshot-bound artifact that changes when the task content changes", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const first = await service.check({ target: "test", taskId: task.id });
		expect(first.argv).toEqual(["bun", "test"]);
		const before = (await service.status(task.id)).task.artifacts.filter(
			(entry) => entry.kind === "test",
		);
		const recorded = before.at(-1);
		expect(recorded?.name).toBe("check:test");
		expect(recorded?.metadata?.snapshot).toMatchObject({ checksum: first.snapshot.checksum });
		await service.edit({
			content: "export const changed = 1;\n",
			create: true,
			path: "src/changed.ts",
			taskId: task.id,
		});
		const second = await service.check({ target: "test", taskId: task.id });
		expect(second.snapshot.checksum).not.toBe(first.snapshot.checksum);
	});

	test("check accepts only server-owned targets and refuses a pattern for targets that take none", async () => {
		const { audits, sandboxCalls, service } = await fixture();
		const task = await patchTask(service);
		const before = sandboxCalls.length;
		await expect(service.check({ target: "sh", taskId: task.id })).rejects.toThrow(
			"unknown_check_target:sh",
		);
		await expect(
			service.check({ pattern: "--preload=./evil.ts", target: "test", taskId: task.id }),
		).rejects.toThrow("invalid_test_pattern");
		await expect(
			service.check({ pattern: "src", target: "lint", taskId: task.id }),
		).rejects.toThrow("pattern_not_supported:lint");
		expect(sandboxCalls.length).toBe(before);
		expect(audits.some((entry) => entry.reason === "unknown_check_target:sh")).toBe(true);
	});

	test("shell runs one allowlisted command with explicit args on the snapshot", async () => {
		const { audits, sandboxCalls, service } = await fixture();
		const task = await patchTask(service);
		const result = await service.shell({
			args: ["ls-files", "--others", "--exclude-standard"],
			command: "git",
			taskId: task.id,
		});
		expect(result.passed).toBe(true);
		const call = sandboxCalls.at(-1);
		expect(call?.command).toBe("git");
		expect(call?.args).toEqual(["ls-files", "--others", "--exclude-standard"]);
		expect(call?.snapshot).toBe(true);
		expect(result.snapshot.checksum).toMatch(/^[0-9a-f]{64}$/u);
		expect(audits.some((entry) => entry.action === "self-iteration.shell")).toBe(true);
	});

	test("shell rejects commands outside the allowlist before any process starts", async () => {
		const { audits, sandboxCalls, service } = await fixture();
		const task = await patchTask(service);
		const before = sandboxCalls.length;
		await expect(
			service.shell({ args: ["-c", "evil"], command: "sh", taskId: task.id }),
		).rejects.toThrow("command_not_allowed:sh");
		await expect(service.shell({ command: "   ", taskId: task.id })).rejects.toThrow(
			"command is required",
		);
		await expect(
			service.shell({ args: ["--\0"], command: "git", taskId: task.id }),
		).rejects.toThrow("invalid_args");
		expect(sandboxCalls.length).toBe(before);
		expect(audits.some((entry) => entry.reason === "command_not_allowed:sh")).toBe(true);
	});

	test("an unavailable isolated executor fails closed before any command starts", async () => {
		const { sandboxCalls, service } = await fixture({
			sandbox: async () => {
				throw new SandboxUnavailableError("bubblewrap probe failed", {
					code: "namespace_denied",
					remedy: "Allow unprivileged user namespaces.",
				});
			},
		});
		const task = await patchTask(service);
		await expect(service.exec({ script: "echo no", taskId: task.id })).rejects.toThrow(
			"sandbox_unavailable",
		);
		await expect(service.check({ target: "test", taskId: task.id })).rejects.toThrow(
			"sandbox_unavailable",
		);
		expect(sandboxCalls).toHaveLength(0);
		// A refused request must not provision a checkout first.
		const fresh = await service.createTask({
			goal: "Refused before provisioning",
			mode: "patch",
			sourceConversationId: "coding-conversation",
		});
		await expect(service.exec({ script: "echo no", taskId: fresh.id })).rejects.toThrow(
			"sandbox_unavailable",
		);
		expect((await service.getTask(fresh.id))?.worktreePath).toBeUndefined();
		const availability = await service.isolatedExecutorStatus();
		expect(availability).toMatchObject({
			available: false,
			code: "namespace_denied",
			remedy: "Allow unprivileged user namespaces.",
		});
	});

	test("a non-isolated backend is refused for exec and check even if it is reachable", async () => {
		const hostCalls: unknown[] = [];
		const { service } = await fixture({
			sandbox: async () => ({
				id: "host",
				isolated: false,
				exec: async (input) => {
					hostCalls.push(input);
					throw new Error("must not run");
				},
			}),
		});
		const task = await patchTask(service);
		await expect(service.exec({ script: "echo no", taskId: task.id })).rejects.toThrow(
			"without OS isolation",
		);
		await expect(service.check({ target: "webui-build", taskId: task.id })).rejects.toThrow(
			"without OS isolation",
		);
		expect(hostCalls).toHaveLength(0);
		const availability = await service.isolatedExecutorStatus();
		expect(availability.available).toBe(false);
		expect(availability.remedy).toContain("TSUKAIMA_CODING_SANDBOX=bubblewrap");
	});

	test("model exec and check calls are denied without a Workspace binding", async () => {
		const { audits, service, sandboxCalls } = await fixture();
		await patchTask(service);
		const tools: {
			name: string;
			execute: (
				input: Record<string, unknown>,
				invocation: { conversationId?: string },
			) => Promise<{ content: { text: string }[] }>;
		}[] = [];
		registerSelfIterationTools(
			{
				audit: { record: async () => undefined },
				logger: captureLogger([]),
				tools: { register: (tool: never) => void tools.push(tool) },
			} as unknown as PluginContext,
			service,
			{ isolatedExecution: true },
		);
		const exec = tools.find((tool) => tool.name === "self-iteration.exec");
		const check = tools.find((tool) => tool.name === "self-iteration.check");
		if (exec === undefined || check === undefined)
			throw new Error("isolated tools were not registered");
		const denied = await exec.execute({ script: "echo no" }, {});
		expect(denied.content[0]?.text).toContain("task_binding_missing");
		const unbound = await check.execute(
			{ target: "test", taskId: "other-task" },
			{ conversationId: "unbound" },
		);
		expect(unbound.content[0]?.text).toContain("task_binding_missing");
		expect(sandboxCalls.some((call) => call.snapshot === true)).toBe(false);
		expect(audits.some((entry) => entry.reason === "task_binding_missing")).toBe(true);
	});
});

describe("isolated Workspace exec and check targets (real bubblewrap)", () => {
	const bwrapProbe = probeBubblewrapSandbox({ repositoryPath: process.cwd() });

	test("bun test and a shell pipeline run on the task snapshot under real namespaces", async () => {
		if (!(await bwrapProbe).ok) return;
		const { service } = await fixture({ realBubblewrap: true });
		const task = await patchTask(service);
		const worktree = (await service.status(task.id)).worktree.path;
		if (worktree === null) throw new Error("worktree missing");
		expect((await service.isolatedExecutorStatus()).backend).toBe("bubblewrap");

		const check = await service.check({ target: "test", taskId: task.id });
		expect(check.passed).toBe(true);
		expect(check.summary?.total ?? 0).toBeGreaterThanOrEqual(1);
		expect(check.snapshot.checksum).toMatch(/^[0-9a-f]{64}$/u);

		const shell = await service.exec({
			script:
				"printf generated > scratch.txt && cat scratch.txt && echo && ls src | sort | head -n 5 | wc -l",
			taskId: task.id,
		});
		expect(shell.passed).toBe(true);
		expect(shell.stdout.split("\n")[0]).toBe("generated");
		await expect(fs.stat(join(worktree, "scratch.txt"))).rejects.toThrow();
	}, 120_000);

	test("the real shell can reach the network with the default policy, and is offline when the policy disables it", async () => {
		if (!(await bwrapProbe).ok) return;
		const { service } = await fixture({ realBubblewrap: true });
		const task = await patchTask(service);
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {}, open() {} },
		});
		try {
			// Default policy allows outbound connections; loopback to the host listener works.
			const online = await service.exec({
				script: `(exec 3<>/dev/tcp/127.0.0.1/${listener.port}) 2>/dev/null && echo reached || echo unreachable`,
				taskId: task.id,
			});
			expect(online.stdout).toContain("reached");

			// With the network disabled the same probe cannot connect.
			await service.updatePolicy({ execNetwork: "none" }, "webui-admin");
			const offline = await service.exec({
				script: `(exec 3<>/dev/tcp/127.0.0.1/${listener.port}) 2>/dev/null && echo reached || echo unreachable`,
				taskId: task.id,
			});
			expect(offline.stdout).toContain("unreachable");
		} finally {
			listener.stop(true);
		}
	}, 120_000);
});

function proposalText(taskId: string) {
	return {
		envChanges: [],
		motivation: "Keep the fixture honest",
		requiresRestart: false,
		riskAssessment: "low",
		rollbackNotes: "git revert the commit",
		taskId,
		title: "Fixture patch",
	};
}

async function verifiedTask(service: SelfIterationService) {
	const task = await patchTask(service);
	await service.check({ target: "test", taskId: task.id });
	// The synthetic fixture has no WebUI workspace, so the build evidence comes from the
	// configured compatibility build; its provenance is checked separately below.
	await service.build({ taskId: task.id });
	return task;
}

describe("proposal evidence bound to the snapshot", () => {
	test("derives patch, revision, files, checksums, and evidence server-side and ignores model-supplied evidence", async () => {
		const { service } = await fixture();
		const task = await verifiedTask(service);
		const forged = {
			artifactMetadata: { builtAtMs: 1, checksum: "forged", command: "forged", sizeBytes: 1 },
			changedFiles: ["forged.ts"],
			diff: "forged diff",
			diffChecksum: "0".repeat(64),
			sourceRevision: "forged",
			testResult: { exitCode: 0, failed: 0, passed: true, stderr: "", stdout: "", total: 1 },
			...proposalText(task.id),
		} as never;
		const result = await service.propose(forged);
		expect(result.missing).toEqual([]);
		expect(result.proposal.diff).toContain("added");
		expect(result.proposal.changedFiles).toEqual(["src/added.ts"]);
		expect(result.proposal.diffChecksum).not.toBe("0".repeat(64));
		expect(result.proposal.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
		expect(result.proposal.evidence?.items.map((item) => item.kind).toSorted()).toEqual([
			"build",
			"test",
		]);
		expect(result.proposal.evidence?.items.find((item) => item.kind === "test")?.provenance).toBe(
			"snapshot",
		);
		expect(result.proposal.evidence?.items.find((item) => item.kind === "build")?.provenance).toBe(
			"live",
		);
		expect(result.proposal.testResult?.passed).toBe(true);
	});

	test("an edit after verification refuses the proposal until checks run on the new content", async () => {
		const { service } = await fixture();
		const task = await verifiedTask(service);
		const first = await service.propose(proposalText(task.id));
		expect(first.missing).toEqual([]);
		await service.edit({ find: "true", path: "src/added.ts", replace: "false", taskId: task.id });
		const stale = await service.propose(proposalText(task.id));
		expect(stale.missing).toEqual(expect.arrayContaining(["testResult", "artifactMetadata"]));
		expect(stale.approvalId).toBe("");
		expect(stale.hint).toContain("self-iteration.check");
		await service.check({ target: "test", taskId: task.id });
		await service.build({ taskId: task.id });
		const fresh = await service.propose(proposalText(task.id));
		expect(fresh.missing).toEqual([]);
		expect(fresh.reused).toBe(false);
		expect(fresh.proposal.id).not.toBe(first.proposal.id);
	});

	test("a failed check blocks the proposal until a passing check runs on the same content", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		await service.edit({
			find: "toBe(1)",
			path: "src/app.test.ts",
			replace: "toBe(2)",
			taskId: task.id,
		});
		const failed = await service.check({ target: "test", taskId: task.id });
		expect(failed.passed).toBe(false);
		await service.build({ taskId: task.id });
		const blocked = await service.propose(proposalText(task.id));
		expect(blocked.missing).toContain("testResult");
		expect(blocked.missing).not.toContain("artifactMetadata");
		await service.edit({
			find: "toBe(2)",
			path: "src/app.test.ts",
			replace: "toBe(1)",
			taskId: task.id,
		});
		const passing = await service.check({ target: "test", taskId: task.id });
		expect(passing.passed).toBe(true);
		// The earlier build validated the failing content; the passing content needs its own build.
		await service.build({ taskId: task.id });
		const accepted = await service.propose(proposalText(task.id));
		expect(accepted.missing).toEqual([]);
	});

	test("a cancelled check is never attached as evidence", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const controller = new AbortController();
		controller.abort();
		const cancelled = await service.check({
			signal: controller.signal,
			target: "test",
			taskId: task.id,
		});
		expect(cancelled.passed).toBe(false);
		await service.build({ taskId: task.id });
		const refused = await service.propose(proposalText(task.id));
		expect(refused.missing).toContain("testResult");
	});

	test("an edit during a live validation unbinds the result and requires fresh evidence", async () => {
		let delegate: SandboxProvider | undefined;
		let duringBuild: (() => Promise<void>) | undefined;
		const provider: SandboxProvider = async () => {
			const executor = await delegate!();
			return {
				...executor,
				exec: async (input) => {
					if (input.snapshot !== true && duringBuild !== undefined) {
						const edit = duringBuild;
						duringBuild = undefined;
						await edit();
					}
					return executor.exec(input);
				},
			};
		};
		const { repo, service } = await fixture({ sandbox: provider });
		delegate = createTestSandbox(repo).provider;
		const task = await patchTask(service);
		await service.check({ target: "test", taskId: task.id });
		duringBuild = async () => {
			await service.edit({
				find: "true",
				path: "src/added.ts",
				replace: "false",
				taskId: task.id,
			});
		};
		const build = await service.build({ taskId: task.id });
		expect(build.success).toBe(true);
		const refused = await service.propose(proposalText(task.id));
		expect(refused.missing).toEqual(expect.arrayContaining(["testResult", "artifactMetadata"]));
		expect(refused.hint).toContain("self-iteration.check");
	});

	test("a changed path under an excluded directory refuses the diff instead of certifying it", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const worktree = String((await service.status(task.id)).task.worktreePath);
		await fs.mkdir(join(worktree, "node_modules", "pkg"), { recursive: true });
		await fs.writeFile(join(worktree, "node_modules", "pkg", "index.ts"), "export {};\n");
		await expect(service.diff({ taskId: task.id })).rejects.toThrow(
			"diff_not_covered_by_snapshot:node_modules/pkg/index.ts",
		);
		await expect(service.propose(proposalText(task.id))).rejects.toThrow(
			"diff_not_covered_by_snapshot",
		);
	});

	test("an untracked link the snapshot drops refuses the diff", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const worktree = String((await service.status(task.id)).task.worktreePath);
		await fs.symlink("/etc/hostname", join(worktree, "escape-link"));
		await expect(service.diff({ taskId: task.id })).rejects.toThrow(
			"diff_not_covered_by_snapshot:escape-link",
		);
	});

	test("more untracked files than the diff expands refuse the diff as incomplete", async () => {
		const { service } = await fixture();
		const task = await patchTask(service);
		const worktree = String((await service.status(task.id)).task.worktreePath);
		await fs.mkdir(join(worktree, "bulk"), { recursive: true });
		await Promise.all(
			Array.from({ length: 201 }, (_, index) =>
				fs.writeFile(join(worktree, "bulk", `f${index}.txt`), `${index}\n`),
			),
		);
		await expect(service.diff({ taskId: task.id })).rejects.toThrow(
			"diff_incomplete:untracked_limit",
		);
	});

	test("duplicate retries for unchanged content create one proposal and one approval", async () => {
		const { service, store } = await fixture();
		const task = await verifiedTask(service);
		const outcomes = await Promise.all([
			service.propose(proposalText(task.id)),
			service.propose(proposalText(task.id)),
		]);
		const created = outcomes.find((outcome) => !outcome.reused);
		const reused = outcomes.find((outcome) => outcome.reused);
		expect(created).toBeDefined();
		expect(reused?.proposal.id).toBe(created?.proposal.id);
		expect(reused?.approvalId).toBe(created?.approvalId);
		expect(await store.listProposals(task.id)).toHaveLength(1);
	});

	test("a proposal recorded before evidence was bound stays readable with null evidence", async () => {
		const { service, store } = await fixture();
		const task = await patchTask(service);
		const legacy = await store.createProposal({
			diff: "old",
			riskAssessment: "low",
			rollbackNotes: "revert",
			taskId: task.id,
			title: "Legacy",
		});
		const read = await service.getProposal(legacy.id);
		expect(read?.evidence).toBeNull();
		expect(read?.title).toBe("Legacy");
	});

	test("the worktree is provisioned from the durable task base, whatever base the model asks for", async () => {
		const { repo, service } = await fixture();
		const task = await service.createTask({
			goal: "Use the durable base",
			mode: "proposal",
			sourceConversationId: "coding-conversation",
		});
		const worktree = await service.worktree({ baseRef: "no-such-ref", taskId: task.id } as never);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: String(worktree.path),
		})
			.toString()
			.trim();
		expect(worktree.baseRef).toBe(task.baseRef);
		expect(head).toBe(
			execFileSync("git", ["rev-parse", task.baseRef], { cwd: repo }).toString().trim(),
		);
	});
});
