export const CODING_API_VERSION = "0.1.0";

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
	TestRunResult,
} from "./types.ts";

export { CodingRunner, CommandRejectedError } from "./runner.ts";
export { runManagedProcess, SCRUBBED_COMMAND_ENV } from "./runner.ts";
export type { CommandResult, ExecOptions, ManagedProcessOptions, RunnerConfig } from "./runner.ts";

export {
	ANALYSIS_MOUNT,
	buildBubblewrapArgv,
	buildScratchBubblewrapArgv,
	createBubblewrapSandbox,
	createHostSandbox,
	createScratchBubblewrapSandbox,
	describeSandboxAvailability,
	ISOLATED_BACKEND_REMEDY,
	probeBubblewrapSandbox,
	resolveExecutable,
	SANDBOX_SYSTEM_READONLY_ROOTS,
	SANDBOX_PATH_DIRS,
	SandboxUnavailableError,
} from "./sandbox.ts";
export type {
	BubblewrapArgvInput,
	BubblewrapSandboxOptions,
	ScratchBubblewrapArgvInput,
	ScratchBubblewrapSandboxOptions,
	HostSandboxOptions,
	SandboxAvailability,
	SandboxMount,
	SandboxExecInput,
	SandboxExecResult,
	SandboxExecutor,
	SandboxProvider,
	SandboxUnavailableCode,
} from "./sandbox.ts";

export {
	createTaskSnapshot,
	measureTaskSnapshot,
	SNAPSHOT_DEFAULT_MAX_BYTES,
	SNAPSHOT_DEFAULT_MAX_FILES,
} from "./snapshot.ts";
export type {
	TaskSnapshot,
	TaskSnapshotManifest,
	TaskSnapshotMeasurement,
	TaskSnapshotOptions,
} from "./snapshot.ts";

export {
	assertSafeBaseRef,
	assertSafeWorktreePath,
	isPathWithinAllowlist,
	WorktreeError,
	WorktreeManager,
} from "./worktree.ts";
export type { WorktreeInfo, WorktreeManagerConfig } from "./worktree.ts";

export {
	GIT_DEFAULT_MAX_OUTPUT_BYTES,
	GIT_DEFAULT_TIMEOUT_MS,
	gitCredentialEnvironment,
	GitCli,
	GitCommandError,
} from "./git.ts";
export type { GitCliOptions, GitCommandResult, GitExecOptions } from "./git.ts";

export { sha256Hex } from "./hash.ts";

export { reconcileRestartDeployment } from "./deployment-reconcile.ts";
export type {
	DeploymentApplicationVerification,
	DeploymentVerifier,
	ReconcileRestartDeploymentInput,
	ReconcileRestartDeploymentResult,
	RestartDeploymentOutcome,
} from "./deployment-reconcile.ts";

export { ApprovalError } from "./approval.ts";
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
	ProposalError,
	validateProposalFields,
} from "./proposal.ts";
export type {
	ArtifactMetadata,
	DeploymentProposal,
	DeploymentProposalInput,
	DeploymentProposalStatus,
	DeploymentProposalStore,
	ProposalEvidence,
	ProposalEvidenceItem,
} from "./proposal.ts";

export { SupervisedReloadController } from "./reload.ts";
export type {
	ReloadContext,
	ReloadController,
	ReloadResult,
	SupervisedReloadOptions,
	SupervisedReloadOutcome,
} from "./reload.ts";

export { DomainCodingStore } from "./domain-store.ts";

export {
	createPiWorkspaceRunner,
	GOVERNED_SHELL_MAX_COMMAND_LENGTH,
	GovernedShellError,
	parseGovernedShellCommand,
	PiWorkspaceRunner,
	PiWorkspaceRunnerError,
	PI_WORKSPACE_DEFAULT_MAX_FILE_BYTES,
	PI_WORKSPACE_DEFAULT_MAX_OUTPUT_BYTES,
	PI_WORKSPACE_DEFAULT_MAX_WRITE_BYTES,
	PI_WORKSPACE_DEFAULT_TIMEOUT_MS,
} from "./pi-workspace-runner.ts";
export type {
	GovernedShellCommand,
	PiWorkspaceNativeToolName,
	PiWorkspaceRunOptions,
	PiWorkspaceRunResult,
	PiWorkspaceRunnerConfig,
	PiWorkspaceRunnerErrorCode,
} from "./pi-workspace-runner.ts";
