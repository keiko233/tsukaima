export type IterationTaskStatus =
	| "awaiting_approval"
	| "approved"
	| "cancelled"
	| "completed"
	| "deploying"
	| "failed"
	| "in_progress"
	| "pending";

/** Task kinds are fixed so a plugin can gate tools by the strongest capability in play. */
export type CodingTaskMode = "analysis" | "maintenance" | "patch" | "proposal";

export interface IterationTaskConstraints {
	readonly allowedCommands: readonly string[];
	readonly maxOutputBytes: number;
	readonly pathAllowlist: readonly string[];
	readonly timeoutMs: number;
}

export interface TaskLogEntry {
	readonly atMs: number;
	readonly level: "error" | "info" | "warn";
	readonly message: string;
}

export interface TaskArtifact {
	readonly checksum?: string;
	readonly kind: "build" | "diff" | "log" | "patch" | "test";
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly name: string;
	readonly path?: string;
	readonly sizeBytes?: number;
}

export interface TaskTimelineEntry {
	readonly atMs: number;
	readonly detail?: string;
	readonly outcome: "denied" | "failure" | "success";
	readonly tool: string;
}

export interface IterationTask {
	readonly artifacts: readonly TaskArtifact[];
	readonly baseRef: string;
	readonly constraints: IterationTaskConstraints;
	readonly createdAtMs: number;
	readonly goal: string;
	readonly id: string;
	readonly logs: readonly TaskLogEntry[];
	readonly mode: CodingTaskMode;
	readonly sourceConversationId: string;
	readonly status: IterationTaskStatus;
	readonly timeline: readonly TaskTimelineEntry[];
	readonly updatedAtMs: number;
	readonly worktreePath?: string;
}

export interface CreateIterationTaskInput {
	readonly baseRef: string;
	readonly constraints: IterationTaskConstraints;
	readonly goal: string;
	readonly mode: CodingTaskMode;
	readonly sourceConversationId: string;
	readonly status?: IterationTaskStatus;
}

export interface IterationTaskPatch {
	readonly artifacts?: readonly TaskArtifact[];
	readonly logs?: readonly TaskLogEntry[];
	readonly status?: IterationTaskStatus;
	readonly timeline?: readonly TaskTimelineEntry[];
	readonly worktreePath?: string | null;
}

export type DeploymentStatus = "deployed" | "failed" | "pending" | "rolled_back";

export interface DeploymentRecord {
	readonly artifactMetadata: Readonly<Record<string, unknown>> | null;
	readonly createdAtMs: number;
	readonly createdBy: string;
	readonly id: string;
	readonly postCheck: HealthCheckResult | null;
	readonly preCheck: HealthCheckResult | null;
	readonly proposalId: string;
	readonly reloadedAtMs: number | null;
	readonly rollbackOfId: string | null;
	readonly rollbackPlan: string;
	readonly sourceRevision: string;
	readonly status: DeploymentStatus;
	readonly taskId: string;
	readonly updatedAtMs: number;
}

export interface CreateDeploymentInput {
	readonly artifactMetadata?: Readonly<Record<string, unknown>> | null;
	readonly createdBy: string;
	readonly postCheck?: HealthCheckResult | null;
	readonly preCheck?: HealthCheckResult | null;
	readonly proposalId: string;
	readonly reloadedAtMs?: number | null;
	readonly rollbackOfId?: string | null;
	readonly rollbackPlan: string;
	readonly sourceRevision: string;
	readonly status: DeploymentStatus;
	readonly taskId: string;
}

/** Mutable lifecycle fields. Identity, rollback plan, and source revision never change. */
export interface DeploymentRecordPatch {
	readonly postCheck?: HealthCheckResult | null;
	readonly preCheck?: HealthCheckResult | null;
	readonly reloadedAtMs?: number | null;
	readonly status?: DeploymentStatus;
}

export type TaskNodeStatus = "done" | "failed" | "pending" | "running" | "skipped";

export type TaskNodeKind =
	| "cleanup"
	| "deploy"
	| "implement"
	| "prepare"
	| "review"
	| "test"
	| "verify";

export interface TaskGraphNode {
	readonly dependsOn: readonly string[];
	readonly id: string;
	readonly kind: TaskNodeKind;
	readonly label: string;
	readonly status: TaskNodeStatus;
}

export interface TaskGraph {
	readonly nodes: readonly TaskGraphNode[];
	readonly taskId: string;
}

export type AuditOutcome = "denied" | "failure" | "success";

export interface AuditEvent {
	readonly action: string;
	readonly actor: string;
	readonly detail?: string;
	readonly id: string;
	readonly outcome: AuditOutcome;
	readonly proposalId?: string;
	readonly taskId: string;
	readonly timestampMs: number;
}

/** Pre/post health probe used by supervised reloads. */
export interface HealthCheckResult {
	readonly checkedAtMs: number;
	readonly message?: string;
	readonly ok: boolean;
}
