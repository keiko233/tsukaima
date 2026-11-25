import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { isPlainObject, mapValues } from "es-toolkit";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_SERVERS_STORAGE_KEY } from "./manifest.ts";
import {
	McpOAuthClientProvider,
	McpOAuthStore,
	defaultOAuthRedirectUrl,
	oauthSecretsForRedaction,
	oauthSnapshotFor,
	parseOAuthCallbackUrl,
	validateCallbackOrigin,
	type McpOAuthCallbackOutcome,
	type McpOAuthCallbackParams,
	type McpOAuthHost,
	type PersistedMcpOAuthState,
} from "./oauth.ts";
import {
	MCP_SECRET_MASK,
	mcpServerConfigSchema,
	type McpHttpAuth,
	type McpOAuthCompleteInput,
	type McpServerConfig,
	type McpServerConfigView,
	type McpServerCreate,
	type McpServerSnapshot,
	type McpServerState,
	type McpServerUpdate,
	type McpToolInfo,
	type McpTransport,
} from "@tsukaima/contracts";
import type {
	AuditEntry,
	PluginAuditApi,
	PluginLogger,
	PluginStorage,
	PluginTool,
	ToolInvocationContext,
} from "@tsukaima/sdk";
import { isAdminMcpCaller, mcpCallerIdentity } from "./auth.ts";

/** One normalized MCP content block; images stay base64 so a model can see them directly. */
export type McpToolContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface McpToolCallResult {
	readonly content: readonly McpToolContent[];
	readonly isError: boolean;
}

export interface McpManagerOptions {
	readonly audit?: PluginAuditApi;
	readonly clientName?: string;
	readonly clientVersion?: string;
	readonly logger: PluginLogger;
	readonly oauthHost?: McpOAuthHost;
	readonly onChanged?: () => Promise<void> | void;
	readonly registerTool: (tool: PluginTool) => void;
	readonly storage: PluginStorage;
	readonly unregisterTool: (name: string) => void;
}

interface McpServerRecord {
	client: Client | undefined;
	config: McpServerConfig;
	connectedAt: string | undefined;
	lastError: string | undefined;
	readonly registeredTools: Set<string>;
	state: McpServerState;
	tools: McpToolInfo[];
}

const DEFAULT_CLIENT_NAME = "tsukaima";
const DEFAULT_CLIENT_VERSION = "0.1.0";
const MAX_TOOL_PAGES = 20;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Error text is bounded before it reaches logs or the WebUI. */
function shortMessage(error: unknown): string {
	return errorMessage(error).slice(0, 256);
}

function withOptional<T extends Record<string, unknown>>(
	base: T,
	extra: Record<string, unknown>,
): T {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined) result[key] = value;
	}
	return result as T;
}

function deriveServerId(name: string): string {
	const base = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/^[-._]+|[-._]+$/gu, "")
		.slice(0, 48);
	return base.length > 0 ? base : "mcp";
}

function secretKeys(transport: McpTransport): string[] {
	if (transport.type === "stdio") {
		return Object.keys(transport.env ?? {}).map((key) => `env:${key}`);
	}
	const keys = Object.keys(transport.headers ?? {}).map((key) => `header:${key}`);
	if (transport.auth?.type === "bearer") {
		keys.push("auth:token");
	} else if (transport.auth?.type === "oauth") {
		if (transport.auth.clientSecret !== undefined) keys.push("auth:clientSecret");
		if (transport.auth.privateKey !== undefined) keys.push("auth:privateKey");
	}
	return keys;
}

function allSecretValues(transport: McpTransport): string[] {
	if (transport.type === "stdio") {
		return Object.values(transport.env ?? {});
	}
	const values = Object.values(transport.headers ?? {});
	if (transport.auth?.type === "bearer") {
		values.push(transport.auth.token);
	} else if (transport.auth?.type === "oauth") {
		if (transport.auth.clientSecret !== undefined) values.push(transport.auth.clientSecret);
		if (transport.auth.privateKey !== undefined) values.push(transport.auth.privateKey);
	}
	return values;
}

function secretValues(transport: McpTransport, oauthState?: PersistedMcpOAuthState): string[] {
	return [...allSecretValues(transport), ...oauthSecretsForRedaction(oauthState)].filter(
		(value) => value.trim().length > 0 && value !== MCP_SECRET_MASK,
	);
}

function maskAuth(
	authConfig: McpHttpAuth,
): Extract<McpServerConfigView["transport"], { type: "http" }>["auth"] {
	if (authConfig.type === "none") return authConfig;
	if (authConfig.type === "bearer") {
		return { token: MCP_SECRET_MASK, type: "bearer" };
	}
	return {
		...authConfig,
		...(authConfig.clientSecret === undefined ? {} : { clientSecret: MCP_SECRET_MASK }),
		...(authConfig.privateKey === undefined ? {} : { privateKey: MCP_SECRET_MASK }),
	};
}

function maskTransport(transport: McpTransport): McpServerConfigView["transport"] {
	if (transport.type === "stdio") {
		return {
			...(transport.args === undefined ? {} : { args: transport.args }),
			command: transport.command,
			...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
			...(transport.env === undefined
				? {}
				: {
						env: mapValues(transport.env, () => MCP_SECRET_MASK),
					}),
			type: "stdio",
		};
	}
	return {
		...(transport.auth === undefined ? {} : { auth: maskAuth(transport.auth) }),
		...(transport.headers === undefined
			? {}
			: {
					headers: mapValues(transport.headers, () => MCP_SECRET_MASK),
				}),
		type: "http",
		url: transport.url,
	};
}

function redactSecrets(
	message: string,
	transport: McpTransport,
	oauthState?: PersistedMcpOAuthState,
): string {
	let redacted = message;
	for (const secret of secretValues(transport, oauthState)) {
		if (secret.length < 4) continue;
		redacted = redacted.split(secret).join(MCP_SECRET_MASK);
	}
	return redacted;
}

function preserveAuthSecrets(
	next: McpHttpAuth | undefined,
	previous: McpHttpAuth | undefined,
): McpHttpAuth | undefined {
	if (next === undefined) return undefined;
	if (next.type === "bearer") {
		if (next.token !== MCP_SECRET_MASK || previous?.type !== "bearer") return next;
		return { ...next, token: previous.token };
	}
	if (next.type === "oauth") {
		if (previous?.type !== "oauth") return next;
		return {
			...next,
			...(next.clientSecret === MCP_SECRET_MASK && previous.clientSecret !== undefined
				? { clientSecret: previous.clientSecret }
				: {}),
			...(next.privateKey === MCP_SECRET_MASK && previous.privateKey !== undefined
				? { privateKey: previous.privateKey }
				: {}),
		};
	}
	return next;
}

/** Editing a server through the masked WebUI view must not erase stored credentials. */
function preserveSecrets(next: McpTransport, previous: McpTransport): McpTransport {
	if (next.type === "stdio") {
		if (next.env === undefined) return next;
		const previousEnv = previous.type === "stdio" ? (previous.env ?? {}) : {};
		return {
			...next,
			env: mapValues(next.env, (value, key) =>
				value === MCP_SECRET_MASK ? (previousEnv[key] ?? value) : value,
			),
		};
	}
	const previousHeaders = previous.type === "http" ? (previous.headers ?? {}) : {};
	const headers =
		next.headers === undefined
			? undefined
			: mapValues(next.headers, (value, key) =>
					value === MCP_SECRET_MASK ? (previousHeaders[key] ?? value) : value,
				);
	const authConfig = preserveAuthSecrets(
		next.auth,
		previous.type === "http" ? previous.auth : undefined,
	);
	return {
		...(authConfig === undefined ? {} : { auth: authConfig }),
		...(headers === undefined ? {} : { headers }),
		type: "http",
		url: next.url,
	};
}

function oauthIdentityChanged(previous: McpTransport, next: McpTransport): boolean {
	if (previous.type !== next.type) return true;
	if (previous.type !== "http" || next.type !== "http") return false;
	if (previous.url !== next.url) return true;
	const prevAuth = previous.auth?.type === "oauth" ? previous.auth : undefined;
	const nextAuth = next.auth?.type === "oauth" ? next.auth : undefined;
	if (prevAuth === undefined && nextAuth === undefined) return false;
	return JSON.stringify(prevAuth) !== JSON.stringify(nextAuth);
}

function sseFetchWithHeaders(headers: Record<string, string>) {
	// EventSource cannot attach headers itself, so the initial SSE GET needs this wrapper.
	return (input: string | URL, init?: RequestInit) =>
		fetch(input, { ...init, headers: { ...init?.headers, ...headers } });
}

function splitCommandLine(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	for (const char of input.trim()) {
		if (quote !== null) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function resolveStdioCommand(
	command: string,
	args: readonly string[] | undefined,
): { readonly command: string; readonly args: string[] } {
	const trimmed = command.trim();
	const explicitArgs = args === undefined ? [] : [...args];
	if (!/\s/u.test(trimmed) || existsSync(trimmed)) {
		return { command: trimmed, args: explicitArgs };
	}
	const [executable, ...inlineArgs] = splitCommandLine(trimmed);
	return {
		command: executable ?? trimmed,
		args: [...inlineArgs, ...explicitArgs],
	};
}

/**
 * Directories that must be reachable from a spawned stdio server: image-installed tooling lives
 * in `/usr/local/bin`, and per-user installs (`uv tool`, `pip install --user`) land in
 * `~/.local/bin`. The SDK's curated environment already carries `PATH`, but it may miss either
 * directory, which made Python and `bunx` servers look uninstalled.
 */
const STDIO_PATH_PREPEND = ["/usr/local/bin", "~/.local/bin"] as const;

function expandHomeDirectory(entry: string, home: string | undefined): string {
	if (home === undefined || home.length === 0) return entry;
	if (entry === "~") return home;
	if (entry.startsWith("~/")) return join(home, entry.slice(2));
	return entry;
}

/**
 * Builds the environment for a spawned stdio MCP server: the curated defaults, the configured
 * values, and a de-duplicated PATH that reaches the image's Python, uv, and Bun tooling.
 */
export function stdioEnvironment(
	configured: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const merged: Record<string, string> = { ...getDefaultEnvironment(), ...configured };
	const home = merged.HOME ?? process.env.HOME;
	const inherited = merged.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	const pathEntries = new Set<string>();
	for (const entry of [
		...STDIO_PATH_PREPEND.map((dir) => expandHomeDirectory(dir, home)),
		...inherited.split(delimiter),
	]) {
		if (entry.length > 0) pathEntries.add(entry);
	}
	return { ...merged, PATH: [...pathEntries].join(delimiter) };
}

function executableSuffixes(): readonly string[] {
	if (process.platform !== "win32") return [""];
	const pathext = process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM";
	return ["", ...pathext.split(";").filter((entry) => entry.length > 0)];
}

function isRunnableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isDirectory(candidate: string): boolean {
	try {
		return statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/** Resolves `command` the way the spawned child will, so a missing binary can be named. */
function findStdioExecutable(
	command: string,
	env: Readonly<Record<string, string>>,
	cwd: string | undefined,
): string | undefined {
	const hasSeparator =
		command.includes("/") || (process.platform === "win32" && command.includes("\\"));
	if (hasSeparator) {
		const candidate = isAbsolute(command) ? command : resolve(cwd ?? process.cwd(), command);
		return isRunnableFile(candidate) ? candidate : undefined;
	}
	const suffixes = executableSuffixes();
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		for (const suffix of suffixes) {
			const candidate = join(dir, `${command}${suffix}`);
			if (isRunnableFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * A bare `spawn ENOENT` never says which executable failed, which is the usual symptom of a
 * Python or npm-based server configured against a runtime image that lacks it.
 */
function missingStdioCommandMessage(
	command: string,
	env: Readonly<Record<string, string>>,
): string {
	return `MCP stdio command "${command}" was not found. Install python3, uv, or bun (use bunx for npm-based servers) in the runtime image, or configure an absolute command path. PATH: ${env.PATH ?? ""}`;
}

/** A spawn error carries its `ENOENT` marker on the error object, not in a plain record. */
function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code: unknown = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/** Enriches an `ENOENT` from the spawn itself, e.g. a script whose shebang interpreter is absent. */
function describeSpawnFailure(error: unknown, transport: McpTransport): string {
	const message = shortMessage(error);
	if (transport.type !== "stdio" || errorCode(error) !== "ENOENT") return message;
	const cwd = transport.cwd === undefined ? "" : ` and working directory "${transport.cwd}"`;
	return `spawn ENOENT: "${transport.command}"${cwd} not found (PATH: ${
		stdioEnvironment(transport.env).PATH ?? ""
	}); ${message}`;
}

function effectiveHttpHeaders(
	config: Extract<McpTransport, { type: "http" }>,
): Record<string, string> | undefined {
	const base = config.headers === undefined ? {} : { ...config.headers };
	if (config.auth?.type === "oauth") {
		// Prevent static headers from overwriting the dynamic OAuth Bearer token.
		for (const key of Object.keys(base)) {
			if (key.toLowerCase() === "authorization") delete base[key];
		}
	} else if (config.auth?.type === "bearer") {
		for (const key of Object.keys(base)) {
			if (key.toLowerCase() === "authorization") delete base[key];
		}
		base.Authorization = `Bearer ${config.auth.token}`;
	}
	return Object.keys(base).length === 0 ? undefined : base;
}

function transportFor(config: McpTransport, authProvider?: McpOAuthClientProvider): Transport {
	if (config.type === "stdio") {
		const resolved = resolveStdioCommand(config.command, config.args);
		const env = stdioEnvironment(config.env);
		if (config.cwd !== undefined && !isDirectory(config.cwd)) {
			throw new Error(
				`MCP stdio command "${resolved.command}" has working directory "${config.cwd}", which does not exist.`,
			);
		}
		if (findStdioExecutable(resolved.command, env, config.cwd) === undefined) {
			throw new Error(missingStdioCommandMessage(resolved.command, env));
		}
		return new StdioClientTransport({
			args: resolved.args,
			command: resolved.command,
			...(config.cwd === undefined ? {} : { cwd: config.cwd }),
			env,
			stderr: "ignore",
		});
	}
	const headers = effectiveHttpHeaders(config);
	return new StreamableHTTPClientTransport(new URL(config.url), {
		...(authProvider === undefined ? {} : { authProvider }),
		...(headers === undefined ? {} : { requestInit: { headers } }),
	});
}

function sseTransportFor(
	config: Extract<McpTransport, { type: "http" }>,
	authProvider?: McpOAuthClientProvider,
): Transport {
	const headers = effectiveHttpHeaders(config);
	return new SSEClientTransport(new URL(config.url), {
		...(authProvider === undefined ? {} : { authProvider }),
		...(headers === undefined
			? {}
			: {
					eventSourceInit: { fetch: sseFetchWithHeaders(headers) as never },
					requestInit: { headers },
				}),
	});
}

function normalizedContent(blocks: readonly unknown[]): McpToolContent[] {
	const output: McpToolContent[] = [];
	for (const block of blocks) {
		if (!isPlainObject(block)) {
			output.push({ text: JSON.stringify(block), type: "text" });
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			output.push({ text: block.text, type: "text" });
			continue;
		}
		if (block.type === "image" && typeof block.data === "string") {
			output.push({
				data: block.data,
				mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png",
				type: "image",
			});
			continue;
		}
		if (block.type === "audio" && typeof block.data === "string") {
			output.push({
				text: `[audio ${typeof block.mimeType === "string" ? block.mimeType : "audio"}]`,
				type: "text",
			});
			continue;
		}
		if (block.type === "resource" && isPlainObject(block.resource)) {
			const resource = block.resource;
			if (typeof resource.text === "string") {
				output.push({ text: resource.text, type: "text" });
				continue;
			}
			const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "";
			if (typeof resource.blob === "string") {
				if (mimeType.startsWith("image/")) {
					output.push({ data: resource.blob, mimeType, type: "image" });
				} else {
					output.push({
						text: `[resource ${String(resource.uri ?? "")} ${mimeType}]`,
						type: "text",
					});
				}
				continue;
			}
		}
		if (block.type === "resource_link") {
			output.push({
				text: `[resource ${String(block.name ?? block.uri ?? "")}]`,
				type: "text",
			});
			continue;
		}
		output.push({ text: JSON.stringify(block), type: "text" });
	}
	return output;
}

function toolNamesFor(config: McpServerConfig, tools: readonly McpToolInfo[]): McpToolInfo[] {
	const disabled = new Set(config.disabledTools ?? []);
	const allowed = config.allowedTools;
	return tools.filter((tool) => {
		if (disabled.has(tool.name)) return false;
		return allowed === undefined || allowed.length === 0 || allowed.includes(tool.name);
	});
}

function canonicalToolName(serverId: string, toolName: string): string {
	return `mcp.${serverId}.${toolName}`;
}

/**
 * Owns MCP server configuration, live transports, and the plugin tool catalog. Config lives in
 * plugin storage; discovered tools enter and leave `context.tools` as connections change, and
 * `createPluginToolsExtension` re-reads that registry on every turn.
 */
export class McpManager {
	readonly #options: McpManagerOptions;
	readonly #oauthStore: McpOAuthStore;
	readonly #records = new Map<string, McpServerRecord>();
	#callbackDisposer: (() => void) | undefined;
	#started = false;

	constructor(options: McpManagerOptions) {
		this.#options = options;
		this.#oauthStore = new McpOAuthStore(options.storage);
	}

	get started(): boolean {
		return this.#started;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		await this.#oauthStore.load();
		this.#callbackDisposer = this.#options.oauthHost?.registerCallbackHandler?.((params) =>
			this.handleOAuthCallback(params),
		);
		const configs = await this.#load();
		const connecting: string[] = [];
		for (const config of configs) {
			const record: McpServerRecord = {
				client: undefined,
				config,
				connectedAt: undefined,
				lastError: undefined,
				registeredTools: new Set(),
				state: config.enabled ? "connecting" : "disconnected",
				tools: [],
			};
			this.#records.set(config.id, record);
			if (config.enabled) connecting.push(config.id);
		}
		// Connect concurrently: one slow server must not serialize every other connect attempt.
		await Promise.all(connecting.map((id) => this.#connect(id)));
	}

	async stop(): Promise<void> {
		this.#started = false;
		this.#callbackDisposer?.();
		this.#callbackDisposer = undefined;
		for (const id of this.#records.keys()) {
			await this.#disconnect(id);
		}
	}

	list(): McpServerSnapshot[] {
		return [...this.#records.values()].map((record) => this.#snapshot(record));
	}

	snapshot(id: string): McpServerSnapshot | undefined {
		const record = this.#records.get(id);
		return record === undefined ? undefined : this.#snapshot(record);
	}

	async create(input: McpServerCreate): Promise<McpServerSnapshot> {
		const id = input.id ?? this.#uniqueId(deriveServerId(input.name));
		if (this.#records.has(id)) throw new Error(`MCP server ${id} already exists`);
		const config: McpServerConfig = withOptional(
			{
				deferred: input.deferred,
				enabled: input.enabled,
				id,
				name: input.name,
				scope: input.scope,
				surface: input.surface,
				timeoutMs: input.timeoutMs,
				transport: input.transport,
			},
			{
				allowedTools: input.allowedTools,
				disabledTools: input.disabledTools,
			},
		);
		const record: McpServerRecord = {
			client: undefined,
			config,
			connectedAt: undefined,
			lastError: undefined,
			registeredTools: new Set(),
			state: config.enabled ? "connecting" : "disconnected",
			tools: [],
		};
		this.#records.set(id, record);
		await this.#persist();
		await this.#audit("mcp.server.create", id, config, "ok");
		if (config.enabled) await this.#connect(id);
		return this.#snapshot(record);
	}

	async update(input: McpServerUpdate): Promise<McpServerSnapshot> {
		const record = this.#records.get(input.id);
		if (record === undefined) throw new Error(`Unknown MCP server ${input.id}`);
		const previous = record.config;
		const nextTransport =
			input.transport === undefined
				? previous.transport
				: preserveSecrets(input.transport, previous.transport);
		const next: McpServerConfig = withOptional(
			{
				deferred: input.deferred ?? previous.deferred,
				enabled: input.enabled ?? previous.enabled,
				id: previous.id,
				name: input.name ?? previous.name,
				scope: input.scope ?? previous.scope,
				surface: input.surface ?? previous.surface,
				timeoutMs: input.timeoutMs ?? previous.timeoutMs,
				transport: nextTransport,
			},
			{
				allowedTools: input.allowedTools ?? previous.allowedTools,
				disabledTools: input.disabledTools ?? previous.disabledTools,
			},
		);
		const reconnected =
			next.enabled &&
			(previous.enabled !== next.enabled ||
				previous.transport.type !== next.transport.type ||
				JSON.stringify(previous.transport) !== JSON.stringify(next.transport) ||
				previous.timeoutMs !== next.timeoutMs);
		record.config = next;
		if (oauthIdentityChanged(previous.transport, next.transport)) {
			await this.#oauthStore.delete(next.id);
		}
		await this.#persist();
		await this.#audit("mcp.server.update", next.id, next, "ok");
		if (reconnected) {
			await this.#disconnect(next.id);
			await this.#connect(next.id);
		} else if (!next.enabled) {
			await this.#disconnect(next.id);
		} else {
			// Deferred/surface/filter changes apply immediately without a reconnect.
			await this.#syncTools(record);
		}
		return this.#snapshot(record);
	}

	async delete(id: string): Promise<{ deleted: boolean; id: string }> {
		const record = this.#records.get(id);
		await this.#disconnect(id);
		this.#records.delete(id);
		await this.#oauthStore.delete(id);
		await this.#persist();
		await this.#audit("mcp.server.delete", id, record?.config, "ok");
		return { deleted: record !== undefined, id };
	}

	async toggle(id: string, enabled: boolean): Promise<McpServerSnapshot> {
		const record = this.#records.get(id);
		if (record === undefined) throw new Error(`Unknown MCP server ${id}`);
		if (record.config.enabled === enabled) return this.#snapshot(record);
		const next: McpServerConfig = { ...record.config, enabled };
		record.config = next;
		await this.#persist();
		await this.#audit("mcp.server.toggle", id, next, "ok");
		if (enabled) {
			await this.#connect(id);
		} else {
			await this.#disconnect(id);
		}
		return this.#snapshot(record);
	}

	async reconnect(id: string): Promise<McpServerSnapshot> {
		const record = this.#records.get(id);
		if (record === undefined) throw new Error(`Unknown MCP server ${id}`);
		await this.#disconnect(id);
		if (record.config.enabled) await this.#connect(id);
		await this.#audit("mcp.server.reconnect", id, record.config, "ok");
		return this.#snapshot(record);
	}

	async startOAuth(id: string, callbackOrigin?: string): Promise<McpServerSnapshot> {
		const record = this.#records.get(id);
		if (record === undefined) throw new Error(`Unknown MCP server ${id}`);
		if (!record.config.enabled) throw new Error(`MCP server ${id} is disabled`);
		if (record.config.transport.type !== "http" || record.config.transport.auth?.type !== "oauth") {
			throw new Error(`MCP server ${id} is not configured for OAuth`);
		}
		const validatedOrigin =
			callbackOrigin === undefined ? undefined : validateCallbackOrigin(callbackOrigin);
		await this.#disconnect(id);
		await this.#oauthStore.update(id, (current) => {
			const {
				codeVerifier: _verifier,
				lastAuthError: _error,
				pending: _pending,
				tokenExpiresAt: _expiry,
				tokens: _tokens,
				...rest
			} = current;
			return rest;
		});
		await this.#connect(
			id,
			validatedOrigin === undefined ? {} : { callbackOrigin: validatedOrigin },
		);
		await this.#audit("mcp.server.oauth.start", id, record.config, "ok");
		return this.#snapshot(record);
	}

	async completeOAuth(input: McpOAuthCompleteInput): Promise<McpServerSnapshot> {
		const record = this.#records.get(input.id);
		if (record === undefined) throw new Error(`Unknown MCP server ${input.id}`);
		if (!record.config.enabled) throw new Error(`MCP server ${input.id} is disabled`);
		if (record.config.transport.type !== "http" || record.config.transport.auth?.type !== "oauth") {
			throw new Error(`MCP server ${input.id} is not configured for OAuth`);
		}
		const authConfig = record.config.transport.auth;
		if (authConfig.grantType !== "authorization_code") {
			throw new Error(`MCP server ${input.id} does not use authorization_code OAuth`);
		}

		const parsed =
			input.callbackUrl !== undefined
				? parseOAuthCallbackUrl(input.callbackUrl)
				: {
						...(input.code === undefined ? {} : { code: input.code }),
						...(input.state === undefined ? {} : { state: input.state }),
					};
		if (parsed.error !== undefined) {
			const message =
				parsed.errorDescription === undefined
					? parsed.error
					: `${parsed.error}: ${parsed.errorDescription}`;
			await this.#recordAuthError(input.id, record, message);
			throw new Error(`OAuth authorization failed: ${message}`);
		}
		if (parsed.code === undefined || parsed.code.length === 0) {
			throw new Error("OAuth authorization code is missing");
		}

		await this.#oauthStore.load();
		const currentState = this.#oauthStore.get(input.id);
		const pending = currentState?.pending;
		if (pending !== undefined) {
			const expiresMs = Date.parse(pending.expiresAt);
			if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
				await this.#oauthStore.update(input.id, (current) => {
					const { pending: _removed, ...rest } = current;
					return rest;
				});
				throw new Error("OAuth authorization session expired; start authorization again");
			}
			if (parsed.state !== undefined && parsed.state !== pending.state) {
				throw new Error("OAuth state parameter mismatch");
			}
		}

		const redirectUrl =
			pending?.redirectUrl ?? defaultOAuthRedirectUrl(this.#options.oauthHost?.publicUrl);
		await this.#oauthStore.update(input.id, (current) => {
			const { pending: _removed, ...rest } = current;
			return rest;
		});

		try {
			const provider = new McpOAuthClientProvider({
				authConfig,
				redirectUrl,
				serverId: input.id,
				store: this.#oauthStore,
			});
			await auth(provider, {
				authorizationCode: parsed.code,
				serverUrl: record.config.transport.url,
			});
		} catch (error) {
			const reason = redactSecrets(
				shortMessage(error),
				record.config.transport,
				this.#oauthStore.get(input.id),
			);
			await this.#recordAuthError(input.id, record, reason);
			throw new Error(`OAuth token exchange failed: ${reason}`, { cause: error });
		}

		await this.#disconnect(input.id);
		await this.#connect(input.id);
		await this.#audit("mcp.server.oauth.complete", input.id, record.config, "ok");
		return this.#snapshot(record);
	}

	async clearOAuth(id: string): Promise<McpServerSnapshot> {
		const record = this.#records.get(id);
		if (record === undefined) throw new Error(`Unknown MCP server ${id}`);
		await this.#disconnect(id);
		await this.#oauthStore.delete(id);
		if (
			record.config.enabled &&
			record.config.transport.type === "http" &&
			record.config.transport.auth?.type === "oauth"
		) {
			record.state = "auth_required";
		}
		await this.#audit("mcp.server.oauth.clear", id, record.config, "ok");
		return this.#snapshot(record);
	}

	async handleOAuthCallback(params: McpOAuthCallbackParams): Promise<McpOAuthCallbackOutcome> {
		if (params.state === undefined || params.state.length === 0) {
			return { error: "Missing OAuth state parameter", ok: false };
		}
		const matched = await this.#oauthStore.consumePendingState(params.state);
		if (matched === undefined) {
			return { error: "Invalid or expired OAuth state parameter", ok: false };
		}
		const record = this.#records.get(matched.serverId);
		if (
			record === undefined ||
			record.config.transport.type !== "http" ||
			record.config.transport.auth?.type !== "oauth"
		) {
			return {
				error: "MCP server is not configured for OAuth",
				ok: false,
				serverId: matched.serverId,
			};
		}
		if (params.error !== undefined) {
			const message =
				params.errorDescription === undefined
					? params.error
					: `${params.error}: ${params.errorDescription}`;
			await this.#recordAuthError(matched.serverId, record, message);
			await this.#options.onChanged?.();
			return { error: message, ok: false, serverId: matched.serverId };
		}
		if (params.code === undefined || params.code.length === 0) {
			const message = "Missing OAuth authorization code";
			await this.#recordAuthError(matched.serverId, record, message);
			await this.#options.onChanged?.();
			return { error: message, ok: false, serverId: matched.serverId };
		}

		try {
			const provider = new McpOAuthClientProvider({
				authConfig: record.config.transport.auth,
				redirectUrl: matched.pending.redirectUrl,
				serverId: matched.serverId,
				store: this.#oauthStore,
			});
			await auth(provider, {
				authorizationCode: params.code,
				serverUrl: record.config.transport.url,
			});
			await this.#disconnect(matched.serverId);
			if (record.config.enabled) {
				await this.#connect(matched.serverId);
			}
			await this.#audit("mcp.server.oauth.complete", matched.serverId, record.config, "ok");
			await this.#options.onChanged?.();
			return { ok: true, serverId: matched.serverId };
		} catch (error) {
			const reason = redactSecrets(
				shortMessage(error),
				record.config.transport,
				this.#oauthStore.get(matched.serverId),
			);
			await this.#recordAuthError(matched.serverId, record, reason);
			await this.#audit(
				"mcp.server.oauth.complete",
				matched.serverId,
				record.config,
				"failed",
				reason,
			);
			await this.#options.onChanged?.();
			return { error: reason, ok: false, serverId: matched.serverId };
		}
	}

	/**
	 * Runs one MCP tool call under the server's timeout and the caller's abort signal.
	 * Transport failures throw; a tool's own `isError` result is returned with its content.
	 */
	async callTool(
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpToolCallResult> {
		const record = this.#records.get(serverId);
		if (record === undefined) throw new Error(`Unknown MCP server ${serverId}`);
		if (!record.config.enabled) throw new Error(`MCP server ${serverId} is disabled`);
		const client = record.client;
		if (client === undefined || record.state !== "connected") {
			throw new Error(`MCP server ${serverId} is not connected`);
		}
		const timeoutMs = record.config.timeoutMs;
		const controller = new AbortController();
		const callerAborted = (): boolean => signal?.aborted === true;
		const onCallerAbort = () => controller.abort(signal?.reason);
		if (signal !== undefined) {
			if (signal.aborted) controller.abort(signal.reason);
			else signal.addEventListener("abort", onCallerAbort, { once: true });
		}
		const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
		timer.unref?.();
		try {
			const result = (await client.callTool({ arguments: args, name: toolName }, undefined, {
				signal: controller.signal,
				timeout: timeoutMs,
			})) as unknown as { content?: readonly unknown[]; isError?: boolean };
			return {
				content: normalizedContent(result.content ?? []),
				isError: result.isError === true,
			};
		} catch (error) {
			if (callerAborted())
				throw new Error(`MCP tool ${serverId}.${toolName} aborted`, { cause: error });
			if (controller.signal.aborted) {
				throw new Error(`MCP tool ${serverId}.${toolName} timed out after ${timeoutMs}ms`, {
					cause: error,
				});
			}
			if (error instanceof UnauthorizedError) {
				record.state = "auth_required";
				record.client = undefined;
				record.tools = [];
				record.connectedAt = undefined;
				await this.#syncTools(record);
				await client.close().catch(() => undefined);
				await this.#options.onChanged?.();
				throw new Error(`MCP server ${serverId} requires OAuth re-authorization`, { cause: error });
			}
			throw new Error(
				`MCP tool ${serverId}.${toolName} failed: ${redactSecrets(
					shortMessage(error),
					record.config.transport,
					this.#oauthStore.get(serverId),
				)}`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		}
	}

	async #recordAuthError(id: string, record: McpServerRecord, message: string): Promise<void> {
		record.state = "error";
		record.lastError = message;
		record.client = undefined;
		record.tools = [];
		record.connectedAt = undefined;
		await this.#syncTools(record);
		await this.#oauthStore.update(id, (current) => ({
			...current,
			lastAuthError: message,
			updatedAt: new Date().toISOString(),
		}));
	}

	async #connect(id: string, options: { readonly callbackOrigin?: string } = {}): Promise<void> {
		const record = this.#records.get(id);
		if (record === undefined) return;
		record.state = "connecting";
		record.lastError = undefined;
		const config = record.config;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		timer.unref?.();
		const client = new Client(
			{
				name: this.#options.clientName ?? DEFAULT_CLIENT_NAME,
				version: this.#options.clientVersion ?? DEFAULT_CLIENT_VERSION,
			},
			{ capabilities: {} },
		);
		const authProvider =
			config.transport.type === "http" && config.transport.auth?.type === "oauth"
				? new McpOAuthClientProvider({
						authConfig: config.transport.auth,
						redirectUrl: defaultOAuthRedirectUrl(
							this.#options.oauthHost?.publicUrl,
							options.callbackOrigin,
						),
						serverId: id,
						store: this.#oauthStore,
					})
				: undefined;
		try {
			let transport = transportFor(config.transport, authProvider);
			try {
				await client.connect(transport, { signal: controller.signal });
			} catch (error) {
				if (
					error instanceof UnauthorizedError ||
					authProvider?.hasCapturedRedirect === true ||
					config.transport.type !== "http" ||
					!/(?:\/sse)(?:[/?#]|$)/iu.test(config.transport.url)
				) {
					throw error;
				}
				await transport.close?.().catch(() => undefined);
				transport = sseTransportFor(config.transport, authProvider);
				await client.connect(transport, { signal: controller.signal });
			}
			const tools = await this.#listTools(client, controller.signal);
			if (record.config !== config || this.#records.get(id) !== record) {
				// A concurrent update/delete replaced this attempt; close the stale connection.
				await client.close().catch(() => undefined);
				return;
			}
			record.client = client;
			record.tools = tools;
			record.state = "connected";
			record.connectedAt = new Date().toISOString();
			await this.#syncTools(record);
			this.#options.logger.info("MCP server connected", {
				serverId: id,
				toolCount: tools.length,
			});
		} catch (error) {
			await client.close().catch(() => undefined);
			if (error instanceof UnauthorizedError || authProvider?.hasCapturedRedirect === true) {
				if (this.#records.get(id) === record && record.config === config) {
					record.state = "auth_required";
					record.lastError = undefined;
					record.client = undefined;
					record.tools = [];
					record.connectedAt = undefined;
					await this.#syncTools(record);
				}
				this.#options.logger.info("MCP server requires OAuth authorization", { serverId: id });
				return;
			}
			const reason = redactSecrets(
				describeSpawnFailure(error, config.transport),
				config.transport,
				this.#oauthStore.get(id),
			);
			if (this.#records.get(id) === record && record.config === config) {
				record.state = "error";
				record.lastError = reason;
				record.client = undefined;
				record.tools = [];
				record.connectedAt = undefined;
				await this.#syncTools(record);
			}
			this.#options.logger.warn("MCP server connection failed", {
				error: reason,
				serverId: id,
			});
		} finally {
			clearTimeout(timer);
		}
	}

	async #listTools(client: Client, signal: AbortSignal): Promise<McpToolInfo[]> {
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
			const result = (await client.listTools(cursor === undefined ? undefined : { cursor }, {
				signal,
			})) as unknown as { nextCursor?: string; tools?: readonly unknown[] };
			for (const tool of result.tools ?? []) {
				if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
				tools.push({
					...(typeof tool.description === "string" ? { description: tool.description } : {}),
					inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: "object" },
					name: tool.name,
				});
			}
			cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
			if (cursor === undefined) break;
		}
		return tools;
	}

	async #disconnect(id: string): Promise<void> {
		const record = this.#records.get(id);
		if (record === undefined) return;
		const client = record.client;
		record.client = undefined;
		record.state = "disconnected";
		record.connectedAt = undefined;
		record.tools = [];
		record.lastError = undefined;
		await this.#syncTools(record);
		if (client !== undefined) {
			try {
				await client.close();
			} catch (error) {
				this.#options.logger.warn("MCP server disconnect failed", {
					error: shortMessage(error),
					serverId: id,
				});
			}
		}
	}

	/** Register exactly the tools of the record's current connected state. */
	async #syncTools(record: McpServerRecord): Promise<void> {
		for (const name of record.registeredTools) {
			this.#options.unregisterTool(name);
		}
		record.registeredTools.clear();
		if (record.state !== "connected" || !record.config.enabled) return;
		for (const tool of toolNamesFor(record.config, record.tools)) {
			const canonical = canonicalToolName(record.config.id, tool.name);
			try {
				this.#options.registerTool(this.#pluginTool(record.config, tool));
				record.registeredTools.add(canonical);
			} catch (error) {
				this.#options.logger.warn("MCP tool registration failed", {
					error: shortMessage(error),
					tool: canonical,
				});
			}
		}
	}

	#pluginTool(config: McpServerConfig, tool: McpToolInfo): PluginTool {
		const surface = config.surface === "workspace" ? "coding" : config.surface;
		const scopeHint = config.scope === "admin" ? ", admin only" : "";
		return {
			name: canonicalToolName(config.id, tool.name),
			description:
				tool.description === undefined
					? `${tool.name} (MCP server ${config.name}${scopeHint})`
					: `${tool.description}\n(MCP server ${config.name}${scopeHint})`,
			parameters:
				tool.inputSchema.type === "object" ? tool.inputSchema : { properties: {}, type: "object" },
			requiredPermissions: [],
			lazy: config.deferred,
			surface,
			policy: {
				lazy: config.deferred,
				maxConcurrent: 4,
				surface,
				timeoutMs: config.timeoutMs,
			},
			execute: async (input, invocation) => {
				if (config.scope === "admin" && !isAdminMcpCaller(invocation)) {
					await this.#auditToolDenied(config, tool.name, invocation);
					return {
						content: [{ text: JSON.stringify({ error: "admin_required" }), type: "text" }],
					};
				}
				const result = await this.callTool(config.id, tool.name, input, invocation.signal);
				const text = result.content
					.filter((part): part is Extract<McpToolContent, { type: "text" }> => part.type === "text")
					.map((part) => part.text);
				if (result.isError) {
					throw new Error(text.join("\n").trim() || "MCP tool returned an error");
				}
				const images = result.content
					.filter(
						(part): part is Extract<McpToolContent, { type: "image" }> => part.type === "image",
					)
					.map((part) => ({ data: part.data, mimeType: part.mimeType }));
				return {
					content: text.map((entry) => ({ text: entry, type: "text" as const })),
					...(images.length === 0 ? {} : { images }),
				};
			},
		};
	}

	async #load(): Promise<McpServerConfig[]> {
		const stored = await this.#options.storage.global.get<unknown>(MCP_SERVERS_STORAGE_KEY);
		if (!Array.isArray(stored)) return [];
		const configs: McpServerConfig[] = [];
		for (const entry of stored) {
			const parsed = mcpServerConfigSchema.safeParse(entry);
			if (!parsed.success) {
				this.#options.logger.warn("stored MCP server configuration is invalid; skipped", {
					error: parsed.error.message,
				});
				continue;
			}
			configs.push(parsed.data);
		}
		return configs;
	}

	async #persist(): Promise<void> {
		await this.#options.storage.global.set(
			MCP_SERVERS_STORAGE_KEY,
			[...this.#records.values()].map((record) => record.config),
		);
	}

	#snapshot(record: McpServerRecord): McpServerSnapshot {
		const config = record.config;
		const values = allSecretValues(config.transport);
		const oauth =
			config.transport.type === "http" && config.transport.auth?.type === "oauth"
				? oauthSnapshotFor(
						config.transport.auth,
						this.#oauthStore.get(config.id),
						defaultOAuthRedirectUrl(this.#options.oauthHost?.publicUrl),
					)
				: undefined;
		return {
			allowedTools: [...(config.allowedTools ?? [])],
			configured: values.every((value) => value.trim().length > 0),
			deferred: config.deferred,
			disabledTools: [...(config.disabledTools ?? [])],
			enabled: config.enabled,
			id: config.id,
			name: config.name,
			scope: config.scope,
			secretKeys: secretKeys(config.transport),
			state: record.state,
			surface: config.surface,
			timeoutMs: config.timeoutMs,
			tools: record.tools.map((tool) => ({
				...(tool.description === undefined ? {} : { description: tool.description }),
				inputSchema: { ...tool.inputSchema },
				name: tool.name,
			})),
			transport: maskTransport(config.transport),
			...(record.connectedAt === undefined ? {} : { connectedAt: record.connectedAt }),
			...(record.lastError === undefined ? {} : { lastError: record.lastError }),
			...(oauth === undefined ? {} : { oauth }),
		};
	}

	#uniqueId(base: string): string {
		let candidate = base;
		for (let index = 2; this.#records.has(candidate); index += 1) {
			candidate = `${base}-${index}`;
		}
		return candidate;
	}

	async #audit(
		action: string,
		id: string,
		config: McpServerConfig | undefined,
		result: "failed" | "ok",
		reason?: string,
	): Promise<void> {
		if (this.#options.audit === undefined) return;
		const entry: AuditEntry = {
			action,
			actorKind: "user",
			payload: {
				id,
				...(config === undefined
					? {}
					: {
							enabled: config.enabled,
							scope: config.scope,
							secretKeys: secretKeys(config.transport),
							transport: config.transport.type,
						}),
			},
			...(reason === undefined ? {} : { reason }),
			result,
			targetId: id,
			targetKind: "mcp-server",
		};
		try {
			await this.#options.audit.record(entry);
		} catch (error) {
			this.#options.logger.warn("MCP audit write failed", {
				action,
				error: shortMessage(error),
			});
		}
	}

	async #auditToolDenied(
		config: McpServerConfig,
		toolName: string,
		invocation: ToolInvocationContext,
	): Promise<void> {
		if (this.#options.audit === undefined) return;
		const canonical = canonicalToolName(config.id, toolName);
		const entry: AuditEntry = {
			action: "mcp.tool.denied",
			...(invocation.senderPlatformId === undefined
				? {}
				: { actorId: invocation.senderPlatformId }),
			actorKind: invocation.senderPlatformId === undefined ? "agent" : "user",
			payload: {
				...mcpCallerIdentity(invocation),
				operation: canonical,
				reason: "admin_required",
				scope: config.scope,
				serverId: config.id,
				tool: toolName,
			},
			reason: "admin_required",
			result: "denied",
			targetId: canonical,
			targetKind: "mcp-tool",
		};
		try {
			await this.#options.audit.record(entry);
		} catch (error) {
			this.#options.logger.warn("MCP tool denial audit write failed", {
				error: shortMessage(error),
				tool: canonical,
			});
		}
	}
}
