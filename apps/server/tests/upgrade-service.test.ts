import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartStatus } from "@tsukaima/contracts";
import { DomainCodingStore, WorktreeManager } from "@tsukaima/coding";
import { migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import type { WorkspaceService } from "../src/services/workspace.ts";
import { writeGitIdentity } from "../src/services/git-identity.ts";
import { UpgradeService, type UpgradeServiceOptions } from "../src/services/upgrade-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function git(cwd: string, args: readonly string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
		{ cwd },
	).toString();
}

const CONSTRAINTS = {
	allowedCommands: ["git"],
	maxOutputBytes: 64 * 1024,
	pathAllowlist: ["README.md", "VERSION", "LOCAL.md", "apps", "packages"],
	timeoutMs: 120_000,
};

async function repository(
	options: {
		readonly omitPreparation?: boolean;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-upgrade-"));
	directories.push(root);
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const local = join(root, "local");
	execFileSync("git", ["init", "--bare", remote]);
	execFileSync("git", ["clone", remote, seed]);
	git(seed, ["checkout", "-b", "main"]);
	await writeFile(join(seed, "VERSION"), "1.0.0\n");
	await writeFile(join(seed, "README.md"), "# Fixture\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "initial"]);
	git(seed, ["push", "-u", "origin", "main"]);
	execFileSync("git", ["clone", "--branch", "main", remote, local]);
	const database = await openDomainDatabase(join(root, "domain.sqlite"));
	migrateDomainDatabase(database);
	const coding = new DomainCodingStore(() => database);
	const worktreeRoot = join(root, "worktrees");
	const worktrees = new Map<string, WorktreeManager>();
	const sessions = new Map<string, string>();
	const restarts: Array<Record<string, unknown>> = [];
	const restartStatus = (input: Record<string, unknown>): RestartStatus => ({
		createdAt: new Date().toISOString(),
		executeAt: new Date(Date.now() + 60_000).toISOString(),
		id: `restart-${restarts.length}`,
		mode: "update",
		reason: String(input.reason ?? ""),
		requestedBy: String(input.requestedBy ?? "webui-admin"),
		status: "scheduled",
	});
	const workspaces: string[] = [];
	let sessionCount = 0;
	const workspace = {
		create: async (input: { readonly baseRef?: string; readonly goal: string }) => {
			workspaces.push(input.goal);
			const task = await coding.createTask({
				baseRef: input.baseRef ?? "HEAD",
				constraints: CONSTRAINTS,
				goal: input.goal,
				mode: "maintenance",
				sourceConversationId: "workspace:test",
			});
			sessionCount += 1;
			const sessionId = `session-${sessionCount}`;
			sessions.set(sessionId, task.id);
			return { chatId: `chat-${sessionCount}`, sessionId, taskId: task.id };
		},
		get: async () => ({ proposals: [] }),
		status: async (input: { readonly sessionId: string }) => {
			const taskId = sessions.get(input.sessionId);
			const task = taskId === undefined ? null : await coding.getTask(taskId);
			return {
				status: task?.status ?? "draft",
				worktreePath: task?.worktreePath,
			};
		},
	} as unknown as WorkspaceService;
	const ensureWorktree = async (taskId: string) => {
		const task = await coding.getTask(taskId);
		if (task === null) throw new Error("workspace_task_not_found");
		const manager =
			worktrees.get(taskId) ??
			new WorktreeManager({
				pathAllowlist: task.constraints.pathAllowlist,
				repositoryPath: local,
				worktreeRoot,
			});
		worktrees.set(taskId, manager);
		const path = task.worktreePath ?? manager.pathFor(taskId);
		if (task.worktreePath === undefined) {
			await manager.create(taskId, task.baseRef);
			await coding.updateTask(taskId, { status: "in_progress", worktreePath: path });
		}
		return { path };
	};
	const logger = {
		child: () => logger,
		debug: () => undefined,
		error: () => undefined,
		info: () => undefined,
		setLevel: () => undefined,
		trace: () => undefined,
		warn: () => undefined,
	};
	const upgradeOptions: UpgradeServiceOptions = {
		coding,
		database: () => database,
		defaultRemote: "origin",
		ensureWorktree,
		logger: logger as never,
		repositoryRoot: local,
		restart: {
			cancel: async () => true,
			schedule: async (input) => {
				restarts.push(input);
				return restartStatus(input);
			},
		},
		workspace,
	};
	if (options.omitPreparation === true) {
		const { coding: _coding, ensureWorktree: _ensureWorktree, ...rest } = upgradeOptions;
		return {
			coding,
			database,
			local,
			remote,
			restarts,
			root,
			seed,
			service: new UpgradeService(rest as unknown as UpgradeServiceOptions),
			workspaces,
		};
	}
	return {
		coding,
		database,
		local,
		remote,
		restarts,
		root,
		seed,
		service: new UpgradeService(upgradeOptions),
		workspaces,
	};
}

function currentCommit(cwd: string): string {
	return git(cwd, ["rev-parse", "HEAD"]).trim();
}

describe("upstream upgrade service", () => {
	test("fast-forwards a clean checkout and schedules an update restart", async () => {
		const { local, seed, service, restarts } = await repository();
		await writeFile(join(seed, "VERSION"), "1.1.0\n");
		await writeFile(join(seed, "README.md"), "# Fixture\n\nupstream\n");
		git(seed, ["commit", "-am", "upstream feature"]);
		git(seed, ["push"]);

		const check = await service.check();
		expect(check).toEqual(
			expect.objectContaining({
				ahead: 0,
				behind: 1,
				canUpgrade: true,
				currentVersion: "1.0.0",
				mode: "fast_forward",
				status: "available",
				upstreamVersion: "1.1.0",
			}),
		);

		const started = await service.start({ autoFinalize: true, requestedBy: "test-admin" });
		expect(started.workspace).toBeNull();
		expect(started.upgrade).toEqual(
			expect.objectContaining({
				mode: "fast_forward",
				status: "restarting",
				targetVersion: "1.1.0",
			}),
		);
		expect(restarts).toHaveLength(1);
		expect(git(local, ["show", "HEAD:VERSION"]).trim()).toBe("1.1.0");
		expect((await service.status())?.restartId).toBe(`restart-${restarts.length}`);
	});

	test("prepares a host-owned workspace proposal without changing the live checkout", async () => {
		const { coding, local, seed, service, workspaces } = await repository();
		const liveHead = currentCommit(local);
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.2.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		expect(currentCommit(local)).not.toBe(liveHead);

		const check = await service.check();
		expect(check).toEqual(
			expect.objectContaining({ ahead: 1, behind: 1, mode: "workspace", status: "diverged" }),
		);

		const started = await service.start({ autoFinalize: true });
		expect(started.workspace).not.toBeNull();
		expect(started.upgrade.mode).toBe("workspace");
		expect(started.upgrade.status).toBe("ready");
		expect(started.upgrade.worktreePath).not.toBeNull();
		expect(workspaces[0]).toContain("1.0.0");
		expect(workspaces[0]).toContain("origin/main");

		const taskId = started.workspace?.taskId ?? "";
		const task = await coding.getTask(taskId);
		expect(task?.status).toBe("awaiting_approval");
		const proposals = await coding.listProposals(taskId);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toEqual(
			expect.objectContaining({
				evidence: expect.objectContaining({ items: [] }),
				requiresRestart: true,
				status: "pending_approval",
			}),
		);
		expect(proposals[0]?.diffChecksum).toHaveLength(64);
		expect(proposals[0]?.diff).toContain("VERSION");
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(check.currentCommit);
		expect(git(local, ["show", "HEAD:VERSION"]).trim()).toBe("1.0.0");
	});

	test("finalizes a verified workspace proposal and preserves the merge identity", async () => {
		const { coding, database, local, seed, service, restarts } = await repository();
		await writeGitIdentity(database, {
			email: "synthetic-bot@example.test",
			name: "Synthetic Bot",
		});
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.4.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start({ autoFinalize: true });
		expect(started.upgrade.status).toBe("ready");
		const taskId = started.workspace?.taskId ?? "";
		const finalized = await service.finalize();
		expect(finalized.restart.mode).toBe("update");
		expect(restarts).toHaveLength(1);
		expect(git(local, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).trim()).toBe("");
		expect(git(local, ["show", "HEAD:VERSION"]).trim()).toBe("1.4.0");
		expect(git(local, ["log", "-1", "--format=%an%x1f%ae"]).trim()).toBe(
			"Synthetic Bot\u001fsynthetic-bot@example.test",
		);
		const proposals = await coding.listProposals(taskId);
		expect(proposals[0]?.status).toBe("approved");
		expect((await coding.getTask(taskId))?.status).toBe("completed");
	});

	test("refuses to finalize a dirty workspace worktree before touching the live checkout", async () => {
		const { coding, local, seed, service, restarts } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.5.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start();
		const taskId = started.workspace?.taskId ?? "";
		const task = await coding.getTask(taskId);
		const worktreePath = task?.worktreePath ?? "";
		await writeFile(join(worktreePath, "scratch.txt"), "uncommitted\n");
		const liveHead = currentCommit(local);

		await expect(service.finalize()).rejects.toThrow("upgrade_worktree_dirty");
		expect(restarts).toHaveLength(0);
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(liveHead);
		expect((await coding.listProposals(taskId))[0]?.status).toBe("pending_approval");
	});

	test("refuses a stale workspace revision before touching the live checkout", async () => {
		const { coding, local, seed, service, restarts } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.6.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start();
		const taskId = started.workspace?.taskId ?? "";
		const task = await coding.getTask(taskId);
		const worktreePath = task?.worktreePath ?? "";
		const proposalHead = git(worktreePath, ["rev-parse", "HEAD"]).trim();
		git(worktreePath, ["commit", "--allow-empty", "-m", "unreviewed workspace commit"]);
		const liveHead = currentCommit(local);

		await expect(service.finalize()).rejects.toThrow("upgrade_proposal_stale");
		expect(restarts).toHaveLength(0);
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(liveHead);
		expect(git(worktreePath, ["rev-parse", "HEAD"]).trim()).not.toBe(proposalHead);
	});

	test("refuses a worktree that lost the target before touching the live checkout", async () => {
		const { coding, local, seed, service, restarts } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.65.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start();
		const taskId = started.workspace?.taskId ?? "";
		const task = await coding.getTask(taskId);
		const worktreePath = task?.worktreePath ?? "";
		git(worktreePath, ["reset", "--hard", started.upgrade.currentCommit]);
		const liveHead = currentCommit(local);

		await expect(service.finalize()).rejects.toThrow("upgrade_target_not_integrated");
		expect(restarts).toHaveLength(0);
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(liveHead);
	});

	test("refuses a stale live checkout before merging an approved workspace", async () => {
		const { local, seed, service, restarts } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.7.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start();
		await writeFile(join(local, "LIVE.md"), "moved while reviewing\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "live moved"]);
		const liveHead = currentCommit(local);

		await expect(service.finalize()).rejects.toThrow("upgrade_checkout_stale");
		expect(restarts).toHaveLength(0);
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(liveHead);
		expect(started.upgrade.worktreePath).not.toBeNull();
	});

	test("requires a reviewable proposal instead of accepting a completed task", async () => {
		const { coding, local, seed, service, restarts } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.8.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		const started = await service.start();
		const taskId = started.workspace?.taskId ?? "";
		const proposals = await coding.listProposals(taskId);
		await coding.transitionProposal(proposals[0]!.id, "rejected");
		await coding.updateTask(taskId, { status: "completed" });
		const liveHead = currentCommit(local);

		await expect(service.finalize()).rejects.toThrow("upgrade_proposal_required");
		expect(restarts).toHaveLength(0);
		expect(git(local, ["rev-parse", "HEAD"]).trim()).toBe(liveHead);
	});

	test("fails closed before creating a workspace when host preparation is unavailable", async () => {
		const { local, seed, service, workspaces } = await repository({ omitPreparation: true });
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.9.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);

		await expect(service.start()).rejects.toThrow("upgrade_workspace_unavailable");
		expect(workspaces).toHaveLength(0);
		expect(await service.status()).toBeNull();
	});

	test("refuses to start while the working tree is dirty", async () => {
		const { local, seed, service } = await repository();
		await writeFile(join(seed, "VERSION"), "2.0.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		await writeFile(join(local, "scratch.txt"), "uncommitted\n");
		const check = await service.check();
		expect(check.mode).toBe("fast_forward");
		expect(check.canUpgrade).toBe(true);
		expect(check.reason).toBe("working_tree_dirty");
		await expect(service.start()).rejects.toThrow("working_tree_dirty");
	});

	test("rejects an option-shaped remote before invoking git", async () => {
		const { service } = await repository();
		await expect(service.check({ remote: "--upload-pack=sh" })).rejects.toThrow(
			"invalid_upgrade_remote",
		);
	});
});
