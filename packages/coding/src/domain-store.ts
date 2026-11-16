import { and, desc, eq } from "drizzle-orm";
import {
	codingApprovals,
	codingDeployments,
	codingProposals,
	codingTasks,
	type TsukaimaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
} from "@tsukaima/db";
import { randomUUID } from "node:crypto";
import { ApprovalError } from "./approval.ts";
import type {
	ApprovalRequest,
	ApprovalRequestInput,
	PendingApprovalRequest,
	ResolvedApprovalRequest,
} from "./approval.ts";
import {
	normalizeDeploymentProposal,
	ProposalError,
	type DeploymentProposal,
	type DeploymentProposalInput,
	type DeploymentProposalStatus,
} from "./proposal.ts";
import type { TestRunResult } from "./tools.ts";
import type {
	CreateDeploymentInput,
	CreateIterationTaskInput,
	DeploymentRecord,
	DeploymentRecordPatch,
	DeploymentStatus,
	IterationTask,
	IterationTaskConstraints,
	IterationTaskPatch,
	IterationTaskStatus,
	TaskArtifact,
	TaskLogEntry,
	TaskTimelineEntry,
} from "./types.ts";

const validTransitions: Readonly<
	Record<DeploymentProposalStatus, readonly DeploymentProposalStatus[]>
> = {
	approved: ["cancelled", "deploying"],
	cancelled: [],
	deployed: ["rolled_back"],
	deploying: ["deployed", "failed"],
	draft: ["cancelled", "pending_approval"],
	failed: ["cancelled", "pending_approval"],
	pending_approval: ["approved", "cancelled", "rejected"],
	rejected: [],
	rolled_back: [],
};

const TASK_STATUSES: readonly IterationTaskStatus[] = [
	"awaiting_approval",
	"approved",
	"cancelled",
	"completed",
	"deploying",
	"failed",
	"in_progress",
	"pending",
];

type DatabaseSource = string | (() => TsukaimaDatabase | undefined);

function parseJsonArray<T>(value: string | null, fallback: readonly T[] = []): readonly T[] {
	if (value === null) return fallback;
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : fallback;
	} catch {
		return fallback;
	}
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function approvalFromRow(row: typeof codingApprovals.$inferSelect): ApprovalRequest {
	const base = {
		action: row.action,
		createdAtMs: row.createdAtMs,
		expiresAtMs: row.expiresAtMs,
		id: row.id,
		...(row.proposalId === null ? {} : { proposalId: row.proposalId }),
		requestedBy: row.requestedBy,
		taskId: row.taskId,
	};
	if (row.status === "pending") {
		return { ...base, status: "pending" } satisfies PendingApprovalRequest;
	}
	return {
		...base,
		...(row.note === null ? {} : { note: row.note }),
		resolvedAtMs: row.resolvedAtMs ?? row.createdAtMs,
		resolvedBy: row.resolvedBy ?? "system",
		status: row.status,
	} satisfies ResolvedApprovalRequest;
}

function proposalFromRow(row: typeof codingProposals.$inferSelect): DeploymentProposal {
	return {
		artifactMetadata: parseJsonObject(
			row.artifactMetadataJson,
		) as DeploymentProposal["artifactMetadata"],
		changedFiles: parseJsonArray<string>(row.changedFilesJson),
		createdAtMs: row.createdAtMs,
		diff: row.diff,
		diffChecksum: row.diffChecksum,
		envChanges: parseJsonArray<string>(row.envChangesJson),
		id: row.id,
		motivation: row.motivation,
		requiresRestart: row.requiresRestart === 1,
		riskAssessment: row.riskAssessment,
		rollbackNotes: row.rollbackNotes,
		sourceRevision: row.sourceRevision,
		status: row.status,
		taskId: row.taskId,
		testResult:
			row.testResultJson === null ? null : (JSON.parse(row.testResultJson) as TestRunResult),
		title: row.title,
		updatedAtMs: row.updatedAtMs,
	};
}

function taskFromRow(row: typeof codingTasks.$inferSelect): IterationTask {
	return {
		artifacts: parseJsonArray<TaskArtifact>(row.artifactsJson),
		baseRef: row.baseRef,
		constraints: JSON.parse(row.constraintsJson) as IterationTaskConstraints,
		createdAtMs: row.createdAtMs,
		goal: row.goal,
		id: row.id,
		logs: parseJsonArray<TaskLogEntry>(row.logsJson),
		mode: row.mode,
		sourceConversationId: row.sourceConversationId,
		status: TASK_STATUSES.includes(row.status) ? row.status : "pending",
		timeline: parseJsonArray<TaskTimelineEntry>(row.timelineJson),
		updatedAtMs: row.updatedAtMs,
		...(row.worktreePath === null ? {} : { worktreePath: row.worktreePath }),
	};
}

function deploymentFromRow(row: typeof codingDeployments.$inferSelect): DeploymentRecord {
	return {
		artifactMetadata: parseJsonObject(row.artifactMetadataJson),
		createdAtMs: row.createdAtMs,
		createdBy: row.createdBy,
		id: row.id,
		postCheck: parseJsonObject(row.postCheckJson) as DeploymentRecord["postCheck"],
		preCheck: parseJsonObject(row.preCheckJson) as DeploymentRecord["preCheck"],
		proposalId: row.proposalId,
		reloadedAtMs: row.reloadedAtMs,
		rollbackOfId: row.rollbackOfId,
		rollbackPlan: row.rollbackPlan,
		sourceRevision: row.sourceRevision,
		status: row.status,
		taskId: row.taskId,
		updatedAtMs: row.updatedAtMs,
	};
}

function jsonOrNull(value: unknown): string | null {
	return value === null || value === undefined ? null : JSON.stringify(value);
}

function taskJson(value: readonly unknown[] | undefined): string {
	return JSON.stringify(value ?? []);
}

/**
 * Durable coding store. It accepts either a SQLite path (tests and standalone tools) or a
 * provider so the server can reuse its already-open domain database handle.
 */
export class DomainCodingStore {
	readonly databasePath: string | undefined;
	readonly #databaseProvider: (() => TsukaimaDatabase | undefined) | undefined;
	#database: TsukaimaDatabase | undefined;
	#databasePromise: Promise<TsukaimaDatabase> | undefined;

	constructor(database: DatabaseSource) {
		if (typeof database === "string") {
			this.databasePath = database;
		} else {
			this.databasePath = undefined;
			this.#databaseProvider = database;
		}
	}

	async #db(): Promise<TsukaimaDatabase> {
		if (this.#database !== undefined) return this.#database;
		if (this.#databaseProvider !== undefined) {
			const database = this.#databaseProvider();
			if (database === undefined) throw new Error("Domain database is not ready");
			this.#database = database;
			return database;
		}
		if (this.databasePath === undefined) throw new Error("Domain database is not configured");
		this.#databasePromise ??= openDomainDatabase(this.databasePath).then((database) => {
			migrateDomainDatabase(database);
			return database;
		});
		this.#database = await this.#databasePromise;
		return this.#database;
	}

	async approve(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolveApproval(id, "approved", resolvedBy, note);
	}

	async reject(id: string, resolvedBy: string, note?: string): Promise<ApprovalRequest> {
		return this.#resolveApproval(id, "rejected", resolvedBy, note);
	}

	async create(input: ApprovalRequestInput): Promise<ApprovalRequest>;
	async create(input: DeploymentProposalInput): Promise<DeploymentProposal>;
	async create(
		input: ApprovalRequestInput | DeploymentProposalInput,
	): Promise<ApprovalRequest | DeploymentProposal> {
		if ("action" in input) {
			const database = await this.#db();
			const request: PendingApprovalRequest = {
				action: input.action,
				createdAtMs: Date.now(),
				expiresAtMs: input.expiresAtMs,
				id: randomUUID(),
				...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
				requestedBy: input.requestedBy,
				status: "pending",
				taskId: input.taskId,
			};
			await database.insert(codingApprovals).values({
				action: request.action,
				createdAtMs: request.createdAtMs,
				expiresAtMs: request.expiresAtMs,
				id: request.id,
				note: null,
				proposalId: request.proposalId ?? null,
				requestedBy: request.requestedBy,
				resolvedAtMs: null,
				resolvedBy: null,
				status: request.status,
				taskId: request.taskId,
			});
			return request;
		}
		return this.createProposal(input);
	}

	async createProposal(input: DeploymentProposalInput): Promise<DeploymentProposal> {
		const database = await this.#db();
		const proposal = normalizeDeploymentProposal(input);
		await database.insert(codingProposals).values({
			artifactMetadataJson: jsonOrNull(proposal.artifactMetadata),
			changedFilesJson: JSON.stringify(proposal.changedFiles),
			createdAtMs: proposal.createdAtMs,
			diff: proposal.diff,
			diffChecksum: proposal.diffChecksum,
			envChangesJson: JSON.stringify(proposal.envChanges),
			id: proposal.id,
			motivation: proposal.motivation,
			requiresRestart: proposal.requiresRestart ? 1 : 0,
			riskAssessment: proposal.riskAssessment,
			rollbackNotes: proposal.rollbackNotes,
			sourceRevision: proposal.sourceRevision,
			status: proposal.status,
			taskId: proposal.taskId,
			testResultJson: proposal.testResult === null ? null : JSON.stringify(proposal.testResult),
			title: proposal.title,
			updatedAtMs: proposal.updatedAtMs,
		});
		return proposal;
	}

	async get(id: string): Promise<ApprovalRequest | DeploymentProposal | null> {
		return (await this.getApproval(id)) ?? (await this.getProposal(id));
	}

	async getApproval(id: string): Promise<ApprovalRequest | null> {
		const database = await this.#db();
		const [row] = await database
			.select()
			.from(codingApprovals)
			.where(eq(codingApprovals.id, id))
			.limit(1);
		if (row === undefined) {
			return null;
		}
		const request = approvalFromRow(row);
		if (request.status !== "pending" || Date.now() <= request.expiresAtMs) {
			return request;
		}
		return this.#expireApproval(request);
	}

	async listPending(): Promise<readonly ApprovalRequest[]> {
		const database = await this.#db();
		const rows = await database
			.select()
			.from(codingApprovals)
			.where(eq(codingApprovals.status, "pending"));
		const pending: ApprovalRequest[] = [];
		for (const row of rows) {
			const request = approvalFromRow(row);
			if (request.status === "pending" && Date.now() > request.expiresAtMs) {
				await this.#expireApproval(request);
			} else if (request.status === "pending") {
				pending.push(request);
			}
		}
		return pending;
	}

	async listApprovals(
		options: { readonly taskId?: string } = {},
	): Promise<readonly ApprovalRequest[]> {
		const database = await this.#db();
		const rows =
			options.taskId === undefined
				? await database.select().from(codingApprovals).orderBy(desc(codingApprovals.createdAtMs))
				: await database
						.select()
						.from(codingApprovals)
						.where(eq(codingApprovals.taskId, options.taskId))
						.orderBy(desc(codingApprovals.createdAtMs));
		const requests: ApprovalRequest[] = [];
		for (const row of rows) {
			const request = approvalFromRow(row);
			if (request.status === "pending" && Date.now() > request.expiresAtMs) {
				requests.push(await this.#expireApproval(request));
			} else {
				requests.push(request);
			}
		}
		return requests;
	}

	async getProposal(id: string): Promise<DeploymentProposal | null> {
		const database = await this.#db();
		const [row] = await database
			.select()
			.from(codingProposals)
			.where(eq(codingProposals.id, id))
			.limit(1);
		return row === undefined ? null : proposalFromRow(row);
	}

	async list(taskId?: string): Promise<readonly DeploymentProposal[]> {
		const database = await this.#db();
		const rows =
			taskId === undefined
				? await database.select().from(codingProposals)
				: await database.select().from(codingProposals).where(eq(codingProposals.taskId, taskId));
		return rows.map(proposalFromRow);
	}

	async listProposals(taskId?: string): Promise<readonly DeploymentProposal[]> {
		return this.list(taskId);
	}

	async transition(id: string, toStatus: DeploymentProposalStatus): Promise<DeploymentProposal> {
		const database = await this.#db();
		const existing = await this.getProposal(id);
		if (existing === null) {
			throw new ProposalError(`Proposal "${id}" not found`);
		}
		if (!validTransitions[existing.status].includes(toStatus)) {
			throw new ProposalError(
				`Invalid transition from "${existing.status}" to "${toStatus}". Allowed: [${validTransitions[existing.status].join(", ")}]`,
			);
		}
		const updatedAtMs = Date.now();
		await database
			.update(codingProposals)
			.set({ status: toStatus, updatedAtMs })
			.where(eq(codingProposals.id, id));
		return { ...existing, status: toStatus, updatedAtMs };
	}

	async transitionProposal(
		id: string,
		toStatus: DeploymentProposalStatus,
	): Promise<DeploymentProposal> {
		return this.transition(id, toStatus);
	}

	async createTask(input: CreateIterationTaskInput): Promise<IterationTask> {
		const database = await this.#db();
		const now = Date.now();
		const task: IterationTask = {
			artifacts: [],
			baseRef: input.baseRef,
			constraints: input.constraints,
			createdAtMs: now,
			goal: input.goal,
			id: randomUUID(),
			logs: [],
			mode: input.mode,
			sourceConversationId: input.sourceConversationId,
			status: input.status ?? "pending",
			timeline: [],
			updatedAtMs: now,
		};
		await database.insert(codingTasks).values({
			artifactsJson: "[]",
			baseRef: task.baseRef,
			constraintsJson: JSON.stringify(task.constraints),
			createdAtMs: task.createdAtMs,
			goal: task.goal,
			id: task.id,
			logsJson: "[]",
			mode: task.mode,
			sourceConversationId: task.sourceConversationId,
			status: task.status,
			timelineJson: "[]",
			updatedAtMs: task.updatedAtMs,
			worktreePath: null,
		});
		return task;
	}

	async getTask(id: string): Promise<IterationTask | null> {
		const database = await this.#db();
		const [row] = await database.select().from(codingTasks).where(eq(codingTasks.id, id)).limit(1);
		return row === undefined ? null : taskFromRow(row);
	}

	async listTasks(
		options: {
			readonly limit?: number;
			readonly mode?: IterationTask["mode"];
			readonly status?: IterationTaskStatus;
		} = {},
	): Promise<readonly IterationTask[]> {
		const database = await this.#db();
		const conditions = [];
		if (options.status !== undefined) conditions.push(eq(codingTasks.status, options.status));
		if (options.mode !== undefined) conditions.push(eq(codingTasks.mode, options.mode));
		const rows = await database
			.select()
			.from(codingTasks)
			.where(conditions.length === 0 ? undefined : and(...conditions))
			.orderBy(desc(codingTasks.updatedAtMs))
			.limit(options.limit ?? 100);
		return rows.map(taskFromRow);
	}

	async updateTask(id: string, patch: IterationTaskPatch): Promise<IterationTask> {
		const database = await this.#db();
		const existing = await this.getTask(id);
		if (existing === null) throw new Error(`Coding task "${id}" not found`);
		const updatedAtMs = Date.now();
		const values: Partial<typeof codingTasks.$inferInsert> = { updatedAtMs };
		if (patch.artifacts !== undefined) values.artifactsJson = taskJson(patch.artifacts);
		if (patch.logs !== undefined) values.logsJson = taskJson(patch.logs);
		if (patch.timeline !== undefined) values.timelineJson = taskJson(patch.timeline);
		if (patch.status !== undefined) values.status = patch.status;
		if (patch.worktreePath !== undefined) values.worktreePath = patch.worktreePath;
		await database.update(codingTasks).set(values).where(eq(codingTasks.id, id));
		return {
			...existing,
			...(patch.artifacts === undefined ? {} : { artifacts: patch.artifacts }),
			...(patch.logs === undefined ? {} : { logs: patch.logs }),
			...(patch.status === undefined ? {} : { status: patch.status }),
			...(patch.timeline === undefined ? {} : { timeline: patch.timeline }),
			...(patch.worktreePath === undefined || patch.worktreePath === null
				? {}
				: { worktreePath: patch.worktreePath }),
			updatedAtMs,
		};
	}

	async createDeployment(input: CreateDeploymentInput): Promise<DeploymentRecord> {
		const database = await this.#db();
		const now = Date.now();
		const record: DeploymentRecord = {
			artifactMetadata: input.artifactMetadata ?? null,
			createdAtMs: now,
			createdBy: input.createdBy,
			id: randomUUID(),
			postCheck: input.postCheck ?? null,
			preCheck: input.preCheck ?? null,
			proposalId: input.proposalId,
			reloadedAtMs: input.reloadedAtMs ?? null,
			rollbackOfId: input.rollbackOfId ?? null,
			rollbackPlan: input.rollbackPlan,
			sourceRevision: input.sourceRevision,
			status: input.status,
			taskId: input.taskId,
			updatedAtMs: now,
		};
		await database.insert(codingDeployments).values({
			artifactMetadataJson: jsonOrNull(record.artifactMetadata),
			createdAtMs: record.createdAtMs,
			createdBy: record.createdBy,
			id: record.id,
			postCheckJson: jsonOrNull(record.postCheck),
			preCheckJson: jsonOrNull(record.preCheck),
			proposalId: record.proposalId,
			reloadedAtMs: record.reloadedAtMs,
			rollbackOfId: record.rollbackOfId,
			rollbackPlan: record.rollbackPlan,
			sourceRevision: record.sourceRevision,
			status: record.status,
			taskId: record.taskId,
			updatedAtMs: record.updatedAtMs,
		});
		return record;
	}

	async getDeployment(id: string): Promise<DeploymentRecord | null> {
		const database = await this.#db();
		const [row] = await database
			.select()
			.from(codingDeployments)
			.where(eq(codingDeployments.id, id))
			.limit(1);
		return row === undefined ? null : deploymentFromRow(row);
	}

	async listDeployments(
		options: {
			readonly limit?: number;
			readonly proposalId?: string;
			readonly status?: DeploymentStatus;
			readonly taskId?: string;
		} = {},
	): Promise<readonly DeploymentRecord[]> {
		const database = await this.#db();
		const conditions = [];
		if (options.proposalId !== undefined)
			conditions.push(eq(codingDeployments.proposalId, options.proposalId));
		if (options.taskId !== undefined) conditions.push(eq(codingDeployments.taskId, options.taskId));
		if (options.status !== undefined) conditions.push(eq(codingDeployments.status, options.status));
		const rows = await database
			.select()
			.from(codingDeployments)
			.where(conditions.length === 0 ? undefined : and(...conditions))
			.orderBy(desc(codingDeployments.createdAtMs))
			.limit(options.limit ?? 100);
		return rows.map(deploymentFromRow);
	}

	async updateDeployment(id: string, patch: DeploymentRecordPatch): Promise<DeploymentRecord> {
		const database = await this.#db();
		const existing = await this.getDeployment(id);
		if (existing === null) throw new Error(`Deployment "${id}" not found`);
		const updatedAtMs = Date.now();
		const values: Partial<typeof codingDeployments.$inferInsert> = { updatedAtMs };
		if (patch.postCheck !== undefined) values.postCheckJson = jsonOrNull(patch.postCheck);
		if (patch.preCheck !== undefined) values.preCheckJson = jsonOrNull(patch.preCheck);
		if (patch.reloadedAtMs !== undefined) values.reloadedAtMs = patch.reloadedAtMs;
		if (patch.status !== undefined) values.status = patch.status;
		await database.update(codingDeployments).set(values).where(eq(codingDeployments.id, id));
		return {
			...existing,
			...(patch.postCheck === undefined ? {} : { postCheck: patch.postCheck }),
			...(patch.preCheck === undefined ? {} : { preCheck: patch.preCheck }),
			...(patch.reloadedAtMs === undefined ? {} : { reloadedAtMs: patch.reloadedAtMs }),
			...(patch.status === undefined ? {} : { status: patch.status }),
			updatedAtMs,
		};
	}

	async close(): Promise<void> {
		if (this.databasePath === undefined) return;
		const database = await this.#db();
		database.$client.close();
	}

	async #resolveApproval(
		id: string,
		status: "approved" | "rejected",
		resolvedBy: string,
		note?: string,
	): Promise<ApprovalRequest> {
		const database = await this.#db();
		const existing = await this.getApproval(id);
		if (existing === null) {
			throw new ApprovalError(`Approval request "${id}" not found`);
		}
		if (existing.status !== "pending") {
			throw new ApprovalError(
				`Approval request "${id}" is not pending (status: ${existing.status})`,
			);
		}
		const resolved: ResolvedApprovalRequest = {
			...existing,
			...(note === undefined ? {} : { note }),
			resolvedAtMs: Date.now(),
			resolvedBy,
			status,
		};
		await database
			.update(codingApprovals)
			.set({
				note: resolved.note ?? null,
				resolvedAtMs: resolved.resolvedAtMs,
				resolvedBy: resolved.resolvedBy,
				status: resolved.status,
			})
			.where(and(eq(codingApprovals.id, id), eq(codingApprovals.status, "pending")));
		return resolved;
	}

	async #expireApproval(request: PendingApprovalRequest): Promise<ResolvedApprovalRequest> {
		const database = await this.#db();
		const expired: ResolvedApprovalRequest = {
			...request,
			resolvedAtMs: Date.now(),
			resolvedBy: "system",
			status: "expired",
		};
		await database
			.update(codingApprovals)
			.set({
				resolvedAtMs: expired.resolvedAtMs,
				resolvedBy: expired.resolvedBy,
				status: expired.status,
			})
			.where(and(eq(codingApprovals.id, request.id), eq(codingApprovals.status, "pending")));
		return expired;
	}
}
