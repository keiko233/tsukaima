export type IterationTaskStatus =
	| "awaiting_approval"
	| "approved"
	| "cancelled"
	| "completed"
	| "deploying"
	| "failed"
	| "in_progress"
	| "pending";

export interface IterationTaskConstraints {
	readonly allowedCommands: readonly string[];
	readonly maxOutputBytes: number;
	readonly pathAllowlist: readonly string[];
	readonly timeoutMs: number;
}

export interface IterationTask {
	readonly baseRef: string;
	readonly constraints: IterationTaskConstraints;
	readonly createdAtMs: number;
	readonly goal: string;
	readonly id: string;
	readonly sourceConversationId: string;
	readonly status: IterationTaskStatus;
	readonly updatedAtMs: number;
	readonly worktreePath?: string;
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
