import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DomainCodingStore,
	sha256Hex,
	type HealthCheckResult,
	type ReloadController,
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
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@tsukaima.local", ...args], {
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
	readonly service: SelfIterationService;
	readonly store: DomainCodingStore;
	readonly worktrees: string;
}

async function fixture(): Promise<Fixture> {
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
	const reload: ReloadController = {
		async reload(componentId, context) {
			reloads.push(`${componentId}:${context.reason}`);
			return { message: "reloaded", reloadedAtMs: Date.now(), success: true };
		},
	};
	const service = new SelfIterationService({
		audit: { record: async (entry) => void audits.push(entry) },
		binding: {
			healthCheck: (): HealthCheckResult => {
				checks.count += 1;
				const ok = checks.script(checks.count);
				return { checkedAtMs: checks.count, ...(ok ? {} : { message: "unhealthy" }), ok };
			},
			reload,
			repositoryRoot: repo,
			store,
			worktreeRoot: worktrees,
		},
		logger: captureLogger(logs),
		storage: new MemoryStorage(),
	});
	return { audits, checks, logs, reloads, repo, service, store, worktrees };
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
	test("enforces mode gating, path policy, and records the tool timeline", async () => {
		const { audits, service } = await fixture();
		const analysis = await service.createTask({
			goal: "Analyze only",
			mode: "analysis",
			sourceConversationId: "coding-conversation",
		});
		const read = await service.analyze({ action: "read", path: "README.md", taskId: analysis.id });
		expect(read.content).toContain("Self iteration fixture");
		await expect(
			service.edit({
				content: "nope",
				create: true,
				path: "src/nope.ts",
				taskId: analysis.id,
			}),
		).rejects.toThrow("mode_denied");
		await expect(service.worktree({ taskId: analysis.id })).rejects.toThrow("mode_denied");

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
		const { service, store } = await fixture();
		const task = await patchTask(service);
		const testResult = await service.test({ taskId: task.id });
		expect(testResult.passed).toBe(true);
		expect(testResult.total).toBeGreaterThanOrEqual(1);
		const build = await service.build({ taskId: task.id });
		expect(build.success).toBe(true);
		expect(build.artifactMetadata.checksum).toHaveLength(64);
		await expect(service.test({ command: "sh", taskId: task.id })).rejects.toThrow(
			"command_not_allowed",
		);
		await service.updatePolicy({ maxOutputBytes: 1024 }, "admin");
		const bounded = await service.test({ taskId: task.id });
		expect(Buffer.byteLength(bounded.stdout, "utf-8")).toBeLessThanOrEqual(1024);
		const loaded = await store.getTask(task.id);
		expect(loaded?.artifacts.some((artifact) => artifact.kind === "test")).toBe(true);
		expect(loaded?.artifacts.some((artifact) => artifact.kind === "build")).toBe(true);
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

		// A failed post-check creates a rolled_back record automatically.
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
		expect(failed.rollback?.status).toBe("rolled_back");
		expect(failed.rollback?.rollbackOfId).toBe(failed.deployment.id);
		const deployments = await store.listDeployments({ taskId: task.id });
		expect(deployments.filter((deployment) => deployment.status === "rolled_back")).toHaveLength(2);
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

	test("registers the plugin and exposes exactly the eight model tools", async () => {
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
