import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { clamp } from "es-toolkit";
import type { RestartStatus, UpgradeCheck, UpgradeRecord } from "@tsukaima/contracts";
import {
	gitCredentialEnvironment,
	GitCli,
	measureTaskSnapshot,
	sha256Hex,
	type DeploymentProposal,
	type DeploymentProposalInput,
	type DeploymentProposalStatus,
	type GitCommandResult,
	type IterationTask,
	type IterationTaskPatch,
} from "@tsukaima/coding";
import { runtimeUpgrades, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { DependencyInstaller } from "./dependency-installer.ts";
import { gitIdentityArgs, readGitIdentity } from "./git-identity.ts";
import type { WorkspaceService } from "./workspace.ts";

/** The host-owned task/worktree surface the upgrade service needs; no model tools are involved. */
export interface UpgradeCodingStore {
	createProposal(input: DeploymentProposalInput): Promise<DeploymentProposal>;
	getTask(id: string): Promise<IterationTask | null>;
	listProposals(taskId?: string): Promise<readonly DeploymentProposal[]>;
	transitionProposal(id: string, status: DeploymentProposalStatus): Promise<DeploymentProposal>;
	updateTask(id: string, patch: IterationTaskPatch): Promise<IterationTask>;
}

export interface UpgradeTaskWorktree {
	readonly path: string;
}

export interface UpgradeServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly coding: UpgradeCodingStore;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly defaultRemote: string;
	readonly dependencyInstaller?: DependencyInstaller | undefined;
	/** Reuse the lifecycle's governed task worktree rather than creating a second worktree policy. */
	readonly ensureWorktree: (taskId: string) => Promise<UpgradeTaskWorktree>;
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
	/** GitHub credential for the network fetch; local git calls stay credential-free. */
	readonly token?: () => Promise<string | undefined>;
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
/** A reviewable patch is bounded independently of the git output cap; never approve a partial diff. */
const UPGRADE_DIFF_MAX_BYTES = 1024 * 1024;
const SAFE_GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SAFE_COMMIT = /^[0-9a-f]{7,64}$/u;

interface WorkspaceEvidence {
	readonly changedFiles: readonly string[];
	readonly diff: string;
	readonly diffChecksum: string;
	readonly snapshotChecksum: string;
}

interface WorkspaceReview {
	readonly branchName: string;
	readonly proposal: DeploymentProposal;
	readonly worktreeHead: string;
}

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
 * A clean checkout with no local commits is fast-forwarded in place. A checkout with local
 * commits is prepared by the host in a governed workspace worktree: the host merges the target,
 * derives the patch/snapshot, records a proposal, and waits for an administrator to finalize it.
 * The live checkout is not touched until finalize re-verifies its revision, cleanliness, target
 * ancestry, worktree snapshot, and proposal before merging. Every path ends in the durable
 * restart coordinator.
 */
export class UpgradeService {
	readonly #audit: UpgradeServiceOptions["audit"];
	readonly #coding: UpgradeServiceOptions["coding"];
	readonly #database: UpgradeServiceOptions["database"];
	readonly #defaultRemote: string;
	readonly #dependencyInstaller: DependencyInstaller | undefined;
	readonly #ensureWorktree: UpgradeServiceOptions["ensureWorktree"];
	readonly #gitCli: GitCli;
	readonly #logger: Logger;
	readonly #repositoryRoot: string;
	readonly #restart: UpgradeServiceOptions["restart"];
	readonly #token: UpgradeServiceOptions["token"];
	readonly #workspace: WorkspaceService;
	#starting = false;

	constructor(options: UpgradeServiceOptions) {
		this.#audit = options.audit;
		this.#coding = options.coding;
		this.#database = options.database;
		this.#defaultRemote = options.defaultRemote;
		this.#dependencyInstaller = options.dependencyInstaller;
		this.#ensureWorktree = options.ensureWorktree;
		this.#gitCli = new GitCli({ repositoryPath: options.repositoryRoot });
		this.#logger = options.logger.child("tsukaima::server::upgrade");
		this.#repositoryRoot = options.repositoryRoot;
		this.#restart = options.restart;
		this.#token = options.token;
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
		const token = await this.#token?.();
		const fetch = await this.#git(
			["fetch", "--prune", remote],
			GIT_TIMEOUT_MS,
			gitCredentialEnvironment(token),
		);
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
			// Fail before creating a workspace when the host-owned preparation port is unavailable;
			// a model-only workspace could never record the proposal this upgrade requires.
			if (check.mode === "workspace") this.#requireWorkspacePreparation();
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
		const review = row.mode === "workspace" ? await this.#reviewWorkspace(row) : undefined;
		const now = Date.now();
		const [claimed] = await database
			.update(runtimeUpgrades)
			.set({ error: null, status: "merging", updatedAtMs: now })
			.where(and(eq(runtimeUpgrades.id, row.id), eq(runtimeUpgrades.status, row.status)))
			.returning({ id: runtimeUpgrades.id });
		if (claimed === undefined) throw new Error("upgrade_already_finalizing");
		try {
			if (review !== undefined) {
				await this.#assertLiveCheckout(row);
				await this.#approveWorkspaceReview(row, requestedBy, review);
			}
			await this.#merge(row, requestedBy, review);
			if (this.#dependencyInstaller !== undefined) {
				try {
					await this.#dependencyInstaller.install();
				} catch (installError) {
					const message =
						installError instanceof Error ? installError.message : String(installError);
					this.#logger.error("dependency installation failed during upgrade finalization", {
						error: message,
						upgradeId: row.id,
					});
					throw new Error(`upgrade_install_dependencies_failed:${message}`, {
						cause: installError,
					});
				}
			}
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
			.limit(clamp(limit, 1, 100));
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

	async failRestart(restartId: string, reason: string): Promise<void> {
		const database = this.#db();
		const now = Date.now();
		const updated = await database
			.update(runtimeUpgrades)
			.set({
				completedAtMs: now,
				error: `restart failed: ${reason}`,
				status: "failed",
				updatedAtMs: now,
			})
			.where(
				and(eq(runtimeUpgrades.restartId, restartId), eq(runtimeUpgrades.status, "restarting")),
			)
			.returning({ id: runtimeUpgrades.id });
		if (updated.length > 0) {
			this.#logger.warn("upgrade marked failed after restart failed", {
				reason,
				restartId,
				upgradeIds: updated.map((r) => r.id),
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
			if (this.#dependencyInstaller !== undefined) {
				try {
					await this.#dependencyInstaller.install();
				} catch (installError) {
					const message =
						installError instanceof Error ? installError.message : String(installError);
					this.#logger.error("dependency installation failed during fast-forward upgrade", {
						error: message,
						upgradeId: row.id,
					});
					await database
						.update(runtimeUpgrades)
						.set({
							error: `upgrade_install_dependencies_failed:${message}`,
							status: "failed",
							updatedAtMs: Date.now(),
						})
						.where(eq(runtimeUpgrades.id, row.id));
					throw new Error(`upgrade_install_dependencies_failed:${message}`, {
						cause: installError,
					});
				}
			}
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

	/** Fail before workspace creation when the host cannot derive and approve a proposal. */
	#requireWorkspacePreparation(): void {
		if (this.#coding === undefined || this.#ensureWorktree === undefined) {
			throw new Error("upgrade_workspace_unavailable");
		}
	}

	async #startWorkspace(
		row: UpgradeRow,
		check: UpgradeCheck,
		requestedBy: string,
	): Promise<UpgradeStartResult> {
		const database = this.#db();
		let taskId: string | undefined;
		try {
			const goal = [
				`Upgrade this Tsukaima checkout from ${check.currentVersion} (${check.currentCommit.slice(0, 12)}) to upstream ${check.upstreamVersion} (${check.upstreamCommit.slice(0, 12)}).`,
				"",
				`Upstream ref: ${check.upstreamRef}`,
				`Local-only commits: ${check.ahead}`,
				`Upstream commits to integrate: ${check.behind}`,
				"",
				"The server prepares this merge in the governed task worktree and records a proposal. Inspect the result here; the administrator finalizes it from Settings.",
				"Do not edit the live repository and do not schedule a restart.",
			]
				.filter((line) => line.length > 0)
				.join("\n");
			const workspace = await this.#workspace.create({
				baseRef: check.currentCommit,
				goal,
				requestedBy,
			});
			taskId = workspace.taskId ?? (await this.#workspace.startTask(workspace.sessionId, { goal }));
			await database
				.update(runtimeUpgrades)
				.set({
					taskId,
					updatedAtMs: Date.now(),
					workspaceSessionId: workspace.sessionId,
				})
				.where(eq(runtimeUpgrades.id, row.id));

			const task = await this.#coding.getTask(taskId);
			if (task === null) throw new Error("upgrade_workspace_task_missing");
			const worktree = await this.#ensureWorktree(taskId);
			const worktreePath = worktree.path;
			await database
				.update(runtimeUpgrades)
				.set({ updatedAtMs: Date.now(), worktreePath })
				.where(eq(runtimeUpgrades.id, row.id));

			await this.#assertLiveCheckout(row);
			await this.#assertCleanWorktree(worktreePath);
			const worktreeHead = await this.#worktreeHead(worktreePath);
			if (worktreeHead !== row.currentCommit) {
				throw new Error("upgrade_worktree_base_mismatch");
			}

			// The host, not a model, performs the merge. The operator-configurable identity keeps this
			// working on a host with no git config, and conflicts fail before any live checkout change.
			const identityArgs = gitIdentityArgs(await readGitIdentity(this.#db()));
			const merge = await this.#git(
				[
					"-C",
					worktreePath,
					...identityArgs,
					"merge",
					"--no-ff",
					"--no-edit",
					"-m",
					`chore(upgrade): merge ${row.targetVersion} from ${row.upstreamRef}`,
					row.targetCommit,
				],
				GIT_TIMEOUT_MS,
			);
			if (merge.exitCode !== 0) {
				await this.#git(["-C", worktreePath, "merge", "--abort"]);
				throw new Error(`upgrade_merge_failed:${merge.stderr.trim()}`);
			}
			const mergedHead = await this.#worktreeHead(worktreePath);
			await this.#assertAncestor(row.currentCommit, mergedHead, "upgrade_worktree_base_mismatch");
			await this.#assertAncestor(row.targetCommit, mergedHead, "upgrade_target_not_integrated");
			const evidence = await this.#workspaceEvidence(worktreePath, row.currentCommit, mergedHead);
			const proposal = await this.#createWorkspaceProposal(row, taskId, mergedHead, evidence);
			await this.#coding.transitionProposal(proposal.id, "pending_approval");
			await this.#appendTask(taskId, "awaiting_approval", proposal.id, "workspace.upgrade.propose");
			await this.#auditRecord({
				action: "runtime.upgrade.proposal",
				actorId: requestedBy,
				actorKind: "user",
				payload: {
					changedFiles: evidence.changedFiles.length,
					diffChecksum: evidence.diffChecksum,
					proposalId: proposal.id,
					sourceRevision: mergedHead,
				},
				result: "ok",
				targetId: row.id,
				targetKind: "runtime-upgrade",
			});

			const updatedAtMs = Date.now();
			const updated = await database
				.update(runtimeUpgrades)
				.set({ error: null, status: "ready", updatedAtMs, worktreePath })
				.where(eq(runtimeUpgrades.id, row.id))
				.returning();
			const result = updated[0];
			if (result === undefined) throw new Error("upgrade_update_failed");
			this.#logger.info("upgrade workspace prepared", {
				proposalId: proposal.id,
				taskId,
				upgradeId: row.id,
				workspaceSessionId: workspace.sessionId,
			});
			return {
				upgrade: toRecord(result),
				workspace: { sessionId: workspace.sessionId, taskId },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (taskId !== undefined) {
				await this.#appendTask(taskId, "failed", message, "workspace.upgrade.prepare", "failure");
			}
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

	async #createWorkspaceProposal(
		row: UpgradeRow,
		taskId: string,
		worktreeHead: string,
		evidence: WorkspaceEvidence,
	): Promise<DeploymentProposal> {
		return await this.#coding.createProposal({
			changedFiles: evidence.changedFiles,
			diff: evidence.diff,
			diffChecksum: evidence.diffChecksum,
			evidence: {
				diffChecksum: evidence.diffChecksum,
				// The host prepares and snapshots the merge, but repository checks remain the
				// administrator's review step; no check result is invented here.
				items: [],
				snapshotChecksum: evidence.snapshotChecksum,
			},
			envChanges: [],
			motivation: `Integrate ${row.upstreamRef} into the local checkout at ${row.currentCommit}.`,
			requiresRestart: true,
			riskAssessment:
				"Host-prepared merge. The live checkout is only changed after the administrator finalizes and the target, worktree snapshot, and proposal are re-verified.",
			rollbackNotes: `Before finalize, reset the worktree to ${row.currentCommit}. After finalize, revert the upgrade merge or reset the live checkout to ${row.currentCommit}.`,
			sourceRevision: worktreeHead,
			taskId,
			title: `Upgrade ${row.currentVersion} to ${row.targetVersion}`,
		});
	}

	/**
	 * Re-derive the worktree snapshot and match it against a reviewable proposal. Nothing in the
	 * live checkout changes here.
	 */
	async #reviewWorkspace(row: UpgradeRow): Promise<WorkspaceReview> {
		if (row.workspaceSessionId === null) throw new Error("upgrade_workspace_missing");
		if (row.taskId === null) throw new Error("upgrade_workspace_task_missing");
		const status = await this.#workspace.status({ sessionId: row.workspaceSessionId });
		const worktreePath =
			typeof status.worktreePath === "string"
				? status.worktreePath
				: (row.worktreePath ?? undefined);
		if (worktreePath === undefined || worktreePath.length === 0) {
			throw new Error("upgrade_worktree_missing");
		}
		await this.#assertLiveCheckout(row);
		await this.#assertCleanWorktree(worktreePath);
		const worktreeHead = await this.#worktreeHead(worktreePath);
		await this.#assertAncestor(row.currentCommit, worktreeHead, "upgrade_worktree_base_mismatch");
		await this.#assertAncestor(row.targetCommit, worktreeHead, "upgrade_target_not_integrated");
		const branch = await this.#git(["-C", worktreePath, "symbolic-ref", "--short", "-q", "HEAD"]);
		if (branch.exitCode !== 0) throw new Error("upgrade_workspace_branch_missing");
		const branchName = branch.stdout.trim();
		if (!SAFE_GIT_NAME.test(branchName)) throw new Error("upgrade_workspace_branch_invalid");
		const branchHead = await this.#git(["rev-parse", "--verify", `refs/heads/${branchName}`]);
		if (branchHead.exitCode !== 0 || branchHead.stdout.trim() !== worktreeHead) {
			throw new Error("upgrade_worktree_branch_stale");
		}

		const evidence = await this.#workspaceEvidence(worktreePath, row.currentCommit, worktreeHead);
		const proposals = await this.#coding.listProposals(row.taskId);
		const reviewable = proposals.filter(
			(proposal) => proposal.status === "approved" || proposal.status === "pending_approval",
		);
		if (reviewable.length === 0) throw new Error("upgrade_proposal_required");
		const matching = reviewable.filter(
			(proposal) =>
				proposal.sourceRevision === worktreeHead &&
				proposal.diffChecksum === evidence.diffChecksum &&
				proposal.evidence !== null &&
				proposal.evidence.diffChecksum === evidence.diffChecksum &&
				proposal.evidence.snapshotChecksum === evidence.snapshotChecksum,
		);
		if (matching.length === 0) {
			const unverified = reviewable.some((proposal) => proposal.evidence === null);
			throw new Error(unverified ? "upgrade_proposal_unverified" : "upgrade_proposal_stale");
		}
		const proposal = matching.reduce((latest, candidate) =>
			candidate.updatedAtMs > latest.updatedAtMs ? candidate : latest,
		);
		return { branchName, proposal, worktreeHead };
	}

	async #approveWorkspaceReview(
		row: UpgradeRow,
		requestedBy: string,
		{ proposal, worktreeHead }: WorkspaceReview,
	): Promise<void> {
		if (proposal.status === "pending_approval") {
			await this.#coding.transitionProposal(proposal.id, "approved");
			await this.#auditRecord({
				action: "runtime.upgrade.approve",
				actorId: requestedBy,
				actorKind: "user",
				payload: {
					diffChecksum: proposal.diffChecksum,
					proposalId: proposal.id,
					sourceRevision: worktreeHead,
				},
				result: "ok",
				targetId: row.id,
				targetKind: "runtime-upgrade",
			});
		}
		this.#logger.info("upgrade workspace reviewed", {
			proposalId: proposal.id,
			upgradeId: row.id,
			worktreeHead,
		});
	}

	async #workspaceEvidence(
		worktreePath: string,
		baseCommit: string,
		worktreeHead: string,
	): Promise<WorkspaceEvidence> {
		this.#assertCommit(baseCommit, "upgrade_checkout_invalid");
		this.#assertCommit(worktreeHead, "upgrade_worktree_invalid");
		const diff = await this.#gitCli.exec(
			[
				"-C",
				worktreePath,
				"diff",
				"--binary",
				"--no-color",
				"--no-ext-diff",
				`${baseCommit}..${worktreeHead}`,
			],
			{ maxOutputBytes: UPGRADE_DIFF_MAX_BYTES, timeoutMs: GIT_TIMEOUT_MS },
		);
		if (diff.exitCode !== 0) throw new Error("upgrade_diff_failed");
		if (diff.stdoutTruncated) throw new Error("upgrade_diff_too_large");
		const names = await this.#git([
			"-C",
			worktreePath,
			"diff",
			"--name-only",
			"-z",
			`${baseCommit}..${worktreeHead}`,
		]);
		if (names.exitCode !== 0 || names.stdoutTruncated) throw new Error("upgrade_diff_failed");
		const changedFiles = names.stdout
			.split("\0")
			.map((path) => path.trim())
			.filter((path) => path.length > 0);
		const snapshot = await measureTaskSnapshot({
			paths: changedFiles,
			repositoryPath: this.#repositoryRoot,
			sourcePath: worktreePath,
		});
		if (snapshot.uncoveredPaths.length > 0) throw new Error("upgrade_snapshot_incomplete");
		return {
			changedFiles,
			diff: diff.stdout,
			diffChecksum: sha256Hex(diff.stdout),
			snapshotChecksum: snapshot.manifest.checksum,
		};
	}

	async #assertLiveCheckout(row: UpgradeRow): Promise<void> {
		this.#assertCommit(row.currentCommit, "upgrade_checkout_invalid");
		const head = await this.#headCommit();
		if (head !== row.currentCommit) throw new Error("upgrade_checkout_stale");
		const branch = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"]);
		if (branch.exitCode !== 0 || branch.stdout.trim() !== row.branch) {
			throw new Error("upgrade_branch_changed");
		}
		const status = await this.#git(["status", "--porcelain"]);
		if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
			throw new Error("working_tree_dirty");
		}
	}

	async #assertCleanWorktree(worktreePath: string): Promise<void> {
		const status = await this.#git(["-C", worktreePath, "status", "--porcelain"]);
		if (status.exitCode !== 0) throw new Error("upgrade_worktree_unavailable");
		if (status.stdout.trim().length > 0) throw new Error("upgrade_worktree_dirty");
	}

	async #worktreeHead(worktreePath: string): Promise<string> {
		const head = await this.#git(["-C", worktreePath, "rev-parse", "HEAD"]);
		if (head.exitCode !== 0) throw new Error("upgrade_worktree_unavailable");
		const commit = head.stdout.trim();
		this.#assertCommit(commit, "upgrade_worktree_invalid");
		return commit;
	}

	async #assertAncestor(ancestor: string, descendant: string, error: string): Promise<void> {
		this.#assertCommit(ancestor, "upgrade_revision_invalid");
		this.#assertCommit(descendant, "upgrade_revision_invalid");
		const result = await this.#git(["merge-base", "--is-ancestor", ancestor, descendant]);
		if (result.exitCode !== 0) throw new Error(error);
	}

	#assertCommit(value: string, error: string): void {
		if (!SAFE_COMMIT.test(value)) throw new Error(error);
	}

	async #appendTask(
		taskId: string,
		status: IterationTask["status"],
		detail: string,
		tool: string,
		outcome: "failure" | "success" = "success",
	): Promise<void> {
		try {
			const task = await this.#coding.getTask(taskId);
			if (task === null) return;
			const patch: IterationTaskPatch = {
				status,
				timeline: [...task.timeline, { atMs: Date.now(), detail, outcome, tool }],
			};
			await this.#coding.updateTask(taskId, patch);
		} catch (error) {
			this.#logger.warn("upgrade task bookkeeping failed", {
				error: error instanceof Error ? error.message : String(error),
				taskId,
			});
		}
	}

	async #merge(row: UpgradeRow, requestedBy: string, review?: WorkspaceReview): Promise<void> {
		if (row.mode === "fast_forward") {
			const merge = await this.#git(["merge", "--ff-only", row.targetCommit]);
			if (merge.exitCode !== 0) {
				throw new Error(`upgrade_merge_failed:${merge.stderr.trim()}`);
			}
			return;
		}
		if (review === undefined) throw new Error("upgrade_worktree_missing");
		// Merge the exact commit that was reviewed, not a branch ref that a concurrent workspace
		// turn could have moved after the snapshot check.
		const identityArgs = gitIdentityArgs(await readGitIdentity(this.#db()));
		await this.#assertLiveCheckout(row);
		const merge = await this.#git(
			[
				...identityArgs,
				"merge",
				"--no-ff",
				"--no-edit",
				"-m",
				`chore(upgrade): merge ${row.targetVersion} from ${row.upstreamRef}`,
				review.worktreeHead,
			],
			GIT_TIMEOUT_MS,
		);
		if (merge.exitCode !== 0) {
			await this.#git(["merge", "--abort"]);
			throw new Error(`upgrade_merge_failed:${merge.stderr.trim()}`);
		}
		const liveHead = await this.#headCommit();
		await this.#assertAncestor(
			review.worktreeHead,
			liveHead,
			"upgrade_live_checkout_missing_workspace",
		);
		await this.#assertAncestor(row.targetCommit, liveHead, "upgrade_live_checkout_missing_target");
		if (row.taskId !== null) {
			await this.#appendTask(
				row.taskId,
				"completed",
				`${review.worktreeHead} (${review.proposal.id})`,
				"workspace.upgrade.merge",
			);
		}
		await this.#auditRecord({
			action: "runtime.upgrade.merge",
			actorId: requestedBy,
			actorKind: "user",
			payload: {
				branch: review.branchName,
				proposalId: review.proposal.id,
				targetCommit: row.targetCommit,
				worktreeHead: review.worktreeHead,
			},
			result: "ok",
			targetId: row.id,
			targetKind: "runtime-upgrade",
		});
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

	async #git(
		args: readonly string[],
		timeoutMs = GIT_QUICK_TIMEOUT_MS,
		env?: Record<string, string>,
	): Promise<GitCommandResult> {
		return await this.#gitCli.exec(args, {
			...(env === undefined ? {} : { env }),
			timeoutMs,
		});
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
