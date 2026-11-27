import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STDERR_LIMIT_BYTES = 32 * 1024;
const DEFAULT_PROTOCOL_VERSION = 1;
const CLOSE_GRACE_MS = 100;
const KILL_GRACE_MS = 500;

const DEFAULT_SPAWN_ENV: Readonly<Record<string, string>> = {
	LANG: process.env.LANG ?? "C.UTF-8",
	PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
	TZ: process.env.TZ ?? "UTC",
};

export type AcpJsonRpcId = string | number;

export interface AcpTextContentBlock {
	readonly type: "text";
	readonly text: string;
}

export interface AcpImageContentBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
	readonly uri?: string;
}

export interface AcpAudioContentBlock {
	readonly type: "audio";
	readonly data: string;
	readonly mimeType: string;
}

export interface AcpEmbeddedResource {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	readonly blob?: string;
}

export interface AcpResourceContentBlock {
	readonly type: "resource";
	readonly resource: AcpEmbeddedResource;
}

export interface AcpResourceLinkContentBlock {
	readonly type: "resource_link";
	readonly uri: string;
	readonly name?: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly size?: number;
}

export type AcpContentBlock =
	| AcpTextContentBlock
	| AcpImageContentBlock
	| AcpAudioContentBlock
	| AcpResourceContentBlock
	| AcpResourceLinkContentBlock;

export type AcpConfigValue = string | boolean | number;

export interface AcpConfigOptionChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string;
}

export interface AcpConfigOption {
	readonly id: string;
	readonly name: string;
	readonly category?: string;
	readonly type?: string;
	readonly currentValue?: AcpConfigValue;
	readonly options?: readonly AcpConfigOptionChoice[];
}

export interface AcpAvailableCommand {
	readonly name: string;
	readonly description?: string;
	readonly input?: unknown;
}

export type AcpSessionUpdateKind =
	| "agent_message_chunk"
	| "agent_thought_chunk"
	| "tool_call"
	| "tool_call_update"
	| "available_commands_update"
	| "config_option_update"
	| (string & {});

/**
 * One `session/update` payload. Known update kinds get typed fields, while the index signature
 * preserves newer or agent-specific fields without discarding them.
 */
export interface AcpSessionUpdate {
	readonly sessionUpdate: AcpSessionUpdateKind;
	readonly sessionId?: string;
	readonly content?: AcpContentBlock | readonly AcpContentBlock[];
	readonly text?: string;
	readonly messageId?: string;
	readonly toolCallId?: string;
	readonly name?: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly rawInput?: unknown;
	readonly rawOutput?: unknown;
	readonly output?: unknown;
	readonly availableCommands?: readonly AcpAvailableCommand[];
	readonly configOptions?: readonly AcpConfigOption[];
	readonly [key: string]: unknown;
}

export type AcpSessionUpdateListener = (update: AcpSessionUpdate) => void | Promise<void>;

export interface AcpToolCall {
	readonly toolCallId: string;
	readonly title?: string;
	readonly kind?: string;
	readonly status?: string;
	readonly content?: readonly AcpContentBlock[];
	readonly rawInput?: unknown;
	readonly rawOutput?: unknown;
	readonly output?: unknown;
	readonly [key: string]: unknown;
}

export interface AcpPermissionOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind?: string;
}

export interface AcpPermissionRequest {
	readonly sessionId: string;
	readonly toolCall: AcpToolCall;
	readonly options: readonly AcpPermissionOption[];
}

export interface AcpPermissionDecision {
	readonly outcome: "selected" | "cancelled";
	readonly optionId?: string;
}

export type AcpPermissionOutcome =
	| { readonly outcome: "selected"; readonly optionId: string }
	| { readonly outcome: "cancelled" };

export interface AcpPermissionResponse {
	readonly outcome: AcpPermissionOutcome;
}

export interface AcpFsReadTextFileRequest {
	readonly sessionId: string;
	readonly path: string;
	readonly line?: number;
	readonly limit?: number;
}

export interface AcpFsReadTextFileResult {
	readonly content: string;
}

export interface AcpFsWriteTextFileRequest {
	readonly sessionId: string;
	readonly path: string;
	readonly content: string;
}

export interface AcpEnvVariable {
	readonly name: string;
	readonly value: string;
}

export interface AcpTerminalExitStatus {
	readonly exitCode?: number | null;
	readonly signal?: string | null;
}

export interface AcpTerminalCreateParams {
	readonly sessionId: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: readonly AcpEnvVariable[];
	readonly outputByteLimit?: number;
}

export interface AcpTerminalOutputParams {
	readonly sessionId: string;
	readonly terminalId: string;
}

export interface AcpTerminalOutputResult {
	readonly output: string;
	readonly truncated: boolean;
	readonly exitStatus?: AcpTerminalExitStatus;
}

export type AcpTerminalRequest =
	| { readonly method: "terminal/create"; readonly params: AcpTerminalCreateParams }
	| { readonly method: "terminal/output"; readonly params: AcpTerminalOutputParams }
	| {
			readonly method: "terminal/wait_for_exit";
			readonly params: AcpTerminalOutputParams;
	  }
	| { readonly method: "terminal/kill"; readonly params: AcpTerminalOutputParams }
	| { readonly method: "terminal/release"; readonly params: AcpTerminalOutputParams };

export type AcpTerminalMethod = AcpTerminalRequest["method"];

export interface AcpClientInfo {
	readonly name: string;
	readonly version?: string;
	readonly title?: string;
}

export interface AcpServerCapabilities {
	readonly loadSession?: boolean;
	readonly promptCapabilities?: {
		readonly image?: boolean;
		readonly audio?: boolean;
		readonly embeddedContext?: boolean;
		readonly [key: string]: unknown;
	};
	readonly mcpCapabilities?: {
		readonly http?: boolean;
		readonly sse?: boolean;
		readonly [key: string]: unknown;
	};
	readonly sessionCapabilities?: {
		readonly [key: string]: unknown;
	};
	readonly [key: string]: unknown;
}

export interface AcpInitializeResult {
	readonly protocolVersion: number;
	readonly agentCapabilities?: AcpServerCapabilities;
	readonly agentInfo?: AcpClientInfo;
	readonly authMethods?: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface AcpModelInfo {
	readonly id: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AcpLegacyModel {
	readonly modelId: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AcpLegacyModels {
	readonly currentModelId?: string;
	readonly availableModels?: readonly AcpLegacyModel[];
	readonly [key: string]: unknown;
}

export interface AcpNewSessionResult {
	readonly sessionId: string;
	readonly configOptions?: readonly AcpConfigOption[];
	readonly models?: AcpLegacyModels;
	readonly availableModels: readonly AcpModelInfo[];
	readonly [key: string]: unknown;
}

export interface AcpNewSessionInput {
	readonly cwd: string;
	readonly mcpServers?: readonly AcpMcpServerConfig[];
}

export interface AcpSetConfigOptionInput {
	readonly sessionId: string;
	readonly configId: string;
	readonly value: AcpConfigValue;
}

export interface AcpSetConfigOptionResult {
	readonly configOptions?: readonly AcpConfigOption[];
	readonly [key: string]: unknown;
}

export interface AcpSetModelInput {
	readonly sessionId: string;
	readonly modelId: string;
}

export interface AcpPromptInput {
	readonly sessionId: string;
	readonly prompt: readonly AcpContentBlock[];
	readonly onUpdate?: AcpSessionUpdateListener;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface AcpPromptResult {
	readonly stopReason?: string;
	readonly usage?: unknown;
	readonly [key: string]: unknown;
}

export interface AcpMcpStdioServerConfig {
	readonly name: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>> | readonly AcpEnvVariable[];
	readonly type?: "stdio";
}

export interface AcpMcpHttpServerConfig {
	readonly name: string;
	readonly type: "http" | "sse";
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>> | readonly AcpEnvVariable[];
}

export type AcpMcpServerConfig = AcpMcpStdioServerConfig | AcpMcpHttpServerConfig;

export interface AcpClientHandlers {
	readonly onPermissionRequest?: (
		request: AcpPermissionRequest,
	) => AcpPermissionDecision | Promise<AcpPermissionDecision>;
	readonly onFsRead?: (
		request: AcpFsReadTextFileRequest,
	) => AcpFsReadTextFileResult | Promise<AcpFsReadTextFileResult>;
	readonly onFsWrite?: (request: AcpFsWriteTextFileRequest) => void | Promise<void>;
	readonly onTerminal?: (request: AcpTerminalRequest) => unknown | Promise<unknown>;
}

export interface AcpClientOptions {
	readonly handlers?: AcpClientHandlers;
	readonly requestTimeoutMs?: number;
	readonly protocolVersion?: number;
	readonly stderrLimitBytes?: number;
}

export interface AcpSpawnTransportOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
}

export interface AcpStreamTransportOptions {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr?: Readable;
	readonly kill?: (signal: "SIGTERM" | "SIGKILL") => void;
}

export type AcpStdioOptions = AcpClientOptions &
	(AcpSpawnTransportOptions | AcpStreamTransportOptions);

export interface AcpRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "AcpRpcError";
		this.code = code;
		this.data = data;
	}
}

export class AcpProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AcpProtocolError";
	}
}

export class AcpClientClosedError extends Error {
	constructor() {
		super("ACP client is closed");
		this.name = "AcpClientClosedError";
	}
}

export class AcpAbortError extends Error {
	readonly sessionId: string | undefined;

	constructor(sessionId?: string) {
		super("ACP request was aborted");
		this.name = "AbortError";
		this.sessionId = sessionId;
	}
}

export class AcpRequestTimeoutError extends Error {
	readonly method: string;
	readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number) {
		super(`ACP request "${method}" timed out after ${timeoutMs}ms`);
		this.name = "AcpRequestTimeoutError";
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

export class AcpProcessExitError extends Error {
	readonly exitCode: number | null;
	readonly signal: string | null;

	constructor(exitCode: number | null, signal: string | null) {
		super(
			exitCode === null && signal === null
				? "ACP transport closed"
				: `ACP process exited (code ${exitCode ?? "none"}, signal ${signal ?? "none"})`,
		);
		this.name = "AcpProcessExitError";
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

interface PendingRequest {
	readonly method: string;
	readonly settle: () => boolean;
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: unknown) => void;
}

interface InternalRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly sessionId?: string;
	readonly onAbort?: () => void;
}

interface SessionState {
	configOptions: readonly AcpConfigOption[];
}

/**
 * JSON-RPC 2.0 client for an ACP agent speaking line-delimited JSON over stdio.
 *
 * Construct it through `connectAcpStdio` or directly with `AcpClientOptions`. Inbound filesystem,
 * terminal, and permission requests are denied unless explicit handlers are installed.
 */
export class AcpClient {
	readonly #handlers: AcpClientHandlers;
	readonly #requestTimeoutMs: number;
	readonly #protocolVersion: number;
	readonly #stderrLimitBytes: number;
	readonly #stdin: Writable;
	readonly #pending = new Map<AcpJsonRpcId, PendingRequest>();
	readonly #sessionHandlers = new Map<string, AcpClientHandlers>();
	readonly #sessionListeners = new Map<string, Set<AcpSessionUpdateListener>>();
	readonly #sessions = new Map<string, SessionState>();
	readonly #streamKill: ((signal: "SIGTERM" | "SIGKILL") => void) | undefined;
	readonly #child: ChildProcessWithoutNullStreams | undefined;
	readonly #exitPromise: Promise<void> | undefined;
	#reader: Interface | undefined;
	#stderrChunks: Buffer[] = [];
	#stderrBytes = 0;
	#nextRequestId = 1;
	#childExited = false;
	#closing = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: AcpStdioOptions) {
		this.#handlers = options.handlers ?? {};
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
		this.#stderrLimitBytes = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;

		if (isStreamTransport(options)) {
			this.#stdin = options.stdin;
			this.#streamKill = options.kill;
			this.#child = undefined;
			this.#exitPromise = undefined;
			this.#attachOutput(options.stdout, options.stderr);
			return;
		}

		const child = spawn(options.command, [...(options.args ?? [])], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			detached: process.platform !== "win32",
			env: { ...DEFAULT_SPAWN_ENV, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.#stdin = child.stdin;
		this.#streamKill = undefined;
		this.#child = child;
		this.#exitPromise = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		this.#attachOutput(child.stdout, child.stderr);
		child.once("error", () => {
			this.#childExited = true;
			this.#failPending(new AcpProcessExitError(null, null));
		});
		child.once("exit", (exitCode, signal) => {
			this.#childExited = true;
			if (!this.#closing) {
				this.#failPending(new AcpProcessExitError(exitCode, signal));
			}
		});
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Last bytes written to agent stderr, bounded for diagnostics. Callers must redact before logging. */
	getStderr(): string {
		return Buffer.concat(this.#stderrChunks).toString("utf8");
	}

	/** Binds or clears permission, filesystem, and terminal handlers scoped to one ACP session. */
	setSessionHandlers(sessionId: string, handlers: AcpClientHandlers | undefined): void {
		if (handlers === undefined) {
			this.#sessionHandlers.delete(sessionId);
			return;
		}
		this.#sessionHandlers.set(sessionId, handlers);
	}

	async initialize(
		clientInfo?: AcpClientInfo,
		options: AcpRequestOptions = {},
	): Promise<AcpInitializeResult> {
		const params = {
			protocolVersion: this.#protocolVersion,
			clientCapabilities: {
				fs: {
					readTextFile: this.#handlers.onFsRead !== undefined,
					writeTextFile: this.#handlers.onFsWrite !== undefined,
				},
				terminal: this.#handlers.onTerminal !== undefined,
			},
			...(clientInfo === undefined ? {} : { clientInfo }),
		};
		const result = await this.#request<unknown>("initialize", params, toInternalOptions(options));
		if (!isRecord(result) || typeof result.protocolVersion !== "number") {
			throw new AcpProtocolError("ACP initialize response is missing protocolVersion");
		}
		return result as unknown as AcpInitializeResult;
	}

	async newSession(
		input: AcpNewSessionInput,
		options: AcpRequestOptions = {},
	): Promise<AcpNewSessionResult> {
		const params = {
			cwd: input.cwd,
			mcpServers: encodeMcpServers(input.mcpServers ?? []),
		};
		const result = await this.#request<unknown>("session/new", params, toInternalOptions(options));
		if (!isRecord(result) || typeof result.sessionId !== "string") {
			throw new AcpProtocolError("ACP session/new response is missing sessionId");
		}
		const configOptions = parseConfigOptions(result.configOptions);
		const availableModels = normalizeAvailableModels(result, configOptions);
		this.#sessions.set(result.sessionId, { configOptions });
		return {
			...result,
			sessionId: result.sessionId,
			...(configOptions.length === 0 ? {} : { configOptions }),
			availableModels,
		} as AcpNewSessionResult;
	}

	async setConfigOption(
		input: AcpSetConfigOptionInput,
		options: AcpRequestOptions = {},
	): Promise<AcpSetConfigOptionResult> {
		const result = await this.#request<unknown>(
			"session/set_config_option",
			{
				sessionId: input.sessionId,
				configId: input.configId,
				value: input.value,
			},
			toInternalOptions(options),
		);
		const configOptions = isRecord(result) ? parseConfigOptions(result.configOptions) : [];
		if (configOptions.length > 0) {
			this.#sessions.set(input.sessionId, { configOptions });
		}
		return {
			...(isRecord(result) ? result : {}),
			...(configOptions.length === 0 ? {} : { configOptions }),
		};
	}

	/**
	 * Selects a model through the ACP config option when the session advertises one, then falls
	 * back to the legacy `session/set_model` request.
	 */
	async setModel(input: AcpSetModelInput, options: AcpRequestOptions = {}): Promise<void> {
		const session = this.#sessions.get(input.sessionId);
		const modelOption =
			session === undefined ? undefined : findModelConfigOption(session.configOptions);
		if (modelOption !== undefined) {
			try {
				await this.setConfigOption(
					{
						sessionId: input.sessionId,
						configId: modelOption.id,
						value: input.modelId,
					},
					options,
				);
				return;
			} catch {
				// Agents can advertise a model selector yet still require the legacy request.
			}
		}
		await this.#request<unknown>(
			"session/set_model",
			{ sessionId: input.sessionId, modelId: input.modelId },
			toInternalOptions(options),
		);
	}

	async prompt(input: AcpPromptInput): Promise<AcpPromptResult> {
		const listeners = this.#sessionListeners.get(input.sessionId) ?? new Set();
		const listener = input.onUpdate;
		if (listener !== undefined) {
			listeners.add(listener);
			this.#sessionListeners.set(input.sessionId, listeners);
		}
		try {
			const result = await this.#request<unknown>(
				"session/prompt",
				{ sessionId: input.sessionId, prompt: input.prompt },
				{
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
					sessionId: input.sessionId,
					onAbort: () => {
						this.#notify("session/cancel", { sessionId: input.sessionId });
					},
				},
			);
			return parsePromptResult(result);
		} finally {
			if (listener !== undefined) {
				listeners.delete(listener);
				if (listeners.size === 0) {
					this.#sessionListeners.delete(input.sessionId);
				}
			}
		}
	}

	async close(): Promise<void> {
		this.#closePromise ??= this.#closeInternal();
		return this.#closePromise;
	}

	async #closeInternal(): Promise<void> {
		if (this.#closed) return;
		this.#closing = true;
		this.#failPending(new AcpClientClosedError());
		await this.#endInput();

		if (this.#child !== undefined) {
			await this.#waitForExit(CLOSE_GRACE_MS);
			if (!this.#childExited) {
				this.#signalTree("SIGTERM");
				await this.#waitForExit(KILL_GRACE_MS);
			}
			if (!this.#childExited) {
				this.#signalTree("SIGKILL");
				await this.#waitForExit(KILL_GRACE_MS);
			}
		} else if (this.#streamKill !== undefined) {
			try {
				this.#streamKill("SIGTERM");
			} catch {
				// The attached transport may already be gone.
			}
			await delay(CLOSE_GRACE_MS);
			try {
				this.#streamKill("SIGKILL");
			} catch {
				// The attached transport may already be gone.
			}
		}

		this.#reader?.close();
		this.#closed = true;
	}

	#attachOutput(stdout: Readable, stderr: Readable | undefined): void {
		const reader = createInterface({
			crlfDelay: Number.POSITIVE_INFINITY,
			input: stdout,
			terminal: false,
		});
		this.#reader = reader;
		reader.on("line", (line) => this.#handleLine(line));
		reader.on("close", () => {
			if (!this.#closing && !this.#closed) {
				this.#failPending(new AcpProcessExitError(null, null));
			}
		});
		reader.on("error", () => {
			if (!this.#closing && !this.#closed) {
				this.#failPending(new AcpProcessExitError(null, null));
			}
		});
		stdout.on("error", () => {
			if (!this.#closing && !this.#closed) {
				this.#failPending(new AcpProcessExitError(null, null));
			}
		});
		if (stderr !== undefined) {
			stderr.on("data", (chunk: Buffer | string) => this.#appendStderr(chunk));
			stderr.on("error", () => {});
		}
	}

	#appendStderr(chunk: Buffer | string): void {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		this.#stderrChunks.push(buffer);
		this.#stderrBytes += buffer.length;
		while (this.#stderrBytes > this.#stderrLimitBytes && this.#stderrChunks.length > 0) {
			const first = this.#stderrChunks[0];
			if (first === undefined) break;
			const overflow = this.#stderrBytes - this.#stderrLimitBytes;
			if (first.length <= overflow) {
				this.#stderrChunks.shift();
				this.#stderrBytes -= first.length;
			} else {
				this.#stderrChunks[0] = first.subarray(overflow);
				this.#stderrBytes -= overflow;
			}
		}
	}

	#handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;

		const method = readString(parsed.method);
		if (method !== undefined) {
			const params = parsed.params;
			const id = readJsonRpcId(parsed.id);
			if (id !== undefined) {
				void this.#handleInboundRequest(id, method, params);
			} else {
				this.#handleNotification(method, params);
			}
			return;
		}

		const id = readJsonRpcId(parsed.id);
		if (id === undefined) return;
		const pending = this.#pending.get(id);
		if (pending === undefined || !pending.settle()) return;
		if (parsed.error !== undefined) {
			pending.reject(parseRpcError(parsed.error));
		} else {
			pending.resolve(parsed.result);
		}
	}

	#handleNotification(method: string, params: unknown): void {
		if (method !== "session/update" || !isRecord(params)) return;
		const update = params.update;
		if (!isRecord(update)) return;
		const sessionId = readString(params.sessionId) ?? readString(update.sessionId);
		if (sessionId === undefined) return;

		const parsedUpdate = update as AcpSessionUpdate;
		if (
			parsedUpdate.sessionUpdate === "config_option_update" &&
			Array.isArray(parsedUpdate.configOptions)
		) {
			const configOptions = parseConfigOptions(parsedUpdate.configOptions);
			if (configOptions.length > 0) {
				this.#sessions.set(sessionId, { configOptions });
			}
		}

		const listeners = this.#sessionListeners.get(sessionId);
		if (listeners === undefined) return;
		for (const listener of listeners) {
			try {
				void Promise.resolve(listener(parsedUpdate)).catch(() => {});
			} catch {
				// A UI callback must not break protocol processing.
			}
		}
	}

	async #handleInboundRequest(id: AcpJsonRpcId, method: string, params: unknown): Promise<void> {
		try {
			const result = await this.#dispatchInboundRequest(method, params);
			this.#sendResponse(id, result);
		} catch (error) {
			const rpcError =
				error instanceof AcpRpcError ? error : new AcpRpcError(-32603, "ACP client handler failed");
			this.#sendError(id, rpcError);
		}
	}

	async #dispatchInboundRequest(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "session/request_permission":
				return await this.#requestPermission(params);
			case "fs/read_text_file":
				return await this.#readTextFile(params);
			case "fs/write_text_file":
				return await this.#writeTextFile(params);
			case "terminal/create":
			case "terminal/output":
			case "terminal/wait_for_exit":
			case "terminal/kill":
			case "terminal/release":
				return await this.#handleTerminal(method, params);
			default:
				throw new AcpRpcError(-32601, `Method not found: ${method}`);
		}
	}

	async #requestPermission(params: unknown): Promise<AcpPermissionResponse> {
		const request = parsePermissionRequest(params);
		const handler =
			this.#sessionHandlers.get(request.sessionId)?.onPermissionRequest ??
			this.#handlers.onPermissionRequest;
		if (handler === undefined) return cancelledPermission();

		let decision: AcpPermissionDecision;
		try {
			decision = await handler(request);
		} catch {
			return cancelledPermission();
		}
		if (
			!isRecord(decision) ||
			decision.outcome !== "selected" ||
			decision.optionId === undefined ||
			!request.options.some((option) => option.optionId === decision.optionId)
		) {
			return cancelledPermission();
		}
		return {
			outcome: { outcome: "selected", optionId: decision.optionId },
		};
	}

	async #readTextFile(params: unknown): Promise<AcpFsReadTextFileResult> {
		const request = parseFsReadRequest(params);
		const handler =
			this.#sessionHandlers.get(request.sessionId)?.onFsRead ?? this.#handlers.onFsRead;
		if (handler === undefined) {
			throw new AcpRpcError(-32601, "Filesystem read access is not enabled");
		}
		const result = await handler(request);
		if (!isRecord(result) || typeof result.content !== "string") {
			throw new AcpRpcError(-32603, "Filesystem read handler returned invalid content");
		}
		return { content: result.content };
	}

	async #writeTextFile(params: unknown): Promise<null> {
		const request = parseFsWriteRequest(params);
		const handler =
			this.#sessionHandlers.get(request.sessionId)?.onFsWrite ?? this.#handlers.onFsWrite;
		if (handler === undefined) {
			throw new AcpRpcError(-32601, "Filesystem write access is not enabled");
		}
		await handler(request);
		return null;
	}

	async #handleTerminal(method: AcpTerminalMethod, params: unknown): Promise<unknown> {
		const request = parseTerminalRequest(method, params);
		const handler =
			this.#sessionHandlers.get(request.params.sessionId)?.onTerminal ?? this.#handlers.onTerminal;
		if (handler === undefined) {
			throw new AcpRpcError(-32601, "Terminal access is not enabled");
		}
		return (await handler(request)) ?? null;
	}

	#request<T>(method: string, params: unknown, options: InternalRequestOptions): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.#closed || this.#closing) {
				reject(new AcpClientClosedError());
				return;
			}
			if (options.signal?.aborted === true) {
				reject(new AcpAbortError(options.sessionId));
				return;
			}

			const id = this.#nextRequestId++;
			const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			let removeAbort: (() => void) | undefined;
			const settle = (): boolean => {
				if (settled) return false;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				removeAbort?.();
				this.#pending.delete(id);
				return true;
			};
			const pending: PendingRequest = {
				method,
				settle,
				resolve: (value) => resolve(value as T),
				reject,
			};
			this.#pending.set(id, pending);

			timer = setTimeout(() => {
				if (!pending.settle()) return;
				pending.reject(new AcpRequestTimeoutError(method, timeoutMs));
			}, timeoutMs);

			if (options.signal !== undefined) {
				const onAbort = (): void => {
					if (!pending.settle()) return;
					try {
						options.onAbort?.();
					} catch {
						// Cancellation is best-effort; the local request still settles.
					}
					pending.reject(new AcpAbortError(options.sessionId));
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
				if (options.signal.aborted) {
					onAbort();
					return;
				}
			}

			try {
				this.#send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				if (pending.settle()) pending.reject(error);
			}
		});
	}

	#sendResponse(id: AcpJsonRpcId, result: unknown): void {
		try {
			this.#send({ jsonrpc: "2.0", id, result: result ?? null });
		} catch {
			// The transport closed while a handler was running.
		}
	}

	#sendError(id: AcpJsonRpcId, error: AcpRpcError): void {
		try {
			this.#send({
				jsonrpc: "2.0",
				id,
				error: {
					code: error.code,
					message: error.message,
					...(error.data === undefined ? {} : { data: error.data }),
				},
			});
		} catch {
			// The transport closed while an inbound request was running.
		}
	}

	#notify(method: string, params: unknown): void {
		try {
			this.#send({ jsonrpc: "2.0", method, params });
		} catch {
			// Best-effort notifications are dropped after close.
		}
	}

	#send(message: Record<string, unknown>): void {
		if (this.#closed || this.#closing) throw new AcpClientClosedError();
		if (this.#stdin.destroyed || this.#stdin.writableEnded) {
			throw new AcpClientClosedError();
		}
		this.#stdin.write(`${JSON.stringify(message)}\n`, "utf8");
	}

	#failPending(error: Error): void {
		for (const pending of Array.from(this.#pending.values())) {
			if (pending.settle()) pending.reject(error);
		}
	}

	#signalTree(signal: "SIGTERM" | "SIGKILL"): void {
		const child = this.#child;
		if (child === undefined || this.#childExited) return;
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch {
				// The process group already exited; try the child handle.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// The child is already gone.
		}
	}

	async #waitForExit(timeoutMs: number): Promise<void> {
		if (this.#childExited || this.#exitPromise === undefined) return;
		await Promise.race([this.#exitPromise, delay(timeoutMs)]);
	}

	async #endInput(): Promise<void> {
		await new Promise<void>((resolve) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(finish, CLOSE_GRACE_MS);
			try {
				if (this.#stdin.destroyed || this.#stdin.writableEnded) {
					finish();
				} else {
					this.#stdin.end(() => finish());
				}
			} catch {
				finish();
			}
		});
	}
}

export function connectAcpStdio(options: AcpStdioOptions): AcpClient {
	return new AcpClient(options);
}

function isStreamTransport(
	options: AcpStdioOptions,
): options is AcpClientOptions & AcpStreamTransportOptions {
	return "stdout" in options;
}

function toInternalOptions(options: AcpRequestOptions): InternalRequestOptions {
	return {
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	};
}

function cancelledPermission(): AcpPermissionResponse {
	return { outcome: { outcome: "cancelled" } };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJsonRpcId(value: unknown): AcpJsonRpcId | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!isRecord(value)) throw new AcpRpcError(-32602, message);
	return value;
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new AcpRpcError(-32602, message);
	}
	return value;
}

function parseRpcError(value: unknown): AcpRpcError {
	if (!isRecord(value)) {
		return new AcpRpcError(-32603, "ACP request failed");
	}
	const code = readNumber(value.code) ?? -32603;
	const message = readString(value.message) ?? "ACP request failed";
	return new AcpRpcError(code, message, value.data);
}

function parseConfigOptions(value: unknown): readonly AcpConfigOption[] {
	if (!Array.isArray(value)) return [];
	const options: AcpConfigOption[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const id = readString(entry.id);
		if (id === undefined || id.length === 0) continue;
		const currentValue = parseConfigValue(entry.currentValue);
		const choices = parseConfigChoices(entry.options);
		const name = readString(entry.name) ?? id;
		const category = readString(entry.category);
		const type = readString(entry.type);
		options.push({
			id,
			name,
			...(category === undefined ? {} : { category }),
			...(type === undefined ? {} : { type }),
			...(currentValue === undefined ? {} : { currentValue }),
			...(choices === undefined ? {} : { options: choices }),
		});
	}
	return options;
}

function parseConfigValue(value: unknown): AcpConfigValue | undefined {
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function parseConfigChoices(value: unknown): readonly AcpConfigOptionChoice[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const choices: AcpConfigOptionChoice[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const rawValue = entry.value;
		const choiceValue =
			typeof rawValue === "string"
				? rawValue
				: typeof rawValue === "number" || typeof rawValue === "boolean"
					? String(rawValue)
					: undefined;
		if (choiceValue === undefined) continue;
		const name = readString(entry.name) ?? choiceValue;
		const description = readString(entry.description);
		choices.push({
			value: choiceValue,
			name,
			...(description === undefined ? {} : { description }),
		});
	}
	return choices.length === 0 ? undefined : choices;
}

function normalizeAvailableModels(
	raw: Record<string, unknown>,
	configOptions: readonly AcpConfigOption[],
): readonly AcpModelInfo[] {
	const models: AcpModelInfo[] = [];
	const seen = new Set<string>();
	const push = (model: AcpModelInfo | undefined): void => {
		if (model === undefined || seen.has(model.id)) return;
		seen.add(model.id);
		models.push(model);
	};

	const modelOption = findModelConfigOption(configOptions);
	for (const choice of modelOption?.options ?? []) {
		push({
			id: choice.value,
			name: choice.name,
			...(choice.description === undefined ? {} : { description: choice.description }),
		});
	}

	const legacy = isRecord(raw.models) ? raw.models : undefined;
	const legacyModels = legacy?.availableModels;
	if (Array.isArray(legacyModels)) {
		for (const entry of legacyModels) push(parseModelInfo(entry));
	}
	if (Array.isArray(raw.availableModels)) {
		for (const entry of raw.availableModels) push(parseModelInfo(entry));
	}

	return models;
}

function parseModelInfo(value: unknown): AcpModelInfo | undefined {
	if (typeof value === "string" && value.length > 0) return { id: value };
	if (!isRecord(value)) return undefined;
	const id = readString(value.id) ?? readString(value.modelId);
	if (id === undefined || id.length === 0) return undefined;
	const name = readString(value.name);
	const description = readString(value.description);
	return {
		id,
		...(name === undefined ? {} : { name }),
		...(description === undefined ? {} : { description }),
	};
}

function findModelConfigOption(
	configOptions: readonly AcpConfigOption[],
): AcpConfigOption | undefined {
	return (
		configOptions.find((option) => option.id === "model") ??
		configOptions.find((option) => option.category === "model")
	);
}

function parsePromptResult(value: unknown): AcpPromptResult {
	if (!isRecord(value)) {
		throw new AcpProtocolError("ACP session/prompt response is not an object");
	}
	const stopReason = readString(value.stopReason);
	return {
		...value,
		...(stopReason === undefined ? {} : { stopReason }),
	};
}

function parsePermissionRequest(params: unknown): AcpPermissionRequest {
	const record = requireRecord(params, "Invalid session/request_permission params");
	const sessionId = requireString(record.sessionId, "Invalid session/request_permission sessionId");
	const toolCall = parseToolCall(record.toolCall);
	const options: AcpPermissionOption[] = [];
	if (Array.isArray(record.options)) {
		for (const entry of record.options) {
			if (!isRecord(entry)) continue;
			const optionId = readString(entry.optionId);
			if (optionId === undefined) continue;
			const kind = readString(entry.kind);
			options.push({
				optionId,
				name: readString(entry.name) ?? optionId,
				...(kind === undefined ? {} : { kind }),
			});
		}
	}
	return { sessionId, toolCall, options };
}

function parseToolCall(value: unknown): AcpToolCall {
	const record = requireRecord(value, "Invalid session/request_permission toolCall");
	const toolCallId = readString(record.toolCallId);
	if (toolCallId === undefined) {
		throw new AcpRpcError(-32602, "Invalid session/request_permission toolCall");
	}
	const title = readString(record.title);
	const kind = readString(record.kind);
	const status = readString(record.status);
	return {
		...record,
		toolCallId,
		...(title === undefined ? {} : { title }),
		...(kind === undefined ? {} : { kind }),
		...(status === undefined ? {} : { status }),
	};
}

function parseFsReadRequest(params: unknown): AcpFsReadTextFileRequest {
	const record = requireRecord(params, "Invalid fs/read_text_file params");
	const sessionId = requireString(record.sessionId, "Invalid fs/read_text_file sessionId");
	const path = requireString(record.path, "Invalid fs/read_text_file path");
	const line = readNumber(record.line);
	const limit = readNumber(record.limit);
	return {
		sessionId,
		path,
		...(line === undefined ? {} : { line }),
		...(limit === undefined ? {} : { limit }),
	};
}

function parseFsWriteRequest(params: unknown): AcpFsWriteTextFileRequest {
	const record = requireRecord(params, "Invalid fs/write_text_file params");
	const sessionId = requireString(record.sessionId, "Invalid fs/write_text_file sessionId");
	const path = requireString(record.path, "Invalid fs/write_text_file path");
	const content = readString(record.content);
	if (content === undefined) {
		throw new AcpRpcError(-32602, "Invalid fs/write_text_file content");
	}
	return { sessionId, path, content };
}

function parseTerminalRequest(method: AcpTerminalMethod, params: unknown): AcpTerminalRequest {
	if (method === "terminal/create") {
		const record = requireRecord(params, "Invalid terminal/create params");
		const sessionId = requireString(record.sessionId, "Invalid terminal/create sessionId");
		const command = requireString(record.command, "Invalid terminal/create command");
		const args = readStringArray(record.args);
		const cwd = readString(record.cwd);
		const env = readEnvVariables(record.env);
		const outputByteLimit = readNumber(record.outputByteLimit);
		return {
			method,
			params: {
				sessionId,
				command,
				...(args === undefined ? {} : { args }),
				...(cwd === undefined ? {} : { cwd }),
				...(env === undefined ? {} : { env }),
				...(outputByteLimit === undefined ? {} : { outputByteLimit }),
			},
		};
	}
	const record = requireRecord(params, `Invalid ${method} params`);
	return {
		method,
		params: {
			sessionId: requireString(record.sessionId, `Invalid ${method} sessionId`),
			terminalId: requireString(record.terminalId, `Invalid ${method} terminalId`),
		},
	};
}

function readStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string");
}

function readEnvVariables(value: unknown): readonly AcpEnvVariable[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const variables: AcpEnvVariable[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = readString(entry.name);
		const variableValue = readString(entry.value);
		if (name === undefined || variableValue === undefined) continue;
		variables.push({ name, value: variableValue });
	}
	return variables.length === 0 ? undefined : variables;
}

function encodeMcpServers(
	servers: readonly AcpMcpServerConfig[],
): readonly Record<string, unknown>[] {
	return servers.map((server) => {
		if ("command" in server) {
			const env = encodeKeyValues(server.env);
			return {
				name: server.name,
				command: server.command,
				args: [...(server.args ?? [])],
				...(env === undefined ? {} : { env }),
			};
		}
		const headers = encodeKeyValues(server.headers);
		return {
			type: server.type,
			name: server.name,
			url: server.url,
			...(headers === undefined ? {} : { headers }),
		};
	});
}

function encodeKeyValues(
	value: Readonly<Record<string, string>> | readonly AcpEnvVariable[] | undefined,
): readonly AcpEnvVariable[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value;
	return Object.entries(value).map(([name, entryValue]) => ({ name, value: entryValue }));
}
