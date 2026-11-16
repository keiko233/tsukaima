import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartStatus } from "@tsukaima/contracts";
import { migrateDomainDatabase, openDomainDatabase } from "@tsukaima/db";
import type { WorkspaceService } from "../src/services/workspace.ts";
import { UpgradeService } from "../src/services/upgrade-service.ts";

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

async function repository(
	options: {
		readonly onCreate?: (root: string) => Promise<void>;
		readonly workspaceGet?: () => Promise<{ proposals: Array<{ status: string }> }>;
		readonly workspaceStatus?: () => Promise<Record<string, unknown>>;
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
	const workspace = {
		create: async (input: { goal: string }) => {
			workspaces.push(input.goal);
			await options.onCreate?.(root);
			return { chatId: "chat", sessionId: "session", taskId: "task" };
		},
		get: options.workspaceGet ?? (async () => ({ proposals: [] })),
		status: options.workspaceStatus ?? (async () => ({ status: "pending" })),
	} as unknown as WorkspaceService;
	const workspaces: string[] = [];
	const logger = {
		child: () => logger,
		debug: () => undefined,
		error: () => undefined,
		info: () => undefined,
		setLevel: () => undefined,
		trace: () => undefined,
		warn: () => undefined,
	};
	const service = new UpgradeService({
		database: () => database,
		defaultRemote: "origin",
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
	});
	return { database, local, remote, restarts, root, seed, service, workspaces };
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

	test("routes a checkout with local commits through a governed workspace", async () => {
		const { local, seed, service, workspaces } = await repository();
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.2.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);

		const check = await service.check();
		expect(check).toEqual(
			expect.objectContaining({ ahead: 1, behind: 1, mode: "workspace", status: "diverged" }),
		);

		const started = await service.start({ autoFinalize: true });
		expect(started.workspace).toEqual({ sessionId: "session", taskId: "task" });
		expect(started.upgrade.mode).toBe("workspace");
		expect(started.upgrade.status).toBe("ready");
		expect(workspaces[0]).toContain("1.0.0");
		expect(workspaces[0]).toContain("origin/main");

		await expect(service.finalize()).rejects.toThrow("upgrade_proposal_required");
	});

	test("finalizes a workspace branch only when the upstream commit is integrated", async () => {
		let worktree = "";
		const { local, seed, service, restarts, root } = await repository({
			onCreate: async () => undefined,
			workspaceGet: async () => ({ proposals: [{ status: "pending_approval" }] }),
			workspaceStatus: async () => ({ status: "awaiting_approval", worktreePath: worktree }),
		});
		await writeFile(join(local, "LOCAL.md"), "local change\n");
		git(local, ["add", "."]);
		git(local, ["commit", "-m", "local feature"]);
		await writeFile(join(seed, "VERSION"), "1.4.0\n");
		git(seed, ["commit", "-am", "upstream release"]);
		git(seed, ["push"]);
		git(local, ["fetch", "origin"]);

		worktree = join(root, "upgrade-worktree");
		git(local, ["worktree", "add", "-b", "tsukaima-iteration/task", worktree, "HEAD"]);
		git(worktree, ["merge", "--no-ff", "--no-commit", "origin/main"]);

		const started = await service.start({ autoFinalize: true });
		expect(started.upgrade.status).toBe("ready");
		const finalized = await service.finalize();
		expect(finalized.restart.mode).toBe("update");
		expect(restarts).toHaveLength(1);
		expect(git(local, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).trim()).toBe("");
		expect(git(local, ["show", "HEAD:VERSION"]).trim()).toBe("1.4.0");
	});

	test("refuses to start while the working tree is dirty", async () => {
		const { local, seed, service } = await repository();
		await writeFile(join(seed, "VERSION"), "1.3.0\n");
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
