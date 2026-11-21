import { constants } from "node:fs";
import { access as fsAccess, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DefaultResourceLoader,
	detectSupportedImageMimeTypeFromFile,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type BashOperations,
	type EditOperations,
	type ModelRuntime,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { CodingRunner } from "./runner.ts";
import { SandboxUnavailableError, type SandboxExecutor } from "./sandbox.ts";
import { assertSafeWorktreePath } from "./worktree.ts";

/**
 * A native Pi coding-agent workspace runner.
 *
 * Pi owns the agent loop, prompt rendering, tool schemas, and session JSONL persistence. This
 * module only supplies governed implementations behind Pi's own tool operation seams:
 *
 * - `bash` executes one restricted simple command through the configured {@link SandboxExecutor}.
 *   Shell operators, substitution, globs, and redirection are rejected before anything spawns.
 * - `read`, `edit`, and `write` enforce the worktree path allowlist and reject symlink escapes.
 * - `DefaultResourceLoader` is created with project extensions, skills, prompt templates, themes,
 *   and context files disabled, so a worktree cannot inject executable resources. Callers may
 *   append prompt text and add tools, but cannot replace Pi's agent loop or base prompt.
 *
 * The agent loop and model request run in the server process; side effects are governed by the
 * sandbox and allowlists. A deployment that needs OS isolation for the loop itself must run the
 * runner inside its own sandbox. See `PiWorkspaceRunner` for the exact boundary.
 */

/** Tools whose native Pi schemas and prompt contributions are kept. */
export type PiWorkspaceNativeToolName = "bash" | "edit" | "read" | "write";

const NATIVE_TOOL_NAMES: readonly PiWorkspaceNativeToolName[] = Object.freeze([
	"read",
	"bash",
	"edit",
	"write",
]);

/** Built-in names a caller may not shadow with an added tool. */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"bash",
	"edit",
	"find",
	"grep",
	"ls",
	"powershell",
	"read",
	"write",
]);

export const PI_WORKSPACE_DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const PI_WORKSPACE_DEFAULT_TIMEOUT_MS = 120_000;
export const PI_WORKSPACE_DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const PI_WORKSPACE_DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;
export const GOVERNED_SHELL_MAX_COMMAND_LENGTH = 8 * 1024;

export type PiWorkspaceRunnerErrorCode =
	| "already_running"
	| "invalid_config"
	| "invalid_session_file"
	| "not_started";

export class PiWorkspaceRunnerError extends Error {
	readonly code: PiWorkspaceRunnerErrorCode;

	constructor(code: PiWorkspaceRunnerErrorCode, message: string) {
		super(message);
		this.name = "PiWorkspaceRunnerError";
		this.code = code;
	}
}

export class GovernedShellError extends Error {
	constructor(message: string) {
		super(`governed_shell_rejected: ${message}`);
		this.name = "GovernedShellError";
	}
}

export interface PiWorkspaceRunnerConfig {
	/** Absolute worktree the agent works in. It must exist and be a directory. */
	readonly worktreePath: string;
	/** Worktree-relative path prefixes the native file tools may read or modify. */
	readonly pathAllowlist: readonly string[];
	/** Commands the native `bash` tool may run. Always executed as one argv, never through a shell. */
	readonly allowedCommands: readonly string[];
	/**
	 * Isolation provider for model-influenced command execution. The provider is resolved during
	 * `start()`; a provider that cannot isolate fails startup instead of falling back to the host.
	 */
	readonly executor: () => Promise<SandboxExecutor>;
	/**
	 * Require the executor to be OS-isolated. Defaults to true: a host-only backend may read files
	 * outside the worktree and must be opted into explicitly with `false`.
	 */
	readonly requireIsolatedSandbox?: boolean;
	/** Pi model/auth runtime owned by the caller, including credentials and provider configuration. */
	readonly modelRuntime: ModelRuntime;
	readonly model: Model<Api>;
	/** Pi settings/config directory. Must be outside the worktree. */
	readonly agentDir: string;
	/** Session JSONL file. It must be absolute and outside the worktree. */
	readonly sessionFile?: string;
	/** Explicit session manager seam; overrides `sessionFile`. */
	readonly sessionManager?: SessionManager;
	readonly sessionDir?: string;
	/** Extra Pi tools. Names that would shadow a Pi built-in tool are rejected. */
	readonly additionalTools?: readonly ToolDefinition[];
	/** Native tools to expose. Defaults to read, bash, edit, and write. */
	readonly nativeTools?: readonly PiWorkspaceNativeToolName[];
	/** Text appended after Pi's own system prompt. The base prompt is never replaced. */
	readonly appendPrompt?: readonly string[];
	readonly thinkingLevel?: "high" | "low" | "max" | "medium" | "minimal" | "off" | "xhigh";
	/** Repository root. When set, the worktree may not be inside it. */
	readonly repositoryPath?: string;
	/** Worktree root. When set, the worktree must be inside it. */
	readonly worktreeRoot?: string;
	readonly maxOutputBytes?: number;
	readonly timeoutMs?: number;
	readonly maxFileBytes?: number;
	readonly maxWriteBytes?: number;
}

export interface PiWorkspaceRunOptions {
	readonly images?: readonly ImageContent[];
	readonly signal?: AbortSignal;
	readonly streamingBehavior?: "followUp" | "steer";
}

export interface PiWorkspaceRunResult {
	/** True when the run stopped because the caller's signal aborted it. */
	readonly aborted: boolean;
	/** Last assistant text produced in the run, after any tool turns. */
	readonly assistantText: string;
	readonly durationMs: number;
	readonly sessionFile: string | undefined;
	readonly sessionId: string;
	readonly stopReason: string | undefined;
	readonly toolCalls: number;
	readonly toolErrors: number;
}

interface ResolvedRunnerConfig {
	readonly additionalTools: readonly ToolDefinition[];
	readonly agentDir: string;
	readonly allowedCommands: readonly string[];
	readonly appendPrompt: readonly string[];
	readonly maxFileBytes: number;
	readonly maxOutputBytes: number;
	readonly maxWriteBytes: number;
	readonly nativeTools: readonly PiWorkspaceNativeToolName[];
	readonly pathAllowlist: readonly string[];
	readonly timeoutMs: number;
	readonly worktreePath: string;
}

/**
 * One long-lived workspace session.
 *
 * The class is intentionally a single-run surface: call `run()` for a prompt, subscribe to
 * `AgentSessionEvent`s if a UI needs live updates, and call `abort()` or pass an `AbortSignal`
 * to stop the active turn. Concurrent prompts are rejected instead of queued; use separate
 * runner instances for separate workspaces.
 */
export class PiWorkspaceRunner {
	readonly #config: PiWorkspaceRunnerConfig;
	#executor: SandboxExecutor | undefined;
	#session: AgentSession | undefined;
	#activeRun: Promise<PiWorkspaceRunResult> | undefined;
	#abortActiveRun: (() => Promise<void>) | undefined;

	constructor(config: PiWorkspaceRunnerConfig) {
		this.#config = config;
	}

	/** Build the Pi session. This also resolves the sandbox provider, so it fails closed early. */
	async start(): Promise<void> {
		if (this.#session !== undefined) return;
		const resolved = await resolveConfig(this.#config);
		const executor = resolved.nativeTools.includes("bash")
			? await this.#config.executor()
			: undefined;
		if (
			executor !== undefined &&
			(this.#config.requireIsolatedSandbox ?? true) &&
			!executor.isolated
		) {
			throw new SandboxUnavailableError(
				`the configured coding sandbox backend "${executor.id}" runs commands without OS isolation`,
				{ code: "backend_not_isolated" },
			);
		}
		this.#executor = executor;
		const sessionManager = await resolveSessionManager(this.#config, resolved.worktreePath);
		const settingsManager = SettingsManager.create(resolved.worktreePath, resolved.agentDir);
		const resourceLoader = new DefaultResourceLoader({
			agentDir: resolved.agentDir,
			appendSystemPrompt: [...resolved.appendPrompt],
			cwd: resolved.worktreePath,
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			settingsManager,
		});
		await resourceLoader.reload();
		const tools = createNativeToolDefinitions(
			{
				...(executor === undefined
					? {}
					: {
							runner: new CodingRunner({
								allowedCommands: resolved.allowedCommands,
								executor: async () => executor,
								maxOutputBytes: resolved.maxOutputBytes,
								timeoutMs: resolved.timeoutMs,
								worktreePath: resolved.worktreePath,
								writable: true,
							}),
						}),
				maxFileBytes: resolved.maxFileBytes,
				maxWriteBytes: resolved.maxWriteBytes,
				pathAllowlist: resolved.pathAllowlist,
				timeoutMs: resolved.timeoutMs,
				worktreePath: resolved.worktreePath,
			},
			resolved.nativeTools,
		);
		const customTools = [...tools, ...resolved.additionalTools];
		const activeToolNames = [
			...resolved.nativeTools,
			...resolved.additionalTools.map((tool) => tool.name),
		];
		const { session } = await createAgentSession({
			...(this.#config.thinkingLevel === undefined
				? {}
				: { thinkingLevel: this.#config.thinkingLevel }),
			agentDir: resolved.agentDir,
			customTools,
			model: this.#config.model,
			modelRuntime: this.#config.modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			tools: activeToolNames,
		});
		this.#session = session;
	}

	get session(): AgentSession {
		return this.#requireSession();
	}

	get sessionId(): string {
		return this.#requireSession().sessionManager.getSessionId();
	}

	get sessionFile(): string | undefined {
		return this.#requireSession().sessionManager.getSessionFile();
	}

	get systemPrompt(): string {
		return this.#requireSession().systemPrompt;
	}

	get activeToolNames(): readonly string[] {
		return this.#requireSession().getActiveToolNames();
	}

	get sandboxIsolated(): boolean {
		return this.#executor?.isolated ?? false;
	}

	/** Subscribe to Pi's native session events. Returns an unsubscribe function. */
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.#requireSession().subscribe(listener);
	}

	async run(text: string, options: PiWorkspaceRunOptions = {}): Promise<PiWorkspaceRunResult> {
		const session = this.#requireSession();
		if (this.#activeRun !== undefined) {
			throw new PiWorkspaceRunnerError(
				"already_running",
				"A Pi workspace run is already active on this runner",
			);
		}
		const startedAtMs = performance.now();
		const signal = options.signal;
		if (signal?.aborted === true) {
			return {
				aborted: true,
				assistantText: "",
				durationMs: 0,
				sessionFile: session.sessionManager.getSessionFile(),
				sessionId: session.sessionManager.getSessionId(),
				stopReason: "aborted",
				toolCalls: 0,
				toolErrors: 0,
			};
		}
		let assistantText = "";
		let stopReason: string | undefined;
		let toolCalls = 0;
		let toolErrors = 0;
		let settledAborted = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message;
				assistantText = message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
				stopReason = message.stopReason;
			} else if (event.type === "tool_execution_start") {
				toolCalls += 1;
			} else if (event.type === "tool_execution_end") {
				if (event.isError) toolErrors += 1;
			} else if (event.type === "agent_settled") {
				settledAborted = event.aborted;
			}
		});
		const abort = (): void => {
			void session.abort().catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const run = (async (): Promise<PiWorkspaceRunResult> => {
			try {
				await session.prompt(text, {
					...(options.images === undefined ? {} : { images: [...options.images] }),
					...(options.streamingBehavior === undefined
						? {}
						: { streamingBehavior: options.streamingBehavior }),
				});
				return {
					aborted: settledAborted || signal?.aborted === true,
					assistantText,
					durationMs: Math.round(performance.now() - startedAtMs),
					sessionFile: session.sessionManager.getSessionFile(),
					sessionId: session.sessionManager.getSessionId(),
					stopReason,
					toolCalls,
					toolErrors,
				};
			} finally {
				unsubscribe();
				signal?.removeEventListener("abort", abort);
			}
		})();
		this.#activeRun = run;
		this.#abortActiveRun = async () => await session.abort();
		try {
			return await run;
		} finally {
			this.#activeRun = undefined;
			this.#abortActiveRun = undefined;
		}
	}

	/** Abort the active turn, if any. The in-flight `run()` still resolves with its summary. */
	async abort(): Promise<void> {
		const active = this.#activeRun;
		const abort = this.#abortActiveRun;
		if (active === undefined || abort === undefined) return;
		await abort().catch(() => undefined);
	}

	async dispose(): Promise<void> {
		const session = this.#session;
		if (session === undefined) return;
		if (this.#activeRun !== undefined) {
			await session.abort().catch(() => undefined);
		}
		session.dispose();
		this.#session = undefined;
		this.#executor = undefined;
	}

	#requireSession(): AgentSession {
		if (this.#session === undefined) {
			throw new PiWorkspaceRunnerError(
				"not_started",
				"Pi workspace runner must be started before use",
			);
		}
		return this.#session;
	}
}

/** Convenience constructor that validates configuration and creates the session. */
export async function createPiWorkspaceRunner(
	config: PiWorkspaceRunnerConfig,
): Promise<PiWorkspaceRunner> {
	const runner = new PiWorkspaceRunner(config);
	await runner.start();
	return runner;
}

interface NativeToolDependencies {
	readonly runner?: CodingRunner;
	readonly maxFileBytes: number;
	readonly maxWriteBytes: number;
	readonly pathAllowlist: readonly string[];
	readonly timeoutMs: number;
	readonly worktreePath: string;
}

function createNativeToolDefinitions(
	deps: NativeToolDependencies,
	names: readonly PiWorkspaceNativeToolName[],
): ToolDefinition[] {
	const readOperations = createGovernedReadOperations(deps);
	const writeOperations = createGovernedWriteOperations(deps);
	const editOperations: EditOperations = {
		access: async (absolutePath) => {
			await assertPath(deps, absolutePath);
			await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
		},
		readFile: async (absolutePath) => {
			await assertPath(deps, absolutePath);
			return await readFile(await assertExistingFile(deps, absolutePath));
		},
		writeFile: async (absolutePath, content) => {
			await writeGovernedFile(deps, absolutePath, content);
		},
	};
	const definitions: ToolDefinition[] = [];
	for (const name of names) {
		switch (name) {
			case "bash":
				definitions.push(
					asToolDefinition(
						createBashToolDefinition(deps.worktreePath, {
							exposeSessionEnvironment: false,
							operations: createGovernedBashOperations(deps),
						}),
					),
				);
				break;
			case "edit":
				definitions.push(
					asToolDefinition(
						createEditToolDefinition(deps.worktreePath, { operations: editOperations }),
					),
				);
				break;
			case "read":
				definitions.push(
					asToolDefinition(
						createReadToolDefinition(deps.worktreePath, { operations: readOperations }),
					),
				);
				break;
			case "write":
				definitions.push(
					asToolDefinition(
						createWriteToolDefinition(deps.worktreePath, { operations: writeOperations }),
					),
				);
				break;
			default:
				throw new PiWorkspaceRunnerError(
					"invalid_config",
					`Unsupported native Pi tool: ${String(name)}`,
				);
		}
	}
	return definitions;
}

/**
 * Pi declares `customTools` as `ToolDefinition[]` with erased generics, while the native
 * factories return definitions typed for their concrete schemas. The values are shape-compatible
 * at runtime; the cast only reconciles generic invariance across the SDK boundary.
 */
function asToolDefinition(definition: unknown): ToolDefinition {
	return definition as ToolDefinition;
}

function createGovernedReadOperations(deps: NativeToolDependencies): ReadOperations {
	return {
		access: async (absolutePath) => {
			await assertPath(deps, absolutePath);
			await fsAccess(absolutePath, constants.R_OK);
		},
		detectImageMimeType: async (absolutePath) => {
			await assertPath(deps, absolutePath);
			const target = await assertExistingFile(deps, absolutePath);
			return await detectSupportedImageMimeTypeFromFile(target);
		},
		readFile: async (absolutePath) => {
			await assertPath(deps, absolutePath);
			return await readFile(await assertExistingFile(deps, absolutePath));
		},
	};
}

function createGovernedWriteOperations(deps: NativeToolDependencies): WriteOperations {
	return {
		mkdir: async (directoryPath) => {
			const resolved = resolve(directoryPath);
			if (samePath(deps.worktreePath, resolved)) {
				// The worktree root already exists and is never created by a tool; an allowlisted
				// root file such as `package.json` needs its parent to be accepted as a no-op.
				return;
			}
			await assertPath(deps, directoryPath);
			await mkdir(directoryPath, { recursive: true });
		},
		writeFile: async (absolutePath, content) => {
			await writeGovernedFile(deps, absolutePath, content);
		},
	};
}

async function writeGovernedFile(
	deps: NativeToolDependencies,
	absolutePath: string,
	content: string,
): Promise<void> {
	if (Buffer.byteLength(content, "utf-8") > deps.maxWriteBytes) {
		throw new Error(`Write exceeds ${deps.maxWriteBytes} bytes`);
	}
	await assertPath(deps, absolutePath);
	await writeFile(absolutePath, content, "utf-8");
}

async function assertPath(deps: NativeToolDependencies, absolutePath: string): Promise<string> {
	if (!isAbsolute(absolutePath)) {
		throw new Error(`Workspace tool path must be absolute: ${absolutePath}`);
	}
	return await assertSafeWorktreePath(deps.worktreePath, deps.pathAllowlist, absolutePath);
}

async function assertExistingFile(
	deps: NativeToolDependencies,
	absolutePath: string,
): Promise<string> {
	const target = await assertPath(deps, absolutePath);
	const stats = await stat(target);
	if (!stats.isFile()) throw new Error(`Workspace tool path is not a file: ${absolutePath}`);
	if (stats.size > deps.maxFileBytes) {
		throw new Error(`File exceeds ${deps.maxFileBytes} bytes: ${absolutePath}`);
	}
	return target;
}

function createGovernedBashOperations(deps: NativeToolDependencies): BashOperations {
	const runner = deps.runner;
	if (runner === undefined) {
		return {
			exec: async () => {
				throw new GovernedShellError("the sandbox executor is unavailable");
			},
		};
	}
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (!samePath(deps.worktreePath, cwd)) {
				throw new GovernedShellError("command working directory must be the task worktree");
			}
			const parsed = parseGovernedShellCommand(command);
			const requestedMs = timeout === undefined ? undefined : Math.round(timeout * 1000);
			if (requestedMs !== undefined && (!Number.isFinite(requestedMs) || requestedMs <= 0)) {
				throw new Error("Invalid timeout: must be a finite number of seconds");
			}
			const timeoutMs =
				requestedMs === undefined ? deps.timeoutMs : Math.min(requestedMs, deps.timeoutMs);
			const result = await runner.exec(parsed.command, parsed.args, {
				...(signal === undefined ? {} : { signal }),
				timeoutMs,
			});
			if (result.stdout.length > 0) onData(Buffer.from(result.stdout));
			if (result.stderr.length > 0) onData(Buffer.from(result.stderr));
			if (signal?.aborted === true || result.cancelled === true) {
				throw new Error("aborted");
			}
			if (result.timedOut) {
				throw new Error(`timeout:${Math.max(1, Math.round(timeoutMs / 1000))}`);
			}
			if (result.exitCode === null) {
				return { exitCode: result.signal === "SIGKILL" ? 137 : 1 };
			}
			return { exitCode: result.exitCode };
		},
	};
}

export interface GovernedShellCommand {
	readonly args: readonly string[];
	readonly command: string;
	readonly raw: string;
}

const SHELL_METACHARACTERS = new Set([
	"$",
	"&",
	"(",
	")",
	"*",
	"?",
	"[",
	"]",
	"{",
	"}",
	"#",
	";",
	"<",
	">",
	"`",
	"|",
	"~",
]);

/**
 * Parse the intentionally small shell grammar accepted by the governed `bash` tool.
 *
 * The grammar is one simple command: an allowlisted executable followed by literal argv. Quotes
 * group whitespace, and backslash escapes the next character. Command separators, pipelines,
 * redirection, command substitution, variable expansion, globs, brace expansion, comments, and
 * newlines are rejected. The parsed tokens are spawned directly, so no shell ever sees the input.
 */
export function parseGovernedShellCommand(input: string): GovernedShellCommand {
	const raw = input.trim();
	if (raw.length === 0) throw new GovernedShellError("command is empty");
	if (raw.length > GOVERNED_SHELL_MAX_COMMAND_LENGTH) {
		throw new GovernedShellError(`command exceeds ${GOVERNED_SHELL_MAX_COMMAND_LENGTH} characters`);
	}
	if (/[\0\r\n]/u.test(raw))
		throw new GovernedShellError("command contains a line break or null byte");

	const tokens: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < raw.length; index++) {
		const character = raw[index]!;
		if (quote === "'") {
			if (character === "'") {
				quote = undefined;
			} else {
				token += character;
			}
			hasToken = true;
			continue;
		}
		if (quote === '"') {
			if (character === '"') {
				quote = undefined;
			} else if (character === "\\") {
				const next = raw[++index];
				if (next === undefined) throw new GovernedShellError("unterminated escape");
				token += next;
			} else if (character === "$" || character === "`") {
				throw new GovernedShellError("variable and command expansion are not allowed");
			} else {
				token += character;
			}
			hasToken = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			hasToken = true;
			continue;
		}
		if (character === "\\") {
			const next = raw[++index];
			if (next === undefined) throw new GovernedShellError("unterminated escape");
			token += next;
			hasToken = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (hasToken) {
				tokens.push(token);
				token = "";
				hasToken = false;
			}
			continue;
		}
		if (SHELL_METACHARACTERS.has(character)) {
			throw new GovernedShellError(`shell metacharacter "${character}" is not allowed`);
		}
		token += character;
		hasToken = true;
	}
	if (quote !== undefined) throw new GovernedShellError("unterminated quote");
	if (hasToken) tokens.push(token);
	const command = tokens[0];
	if (command === undefined) throw new GovernedShellError("command is empty");
	if (command.includes("/") || command.includes("\\")) {
		throw new GovernedShellError("command must be an allowlisted executable name, not a path");
	}
	return { args: tokens.slice(1), command, raw };
}

async function resolveConfig(config: PiWorkspaceRunnerConfig): Promise<ResolvedRunnerConfig> {
	if (!isAbsolute(config.worktreePath)) {
		throw invalidConfig("worktreePath must be absolute");
	}
	const worktreePath = await realpath(config.worktreePath).catch(() => {
		throw invalidConfig(`worktreePath does not exist: ${config.worktreePath}`);
	});
	const worktreeStats = await stat(worktreePath).catch(() => undefined);
	if (worktreeStats === undefined || !worktreeStats.isDirectory()) {
		throw invalidConfig(`worktreePath is not a directory: ${config.worktreePath}`);
	}
	if (config.repositoryPath !== undefined) {
		const repositoryPath = await realpath(config.repositoryPath).catch(() => {
			throw invalidConfig(`repositoryPath does not exist: ${config.repositoryPath}`);
		});
		if (samePath(repositoryPath, worktreePath) || isInside(repositoryPath, worktreePath)) {
			throw invalidConfig("worktreePath must not be the repository root or inside it");
		}
	}
	if (config.worktreeRoot !== undefined) {
		const worktreeRoot = await realpath(config.worktreeRoot).catch(() => {
			throw invalidConfig(`worktreeRoot does not exist: ${config.worktreeRoot}`);
		});
		if (!isInside(worktreeRoot, worktreePath)) {
			throw invalidConfig("worktreePath must be inside worktreeRoot");
		}
	}
	if (!isAbsolute(config.agentDir)) throw invalidConfig("agentDir must be absolute");
	const agentDir = await realpath(config.agentDir).catch(() => {
		throw invalidConfig(`agentDir does not exist: ${config.agentDir}`);
	});
	if (samePath(worktreePath, agentDir) || isInside(worktreePath, agentDir)) {
		throw invalidConfig("agentDir must be outside the worktree");
	}
	const pathAllowlist = validateAllowlist(config.pathAllowlist);
	const allowedCommands = validateCommands(config.allowedCommands);
	const nativeTools = validateNativeTools(config.nativeTools);
	const additionalTools = validateAdditionalTools(config.additionalTools);
	const maxOutputBytes = config.maxOutputBytes ?? PI_WORKSPACE_DEFAULT_MAX_OUTPUT_BYTES;
	const timeoutMs = config.timeoutMs ?? PI_WORKSPACE_DEFAULT_TIMEOUT_MS;
	const maxFileBytes = config.maxFileBytes ?? PI_WORKSPACE_DEFAULT_MAX_FILE_BYTES;
	const maxWriteBytes = config.maxWriteBytes ?? PI_WORKSPACE_DEFAULT_MAX_WRITE_BYTES;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
		throw invalidConfig("maxOutputBytes must be a positive integer");
	}
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw invalidConfig("timeoutMs must be a positive integer");
	}
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
		throw invalidConfig("maxFileBytes must be a positive integer");
	}
	if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes <= 0) {
		throw invalidConfig("maxWriteBytes must be a positive integer");
	}
	return {
		additionalTools,
		agentDir,
		allowedCommands,
		appendPrompt: [...(config.appendPrompt ?? [])],
		worktreePath,
		maxFileBytes,
		maxOutputBytes,
		maxWriteBytes,
		pathAllowlist,
		nativeTools,
		timeoutMs,
	};
}

async function resolveSessionManager(
	config: PiWorkspaceRunnerConfig,
	worktreePath: string,
): Promise<SessionManager> {
	if (config.sessionManager !== undefined) return config.sessionManager;
	if (config.sessionFile === undefined) {
		throw invalidConfig("sessionFile or sessionManager is required");
	}
	if (!isAbsolute(config.sessionFile)) {
		throw new PiWorkspaceRunnerError(
			"invalid_session_file",
			"sessionFile must be absolute so persistence cannot land inside the worktree",
		);
	}
	const sessionFile = resolve(config.sessionFile);
	const sessionParent = await realpath(dirname(sessionFile)).catch(() => {
		throw new PiWorkspaceRunnerError(
			"invalid_session_file",
			"sessionFile parent directory must exist",
		);
	});
	if (samePath(worktreePath, sessionParent) || isInside(worktreePath, sessionParent)) {
		throw new PiWorkspaceRunnerError(
			"invalid_session_file",
			"sessionFile must be outside the worktree",
		);
	}
	let sessionDir: string | undefined;
	if (config.sessionDir !== undefined) {
		if (!isAbsolute(config.sessionDir)) {
			throw new PiWorkspaceRunnerError("invalid_session_file", "sessionDir must be absolute");
		}
		sessionDir = await realpath(config.sessionDir).catch(() => {
			throw new PiWorkspaceRunnerError("invalid_session_file", "sessionDir must exist");
		});
		if (samePath(worktreePath, sessionDir) || isInside(worktreePath, sessionDir)) {
			throw new PiWorkspaceRunnerError(
				"invalid_session_file",
				"sessionDir must be outside the worktree",
			);
		}
	}
	return SessionManager.open(sessionFile, sessionDir, worktreePath);
}

function validateAllowlist(entries: readonly string[]): readonly string[] {
	if (entries.length === 0) throw invalidConfig("pathAllowlist must not be empty");
	const unique = new Set<string>();
	for (const entry of entries) {
		const normalized = entry.replace(/\/+$/u, "");
		if (normalized.length === 0 || normalized === ".") {
			throw invalidConfig(`pathAllowlist entry is invalid: ${entry}`);
		}
		if (normalized.includes("\0") || isAbsolute(normalized) || normalized.startsWith("..")) {
			throw invalidConfig(`pathAllowlist entry must be worktree-relative: ${entry}`);
		}
		if (normalized.split(/[\\/]/u).includes("..")) {
			throw invalidConfig(`pathAllowlist entry must not traverse: ${entry}`);
		}
		unique.add(normalized);
	}
	return [...unique];
}

function validateCommands(entries: readonly string[]): readonly string[] {
	if (entries.length === 0) throw invalidConfig("allowedCommands must not be empty");
	const unique = new Set<string>();
	for (const entry of entries) {
		if (entry.length === 0 || entry.includes("\0") || entry.includes("/") || entry.includes("\\")) {
			throw invalidConfig(`allowedCommands entry is invalid: ${entry}`);
		}
		unique.add(entry);
	}
	return [...unique];
}

function validateNativeTools(
	entries: readonly PiWorkspaceNativeToolName[] | undefined,
): readonly PiWorkspaceNativeToolName[] {
	const names = entries ?? NATIVE_TOOL_NAMES;
	if (names.length === 0) throw invalidConfig("nativeTools must not be empty");
	const unique = new Set<PiWorkspaceNativeToolName>();
	for (const name of names) {
		if (!NATIVE_TOOL_NAMES.includes(name)) {
			throw invalidConfig(`unsupported native tool: ${String(name)}`);
		}
		unique.add(name);
	}
	return [...unique];
}

function validateAdditionalTools(
	entries: readonly ToolDefinition[] | undefined,
): readonly ToolDefinition[] {
	if (entries === undefined) return [];
	const names = new Set<string>();
	for (const tool of entries) {
		if (tool.name.length === 0 || tool.name.includes("\0")) {
			throw invalidConfig("additional tool names must be non-empty");
		}
		if (RESERVED_TOOL_NAMES.has(tool.name)) {
			throw invalidConfig(`additional tool may not shadow the Pi built-in tool: ${tool.name}`);
		}
		if (names.has(tool.name)) {
			throw invalidConfig(`duplicate additional tool name: ${tool.name}`);
		}
		names.add(tool.name);
	}
	return entries;
}

function invalidConfig(message: string): PiWorkspaceRunnerError {
	return new PiWorkspaceRunnerError("invalid_config", message);
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function samePath(left: string, right: string): boolean {
	return relative(resolve(left), resolve(right)) === "";
}
