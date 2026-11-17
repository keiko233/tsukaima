export const CODING_API_VERSION = "0.1.0";

/** Host binding consumed by the self-iteration plugin; the server owns the values. */
export const SELF_ITERATION_HOST_BINDING = "tsukaima.self-iteration.host";

export type {
	AuditEvent,
	AuditOutcome,
	CodingTaskMode,
	CreateDeploymentInput,
	CreateIterationTaskInput,
	DeploymentIdentity,
	DeploymentRecord,
	DeploymentRecordPatch,
	DeploymentStatus,
	HealthCheckResult,
	IterationTask,
	IterationTaskConstraints,
	IterationTaskPatch,
	IterationTaskStatus,
	TaskArtifact,
	TaskGraph,
	TaskGraphNode,
	TaskLogEntry,
	TaskNodeKind,
	TaskNodeStatus,
	TaskTimelineEntry,
} from "./types.ts";

export { CodingRunner, CommandRejectedError } from "./runner.ts";
export { runManagedProcess, SCRUBBED_COMMAND_ENV } from "./runner.ts";
export type { CommandResult, ManagedProcessOptions, RunnerConfig } from "./runner.ts";

export {
	ANALYSIS_MOUNT,
	buildBubblewrapArgv,
	createBubblewrapSandbox,
	probeBubblewrapSandbox,
	resolveExecutable,
	SANDBOX_PATH_DIRS,
	SandboxUnavailableError,
} from "./sandbox.ts";
export type {
	BubblewrapArgvInput,
	BubblewrapSandboxOptions,
	SandboxMount,
	SandboxExecInput,
	SandboxExecutor,
	SandboxProvider,
} from "./sandbox.ts";

export {
	assertSafeBaseRef,
	assertSafeWorktreePath,
	isPathWithinAllowlist,
	WorktreeError,
	WorktreeManager,
} from "./worktree.ts";
export type { GitExecResult, WorktreeInfo, WorktreeManagerConfig } from "./worktree.ts";

export {
	applyStructuredEdit,
	EditValidationError,
	readAllowedTextFile,
	validateStructuredEdit,
} from "./edit.ts";
export type { EditOptions, EditResult, StructuredEdit } from "./edit.ts";

export { sha256Hex } from "./hash.ts";

export { reconcileRestartDeployment } from "./deployment-reconcile.ts";
export type {
	DeploymentApplicationVerification,
	DeploymentVerifier,
	ReconcileRestartDeploymentInput,
	ReconcileRestartDeploymentResult,
	RestartDeploymentOutcome,
} from "./deployment-reconcile.ts";

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

export {
	missingProposalFields,
	normalizeDeploymentProposal,
	JsonFileProposalStore,
	ProposalError,
	validateProposalFields,
} from "./proposal.ts";
export type {
	ArtifactMetadata,
	DeploymentProposal,
	DeploymentProposalInput,
	DeploymentProposalStatus,
	DeploymentProposalStore,
} from "./proposal.ts";

export { NoopReloadController, SupervisedReloadController } from "./reload.ts";
export type {
	ReloadContext,
	ReloadController,
	ReloadResult,
	SupervisedReloadOptions,
	SupervisedReloadOutcome,
} from "./reload.ts";

export { DomainCodingStore } from "./domain-store.ts";
