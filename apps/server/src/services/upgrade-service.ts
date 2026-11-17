import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { RestartStatus, UpgradeCheck, UpgradeRecord } from "@tsukaima/contracts";
import { GitCli, type GitCommandResult } from "@tsukaima/coding";
import { runtimeUpgrades, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { WorkspaceService } from "./workspace.ts";

export interface UpgradeServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly defaultRemote: string;
	readonly logger: Logger;
	readonly repositoryRoot: string;
	readonly restart: {
		cancel(reason?: string): Promise<boolean>;
		schedule(input: {
			readonly delaySeconds?: number;
			readonly mode?: "restart" | "update";
			readonly reason?: string;
			readonly requestedBy?: string;
		}): Promise<RestartStatus>;
	};
	readonly workspace: WorkspaceService;
}

export interface UpgradeStartOptions {
	readonly autoFinalize?: boolean;
	readonly remote?: string;
	readonly requestedBy?: string;
}

export interface UpgradeStartResult {
	readonly upgrade: UpgradeRecord;
	readonly workspace: { readonly sessionId: string; readonly taskId: string } | null;
}

type UpgradeRow = typeof runtimeUpgrades.$inferSelect;

const VERSION_FILE = "VERSION";
const DEFAULT_UPGRADE_DELAY_SECONDS = 60;
const GIT_TIMEOUT_MS = 60_000;
/** Local revision reads are fast; a hung `git status` must not hold an admin request open. */
const GIT_QUICK_TIMEOUT_MS = 15_000;
const SAFE_GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function toRecord(row: UpgradeRow): UpgradeRecord {
	return {
		ahead: row.ahead,
		autoFinalize: row.autoFinalize,
		behind: row.behind,
		branch: row.branch,
		completedAt: row.completedAtMs === null ? null : new Date(row.completedAtMs).toISOString(),
		createdAt: new Date(row.createdAtMs).toISOString(),
		currentCommit: row.currentCommit,
		currentVersion: row.currentVersion,
		error: row.error,
		id: row.id,
		mode: row.mode,
		remote: row.remote,
		restartId: row.restartId,
		status: row.status,
		targetCommit: row.targetCommit,
		targetVersion: row.targetVersion,
		taskId: row.taskId,
		updatedAt: new Date(row.updatedAtMs).toISOString(),
		upstreamRef: row.upstreamRef,
		workspaceSessionId: row.workspaceSessionId,
		worktreePath: row.worktreePath,
	};
}

function upgradeModeFor(
	check: Pick<UpgradeCheck, "ahead" | "behind" | "dirty">,
): "fast_forward" | "workspace" | "none" {
	if (check.behind === 0) return "none";
	if (check.ahead > 0) return "workspace";
	return "fast_forward";
}

/**
 * Inspect and start git-based upstream upgrades without handing the model host-shell access.
 *
 * A clean checkout with no local commits is fast-forwarded in place. Any local commit (or a
 * dirty working tree) is routed through the existing governed workspace flow instead: the
 * workspace gets its own worktree, must produce a proposal, and only `finalize` merges that
 * branch back into the running checkout. Every path ends in the durable restart coordinator.
 */
export class UpgradeService {
	readonly #audit: UpgradeServiceOptions["audit"];
	readonly #database: UpgradeServiceOptions["database"];
	readonly #defaultRemote: string;
	readonly #gitCli: GitCli;
	readonly #logger: Logger;
	readonly #restart: UpgradeServiceOptions["restart"];
	readonly #workspace: WorkspaceService;
	#starting = false;

	constructor(options: UpgradeServiceOptions) {
		this.#audit = options.audit;
		this.#database = options.database;
		this.#defaultRemote = options.defaultRemote;
		this.#gitCli = new GitCli({ repositoryPath: options.repositoryRoot });
		this.#logger = options.logger.child("tsukaima::server::upgrade");
		this.#restart = options.restart;
		this.#workspace = options.workspace;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async check(input: { readonly remote?: string } = {}): Promise<UpgradeCheck> {
		const remote = input.remote ?? this.#defaultRemote;
		if (!SAFE_GIT_NAME.test(remote)) {
			throw new Error("invalid_upgrade_remote");
		}
		const current = await this.#currentRevision();
		const base = {
			ahead: 0,
			behind: 0,
			branch: current.branch,
			canUpgrade: false,
			currentCommit: current.commit,
			currentVersion: current.version,
			dirty: current.dirty,
			mode: "none" as const,
			remote,
			status: "unavailable" as const,
			upstreamCommit: "",
			upstreamRef: "",
			upstreamVersion: "",
		};
		if (current.branch === "" || current.branch === "HEAD") {
			return { ...base, reason: "detached_head" };
		}
		const remoteResult = await this.#git(["remote", "get-url", remote]);
		if (remoteResult.exitCode !== 0) {
			return { ...base, reason: "remote_not_configured" };
		}
		const fetch = await this.#git(["fetch", "--prune", remote], GIT_TIMEOUT_MS);
		if (fetch.exitCode !== 0) {
			this.#logger.warn("upstream fetch failed", {
				error: fetch.stderr.trim().slice(0, 300),
				remote,
			});
			return { ...base, reason: "fetch_failed" };
		}
		if (!SAFE_GIT_NAME.test(current.branch)) {
			return { ...base, reason: "invalid_branch" };
		}
		const upstreamRef = `refs/remotes/${remote}/${current.branch}`;
		const resolve = await this.#git(["rev-parse", "--verify", `${upstreamRef}^{commit}`]);
		if (resolve.exitCode !== 0) {
			return { ...base, reason: "upstream_branch_missing", upstreamRef };
		}
		const upstreamCommit = resolve.stdout.trim();
		const counts = await this.#git([
			"rev-list",
			"--left-right",
			"--count",
			`${current.commit}...${upstreamCommit}`,
		]);
		if (counts.exitCode !== 0) {
			return { ...base, reason: "compare_failed", upstreamCommit, upstreamRef };
		}
		const [aheadRaw = "0", behindRaw = "0"] = counts.stdout.trim().split(/\s+/u);
		const ahead = Number.parseInt(aheadRaw, 10) || 0;
		const behind = Number.parseInt(behindRaw, 10) || 0;
		const upstreamVersion = (await this.#versionAt(upstreamCommit)) || current.version;
		const mode = upgradeModeFor({ ahead, behind, dirty: current.dirty });
		const status =
			behind === 0 ? "up_to_date" : ahead > 0 || current.dirty ? "diverged" : "available";
		return {
			...base,
			ahead,
			behind,
			canUpgrade: mode !== "none",
			mode,
			status,
			upstreamCommit,
			upstreamRef,
			upstreamVersion,
			...(current.dirty ? { reason: "working_tree_dirty" } : {}),
		};
	}

	/**
	 * Fetch immediately before merging so the commit compared in the UI is the commit that is
	 * actually integrated. The upstream branch can move between a page load and the button click.
	 */
	async #recheck(input: { readonly remote?: string } = {}): Promise<UpgradeCheck> {
		const check = await this.check(input);
		if (check.status !== "available" && check.status !== "diverged") return check;
		const database = this.#db();
		const active = await database
			.select()
			.from(runtimeUpgrades)
			.where(sql`${runtimeUpgrades.status} IN ('running', 'ready', 'merging')`)
			.orderBy(desc(runtimeUpgrades.createdAtMs))
			.limit(1);
		if (active[0] !== undefined) throw new Error(`upgrade_in_progress:${active[0].id}`);
		return check;
	}

	async start(input: UpgradeStartOptions = {}): Promise<UpgradeStartResult> {
		if (this.#starting) throw new Error("upgrade_already_starting");
		this.#starting = true;
		try {
			const database = this.#db();
			const active = await database
				.select()
				.from(runtimeUpgrades)
				.where(sql`${runtimeUpgrades.status} IN ('running', 'ready', 'merging')`)
				.orderBy(desc(runtimeUpgrades.createdAtMs))
				.limit(1);
			if (active[0] !== undefined) throw new Error(`upgrade_in_progress:${active[0].id}`);
			const requestedBy = input.requestedBy ?? "webui-admin";
			if (input.remote !== undefined && !SAFE_GIT_NAME.test(input.remote)) {
				throw new Error("invalid_upgrade_remote");
			}
			const check = await this.#recheck(input.remote === undefined ? {} : { remote: input.remote });
			if (check.status === "unavailable") {
				throw new Error(`upgrade_check_failed:${check.reason ?? "unavailable"}`);
			}
			if (!check.canUpgrade) {
				throw new Error(check.status === "up_to_date" ? "already_up_to_date" : "no_upgrade_mode");
			}
			if (check.dirty) throw new Error("working_tree_dirty");
			const now = Date.now();
			const id = randomUUID();
			const autoFinalize = input.autoFinalize !== false;
			const insert = await database
				.insert(runtimeUpgrades)
				.values({
					ahead: check.ahead,
					autoFinalize,
					behind: check.behind,
					branch: check.branch,
					completedAtMs: null,
					createdAtMs: now,
					currentCommit: check.currentCommit,
					currentVersion: check.currentVersion,
					error: null,
					id,
					mode: check.mode === "workspace" ? "workspace" : "fast_forward",
					remote: check.remote,
					restartId: null,
					status: "running",
					targetCommit: check.upstreamCommit,
					targetVersion: check.upstreamVersion,
					taskId: null,
					updatedAtMs: now,
					upstreamRef: check.upstreamRef,
					workspaceSessionId: null,
					worktreePath: null,
				})
				.returning();
			const row = insert[0];
			if (row === undefined) throw new Error("upgrade_persist_failed");
			await this.#auditRecord({
				action: "runtime.upgrade.start",
				actorId: requestedBy,
				actorKind: "user",
				payload: {
					autoFinalize,
					mode: row.mode,
					remote: row.remote,
					targetCommit: row.targetCommit,
					targetVersion: row.targetVersion,
				},
				result: "ok",
				targetId: id,
				targetKind: "runtime-upgrade",
			});
			this.#logger.info("upgrade started", {
				behind: check.behind,
				mode: row.mode,
				remote: row.remote,
				targetCommit: check.upstreamCommit,
				upgradeId: id,
			});
			if (row.mode === "fast_forward") {
				return { upgrade: await this.#fastForward(row, requestedBy), workspace: null };
			}
			return await this.#startWorkspace(row, check, requestedBy);
		} finally {
			this.#starting = false;
		}
	}

	async finalize(
		input: {
			readonly requestedBy?: string;
			readonly upgradeId?: string;
		} = {},
	): Promise<{ upgrade: UpgradeRecord; restart: RestartStatus }> {
		const database = this.#db();
		const rows =
			input.upgradeId === undefined
				? await database
						.select()
						.from(runtimeUpgrades)
						.where(sql`${runtimeUpgrades.status} IN ('ready', 'running')`)
						.orderBy(desc(runtimeUpgrades.createdAtMs))
						.limit(1)
				: await database
						.select()
						.from(runtimeUpgrades)
						.where(eq(runtimeUpgrades.id, input.upgradeId))
						.limit(1);
		const row = rows[0];
		if (row === undefined) throw new Error("upgrade_not_found");
		if (row.status !== "ready" && row.status !== "running") {
			throw new Error(`upgrade_not_finalizable:${row.status}`);
		}
		const requestedBy = input.requestedBy ?? "webui-admin";
		if (row.mode === "workspace") {
			if (row.workspaceSessionId === null) throw new Error("upgrade_workspace_missing");
			const detail = await this.#workspace.get(row.workspaceSessionId);
			if (detail === null) throw new Error("upgrade_workspace_not_found");
			const proposal = detail.proposals.find(
				(entry) => entry.status === "approved" || entry.status === "pending_approval",
			);
			const workspaceStatus = await this.#workspace.status({
				sessionId: row.workspaceSessionId,
			});
			const taskStatus = String(workspaceStatus.status ?? "");
			if (proposal === undefined && taskStatus !== "completed") {
				throw new Error("upgrade_proposal_required");
			}
		}
		const now = Date.now();
		await database
			.update(runtimeUpgrades)
			.set({ error: null, status: "merging", updatedAtMs: now })
			.where(eq(runtimeUpgrades.id, row.id));
		try {
			await this.#merge(row, requestedBy);
			const restart = await this.#restart.schedule({
				delaySeconds: DEFAULT_UPGRADE_DELAY_SECONDS,
				mode: "update",
				reason: `upstream upgrade ${row.currentVersion} -> ${row.targetVersion}`,
				requestedBy,
			});
			const updatedAtMs = Date.now();
			const updated = await database
				.update(runtimeUpgrades)
				.set({
					completedAtMs: updatedAtMs,
					restartId: restart.id,
					status: "restarting",
					updatedAtMs,
				})
				.where(eq(runtimeUpgrades.id, row.id))
				.returning();
			const result = updated[0];
			if (result === undefined) throw new Error("upgrade_update_failed");
			await this.#auditRecord({
				action: "runtime.upgrade.finalize",
				actorId: requestedBy,
				actorKind: "user",
				payload: { restartId: restart.id, targetCommit: row.targetCommit },
				result: "ok",
				targetId: row.id,
				targetKind: "runtime-upgrade",
			});
			this.#logger.info("upgrade merged and restart scheduled", {
				restartId: restart.id,
				targetCommit: row.targetCommit,
				upgradeId: row.id,
			});
			return { restart, upgrade: toRecord(result) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await database
				.update(runtimeUpgrades)
				.set({ error: message, status: "failed", updatedAtMs: Date.now() })
				.where(eq(runtimeUpgrades.id, row.id));
			await this.#auditRecord({
				action: "runtime.upgrade.finalize",
				actorId: requestedBy,
				actorKind: "user",
				payload: { targetCommit: row.targetCommit },
				reason: message,
				result: "failed",
				targetId: row.id,
				targetKind: "runtime-upgrade",
			});
			throw error;
		}
	}

	async status(): Promise<UpgradeRecord | null> {
		const rows = await this.#db()
			.select()
			.from(runtimeUpgrades)
			.orderBy(desc(runtimeUpgrades.createdAtMs))
			.limit(1);
		return rows[0] === undefined ? null : toRecord(rows[0]);
	}

	async history(limit = 20): Promise<readonly UpgradeRecord[]> {
		const rows = await this.#db()
			.select()
			.from(runtimeUpgrades)
			.orderBy(desc(runtimeUpgrades.createdAtMs))
			.limit(Math.max(1, Math.min(limit, 100)));
		return rows.map(toRecord);
	}

	/**
	 * A process can exit while an upgrade is "restarting". The supervisor starts the old or new
	 * image; either way, a restarting row whose restart intent is no longer active has settled.
	 */
	async recover(): Promise<void> {
		const database = this.#db();
		const rows = await database
			.select()
			.from(runtimeUpgrades)
			.where(sql`${runtimeUpgrades.status} IN ('merging', 'restarting')`);
		for (const row of rows) {
			const now = Date.now();
			const integrated =
				row.status === "restarting"
					? await this.#git(["merge-base", "--is-ancestor", row.targetCommit, "HEAD"])
					: undefined;
			const restartCompleted =
				integrated?.exitCode === 0 ||
				(row.status === "restarting" && row.targetCommit === (await this.#headCommit()));
			await database
				.update(runtimeUpgrades)
				.set({
					completedAtMs: now,
					error:
						row.status === "merging"
							? "merge was interrupted; inspect the checkout before retrying"
							: restartCompleted
								? null
								: "restart completed but the running checkout does not contain the target commit",
					status: row.status === "merging" ? "failed" : restartCompleted ? "completed" : "failed",
					updatedAtMs: now,
				})
				.where(eq(runtimeUpgrades.id, row.id));
			this.#logger.info("upgrade intent recovered", {
				status: row.status === "merging" ? "failed" : restartCompleted ? "completed" : "failed",
				upgradeId: row.id,
			});
		}
	}

	async #fastForward(row: UpgradeRow, requestedBy: string): Promise<UpgradeRecord> {
		const database = this.#db();
		const merge = await this.#git(["merge", "--ff-only", row.targetCommit]);
		if (merge.exitCode !== 0) {
			const message = merge.stderr.trim() || "fast-forward merge failed";
			await database
				.update(runtimeUpgrades)
				.set({ error: message, status: "failed", updatedAtMs: Date.now() })
				.where(eq(runtimeUpgrades.id, row.id));
			throw new Error(`upgrade_merge_failed:${message}`);
		}
		const version = await this.#versionAt("HEAD");
		const updatedAtMs = Date.now();
		const updated = await database
			.update(runtimeUpgrades)
			.set({
				error: null,
				status: "ready",
				targetVersion: version || row.targetVersion,
				updatedAtMs,
			})
			.where(eq(runtimeUpgrades.id, row.id))
			.returning();
		const result = updated[0];
		if (result === undefined) throw new Error("upgrade_update_failed");
		this.#logger.info("upstream fast-forwarded", {
			requestedBy,
			targetCommit: row.targetCommit,
			upgradeId: row.id,
			version: version || row.targetVersion,
		});
		if (row.autoFinalize) {
			const restart = await this.#restart.schedule({
				delaySeconds: DEFAULT_UPGRADE_DELAY_SECONDS,
				mode: "update",
				reason: `upstream upgrade ${row.currentVersion} -> ${version || row.targetVersion}`,
				requestedBy,
			});
			const restartAtMs = Date.now();
			const scheduled = await database
				.update(runtimeUpgrades)
				.set({
					completedAtMs: restartAtMs,
					restartId: restart.id,
					status: "restarting",
					updatedAtMs: restartAtMs,
				})
				.where(eq(runtimeUpgrades.id, row.id))
				.returning();
			const scheduledRow = scheduled[0];
			if (scheduledRow !== undefined) return toRecord(scheduledRow);
		}
		return toRecord(result);
	}

	async #startWorkspace(
		row: UpgradeRow,
		check: UpgradeCheck,
		requestedBy: string,
	): Promise<UpgradeStartResult> {
		const database = this.#db();
		try {
			const goal = [
				`Upgrade this Tsukaima checkout from ${check.currentVersion} (${check.currentCommit.slice(0, 12)}) to upstream ${check.upstreamVersion} (${check.upstreamCommit.slice(0, 12)}).`,
				"",
				`Upstream ref: ${check.upstreamRef}`,
				`Local-only commits: ${check.ahead}`,
				`Upstream commits to integrate: ${check.behind}`,
				check.dirty ? "The live working tree has uncommitted changes; preserve their intent." : "",
				"",
				"Create the governed worktree from the current checkout, merge the upstream ref inside that worktree, resolve conflicts, run the repository checks, and create a deployment proposal.",
				"Do not edit the live repository directly. Do not schedule a restart yourself; finalizing the upgrade does that after the proposal is reviewed.",
			]
				.filter((line) => line.length > 0)
				.join("\n");
			const workspace = await this.#workspace.create({
				baseRef: check.currentCommit,
				goal,
				mode: "proposal",
				requestedBy,
			});
			const taskId =
				workspace.taskId ?? (await this.#workspace.startTask(workspace.sessionId, { goal }));
			const updatedAtMs = Date.now();
			const updated = await database
				.update(runtimeUpgrades)
				.set({
					status: "ready",
					taskId,
					updatedAtMs,
					workspaceSessionId: workspace.sessionId,
				})
				.where(eq(runtimeUpgrades.id, row.id))
				.returning();
			const result = updated[0];
			if (result === undefined) throw new Error("upgrade_update_failed");
			this.#logger.info("upgrade workspace created", {
				taskId,
				upgradeId: row.id,
				workspaceSessionId: workspace.sessionId,
			});
			const workspaceStatus = await this.#workspace.status({ sessionId: workspace.sessionId });
			const worktreePath =
				typeof workspaceStatus.worktreePath === "string" ? workspaceStatus.worktreePath : undefined;
			if (worktreePath !== undefined) {
				const linked = await database
					.update(runtimeUpgrades)
					.set({ updatedAtMs: Date.now(), worktreePath })
					.where(eq(runtimeUpgrades.id, row.id))
					.returning();
				const linkedRow = linked[0];
				if (linkedRow !== undefined) {
					return {
						upgrade: toRecord(linkedRow),
						workspace: { sessionId: workspace.sessionId, taskId },
					};
				}
			}
			return {
				upgrade: toRecord(result),
				workspace: { sessionId: workspace.sessionId, taskId },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await database
				.update(runtimeUpgrades)
				.set({ error: message, status: "failed", updatedAtMs: Date.now() })
				.where(eq(runtimeUpgrades.id, row.id));
			this.#logger.error("upgrade workspace failed", {
				error: message,
				upgradeId: row.id,
			});
			throw error;
		}
	}

	async #merge(row: UpgradeRow, requestedBy: string): Promise<void> {
		if (row.mode === "fast_forward") {
			const merge = await this.#git(["merge", "--ff-only", row.targetCommit]);
			if (merge.exitCode !== 0) {
				throw new Error(`upgrade_merge_failed:${merge.stderr.trim()}`);
			}
			return;
		}
		if (row.workspaceSessionId === null) throw new Error("upgrade_workspace_missing");
		const status = await this.#workspace.status({ sessionId: row.workspaceSessionId });
		const worktreePath = typeof status.worktreePath === "string" ? status.worktreePath : undefined;
		if (worktreePath === undefined) throw new Error("upgrade_worktree_missing");
		await this.#db()
			.update(runtimeUpgrades)
			.set({ worktreePath, updatedAtMs: Date.now() })
			.where(eq(runtimeUpgrades.id, row.id));
		const branch = await this.#git(["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"]);
		if (branch.exitCode !== 0) {
			throw new Error("upgrade_workspace_branch_missing");
		}
		const branchName = branch.stdout.trim();
		if (!SAFE_GIT_NAME.test(branchName)) throw new Error("upgrade_workspace_branch_invalid");
		await this.#git(["-C", worktreePath, "add", "--all"]);
		const pending = await this.#git(["-C", worktreePath, "status", "--porcelain"]);
		if (pending.stdout.trim().length > 0) {
			const commit = await this.#git(
				[
					"-C",
					worktreePath,
					"-c",
					"user.name=tsukaima-upgrade",
					"-c",
					"user.email=tsukaima-upgrade@localhost",
					"commit",
					"-m",
					`chore(upgrade): integrate ${row.targetVersion}`,
				],
				GIT_TIMEOUT_MS,
			);
			if (commit.exitCode !== 0) {
				throw new Error(`upgrade_commit_failed:${commit.stderr.trim()}`);
			}
		}
		const merge = await this.#git(
			[
				"merge",
				"--no-ff",
				"--no-edit",
				"-m",
				`chore(upgrade): merge ${row.targetVersion} from ${row.upstreamRef}`,
				branchName,
			],
			GIT_TIMEOUT_MS,
		);
		if (merge.exitCode !== 0) {
			await this.#git(["merge", "--abort"]);
			throw new Error(`upgrade_merge_failed:${merge.stderr.trim()}`);
		}
		const integrated = await this.#git([
			"-C",
			worktreePath,
			"merge-base",
			"--is-ancestor",
			row.targetCommit,
			"HEAD",
		]);
		if (integrated.exitCode !== 0) {
			throw new Error("upgrade_target_not_integrated");
		}
		await this.#auditRecord({
			action: "runtime.upgrade.merge",
			actorId: requestedBy,
			actorKind: "user",
			payload: { branch: branchName, targetCommit: row.targetCommit },
			result: "ok",
			targetId: row.id,
			targetKind: "runtime-upgrade",
		});
		const liveIntegrated = await this.#git([
			"merge-base",
			"--is-ancestor",
			row.targetCommit,
			"HEAD",
		]);
		if (liveIntegrated.exitCode !== 0) {
			throw new Error("upgrade_live_checkout_missing_target");
		}
	}

	async #currentRevision(): Promise<{
		readonly branch: string;
		readonly commit: string;
		readonly dirty: boolean;
		readonly version: string;
	}> {
		const branch = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"]);
		const commit = await this.#git(["rev-parse", "HEAD"]);
		const status = await this.#git(["status", "--porcelain"]);
		const version = await this.#versionAt("HEAD");
		return {
			branch: branch.exitCode === 0 ? branch.stdout.trim() : "",
			commit: commit.exitCode === 0 ? commit.stdout.trim() : "",
			dirty: status.exitCode === 0 && status.stdout.trim().length > 0,
			version,
		};
	}

	async #versionAt(ref: string): Promise<string> {
		const result = await this.#git(["show", `${ref}:${VERSION_FILE}`]);
		return result.exitCode === 0 ? result.stdout.trim() : "";
	}

	async #headCommit(): Promise<string> {
		const result = await this.#git(["rev-parse", "HEAD"]);
		return result.exitCode === 0 ? result.stdout.trim() : "";
	}

	async #git(args: readonly string[], timeoutMs = GIT_QUICK_TIMEOUT_MS): Promise<GitCommandResult> {
		return await this.#gitCli.exec(args, { timeoutMs });
	}

	async #auditRecord(entry: AuditEntry): Promise<void> {
		try {
			await this.#audit?.(entry);
		} catch (error) {
			this.#logger.warn("upgrade audit failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
