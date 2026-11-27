import { delimiter, join } from "node:path";
import type { ReadAcpProfile } from "./config.ts";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const DEFAULT_REAPER_INTERVAL_MS = 30_000;

const SAFE_HOST_ENV_KEYS = [
	"LANG",
	"LC_ALL",
	"TZ",
	"HOME",
	"USER",
	"LOGNAME",
	"TERM",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SYSTEMROOT",
	"COMSPEC",
] as const;

export interface AcpProcessEnvOptions {
	readonly hostEnv?: Readonly<Record<string, string | undefined>>;
	readonly profileEnv?: Readonly<Record<string, string>>;
	readonly toolsRootDir?: string;
}

/**
 * Builds the environment for an ACP child process from a fixed allowlist. Host secrets and
 * server-owned configuration never cross into a spawned agent; profile settings intentionally
 * win because they are explicit operator configuration for that process.
 */
export function buildAcpProcessEnv(options: AcpProcessEnvOptions = {}): Record<string, string> {
	const hostEnv = options.hostEnv ?? process.env;
	const profileEnv = options.profileEnv ?? {};
	const env: Record<string, string> = {};
	for (const key of SAFE_HOST_ENV_KEYS) {
		const value = hostEnv[key];
		if (value !== undefined) env[key] = value;
	}

	const home = firstNonEmpty(profileEnv.HOME, hostEnv.HOME);
	const pathEntries: string[] = [];
	const toolsRootDir = options.toolsRootDir;
	if (toolsRootDir !== undefined && toolsRootDir.trim().length > 0) {
		pathEntries.push(join(toolsRootDir, "node_modules", ".bin"));
	}
	if (home !== undefined) {
		pathEntries.push(join(home, ".local", "bin"));
		pathEntries.push(join(home, ".bun", "bin"));
	}
	for (const entry of (firstNonEmpty(hostEnv.PATH, DEFAULT_PATH) ?? DEFAULT_PATH).split(
		delimiter,
	)) {
		if (entry.length > 0) pathEntries.push(entry);
	}
	env.PATH = [...new Set(pathEntries)].join(delimiter);

	return {
		...env,
		...profileEnv,
	};
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (value !== undefined && value.length > 0) return value;
	}
	return undefined;
}

export interface AcpPromptCapabilities {
	readonly audio?: boolean;
	readonly embeddedContext?: boolean;
	readonly image?: boolean;
}

export interface AcpSessionModelInfo {
	readonly description?: string;
	readonly modelId: string;
	readonly name?: string;
}

export interface AcpSessionModels {
	readonly availableModels: readonly AcpSessionModelInfo[];
	readonly currentModelId: string;
}

export interface AcpSessionConfigOption {
	readonly currentValue?: unknown;
	readonly description?: string;
	readonly id: string;
	readonly name: string;
	readonly options?: readonly unknown[];
	readonly type: string;
}

export interface AcpNewSessionInfo {
	readonly availableModels?: readonly AcpSessionModelInfo[];
	readonly configOptions?: readonly AcpSessionConfigOption[];
	readonly currentModelId?: string;
	readonly models?: AcpSessionModels;
	readonly promptCapabilities?: AcpPromptCapabilities;
	readonly sessionId: string;
}

export interface AcpSessionNotification {
	readonly sessionId: string;
	readonly update: unknown;
}

export interface AcpPermissionRequest {
	readonly options: readonly unknown[];
	readonly sessionId: string;
	readonly toolCall: unknown;
}

export interface AcpPermissionResponse {
	readonly outcome: unknown;
}

/**
 * Client-side ACP callbacks. Both ACP method names and UI-oriented aliases are accepted so the
 * process manager stays independent of the concrete stdio client implementation.
 */
export interface AcpClientSessionHandlers {
	readonly signal?: AbortSignal;
	createTerminal?(params: unknown): unknown | Promise<unknown>;
	killTerminal?(params: unknown): unknown | Promise<unknown>;
	onPermissionRequest?(params: unknown): unknown | Promise<unknown>;
	onSessionUpdate?(notification: unknown): void | Promise<void>;
	readTextFile?(params: unknown): unknown | Promise<unknown>;
	releaseTerminal?(params: unknown): unknown | Promise<unknown>;
	requestPermission?(params: AcpPermissionRequest): unknown | Promise<unknown>;
	sessionUpdate?(notification: AcpSessionNotification): void | Promise<void>;
	terminalOutput?(params: unknown): unknown | Promise<unknown>;
	waitForTerminalExit?(params: unknown): unknown | Promise<unknown>;
	writeTextFile?(params: unknown): unknown | Promise<unknown>;
}

export interface AcpClientInitializeParams {
	readonly clientCapabilities?: unknown;
	readonly clientInfo?: {
		readonly name: string;
		readonly version: string;
	};
	readonly protocolVersion?: number;
}

export interface AcpNewSessionParams {
	readonly additionalDirectories?: readonly string[];
	readonly cwd: string;
	readonly mcpServers?: readonly unknown[];
}

export interface AcpSetModelParams {
	readonly modelId: string;
	readonly sessionId: string;
}

export interface AcpPromptParams {
	readonly prompt: readonly unknown[];
	readonly sessionId: string;
}

export interface AcpManagedClient {
	readonly closed: boolean;
	initialize(params: AcpClientInitializeParams): Promise<unknown>;
	isClosed?(): boolean;
	newSession(
		params: AcpNewSessionParams,
		handlers?: AcpClientSessionHandlers,
	): Promise<AcpNewSessionInfo>;
	prompt(params: AcpPromptParams): Promise<unknown>;
	setModel?(params: AcpSetModelParams): Promise<void>;
	close(): Promise<void>;
}

/** Compatibility alias for callers that only need the structural client surface. */
export type AcpClientLike = AcpManagedClient;

export interface AcpSpawnSpec {
	readonly args: readonly string[];
	readonly capabilitiesKey: string;
	readonly command: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly key: string;
	readonly profile: ReadAcpProfile;
}

export interface AcpProcessManagerOptions {
	readonly connect: (spec: AcpSpawnSpec) => Promise<AcpManagedClient>;
	readonly hostEnv?: Readonly<Record<string, string | undefined>>;
	readonly initializeParams?: AcpClientInitializeParams;
	readonly now?: () => number;
	readonly reaperIntervalMs?: number;
	readonly sessionHandlers?: AcpClientSessionHandlers;
	readonly toolsRootDir?: string;
}

export interface AcpAcquireOptions {
	readonly capabilitiesKey?: string;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly hostEnv?: Readonly<Record<string, string | undefined>>;
	readonly initializeParams?: AcpClientInitializeParams;
	readonly maxConcurrency?: number;
	readonly maxConcurrentSessions?: number;
	readonly reuseProcess?: boolean;
	readonly sessionHandlers?: AcpClientSessionHandlers;
	readonly signal?: AbortSignal;
	readonly singleSessionOnly?: boolean;
	readonly toolsRootDir?: string;
}

export interface AcpWithSessionOptions extends AcpAcquireOptions {
	readonly additionalDirectories?: readonly string[];
	readonly handlers?: AcpClientSessionHandlers;
	readonly mcpServers?: readonly unknown[];
	readonly modelId?: string;
}

export interface AcpSessionContext extends AcpNewSessionInfo {
	readonly client: AcpManagedClient;
	readonly cwd: string;
	readonly info: AcpNewSessionInfo;
	readonly key: string;
	readonly profile: ReadAcpProfile;
	readonly session: AcpNewSessionInfo;
	readonly signal?: AbortSignal;
}

export interface AcpProcessSnapshot {
	readonly activeSessions: number;
	readonly capabilitiesKey: string;
	readonly closed: boolean;
	readonly createdAtMs: number;
	readonly cwd: string;
	readonly idleTtlMs: number;
	readonly key: string;
	readonly lastUsedAtMs: number;
	readonly profileId: string;
}

interface SessionWaiter {
	readonly cleanup: () => void;
	readonly limit: number;
	readonly reject: (error: unknown) => void;
	readonly resolve: () => void;
}

interface ManagedProcess {
	readonly capabilitiesKey: string;
	readonly createdAtMs: number;
	readonly cwd: string;
	readonly idleTtlMs: number;
	readonly key: string;
	readonly profileId: string;
	readonly waiters: SessionWaiter[];
	activeSessions: number;
	client: AcpManagedClient | undefined;
	connecting: Promise<AcpManagedClient> | undefined;
	invalidated: boolean;
	lastUsedAtMs: number;
}

export class AcpProcessManager {
	readonly #connect: (spec: AcpSpawnSpec) => Promise<AcpManagedClient>;
	readonly #hostEnv: Readonly<Record<string, string | undefined>> | undefined;
	readonly #initializeParams: AcpClientInitializeParams | undefined;
	readonly #now: () => number;
	readonly #processes = new Map<string, ManagedProcess>();
	readonly #reaperIntervalMs: number;
	readonly #sessionHandlers: AcpClientSessionHandlers | undefined;
	readonly #toolsRootDir: string | undefined;
	#disposed = false;
	#reaper: ReturnType<typeof setInterval> | undefined;

	constructor(options: AcpProcessManagerOptions) {
		this.#connect = options.connect;
		this.#hostEnv = options.hostEnv;
		this.#initializeParams = options.initializeParams;
		this.#now = options.now ?? Date.now;
		this.#reaperIntervalMs = Math.max(1, options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS);
		this.#sessionHandlers = options.sessionHandlers;
		this.#toolsRootDir = options.toolsRootDir;
	}

	async acquire(
		profile: ReadAcpProfile,
		options: AcpAcquireOptions = {},
	): Promise<AcpManagedClient> {
		const record = await this.#acquireRecord(profile, options);
		const client = record.client;
		if (client === undefined) throw new Error("ACP client failed to initialize");
		return client;
	}

	async withSession<T>(
		profile: ReadAcpProfile,
		options: AcpWithSessionOptions,
		fn: (session: AcpSessionContext) => Promise<T> | T,
	): Promise<T> {
		throwIfAborted(options.signal);
		const record = await this.#acquireRecord(profile, options);
		const client = record.client;
		if (client === undefined) throw new Error("ACP client failed to initialize");

		const limit = this.#sessionLimit(options);
		await this.#acquireSlot(record, limit, options.signal);
		try {
			throwIfAborted(options.signal);
			if (isClientClosed(client)) {
				this.#evictRecord(record);
				throw new Error("ACP client closed before session start");
			}
			const handlers = options.handlers ?? options.sessionHandlers ?? this.#sessionHandlers;
			const params: AcpNewSessionParams = {
				cwd: record.cwd,
				...(options.additionalDirectories === undefined
					? {}
					: { additionalDirectories: options.additionalDirectories }),
				...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
			};
			const info =
				handlers === undefined
					? await client.newSession(params)
					: await client.newSession(params, handlers);
			if (options.modelId !== undefined && client.setModel !== undefined) {
				await client.setModel({ modelId: options.modelId, sessionId: info.sessionId });
			}
			const context: AcpSessionContext = {
				...info,
				client,
				cwd: record.cwd,
				info,
				key: record.key,
				profile,
				session: info,
				sessionId: info.sessionId,
				...(options.signal === undefined ? {} : { signal: options.signal }),
			};
			return await fn(context);
		} finally {
			record.activeSessions = Math.max(0, record.activeSessions - 1);
			record.lastUsedAtMs = this.#now();
			this.#drainWaiters(record);
			if (isClientClosed(client)) this.#evictRecord(record);
		}
	}

	activeCount(): number {
		this.#pruneClosed();
		return this.#processes.size;
	}

	snapshot(): readonly AcpProcessSnapshot[] {
		this.#pruneClosed();
		return [...this.#processes.values()].map((record) => ({
			activeSessions: record.activeSessions,
			capabilitiesKey: record.capabilitiesKey,
			closed: record.client === undefined ? false : isClientClosed(record.client),
			createdAtMs: record.createdAtMs,
			cwd: record.cwd,
			idleTtlMs: record.idleTtlMs,
			key: record.key,
			lastUsedAtMs: record.lastUsedAtMs,
			profileId: record.profileId,
		}));
	}

	async invalidateProfile(profileId: string): Promise<void> {
		const records = [...this.#processes.values()].filter(
			(record) => record.profileId === profileId,
		);
		const closing: Promise<void>[] = [];
		for (const record of records) {
			record.invalidated = true;
			if (this.#processes.get(record.key) === record) this.#processes.delete(record.key);
			closing.push(this.#closeRecord(record));
		}
		await Promise.allSettled(closing);
	}

	async disposeAll(): Promise<void> {
		this.#disposed = true;
		if (this.#reaper !== undefined) {
			clearInterval(this.#reaper);
			this.#reaper = undefined;
		}
		const records = [...this.#processes.values()];
		this.#processes.clear();
		await Promise.allSettled(records.map((record) => this.#closeRecord(record)));
	}

	async reapIdle(): Promise<number> {
		const now = this.#now();
		const victims: ManagedProcess[] = [];
		for (const record of this.#processes.values()) {
			if (record.connecting !== undefined || record.activeSessions > 0) continue;
			const client = record.client;
			if (client === undefined) {
				victims.push(record);
				continue;
			}
			if (isClientClosed(client)) {
				victims.push(record);
				continue;
			}
			if (now - record.lastUsedAtMs > record.idleTtlMs) victims.push(record);
		}
		await Promise.allSettled(
			victims.map(async (record) => {
				this.#evictRecord(record);
				await this.#closeRecord(record);
			}),
		);
		return victims.length;
	}

	async sweepIdle(): Promise<number> {
		return this.reapIdle();
	}

	async #acquireRecord(
		profile: ReadAcpProfile,
		options: AcpAcquireOptions,
	): Promise<ManagedProcess> {
		this.#throwIfDisposed();
		throwIfAborted(options.signal);
		this.#ensureReaper();

		const cwd = options.cwd ?? profile.cwd ?? process.cwd();
		const capabilitiesKey = options.capabilitiesKey ?? "";
		const key =
			options.reuseProcess === true
				? profile.id
				: [profile.id, cwd, capabilitiesKey].join("\u0000");
		let record = this.#processes.get(key);
		if (record !== undefined && record.invalidated) {
			this.#evictRecord(record);
			record = undefined;
		}
		if (record !== undefined && record.client !== undefined && isClientClosed(record.client)) {
			this.#evictRecord(record);
			record = undefined;
		}
		if (record === undefined) {
			record = {
				activeSessions: 0,
				capabilitiesKey,
				client: undefined,
				connecting: undefined,
				createdAtMs: this.#now(),
				cwd,
				idleTtlMs: profile.idleTtlMs,
				invalidated: false,
				key,
				lastUsedAtMs: this.#now(),
				profileId: profile.id,
				waiters: [],
			};
			this.#processes.set(key, record);
		}
		try {
			await this.#ensureConnected(record, profile, options);
			return record;
		} catch (error) {
			if (
				this.#processes.get(key) === record &&
				record.client === undefined &&
				record.connecting === undefined
			) {
				this.#processes.delete(key);
			}
			throw error;
		}
	}

	async #ensureConnected(
		record: ManagedProcess,
		profile: ReadAcpProfile,
		options: AcpAcquireOptions,
	): Promise<AcpManagedClient> {
		if (record.client !== undefined && !isClientClosed(record.client)) {
			record.lastUsedAtMs = this.#now();
			return record.client;
		}
		if (record.connecting !== undefined) {
			const client = await awaitWithAbort(record.connecting, options.signal);
			if (record.client !== undefined) return record.client;
			if (record.invalidated || this.#processes.get(record.key) !== record) {
				throw new Error("ACP client was invalidated during startup");
			}
			record.client = client;
			record.lastUsedAtMs = this.#now();
			return client;
		}

		const hostEnv = options.hostEnv ?? this.#hostEnv;
		const toolsRootDir = options.toolsRootDir ?? this.#toolsRootDir;
		const spec: AcpSpawnSpec = {
			args: profile.args,
			capabilitiesKey: record.capabilitiesKey,
			command: profile.command,
			cwd: record.cwd,
			env: buildAcpProcessEnv({
				...(hostEnv === undefined ? {} : { hostEnv }),
				profileEnv: {
					...profile.env,
					...options.env,
				},
				...(toolsRootDir === undefined ? {} : { toolsRootDir }),
			}),
			key: record.key,
			profile,
		};

		const startup = this.#connectAndInitialize(spec, record, options);
		record.connecting = startup;
		try {
			const client = await awaitWithAbort(startup, options.signal, (lateClient) =>
				closeClient(lateClient),
			);
			if (record.invalidated || this.#processes.get(record.key) !== record) {
				await closeClient(client);
				throw new Error("ACP client was invalidated during startup");
			}
			record.client = client;
			record.lastUsedAtMs = this.#now();
			return client;
		} catch (error) {
			if (this.#processes.get(record.key) === record && record.client === undefined) {
				this.#processes.delete(record.key);
			}
			throw error;
		} finally {
			if (record.connecting === startup) record.connecting = undefined;
		}
	}

	async #connectAndInitialize(
		spec: AcpSpawnSpec,
		record: ManagedProcess,
		options: AcpAcquireOptions,
	): Promise<AcpManagedClient> {
		let client: AcpManagedClient | undefined;
		let closed = false;
		const close = async (): Promise<void> => {
			if (client === undefined || closed) return;
			closed = true;
			await closeClient(client);
		};
		try {
			client = await this.#connect(spec);
			if (isClientClosed(client)) throw new Error("ACP client connected in a closed state");
			await client.initialize(options.initializeParams ?? this.#initializeParams ?? {});
			if (this.#disposed || record.invalidated || this.#processes.get(record.key) !== record) {
				throw new Error("ACP client was invalidated during startup");
			}
			return client;
		} catch (error) {
			await close();
			throw error;
		}
	}

	#sessionLimit(options: AcpWithSessionOptions): number {
		if (options.singleSessionOnly === true) return 1;
		const configured = options.maxConcurrency ?? options.maxConcurrentSessions;
		if (configured === undefined) return Number.POSITIVE_INFINITY;
		return Math.max(1, Math.floor(configured));
	}

	#acquireSlot(
		record: ManagedProcess,
		limit: number,
		signal: AbortSignal | undefined,
	): Promise<void> {
		if (signal?.aborted === true) return Promise.reject(abortError());
		if (record.activeSessions < limit) {
			record.activeSessions += 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			let onAbort: (() => void) | undefined;
			const waiter: SessionWaiter = {
				cleanup: () => {
					if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
				},
				limit,
				reject,
				resolve,
			};
			onAbort = (): void => {
				const index = record.waiters.indexOf(waiter);
				if (index >= 0) record.waiters.splice(index, 1);
				reject(abortError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			record.waiters.push(waiter);
		});
	}

	#drainWaiters(record: ManagedProcess): void {
		while (record.waiters.length > 0) {
			const index = record.waiters.findIndex((waiter) => record.activeSessions < waiter.limit);
			if (index < 0) return;
			const [waiter] = record.waiters.splice(index, 1);
			if (waiter === undefined) return;
			waiter.cleanup();
			record.activeSessions += 1;
			waiter.resolve();
		}
	}

	#ensureReaper(): void {
		if (this.#disposed || this.#reaper !== undefined) return;
		this.#reaper = setInterval(() => {
			void this.reapIdle().catch(() => undefined);
		}, this.#reaperIntervalMs);
		this.#reaper.unref?.();
	}

	#evictRecord(record: ManagedProcess): void {
		if (this.#processes.get(record.key) === record) this.#processes.delete(record.key);
	}

	#pruneClosed(): void {
		for (const [key, record] of this.#processes) {
			if (record.client !== undefined && isClientClosed(record.client)) {
				this.#processes.delete(key);
			}
		}
	}

	async #closeRecord(record: ManagedProcess): Promise<void> {
		const client = record.client;
		if (client !== undefined) {
			await closeClient(client);
			return;
		}
		if (record.connecting !== undefined) {
			try {
				await record.connecting;
			} catch {
				return;
			}
			if (record.client !== undefined) await closeClient(record.client);
		}
	}

	#throwIfDisposed(): void {
		if (this.#disposed) throw new Error("ACP process manager is disposed");
	}
}

function isClientClosed(client: AcpManagedClient): boolean {
	return client.closed === true || client.isClosed?.() === true;
}

async function closeClient(client: AcpManagedClient): Promise<void> {
	if (isClientClosed(client)) return;
	try {
		await client.close();
	} catch {
		// Closing is best effort during eviction and shutdown.
	}
}

function abortError(): Error {
	const error = new Error("ACP operation aborted");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw abortError();
}

function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	onAbandon?: (value: T) => void | Promise<void>,
): Promise<T> {
	if (signal === undefined) return promise;
	const abandon = (): void => {
		if (onAbandon === undefined) return;
		void promise.then(
			(value) => onAbandon(value),
			() => undefined,
		);
	};
	if (signal.aborted) {
		abandon();
		return Promise.reject(abortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			abandon();
			reject(abortError());
		};
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}
