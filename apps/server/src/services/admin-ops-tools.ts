import { promises as fs } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { runManagedProcess } from "@tsukaima/coding";
import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ResolvedImCallerContext } from "./im-caller-context.ts";

export const ADMIN_OPS_TOOLS_EXTENSION_NAME = "tsukaima-admin-ops-tools";
export const ADMIN_OPS_TOOL_NAMES = [
	"admin_exec",
	"admin_file_read",
	"admin_file_write",
	"admin_file_list",
] as const;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 1_000;

/**
 * Curated environment for admin commands: locale, zone, home, and a PATH that reaches image
 * and per-user tooling. Arbitrary host environment (API keys, tokens, credentials) never
 * crosses into a spawned command.
 */
export function buildAdminCommandEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const home = env.HOME;
	const pathEntries = new Set<string>(["/usr/local/bin"]);
	if (home !== undefined && home.length > 0) pathEntries.add(join(home, ".local/bin"));
	for (const entry of (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter)) {
		if (entry.length > 0) pathEntries.add(entry);
	}
	return {
		LANG: env.LANG ?? "C.UTF-8",
		PATH: [...pathEntries].join(delimiter),
		TZ: env.TZ ?? "UTC",
		...(home === undefined || home.length === 0 ? {} : { HOME: home }),
	};
}

export interface AdminOpsAuthorization {
	readonly allowed: boolean;
	readonly callerId?: string;
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly isAdmin?: boolean;
	readonly platformConversationId?: string;
	readonly reason?: string;
	readonly sessionId?: string;
}

export interface AdminOpsToolsOptions {
	readonly allowedRoots?: readonly string[];
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	/**
	 * Fail-closed runtime authorization. A tool never executes without this callback, so a missing
	 * or throwing authorization check denies the call instead of falling back to an allow.
	 */
	readonly authorize?: (
		durableConversationId: string,
		toolName: string,
	) => Promise<AdminOpsAuthorization>;
	readonly commandTimeoutMs?: number;
	readonly logger: Logger;
	readonly maxCommandTimeoutMs?: number;
	readonly maxFileBytes?: number;
	readonly maxListEntries?: number;
	readonly maxOutputBytes?: number;
	/** Base root used for relative paths; the first allowed root unless configured separately. */
	readonly root?: string;
}

function baseAuthorization(
	caller: ResolvedImCallerContext,
): Omit<AdminOpsAuthorization, "allowed"> {
	return {
		...(caller.senderPlatformId === undefined ? {} : { callerId: caller.senderPlatformId }),
		...(caller.channelId === undefined ? {} : { channelId: caller.channelId }),
		...(caller.chatKind === undefined ? {} : { chatKind: caller.chatKind }),
		...(caller.isAdmin === undefined ? {} : { isAdmin: caller.isAdmin }),
		...(caller.platformConversationId === undefined
			? {}
			: { platformConversationId: caller.platformConversationId }),
		...(caller.domainConversationId === undefined
			? {}
			: { sessionId: caller.domainConversationId }),
	};
}

/**
 * Fail-closed admin authorization shared by the admin operations extension.
 *
 * `webui` is the single-admin authenticated surface. A coding `workspace` turn is admin-gated
 * by its resolved caller; a sandbox workspace always resolves `isAdmin: false` and is denied.
 * IM (`private`/`group`) requires a runtime-resolved trusted admin sender. A proactive/background
 * turn has no turn-bound sender, so `resolveImCallerContext` cannot resolve an admin and every
 * tool call is denied. Unknown kinds, missing callers, and transient read failures deny as well.
 */
export function authorizeAdminOpsToolCall(input: {
	readonly caller: ResolvedImCallerContext;
	readonly toolName: string;
}): AdminOpsAuthorization {
	const { caller, toolName } = input;
	const base = baseAuthorization(caller);
	if (!(ADMIN_OPS_TOOL_NAMES as readonly string[]).includes(toolName)) {
		return { ...base, allowed: false, reason: "unknown_admin_tool" };
	}
	const chatKind = caller.chatKind;
	if (chatKind === "webui") {
		return { ...base, allowed: true };
	}
	if (chatKind === "workspace") {
		return caller.isAdmin === true
			? { ...base, allowed: true }
			: { ...base, allowed: false, reason: "admin_required" };
	}
	if (chatKind !== "private" && chatKind !== "group") {
		return { ...base, allowed: false, reason: "disallowed_chat_kind" };
	}
	if (caller.isAdmin !== true || caller.senderPlatformId === undefined) {
		return { ...base, allowed: false, reason: "admin_required" };
	}
	return { ...base, allowed: true };
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function text(value: unknown): { output: { text: string; type: "text" }[] } {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text",
			},
		],
	};
}

function failure(error: unknown): {
	isError: true;
	output: { text: string; type: "text" }[];
} {
	return {
		isError: true,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text",
			},
		],
	};
}

function stringValue(
	input: Record<string, unknown>,
	key: string,
	required = false,
): string | undefined {
	const value = input[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
		if (!required && value.length === 0) return value;
	}
	if (required) throw new Error(`${key} is required`);
	return undefined;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), max);
}

function callerPayload(
	conversationId: string,
	auth: AdminOpsAuthorization | undefined,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		conversationId,
		...(auth?.sessionId === undefined ? {} : { originSessionId: auth.sessionId }),
		...(auth?.chatKind === undefined ? {} : { chatKind: auth.chatKind }),
		...(auth?.channelId === undefined ? {} : { channelId: auth.channelId }),
		...(auth?.platformConversationId === undefined
			? {}
			: { platformConversationId: auth.platformConversationId }),
		...(auth?.callerId === undefined ? {} : { callerId: auth.callerId }),
		...(auth?.isAdmin === undefined ? {} : { isAdmin: auth.isAdmin }),
		...extra,
	};
}

function redactAuditText(value: string): string {
	return value
		.replace(
			/\b(?:token|secret|password|passwd|api[_-]?key|authorization)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
			"[redacted]",
		)
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]");
}

function isWithinRoot(root: string, candidate: string): boolean {
	if (candidate === root) return true;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return candidate.startsWith(prefix);
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: string;
	readonly parameters: Record<string, unknown>;
}): DurableToolRegistration {
	return {
		deferred: true,
		description: input.description,
		execute: input.execute,
		name: input.name,
		parameters: input.parameters,
		surface: "both",
	};
}

const canonicalRoot = async (root: string): Promise<string> =>
	await fs.realpath(root).catch(() => resolve(root));

/**
 * Admin-only terminal and file operations. Every tool call has a fail-closed runtime
 * authorization check, a bounded working-directory allowlist, and a durable audit record
 * covering both allowed and denied calls.
 */
export function createAdminOpsToolsExtension(options: AdminOpsToolsOptions): DurableExtension {
	const roots = options.allowedRoots ?? [options.root ?? process.cwd()];
	const baseRoot = options.root ?? roots[0] ?? process.cwd();
	const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const maxCommandTimeoutMs = options.maxCommandTimeoutMs ?? DEFAULT_MAX_COMMAND_TIMEOUT_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxListEntries = options.maxListEntries ?? DEFAULT_MAX_LIST_ENTRIES;

	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("admin ops audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};

	/** Resolve a caller path under an allowed root and reject symlink escapes. */
	const safePath = async (inputPath: string, relativeBase = baseRoot): Promise<string> => {
		const requested = isAbsolute(inputPath) ? resolve(inputPath) : resolve(relativeBase, inputPath);
		const lexicalRoots = roots.map((root) => resolve(root));
		const matchingRoot = lexicalRoots.find((root) => isWithinRoot(root, requested));
		if (matchingRoot === undefined) throw new Error("path_outside_allowed_roots");
		const realRoot = await canonicalRoot(matchingRoot);
		let canonical: string;
		try {
			canonical = await fs.realpath(requested);
		} catch {
			const realParent = await canonicalRoot(dirname(requested));
			canonical = resolve(realParent, basename(requested));
		}
		if (!isWithinRoot(realRoot, canonical)) throw new Error("path_outside_allowed_roots");
		return canonical;
	};

	const run = async (
		name: string,
		conversationId: string,
		body: (auth: AdminOpsAuthorization) => Promise<unknown>,
		extraAudit?: (result: unknown) => Record<string, unknown>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| { isError: true; output: { text: string; type: "text" }[] }
	> => {
		let auth: AdminOpsAuthorization | undefined;
		if (options.authorize === undefined) {
			auth = { allowed: false, reason: "authorization_unavailable" };
		} else {
			try {
				auth = await options.authorize(conversationId, name);
			} catch {
				auth = { allowed: false, reason: "authorization_check_failed" };
			}
		}
		if (auth === undefined || !auth.allowed) {
			const reason = auth?.reason ?? "admin_ops_denied";
			await audit({
				action: `admin-ops.${name}`,
				...(auth?.callerId === undefined ? {} : { actorId: auth.callerId }),
				actorKind: auth?.callerId === undefined ? "agent" : "user",
				payload: callerPayload(conversationId, auth, { reason }),
				reason,
				result: "denied",
				...(auth?.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-ops",
			});
			options.logger.warn("admin ops tool denied", {
				callerId: auth?.callerId ?? null,
				chatKind: auth?.chatKind ?? null,
				conversationId,
				reason,
				tool: name,
			});
			return failure(new Error(reason));
		}
		const isImCaller = auth.chatKind === "private" || auth.chatKind === "group";
		try {
			const result = await body(auth);
			await audit({
				action: `admin-ops.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth, extraAudit?.(result)),
				result: "ok",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-ops",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await audit({
				action: `admin-ops.${name}`,
				...(isImCaller && auth.callerId !== undefined ? { actorId: auth.callerId } : {}),
				actorKind: isImCaller && auth.callerId !== undefined ? "user" : "agent",
				payload: callerPayload(conversationId, auth),
				reason: message,
				result: "failed",
				...(auth.sessionId === undefined ? {} : { targetId: auth.sessionId }),
				targetKind: "admin-ops",
			});
			options.logger.warn("admin ops tool failed", {
				conversationId,
				error: message,
				tool: name,
			});
			return failure(error);
		}
	};

	const exec = tool({
		description:
			"Admin-only terminal execution. Runs one command through /bin/bash in a validated working directory (defaults to the persistent data directory). Store downloaded Agent Skills under skills/<name>/ and local stdio MCP servers, virtualenvs, or binaries under mcp/<name>/ or mcp/bin/ inside the data directory—never in the repository checkout. Output is bounded and the command is killed after the configured timeout.",
		name: "admin_exec",
		parameters: {
			properties: {
				command: { type: "string" },
				cwd: { type: "string" },
				timeoutMs: { type: "number" },
			},
			required: ["command"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			const command = stringValue(input, "command", true)!;
			return await run(
				"admin_exec",
				String(api.conversationId),
				async () => {
					const cwdInput = stringValue(input, "cwd");
					const cwd = await safePath(cwdInput ?? ".");
					const stats = await fs.stat(cwd);
					if (!stats.isDirectory()) throw new Error("cwd must be a directory");
					const timeoutMs = positiveInteger(input.timeoutMs, commandTimeoutMs, maxCommandTimeoutMs);
					const result = await runManagedProcess({
						args: ["-c", command],
						command: "/bin/bash",
						cwd,
						env: buildAdminCommandEnv(),
						maxOutputBytes,
						timeoutMs,
					});
					return {
						command: redactAuditText(command),
						cwd,
						durationMs: result.durationMs,
						exitCode: result.exitCode,
						signal: result.signal,
						stderr: result.stderr,
						stderrTruncated: result.stderrTruncated,
						stdout: result.stdout,
						stdoutTruncated: result.stdoutTruncated,
						timedOut: result.timedOut,
					};
				},
				(result) => {
					const value = record(result);
					return {
						command: value.command,
						cwd: value.cwd,
						exitCode: value.exitCode,
						signal: value.signal,
						stderrTruncated: value.stderrTruncated,
						stdoutTruncated: value.stdoutTruncated,
						timedOut: value.timedOut,
					};
				},
			);
		},
	});

	const fileRead = tool({
		description:
			"Admin-only UTF-8 file read inside the allowlisted roots. Returns bounded content and reports truncation instead of reading an unbounded file.",
		name: "admin_file_read",
		parameters: {
			properties: {
				maxBytes: { type: "number" },
				path: { type: "string" },
			},
			required: ["path"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"admin_file_read",
				String(api.conversationId),
				async () => {
					const target = await safePath(stringValue(input, "path", true)!);
					const stats = await fs.stat(target);
					if (!stats.isFile()) throw new Error("path must be a regular file");
					const limit = positiveInteger(input.maxBytes, maxFileBytes, maxFileBytes);
					const handle = await fs.open(target, "r");
					try {
						const buffer = Buffer.alloc(limit);
						let offset = 0;
						while (offset < limit) {
							const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
							if (bytesRead <= 0) break;
							offset += bytesRead;
						}
						return {
							bytes: offset,
							content: buffer.subarray(0, offset).toString("utf8"),
							maxBytes: limit,
							path: target,
							totalBytes: stats.size,
							truncated: stats.size > offset,
						};
					} finally {
						await handle.close();
					}
				},
				(result) => {
					const value = record(result);
					return {
						bytes: value.bytes,
						path: value.path,
						truncated: value.truncated,
					};
				},
			);
		},
	});

	const fileWrite = tool({
		description:
			"Admin-only UTF-8 file write inside the allowlisted roots (relative paths resolve under the persistent data directory). Place downloaded skill or MCP files under skills/ or mcp/, never inside the repository checkout. The content is never copied into logs or audit records.",
		name: "admin_file_write",
		parameters: {
			properties: {
				content: { type: "string" },
				createDirs: { type: "boolean" },
				path: { type: "string" },
			},
			required: ["path", "content"],
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			const content = input.content;
			if (typeof content !== "string") throw new Error("content is required");
			return await run(
				"admin_file_write",
				String(api.conversationId),
				async () => {
					const bytes = Buffer.from(content, "utf8");
					if (bytes.length > maxFileBytes) {
						throw new Error(`content exceeds the configured ${maxFileBytes} byte file limit`);
					}
					const target = await safePath(stringValue(input, "path", true)!);
					if (input.createDirs === true) {
						await fs.mkdir(dirname(target), { recursive: true });
					}
					await fs.writeFile(target, bytes);
					return { bytesWritten: bytes.length, path: target };
				},
				(result) => {
					const value = record(result);
					return { bytesWritten: value.bytesWritten, path: value.path };
				},
			);
		},
	});

	const fileList = tool({
		description:
			"Admin-only directory listing inside the allowlisted roots (relative paths resolve under the persistent data directory). Entry names are bounded and no file content is read.",
		name: "admin_file_list",
		parameters: {
			properties: { path: { type: "string" } },
			type: "object",
		},
		async execute(args, api) {
			const input = record(args);
			return await run(
				"admin_file_list",
				String(api.conversationId),
				async () => {
					const target = await safePath(stringValue(input, "path") ?? ".");
					const stats = await fs.stat(target);
					if (!stats.isDirectory()) throw new Error("path must be a directory");
					const directoryEntries = await fs.readdir(target, { withFileTypes: true });
					const entries = directoryEntries
						.toSorted((left, right) => left.name.localeCompare(right.name))
						.slice(0, maxListEntries)
						.map((entry) => ({
							name: entry.name,
							...(entry.isDirectory()
								? { type: "directory" }
								: entry.isFile()
									? { type: "file" }
									: { type: "other" }),
						}));
					return {
						entries,
						path: target,
						total: directoryEntries.length,
						truncated: directoryEntries.length > maxListEntries,
					};
				},
				(result) => {
					const value = record(result);
					return { path: value.path, total: value.total, truncated: value.truncated };
				},
			);
		},
	});

	return {
		name: ADMIN_OPS_TOOLS_EXTENSION_NAME,
		tools: [exec, fileRead, fileWrite, fileList],
	};
}
