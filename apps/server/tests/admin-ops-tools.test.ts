import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import {
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
	workspaceSessions,
} from "@tsukaima/db";
import type { DurableExtension } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../src/logging.ts";
import {
	ADMIN_OPS_TOOL_NAMES,
	authorizeAdminOpsToolCall,
	buildAdminCommandEnv,
	createAdminOpsToolsExtension,
	type AdminOpsToolsOptions,
} from "../src/services/admin-ops-tools.ts";
import { resolveImCallerContext } from "../src/services/im-caller-context.ts";
import type { PluginSettingsStore } from "../src/services/plugin-settings.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const logger = {
	debug: () => undefined,
	info: () => undefined,
	trace: () => undefined,
	warn: () => undefined,
} as unknown as Logger;

function settingsWithAdmins(adminUsers: readonly string[]): PluginSettingsStore {
	return {
		read: async () => ({ adminUsers: [...adminUsers] }),
	} as unknown as PluginSettingsStore;
}

async function createHarness(): Promise<{
	readonly cleanup: () => Promise<void>;
	readonly database: TsukaimaDatabase;
	readonly directory: string;
	readonly opsRoot: string;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-ops-"));
	temporaryDirectories.push(directory);
	const opsRoot = join(directory, "ops");
	await fs.mkdir(opsRoot);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return {
		cleanup: async () => {
			try {
				(database as unknown as { $client?: { close?: () => void } }).$client?.close?.();
			} catch {}
			await fs.rm(directory, { force: true, recursive: true });
		},
		database,
		directory,
		opsRoot,
	};
}

async function seedConversation(
	database: TsukaimaDatabase,
	input: {
		readonly kind: "group" | "private" | "webui" | "workspace";
		readonly messages?: readonly { readonly senderExternalId: string }[];
		readonly platformConversationId?: string;
	},
): Promise<{
	readonly durableConversationId: string;
	readonly platformConversationId: string | undefined;
	readonly sessionId: string;
}> {
	const durableConversationId = `durable-${randomUUID()}`;
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	const platformConversationId = input.platformConversationId;
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: input.kind,
		...(platformConversationId === undefined ? {} : { platformConversationId }),
		title: "Synthetic admin ops chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: input.kind,
		...(platformConversationId === undefined ? {} : { platformConversationId }),
		title: "Synthetic admin ops chat",
		updatedAt: now,
	});
	if (input.kind === "workspace") {
		await database.insert(workspaceSessions).values({
			baseRef: "HEAD",
			chatObjectId: chatId,
			createdAtMs: Date.now(),
			id: sessionId,
			mode: "maintenance",
			repositoryRoot: process.cwd(),
			updatedAtMs: Date.now(),
			workspaceKind: "coding",
		});
	}
	let occurredAtMs = Date.now() - 60_000;
	for (const message of input.messages ?? []) {
		occurredAtMs += 1_000;
		await database.insert(messages).values({
			chatObjectId: chatId,
			contentText: "synthetic message",
			conversationId: sessionId,
			direction: "inbound",
			id: randomUUID(),
			ingestedAt: new Date(occurredAtMs).toISOString(),
			kind: "onebot-v11",
			occurredAt: new Date(occurredAtMs).toISOString(),
			platformMessageId: `msg-${randomUUID()}`,
			senderDisplayName: "Synthetic speaker",
			senderExternalId: message.senderExternalId,
		});
	}
	return { durableConversationId, platformConversationId, sessionId };
}

function resultText(result: unknown): string {
	const output = (result as { readonly output?: readonly unknown[] }).output;
	for (const part of output ?? []) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			return part.text;
		}
	}
	return "";
}

function decodeResult(result: unknown): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(resultText(result));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function extensionTool(extension: DurableExtension, name: string) {
	const found = (extension.tools ?? []).find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Tool ${name} missing from ${extension.name}`);
	return found;
}

async function invokeTool(
	extension: DurableExtension,
	name: string,
	args: Record<string, unknown>,
	durableConversationId: string,
) {
	const tool = extensionTool(extension, name);
	return await tool.execute(
		args,
		{ conversationId: durableConversationId } as unknown as Parameters<typeof tool.execute>[1],
		undefined as never,
	);
}

function createExtension(input: {
	readonly adminUsers: readonly string[];
	readonly database: TsukaimaDatabase;
	readonly opsRoot: string;
	readonly options?: Partial<
		Omit<AdminOpsToolsOptions, "allowedRoots" | "audit" | "authorize" | "logger">
	>;
	readonly turnBoundSender: string | null | undefined;
}): { readonly audits: AuditEntry[]; readonly extension: DurableExtension } {
	const audits: AuditEntry[] = [];
	const extension = createAdminOpsToolsExtension({
		allowedRoots: [input.opsRoot],
		audit: (entry) => {
			audits.push(entry);
		},
		authorize: async (durableConversationId, toolName) => {
			const caller = await resolveImCallerContext({
				conversationId: durableConversationId,
				database: input.database,
				...(input.turnBoundSender === undefined
					? {}
					: { overrides: { turnBoundSender: input.turnBoundSender } }),
				settings: settingsWithAdmins(input.adminUsers),
			});
			return authorizeAdminOpsToolCall({ caller, toolName });
		},
		...input.options,
		logger,
	});
	return { audits, extension };
}

describe("admin ops authorization", () => {
	test("webui and coding workspaces are allowed while sandbox workspaces and unknown kinds fail closed", () => {
		expect(
			authorizeAdminOpsToolCall({
				caller: { chatKind: "webui", domainConversationId: "session-synthetic" },
				toolName: "admin_exec",
			}),
		).toMatchObject({ allowed: true });
		expect(
			authorizeAdminOpsToolCall({
				caller: {
					chatKind: "workspace",
					domainConversationId: "session-synthetic",
					isAdmin: true,
					workspaceKind: "coding",
				},
				toolName: "admin_exec",
			}),
		).toMatchObject({ allowed: true });
		expect(
			authorizeAdminOpsToolCall({
				caller: {
					chatKind: "workspace",
					domainConversationId: "session-synthetic",
					isAdmin: false,
					workspaceKind: "sandbox",
				},
				toolName: "admin_exec",
			}),
		).toMatchObject({ allowed: false, reason: "admin_required" });
		for (const caller of [
			{},
			{ chatKind: "task" },
			{ chatKind: "plugin" },
			{ chatKind: "unknown" },
		] as const) {
			expect(authorizeAdminOpsToolCall({ caller, toolName: "admin_exec" })).toMatchObject({
				allowed: false,
				reason: "disallowed_chat_kind",
			});
		}
		expect(
			authorizeAdminOpsToolCall({
				caller: { chatKind: "webui" },
				toolName: "not_an_admin_tool",
			}),
		).toMatchObject({ allowed: false, reason: "unknown_admin_tool" });
	});

	test("non-admin IM private and group callers are denied", () => {
		for (const chatKind of ["private", "group"] as const) {
			expect(
				authorizeAdminOpsToolCall({
					caller: { chatKind, domainConversationId: "session-synthetic" },
					toolName: "admin_file_read",
				}),
			).toMatchObject({ allowed: false, reason: "admin_required" });
		}
	});

	test("admin IM caller with a turn-bound sender is allowed", () => {
		expect(
			authorizeAdminOpsToolCall({
				caller: {
					chatKind: "group",
					domainConversationId: "session-synthetic",
					isAdmin: true,
					senderPlatformId: "10002",
				},
				toolName: "admin_exec",
			}),
		).toMatchObject({ allowed: true, callerId: "10002", isAdmin: true });
	});

	test("webui and workspace resolve as admin while IM and synthetic kinds fail closed", async () => {
		const harness = await createHarness();
		try {
			for (const kind of ["webui", "workspace"] as const) {
				const session = await seedConversation(harness.database, { kind });
				const caller = await resolveImCallerContext({
					conversationId: session.durableConversationId,
					database: harness.database,
					settings: settingsWithAdmins([]),
				});
				expect(caller.chatKind).toBe(kind);
				expect(caller.isAdmin).toBe(true);
				expect(caller.role).toBe("admin");
			}
			const sandbox = await seedConversation(harness.database, { kind: "workspace" });
			await harness.database
				.update(workspaceSessions)
				.set({ workspaceKind: "sandbox" })
				.where(eq(workspaceSessions.id, sandbox.sessionId));
			const sandboxCaller = await resolveImCallerContext({
				conversationId: sandbox.durableConversationId,
				database: harness.database,
				settings: settingsWithAdmins([]),
			});
			expect(sandboxCaller.chatKind).toBe("workspace");
			expect(sandboxCaller.isAdmin).toBe(false);
			expect(sandboxCaller.role).toBeUndefined();
			const webui = await seedConversation(harness.database, { kind: "webui" });
			const explicitlyDenied = await resolveImCallerContext({
				conversationId: webui.durableConversationId,
				database: harness.database,
				overrides: { isAdmin: false },
				settings: settingsWithAdmins([]),
			});
			expect(explicitlyDenied.isAdmin).toBe(false);
			expect(explicitlyDenied.role).toBeUndefined();

			const privateChat = await seedConversation(harness.database, {
				kind: "private",
				messages: [{ senderExternalId: "10003" }],
				platformConversationId: "10003",
			});
			const nonAdminIm = await resolveImCallerContext({
				conversationId: privateChat.durableConversationId,
				database: harness.database,
				overrides: { turnBoundSender: "10003" },
				settings: settingsWithAdmins(["10002"]),
			});
			expect(nonAdminIm.chatKind).toBe("private");
			expect(nonAdminIm.isAdmin).toBeUndefined();
			expect(nonAdminIm.role).toBeUndefined();

			for (const chatKind of ["task", "plugin", "unknown"] as const) {
				const caller = await resolveImCallerContext({
					conversationId: "synthetic:unknown",
					database: undefined,
					overrides: { chatKind, turnBoundSender: "10002" },
					settings: settingsWithAdmins(["10002"]),
				});
				expect(caller.isAdmin).toBeUndefined();
				expect(caller.role).toBeUndefined();
			}
		} finally {
			await harness.cleanup();
		}
	});

	test("ADMIN_OPS_TOOL_NAMES is the complete admin surface", () => {
		expect([...ADMIN_OPS_TOOL_NAMES]).toEqual([
			"admin_exec",
			"admin_file_read",
			"admin_file_write",
			"admin_file_list",
		]);
	});
});

describe("admin ops runtime authorization", () => {
	test("a non-admin private chat is denied and audited", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, {
				kind: "private",
				messages: [{ senderExternalId: "10003" }],
				platformConversationId: "10003",
			});
			const { audits, extension } = createExtension({
				adminUsers: ["10002"],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: "10003",
			});
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "echo synthetic-denied" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("admin_required");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-ops.admin_exec",
				actorId: "10003",
				actorKind: "user",
				reason: "admin_required",
				result: "denied",
				targetKind: "admin-ops",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("non-admin group turn is denied even when an admin spoke earlier", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, {
				kind: "group",
				messages: [{ senderExternalId: "10002" }],
				platformConversationId: "20001",
			});
			// The ambient message would authorize an admin, but the turn-bound sender is the
			// non-admin group member who actually triggered this turn.
			const ambient = await resolveImCallerContext({
				conversationId: session.durableConversationId,
				database: harness.database,
				settings: settingsWithAdmins(["10002"]),
			});
			expect(ambient.isAdmin).toBe(true);
			const turnCaller = await resolveImCallerContext({
				conversationId: session.durableConversationId,
				database: harness.database,
				overrides: { turnBoundSender: "10003" },
				settings: settingsWithAdmins(["10002"]),
			});
			expect(turnCaller.senderPlatformId).toBe("10003");
			expect(turnCaller.isAdmin).toBeUndefined();
			expect(
				authorizeAdminOpsToolCall({
					caller: turnCaller,
					toolName: "admin_file_write",
				}),
			).toMatchObject({
				allowed: false,
				callerId: "10003",
				reason: "admin_required",
			});

			const { audits, extension } = createExtension({
				adminUsers: ["10002"],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: "10003",
			});
			const result = await invokeTool(
				extension,
				"admin_file_write",
				{ content: "synthetic", path: "denied.txt" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("admin_required");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-ops.admin_file_write",
				actorId: "10003",
				reason: "admin_required",
				result: "denied",
			});
			await expect(fs.stat(join(harness.opsRoot, "denied.txt"))).rejects.toThrow();
		} finally {
			await harness.cleanup();
		}
	});

	test("a proactive background turn with no turn-bound sender fails closed", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, {
				kind: "group",
				messages: [{ senderExternalId: "10002" }],
				platformConversationId: "20001",
			});
			const caller = await resolveImCallerContext({
				conversationId: session.durableConversationId,
				database: harness.database,
				overrides: { turnBoundSender: null },
				settings: settingsWithAdmins(["10002"]),
			});
			expect(caller.senderPlatformId).toBeUndefined();
			expect(caller.isAdmin).toBeUndefined();
			expect(authorizeAdminOpsToolCall({ caller, toolName: "admin_exec" })).toMatchObject({
				allowed: false,
				reason: "admin_required",
			});

			const { audits, extension } = createExtension({
				adminUsers: ["10002"],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: null,
			});
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "echo background-denied" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("admin_required");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-ops.admin_exec",
				reason: "admin_required",
				result: "denied",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("an admin IM turn is allowed and audited with the trusted caller identity", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, {
				kind: "group",
				messages: [{ senderExternalId: "10002" }],
				platformConversationId: "20001",
			});
			const { audits, extension } = createExtension({
				adminUsers: ["10002"],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: "10002",
			});
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "printf synthetic-admin-output" },
				session.durableConversationId,
			);
			expect(result.isError).toBeUndefined();
			expect(decodeResult(result)).toMatchObject({
				exitCode: 0,
				stdout: "synthetic-admin-output",
				timedOut: false,
			});
			expect(audits.at(-1)).toMatchObject({
				action: "admin-ops.admin_exec",
				actorId: "10002",
				actorKind: "user",
				payload: expect.objectContaining({
					callerId: "10002",
					chatKind: "group",
					channelId: "onebot",
					conversationId: session.durableConversationId,
					isAdmin: true,
					originSessionId: session.sessionId,
					platformConversationId: "20001",
				}),
				result: "ok",
				targetKind: "admin-ops",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("a WebUI conversation is allowed without an IM admin identity", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: undefined,
			});
			const write = await invokeTool(
				extension,
				"admin_file_write",
				{ content: "webui-content", path: "webui.txt" },
				session.durableConversationId,
			);
			expect(write.isError).toBeUndefined();
			const read = await invokeTool(
				extension,
				"admin_file_read",
				{ path: "webui.txt" },
				session.durableConversationId,
			);
			expect(decodeResult(read)).toMatchObject({
				content: "webui-content",
				truncated: false,
			});
			expect(audits.filter((entry) => entry.result === "ok")).toHaveLength(2);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("admin command environment", () => {
	test("curates locale, home, and PATH without copying host secrets", () => {
		const env = buildAdminCommandEnv({
			HOME: "/home/synthetic",
			LANG: "C.UTF-8",
			PATH: ["/usr/bin", "/usr/local/bin", "/home/synthetic/.local/bin", "/bin"].join(delimiter),
			SYNTHETIC_SECRET_VALUE: "do-not-copy",
		});
		expect(env).toEqual({
			HOME: "/home/synthetic",
			LANG: "C.UTF-8",
			PATH: ["/usr/local/bin", "/home/synthetic/.local/bin", "/usr/bin", "/bin"].join(delimiter),
			TZ: "UTC",
		});
		const withoutHome = buildAdminCommandEnv({ PATH: "/usr/bin:/bin" });
		expect(withoutHome).toEqual({
			LANG: "C.UTF-8",
			PATH: ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
			TZ: "UTC",
		});
		expect(withoutHome.HOME).toBeUndefined();
	});

	test("admin_exec inherits the curated PATH and HOME but no unrelated server env", async () => {
		const harness = await createHarness();
		const marker = "TSUKAIMA_SYNTHETIC_ADMIN_ENV_SECRET";
		const previous = process.env[marker];
		process.env[marker] = "synthetic-secret-value";
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				opsRoot: harness.opsRoot,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "env" },
				session.durableConversationId,
			);
			const output = String(decodeResult(result).stdout ?? "");
			expect(output).toContain("/usr/local/bin");
			if (process.env.HOME !== undefined) {
				expect(output).toContain(`HOME=${process.env.HOME}`);
			}
			expect(output).not.toContain(marker);
			expect(output).not.toContain("synthetic-secret-value");
		} finally {
			if (previous === undefined) delete process.env[marker];
			else process.env[marker] = previous;
			await harness.cleanup();
		}
	});
});

describe("admin ops execution safety", () => {
	test("commands are killed after the configured timeout", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				opsRoot: harness.opsRoot,
				options: { commandTimeoutMs: 40, maxCommandTimeoutMs: 40 },
				turnBoundSender: undefined,
			});
			const startedAt = performance.now();
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "sleep 2" },
				session.durableConversationId,
			);
			const elapsedMs = performance.now() - startedAt;
			expect(decodeResult(result)).toMatchObject({
				command: "sleep 2",
				timedOut: true,
			});
			expect(elapsedMs).toBeLessThan(1_500);
		} finally {
			await harness.cleanup();
		}
	});

	test("stdout is truncated at the configured byte cap", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				opsRoot: harness.opsRoot,
				options: { maxOutputBytes: 16 },
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"admin_exec",
				{ command: "printf 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'" },
				session.durableConversationId,
			);
			const decoded = decodeResult(result);
			expect(decoded.stdoutTruncated).toBe(true);
			expect(String(decoded.stdout).length).toBeLessThanOrEqual(16);
		} finally {
			await harness.cleanup();
		}
	});

	test("file read, write, list, and path allowlist behave safely", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				opsRoot: harness.opsRoot,
				options: { maxFileBytes: 64 },
				turnBoundSender: undefined,
			});
			const secret = "SYNTHETIC_SECRET_VALUE";
			const write = await invokeTool(
				extension,
				"admin_file_write",
				{ content: secret, path: "notes/secret.txt", createDirs: true },
				session.durableConversationId,
			);
			expect(write.isError).toBeUndefined();
			expect(decodeResult(write)).toMatchObject({
				bytesWritten: secret.length,
				path: join(harness.opsRoot, "notes", "secret.txt"),
			});
			const read = await invokeTool(
				extension,
				"admin_file_read",
				{ path: "notes/secret.txt" },
				session.durableConversationId,
			);
			expect(decodeResult(read)).toMatchObject({
				content: secret,
				truncated: false,
			});

			const oversized = "B".repeat(100);
			await fs.writeFile(join(harness.opsRoot, "large.txt"), oversized, "utf8");
			const truncatedRead = await invokeTool(
				extension,
				"admin_file_read",
				{ path: "large.txt" },
				session.durableConversationId,
			);
			const truncated = decodeResult(truncatedRead);
			expect(truncated.truncated).toBe(true);
			expect(String(truncated.content)).toHaveLength(64);

			const list = await invokeTool(
				extension,
				"admin_file_list",
				{ path: "." },
				session.durableConversationId,
			);
			const entries = (decodeResult(list).entries ?? []) as readonly {
				readonly name: string;
			}[];
			expect(entries.map((entry) => entry.name)).toEqual(
				expect.arrayContaining(["large.txt", "notes"]),
			);

			const escape = await invokeTool(
				extension,
				"admin_file_read",
				{ path: "../outside.txt" },
				session.durableConversationId,
			);
			expect(resultText(escape)).toContain("path_outside_allowed_roots");

			const writeTooLarge = await invokeTool(
				extension,
				"admin_file_write",
				{ content: oversized, path: "too-large.txt" },
				session.durableConversationId,
			);
			expect(writeTooLarge.isError).toBe(true);
			expect(resultText(writeTooLarge)).toContain("64 byte file limit");

			expect(JSON.stringify(audits)).not.toContain(secret);
			expect(JSON.stringify(audits)).not.toContain(oversized);
		} finally {
			await harness.cleanup();
		}
	});

	test("invalid authorization setups fail closed instead of allowing execution", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const audits: AuditEntry[] = [];
			const withoutAuthorizer = createAdminOpsToolsExtension({
				allowedRoots: [harness.opsRoot],
				audit: (entry) => {
					audits.push(entry);
				},
				logger,
			});
			const result = await invokeTool(
				withoutAuthorizer,
				"admin_exec",
				{ command: "echo should-not-run" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("authorization_unavailable");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-ops.admin_exec",
				reason: "authorization_unavailable",
				result: "denied",
			});
		} finally {
			await harness.cleanup();
		}
	});
});
