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
	MCP_SECRET_MASK,
	mcpServerConfigSchema,
	type McpServerConfig,
	type McpServerConfigView,
	type McpServerCreate,
	type McpServerSnapshot,
	type McpServerState,
	type McpServerUpdate,
	type McpToolInfo,
	type McpTransport,
} from "@tsukaima/contracts";
import {
	type AuditEntry,
	type PluginAuditApi,
	type PluginLogger,
	type PluginStorage,
	type PluginTool,
} from "@tsukaima/sdk";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	return Object.keys(transport.headers ?? {}).map((key) => `header:${key}`);
}

function allSecretValues(transport: McpTransport): string[] {
	return transport.type === "stdio"
		? Object.values(transport.env ?? {})
		: Object.values(transport.headers ?? {});
}

function secretValues(transport: McpTransport): string[] {
	return allSecretValues(transport).filter(
		(value) => value.trim().length > 0 && value !== MCP_SECRET_MASK,
	);
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
						env: Object.fromEntries(
							Object.keys(transport.env).map((key) => [key, MCP_SECRET_MASK] as const),
						),
					}),
			type: "stdio",
		};
	}
	return {
		...(transport.headers === undefined
			? {}
			: {
					headers: Object.fromEntries(
						Object.keys(transport.headers).map((key) => [key, MCP_SECRET_MASK] as const),
					),
				}),
		type: "http",
		url: transport.url,
	};
}

function redactSecrets(message: string, transport: McpTransport): string {
	let redacted = message;
	for (const secret of secretValues(transport)) {
		if (secret.length < 4) continue;
		redacted = redacted.split(secret).join(MCP_SECRET_MASK);
	}
	return redacted;
}

/** Editing a server through the masked WebUI view must not erase stored credentials. */
function preserveSecrets(next: McpTransport, previous: McpTransport): McpTransport {
	if (next.type === "stdio") {
		if (next.env === undefined) return next;
		const previousEnv = previous.type === "stdio" ? (previous.env ?? {}) : {};
		return {
			...next,
			env: Object.fromEntries(
				Object.entries(next.env).map(([key, value]) => [
					key,
					value === MCP_SECRET_MASK ? (previousEnv[key] ?? value) : value,
				]),
			),
		};
	}
	if (next.headers === undefined) return next;
	const previousHeaders = previous.type === "http" ? (previous.headers ?? {}) : {};
	return {
		...next,
		headers: Object.fromEntries(
			Object.entries(next.headers).map(([key, value]) => [
				key,
				value === MCP_SECRET_MASK ? (previousHeaders[key] ?? value) : value,
			]),
		),
	};
}

function sseFetchWithHeaders(headers: Record<string, string>) {
	// EventSource cannot attach headers itself, so the initial SSE GET needs this wrapper.
	return (input: string | URL, init?: RequestInit) =>
		fetch(input, { ...init, headers: { ...init?.headers, ...headers } });
}

function transportFor(config: McpTransport): Transport {
	if (config.type === "stdio") {
		return new StdioClientTransport({
			args: config.args ?? [],
			command: config.command,
			...(config.cwd === undefined ? {} : { cwd: config.cwd }),
			env: { ...getDefaultEnvironment(), ...config.env },
			stderr: "ignore",
		});
	}
	return new StreamableHTTPClientTransport(
		new URL(config.url),
		config.headers === undefined ? {} : { requestInit: { headers: config.headers } },
	);
}

function sseTransportFor(config: Extract<McpTransport, { type: "http" }>): Transport {
	const options =
		config.headers === undefined
			? {}
			: {
					eventSourceInit: { fetch: sseFetchWithHeaders(config.headers) as never },
					requestInit: { headers: config.headers },
				};
	return new SSEClientTransport(new URL(config.url), options);
}

function normalizedContent(blocks: readonly unknown[]): McpToolContent[] {
	const output: McpToolContent[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) {
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
		if (block.type === "resource" && isRecord(block.resource)) {
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
	readonly #records = new Map<string, McpServerRecord>();
	#started = false;

	constructor(options: McpManagerOptions) {
		this.#options = options;
	}

	get started(): boolean {
		return this.#started;
	}

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
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
			throw new Error(
				`MCP tool ${serverId}.${toolName} failed: ${redactSecrets(
					shortMessage(error),
					record.config.transport,
				)}`,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		}
	}

	async #connect(id: string): Promise<void> {
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
		try {
			let transport = transportFor(config.transport);
			try {
				await client.connect(transport, { signal: controller.signal });
			} catch (error) {
				if (
					config.transport.type !== "http" ||
					!/(?:\/sse)(?:[/?#]|$)/iu.test(config.transport.url)
				) {
					throw error;
				}
				await transport.close?.().catch(() => undefined);
				transport = sseTransportFor(config.transport);
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
			const reason = redactSecrets(shortMessage(error), config.transport);
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
				if (!isRecord(tool) || typeof tool.name !== "string") continue;
				tools.push({
					...(typeof tool.description === "string" ? { description: tool.description } : {}),
					inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" },
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
		return {
			name: canonicalToolName(config.id, tool.name),
			description:
				tool.description === undefined
					? `${tool.name} (MCP server ${config.name})`
					: `${tool.description}\n(MCP server ${config.name})`,
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
		return {
			allowedTools: [...(config.allowedTools ?? [])],
			configured: values.every((value) => value.trim().length > 0),
			deferred: config.deferred,
			disabledTools: [...(config.disabledTools ?? [])],
			enabled: config.enabled,
			id: config.id,
			name: config.name,
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
}
