import type {
	DeploymentIdentity,
	DeploymentProposal,
	DomainCodingStore,
	HealthCheckResult,
	IterationTask,
	IterationTaskConstraints,
	IterationTaskStatus,
	ReloadController,
	SandboxProvider,
} from "@tsukaima/coding";

export const SELF_ITERATION_PLUGIN_ID = "self-iteration";
export const SELF_ITERATION_RPC_PREFIX = `${SELF_ITERATION_PLUGIN_ID}.`;
/** Host-provided store, repository root, worktree root, and supervised reload controller. */
export const SELF_ITERATION_HOST_BINDING = "tsukaima.self-iteration.host";
export const SELF_ITERATION_POLICY_KEY = "self-iteration.policy";

/** Bounded policy edited in the WebUI and applied by every tool. */
export interface CodingPolicy {
	readonly allowedCommands: readonly string[];
	readonly autoApply: boolean;
	readonly buildCommand: readonly string[];
	/** Timeout for one named check; the longest target (webui-build) needs the most headroom. */
	readonly checkTimeoutMs: number;
	/** Whether the Workspace shell may make outbound connections. Default: allowed. */
	readonly execNetwork: "none" | "outbound";
	/** Size cap on one model-authored shell script. */
	readonly maxScriptBytes: number;
	readonly maxDiffBytes: number;
	readonly maxDiffFiles: number;
	readonly maxOutputBytes: number;
	readonly pathAllowlist: readonly string[];
	readonly testCommand: readonly string[];
	readonly timeoutMs: number;
	/** Timeout for one Workspace shell run; longer than test/build, shorter than a check. */
	readonly execTimeoutMs: number;
}

export const DEFAULT_CODING_POLICY: CodingPolicy = {
	allowedCommands: ["bun", "git", "rg"],
	autoApply: false,
	buildCommand: ["bun", "run", "build"],
	checkTimeoutMs: 600_000,
	execNetwork: "outbound",
	maxScriptBytes: 32 * 1024,
	maxDiffBytes: 256 * 1024,
	maxDiffFiles: 200,
	maxOutputBytes: 64 * 1024,
	pathAllowlist: [
		"README.md",
		"apps",
		"docs",
		"package.json",
		"packages",
		"plugins",
		"src",
		"tests",
		"tools",
	],
	testCommand: ["bun", "test"],
	timeoutMs: 120_000,
	execTimeoutMs: 300_000,
};

function strings(input: unknown, fallback: readonly string[]): readonly string[] {
	return Array.isArray(input)
		? input.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: fallback;
}

function number(input: unknown, fallback: number, min: number): number {
	return typeof input === "number" && Number.isFinite(input)
		? Math.max(min, Math.floor(input))
		: fallback;
}

function command(input: unknown, fallback: readonly string[]): readonly string[] {
	const values = strings(input, fallback);
	return values.length === 0 ? fallback : values;
}

export function normalizePolicy(value: unknown): CodingPolicy {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const allowedCommands = strings(record.allowedCommands, DEFAULT_CODING_POLICY.allowedCommands);
	return {
		allowedCommands:
			allowedCommands.length === 0 ? DEFAULT_CODING_POLICY.allowedCommands : allowedCommands,
		autoApply: record.autoApply === true,
		buildCommand: command(record.buildCommand, DEFAULT_CODING_POLICY.buildCommand),
		checkTimeoutMs: number(record.checkTimeoutMs, DEFAULT_CODING_POLICY.checkTimeoutMs, 1000),
		execNetwork:
			record.execNetwork === "none"
				? "none"
				: record.execNetwork === "outbound"
					? "outbound"
					: DEFAULT_CODING_POLICY.execNetwork,
		maxScriptBytes: number(record.maxScriptBytes, DEFAULT_CODING_POLICY.maxScriptBytes, 1024),
		maxDiffBytes: number(record.maxDiffBytes, DEFAULT_CODING_POLICY.maxDiffBytes, 1024),
		maxDiffFiles: number(record.maxDiffFiles, DEFAULT_CODING_POLICY.maxDiffFiles, 1),
		maxOutputBytes: number(record.maxOutputBytes, DEFAULT_CODING_POLICY.maxOutputBytes, 1024),
		pathAllowlist: strings(record.pathAllowlist, DEFAULT_CODING_POLICY.pathAllowlist),
		testCommand: command(record.testCommand, DEFAULT_CODING_POLICY.testCommand),
		timeoutMs: number(record.timeoutMs, DEFAULT_CODING_POLICY.timeoutMs, 1000),
		execTimeoutMs: number(record.execTimeoutMs, DEFAULT_CODING_POLICY.execTimeoutMs, 1000),
	};
}

export function mergePolicy(base: CodingPolicy, patch: unknown): CodingPolicy {
	const record =
		typeof patch === "object" && patch !== null && !Array.isArray(patch)
			? (patch as Record<string, unknown>)
			: {};
	return normalizePolicy({ ...base, ...record });
}

export function constraintsFromPolicy(policy: CodingPolicy): IterationTaskConstraints {
	return {
		allowedCommands: [...policy.allowedCommands],
		maxOutputBytes: policy.maxOutputBytes,
		pathAllowlist: [...policy.pathAllowlist],
		timeoutMs: policy.timeoutMs,
	};
}

export type TaskMode = IterationTask["mode"];
export type DeploymentProposalStatus = DeploymentProposal["status"];
export type TaskStatus = IterationTaskStatus;

export interface SelfIterationHostBinding {
	/**
	 * Exact artifact identity the deployer will make live for this proposal. Without it the
	 * deployment cannot be verified and must settle `manual_apply_required`.
	 */
	readonly appliedIdentity?: (
		proposal: DeploymentProposal,
	) => Promise<DeploymentIdentity | undefined> | DeploymentIdentity | undefined;
	readonly healthCheck?: () => Promise<HealthCheckResult> | HealthCheckResult;
	/** Identity for git commits created by the server or inside a governed worktree. */
	readonly gitIdentity?: () =>
		| { readonly email: string; readonly name: string }
		| Promise<{ readonly email: string; readonly name: string }>;
	readonly reload: ReloadController;
	readonly repositoryRoot: string;
	/** Command execution boundary chosen by the host; defaults to bubblewrap. */
	readonly sandbox?: SandboxProvider;
	/** Exact artifact identity this process is running, if the host can report it. */
	readonly runningIdentity?: () =>
		| Promise<DeploymentIdentity | undefined>
		| DeploymentIdentity
		| undefined;
	readonly store: DomainCodingStore;
	/**
	 * Coding task bound to a durable Workspace conversation. `null` means the workspace has no task
	 * yet; `undefined` means the conversation is not a Workspace. Model tool calls resolve their
	 * task only through this binding, so a missing function fails closed.
	 */
	readonly workspaceTaskFor?: (
		conversationId: string,
	) => Promise<string | null | undefined> | string | null | undefined;
	readonly worktreeRoot: string;
}

/**
 * Named repository checks. The argv is owned by the server: a model names a target and, for
 * `test` only, a path filter. It never supplies a command, flag, or environment, so no check can
 * reach an interpreter flag or a different program than the one listed here.
 */
export const CHECK_TARGET_NAMES = [
	"lint",
	"test",
	"typecheck",
	"webui-build",
	"db-generate",
	"check-all",
] as const;
export type CheckTargetName = (typeof CHECK_TARGET_NAMES)[number];

export const CHECK_TARGET_ARGV: Readonly<Record<CheckTargetName, readonly string[]>> =
	Object.freeze({
		lint: ["bun", "run", "lint"],
		test: ["bun", "test"],
		typecheck: ["bun", "run", "typecheck"],
		"webui-build": ["bun", "run", "--filter", "@tsukaima/web", "build"],
		// Writes generated migration files into the snapshot; like every snapshot run, they are
		// discarded unless the agent reproduces them through a governed edit.
		"db-generate": ["bun", "run", "--filter", "@tsukaima/db", "generate"],
		// The full server gate: version, lint, format, typecheck, and the whole test suite.
		"check-all": ["bun", "run", "check"],
	});

export function isCheckTargetName(value: string): value is CheckTargetName {
	return (CHECK_TARGET_NAMES as readonly string[]).includes(value);
}

export const RESTART_REQUIRED_KEY = "requiresRestart";
