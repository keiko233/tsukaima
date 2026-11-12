export const CODING_API_VERSION = "0.1.0";

export type {
	AuditEvent,
	AuditOutcome,
	IterationTask,
	IterationTaskConstraints,
	IterationTaskStatus,
	TaskGraph,
	TaskGraphNode,
	TaskNodeKind,
	TaskNodeStatus,
} from "./types.ts";

export { CodingRunner, CommandRejectedError } from "./runner.ts";
export type { CommandResult, RunnerConfig } from "./runner.ts";

export { isPathWithinAllowlist, WorktreeError, WorktreeManager } from "./worktree.ts";
export type { GitExecResult, WorktreeInfo, WorktreeManagerConfig } from "./worktree.ts";

export { CodingTools, parseDiffOutput, parseTestOutput } from "./tools.ts";
export type { BuildResult, DiffFileEntry, DiffResult, TestRunResult } from "./tools.ts";

export { ApprovalError, JsonFileApprovalStore } from "./approval.ts";
export type {
	ApprovalGate,
	ApprovalRequest,
	ApprovalRequestBase,
	ApprovalRequestInput,
	ApprovalStatus,
	PendingApprovalRequest,
	ResolvedApprovalRequest,
} from "./approval.ts";

export { JsonFileProposalStore, ProposalError } from "./proposal.ts";
export type {
	DeploymentProposal,
	DeploymentProposalInput,
	DeploymentProposalStatus,
	DeploymentProposalStore,
} from "./proposal.ts";

export { NoopReloadController } from "./reload.ts";
export type { ReloadContext, ReloadController, ReloadResult } from "./reload.ts";
