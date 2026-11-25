import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { isAdminMcpCaller } from "@tsukaima-plugin/mcp";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import { auditLog, chatObjects, conversations, messages, pluginInstallStates } from "@tsukaima/db";
import type { DurableExtension } from "@tsukaima/core";
import { PluginLifecycleError } from "@tsukaima/plugin-registry";
import {
	pluginManifestSchema,
	resolveToolName,
	type PluginManifest,
	type TsukaimaPlugin,
} from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";
import type { TsukaimaLifecycle } from "../src/lifecycle.ts";
import { resolveImCallerContext } from "../src/services/im-caller-context.ts";
import {
	authorizeSandboxToolCall,
	authorizeWorkspaceToolCall,
} from "../src/services/workspace-authorization.ts";
import type { PluginSettingsStore } from "../src/services/plugin-settings.ts";

const directories: string[] = [];
const lifecycles: TsukaimaLifecycle[] = [];

afterEach(async () => {
	await Promise.all(
		lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
	);
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

interface WireRequest {
	readonly messages?: readonly {
		readonly content?: unknown;
		readonly role: string;
		readonly tool_call_id?: string;
	}[];
	readonly tools?: readonly {
		readonly function?: { readonly name?: string };
		readonly name?: string;
	}[];
}

function toolNames(request: WireRequest): string[] {
	return (request.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? "");
}

function textResponse(content: string) {
	return {
		choices: [{ finish_reason: "stop", message: { content } }],
		id: `resp-${randomUUID()}`,
		model: "capture-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	};
}

function toolCallResponse(name: string, args: Record<string, unknown>, id: string) {
	return {
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: null,
					tool_calls: [
						{ function: { arguments: JSON.stringify(args), name }, id, type: "function" },
					],
				},
			},
		],
		id: `resp-${id}`,
		model: "capture-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	};
}

function parseOutput(content: unknown): Record<string, unknown> {
	if (typeof content !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(content);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return { raw: content };
	}
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (check()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function createHarness(
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-4-acceptance-"));
	directories.push(directory);
	const captured: WireRequest[] = [];
	const defaultFetch = async (
		_input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		captured.push(JSON.parse(String(init?.body ?? "{}")) as WireRequest);
		return Response.json(textResponse("ok"));
	};
	const fetchImplOrDefault = (fetchImpl ?? defaultFetch) as unknown as typeof fetch;
	const model = createOpenAICompatibleModelPort(
		{
			apiKey: "synthetic-api-key",
			baseUrl: "http://capture.invalid/v1",
			fetch: fetchImplOrDefault,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "capture-model" }],
	);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{ model },
	);
	await lifecycle.start();
	lifecycles.push(lifecycle);
	return { captured, directory, lifecycle };
}

function workspaceToolsExtension(lifecycle: TsukaimaLifecycle): DurableExtension {
	const extension = (lifecycle as unknown as { workspaceToolsExtension?: DurableExtension })
		.workspaceToolsExtension;
	if (extension === undefined) throw new Error("workspace tools extension missing");
	return extension;
}

function codingAgentToolsExtension(lifecycle: TsukaimaLifecycle): DurableExtension {
	const extension = (lifecycle as unknown as { codingAgentToolsExtension?: DurableExtension })
		.codingAgentToolsExtension;
	if (extension === undefined) throw new Error("coding agent tools extension missing");
	return extension;
}

function extensionTool(extension: DurableExtension, name: string) {
	const found = (extension.tools ?? []).find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Tool ${name} missing from ${extension.name}`);
	return found;
}

async function executeTool(
	extension: DurableExtension,
	name: string,
	args: Record<string, unknown>,
	durableConversationId: string,
) {
	const tool = extensionTool(extension, name);
	return await tool.execute(
		args,
		{ conversationId: Number(durableConversationId) } as unknown as Parameters<
			typeof tool.execute
		>[1],
		undefined as never,
	);
}

async function seedImSession(
	lifecycle: TsukaimaLifecycle,
	input: {
		readonly kind?: "group" | "private";
		readonly messages?: readonly {
			readonly occurredAt?: string;
			readonly senderExternalId: string;
		}[];
		readonly platformConversationId?: string;
	},
) {
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const kind = input.kind ?? "group";
	const platformConversationId = input.platformConversationId ?? "20001";
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind,
		platformConversationId,
		title: "Synthetic IM chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind,
		platformConversationId,
		title: "Synthetic IM chat",
		updatedAt: now,
	});
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
			occurredAt: message.occurredAt ?? new Date(occurredAtMs).toISOString(),
			platformMessageId: `msg-${randomUUID()}`,
			senderDisplayName: "Synthetic speaker",
			senderExternalId: message.senderExternalId,
		});
	}
	return { chatId, durableConversationId, sessionId, kind, platformConversationId };
}

function envelope(input: {
	readonly id: string;
	readonly text: string;
	readonly platformConversationId: string;
	readonly senderId: string;
}): MessageEnvelope {
	return {
		channelId: "onebot",
		channelKind: "onebot-v11",
		conversationKey: {
			groupId: input.platformConversationId,
			kind: "group",
			peerId: input.senderId,
		},
		id: input.id,
		mentions: [],
		parts: [{ text: input.text, type: "text" }],
		sender: { displayName: "Synthetic speaker", id: input.senderId, platformId: input.senderId },
		source: { messageId: input.id, receivedAtMs: Date.now(), timestampMs: Date.now() },
	};
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

function auditPayload(row: typeof auditLog.$inferSelect): Record<string, unknown> {
	if (row.payloadJson === null) return {};
	try {
		const parsed: unknown = JSON.parse(row.payloadJson);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

describe("IM-to-workspace delegation acceptance", () => {
	test("a fake model drives workspace_spawn -> workspace_status -> workspace_send with caller-scoped audits", async () => {
		const calls = new Map<string, string>();
		let finished = false;
		const scriptedFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
			const offered = toolNames(request);
			if (offered.includes("workspace_git_identity")) {
				return Response.json(textResponse("workspace task acknowledged"));
			}
			const last = request.messages?.at(-1);
			if (last?.role === "tool") {
				const name = calls.get(last.tool_call_id ?? "");
				const output = parseOutput(last.content);
				if (name === "workspace_spawn") {
					const id = `call-${calls.size + 1}`;
					const next = "workspace_status";
					calls.set(id, next);
					return Response.json(toolCallResponse(next, { sessionId: String(output.sessionId) }, id));
				}
				if (name === "workspace_status") {
					const id = `call-${calls.size + 1}`;
					const next = "workspace_send";
					calls.set(id, next);
					return Response.json(
						toolCallResponse(
							next,
							{ sessionId: String(output.sessionId), text: "Synthetic workspace follow-up" },
							id,
						),
					);
				}
				finished = true;
				return Response.json(textResponse("Delegation complete"));
			}
			if (offered.includes("workspace_spawn")) {
				const id = `call-${calls.size + 1}`;
				calls.set(id, "workspace_spawn");
				return Response.json(
					toolCallResponse("workspace_spawn", { goal: "Synthetic governed workspace task" }, id),
				);
			}
			return Response.json(textResponse("ok"));
		};

		const { lifecycle } = await createHarness(scriptedFetch as typeof fetch);
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "delegation-turn",
				platformConversationId: session.platformConversationId,
				senderId: "10002",
				text: "Please inspect the failing synthetic restart countdown.",
			}),
			forceSubmit: true,
			submittedAtMs: Date.now(),
		});
		await waitFor(() => (finished ? true : undefined));

		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const audits = await database.select().from(auditLog);
		const spawn = audits.find(
			(row) => row.action === "workspace-tool.workspace_spawn" && row.result === "ok",
		);
		const status = audits.find(
			(row) => row.action === "workspace-tool.workspace_status" && row.result === "ok",
		);
		const send = audits.find(
			(row) => row.action === "workspace-tool.workspace_send" && row.result === "ok",
		);
		expect(spawn).toBeDefined();
		expect(status).toBeDefined();
		expect(send).toBeDefined();
		for (const row of [spawn!, status!, send!]) {
			expect(row.actorId).toBe("10002");
			expect(row.actorKind).toBe("user");
			expect(auditPayload(row)).toEqual(
				expect.objectContaining({
					callerId: "10002",
					chatKind: "group",
					channelId: "onebot",
					conversationId: session.durableConversationId,
					isAdmin: true,
					originSessionId: session.sessionId,
					platformConversationId: session.platformConversationId,
				}),
			);
		}
		const spawnPayload = auditPayload(spawn!);
		const sendPayload = auditPayload(send!);
		expect(typeof spawnPayload.spawnedSessionId).toBe("string");
		expect(spawnPayload.taskId).toBeTruthy();
		expect(sendPayload.targetWorkspaceSessionId).toBe(spawnPayload.spawnedSessionId);
	});

	test("multi-speaker group chat resolves the latest non-admin after an admin and denies fail-closed", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [
				{ senderExternalId: "10002" },
				{ occurredAt: new Date(Date.now() + 1_000).toISOString(), senderExternalId: "10003" },
			],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const resolved = await resolveImCallerContext({
			conversationId: session.durableConversationId,
			database,
			settings: lifecycle.pluginSettings,
		});
		expect(resolved.userId).toBe("10003");
		expect(resolved.senderPlatformId).toBe("10003");
		expect(resolved.isAdmin).toBeUndefined();

		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic unauthorized task" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("admin_required");
		const audits = await database.select().from(auditLog);
		const denial = audits.find(
			(row) =>
				row.action === "workspace-tool.workspace_spawn" &&
				row.result === "denied" &&
				row.reason === "admin_required",
		);
		expect(denial).toBeDefined();
		expect(denial?.actorId).toBe("10003");
		expect(auditPayload(denial!)).toEqual(
			expect.objectContaining({
				callerId: "10003",
				chatKind: "group",
				originSessionId: session.sessionId,
				platformConversationId: session.platformConversationId,
			}),
		);
	});

	test("policy toggle off removes delegation visibility and denies a trusted admin at runtime", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		const enabledNames = (
			await host.inspectConversationContext(session.durableConversationId)
		)?.tools.map((tool) => tool.name);
		expect(enabledNames).toEqual(
			expect.arrayContaining([
				"workspace_spawn",
				"workspace_status",
				"workspace_send",
				"session_lookup",
				"schedule_create",
				"schedule_list",
				"schedule_cancel",
			]),
		);
		expect(enabledNames).not.toContain("schedule");
		expect(enabledNames).not.toContain("list");
		expect(enabledNames).not.toContain("cancel");

		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: false },
			scope: "conversation",
		});
		const disabledNames = (
			await host.inspectConversationContext(session.durableConversationId)
		)?.tools.map((tool) => tool.name);
		expect(disabledNames).not.toContain("workspace_spawn");
		expect(disabledNames).not.toContain("workspace_status");
		expect(disabledNames).not.toContain("workspace_send");
		expect(disabledNames).not.toContain("session_lookup");
		expect(disabledNames).not.toContain("hook_schedule");
		expect(disabledNames).not.toContain("hook_list");
		expect(disabledNames).not.toContain("workspace_git_identity");

		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic denied task" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("workspace_delegation_disabled");
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const audits = await database.select().from(auditLog);
		expect(
			audits.some(
				(row) =>
					row.action === "workspace-tool.workspace_spawn" &&
					row.result === "denied" &&
					row.reason === "workspace_delegation_disabled" &&
					row.actorId === "10002",
			),
		).toBe(true);
	});

	test("coding, database, and hook tools are denied and audited from IM", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const workspaceTools = workspaceToolsExtension(lifecycle);
		const codingTools = codingAgentToolsExtension(lifecycle);
		for (const tool of ["workspace_git_identity", "hook_schedule", "hook_list"]) {
			const result = await executeTool(
				workspaceTools,
				tool,
				tool === "hook_schedule" ? { prompt: "Synthetic hook", timing: "next-turn" } : {},
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
		}
		for (const tool of ["todo_write", "db_query"]) {
			const result = await executeTool(
				codingTools,
				tool,
				tool === "db_query" ? { sql: "SELECT 1" } : { items: [] },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("im_tool_not_permitted");
		}

		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const audits = await database.select().from(auditLog);
		expect(
			audits.some(
				(row) =>
					row.action === "workspace-tool.workspace_git_identity" &&
					row.result === "denied" &&
					row.reason === "workspace_coding_tool_denied",
			),
		).toBe(true);
		for (const tool of ["hook_schedule", "hook_list"]) {
			expect(
				audits.some(
					(row) =>
						row.action === `workspace-tool.${tool}` &&
						row.result === "denied" &&
						row.reason === "im_tool_not_permitted",
				),
			).toBe(true);
		}
		for (const tool of ["todo_write", "db_query"]) {
			expect(
				audits.some(
					(row) =>
						row.action === `coding-tool.${tool}` &&
						row.result === "denied" &&
						row.reason === "im_tool_not_permitted",
				),
			).toBe(true);
		}
	});
});

describe("resolveImCallerContext fail-closed edge cases", () => {
	test("missing database still returns only the channel id from a durable conversation key", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		const resolved = await resolveImCallerContext({
			conversationId: `onebot:${session.platformConversationId}`,
			database: undefined,
			settings: lifecycle.pluginSettings,
		});
		expect(resolved).toEqual({ channelId: "onebot" });
		expect(resolved.userId).toBeUndefined();
		expect(resolved.isAdmin).toBeUndefined();
	});

	test("malformed adminUsers entries are ignored and whitespace-trimmed identities still match", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		const malformed = {
			read(): Promise<Record<string, unknown>> {
				return Promise.resolve({
					adminUsers: [" 10002 ", 12_002, null, { id: "10003" }, "", "   "],
				});
			},
		} as unknown as PluginSettingsStore;
		const resolved = await resolveImCallerContext({
			conversationId: session.durableConversationId,
			database: lifecycle.domainDatabase,
			settings: malformed,
		});
		expect(resolved.userId).toBe("10002");
		expect(resolved.isAdmin).toBe(true);
		expect(resolved.role).toBe("admin");

		const nonArray = {
			read(): Promise<Record<string, unknown>> {
				return Promise.resolve({ adminUsers: "10002" });
			},
		} as unknown as PluginSettingsStore;
		const denied = await resolveImCallerContext({
			conversationId: session.durableConversationId,
			database: lifecycle.domainDatabase,
			settings: nonArray,
		});
		expect(denied.isAdmin).toBeUndefined();
		expect(denied.role).toBeUndefined();
	});

	test("private chats resolve their peer without inbound rows and leave a draft peer loadable", async () => {
		const { lifecycle } = await createHarness();
		const chat = await seedImSession(lifecycle, {
			kind: "private",
			messages: [],
			platformConversationId: "10002",
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		const resolved = await resolveImCallerContext({
			conversationId: chat.durableConversationId,
			database: lifecycle.domainDatabase,
			settings: lifecycle.pluginSettings,
		});
		expect(resolved.chatKind).toBe("private");
		expect(resolved.platformConversationId).toBe("10002");
		expect(resolved.userId).toBe("10002");
		expect(resolved.isAdmin).toBe(true);

		const host = lifecycle.conversationHost;
		const database = lifecycle.domainDatabase;
		if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
		const durableConversationId = await host.createConversation();
		const draftChatId = randomUUID();
		const draftSessionId = randomUUID();
		const now = new Date().toISOString();
		await database.insert(chatObjects).values({
			channelId: "onebot",
			createdAt: now,
			id: draftChatId,
			kind: "private",
			title: "Synthetic draft",
			updatedAt: now,
		});
		await database.insert(conversations).values({
			channelId: "onebot",
			chatObjectId: draftChatId,
			createdAt: now,
			durableConversationId,
			id: draftSessionId,
			isReceiving: 1,
			kind: "private",
			title: "Synthetic draft",
			updatedAt: now,
		});
		const draft = await resolveImCallerContext({
			conversationId: durableConversationId,
			database,
			settings: lifecycle.pluginSettings,
		});
		expect(draft.userId).toBeUndefined();
		expect(draft.isAdmin).toBeUndefined();
	});

	test("a domain database read error is caught and yields no caller identity", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		const throwing = {
			select() {
				throw new Error("synthetic database read failure");
			},
		} as unknown as Parameters<typeof resolveImCallerContext>[0]["database"];
		const resolved = await resolveImCallerContext({
			conversationId: session.durableConversationId,
			database: throwing,
			settings: lifecycle.pluginSettings,
		});
		expect(resolved).toEqual({});
	});

	test("same-millisecond inbound rows resolve the last inserted speaker by rowid", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const [source] = await database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, session.sessionId))
			.limit(1);
		if (source === undefined) throw new Error("seed message missing");
		await database.insert(messages).values({
			...source,
			contentText: "synthetic later message",
			id: randomUUID(),
			platformMessageId: `msg-${randomUUID()}`,
			senderExternalId: "10003",
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		const resolved = await resolveImCallerContext({
			conversationId: session.durableConversationId,
			database,
			settings: lifecycle.pluginSettings,
		});
		expect(resolved.userId).toBe("10003");
		expect(resolved.isAdmin).toBeUndefined();
	});
});

function manifestOnlyManifest(
	name: string,
	version: string,
	tools: PluginManifest["tools"] = [],
): PluginManifest {
	return pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "third-party",
		name,
		permissions: ["tools"],
		tools,
		version,
	});
}

describe("plugin runtime boundary", () => {
	test("tool-bearing non-builtin installs reject atomically without registry, DB, or migration state", async () => {
		const { directory, lifecycle } = await createHarness();
		const manifest = {
			apiVersion: "1",
			kind: "third-party" as const,
			migrations: { directory: "migrations" },
			name: "external-tool-plugin",
			permissions: ["tools"],
			tools: [
				{
					description: "Synthetic external tool",
					name: "external-tool-plugin.ping",
					parameters: { properties: {}, type: "object" },
					requiredPermissions: [],
				},
			],
			version: "1.0.0",
		};
		await expect(
			lifecycle.pluginHost.install(manifest, {
				migrations: [
					{
						rollbackSql: "DROP TABLE plugin_external_tool_plugin_items;",
						sql: "CREATE TABLE plugin_external_tool_plugin_items (id text primary key);",
						version: "1.0.0",
					},
				],
			}),
		).rejects.toThrow(PluginLifecycleError);
		expect((await lifecycle.pluginHost.list()).some((plugin) => plugin.id === manifest.name)).toBe(
			false,
		);
		expect(lifecycle.pluginHost.context(manifest.name)).toBeUndefined();
		expect(existsSync(lifecycle.pluginDatabases.pathFor(manifest.name))).toBe(false);
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const states = await database
			.select()
			.from(pluginInstallStates)
			.where(eq(pluginInstallStates.pluginId, manifest.name));
		expect(states).toHaveLength(0);
		expect(directory.length).toBeGreaterThan(0);
	});

	test("upgrade and downgrade reject introducing tools onto a manifest-only plugin", async () => {
		const { lifecycle } = await createHarness();
		const tool = {
			description: "Synthetic manifest tool",
			name: "manifest-only-plugin.ping",
			parameters: { properties: {}, type: "object" },
			requiredPermissions: [],
		};
		await lifecycle.pluginHost.install(manifestOnlyManifest("manifest-only-plugin", "1.0.0"), {
			migrations: [],
		});
		expect(
			(await lifecycle.pluginHost.list()).find((plugin) => plugin.id === "manifest-only-plugin")
				?.version,
		).toBe("1.0.0");
		await expect(
			lifecycle.pluginHost.upgrade(
				"manifest-only-plugin",
				manifestOnlyManifest("manifest-only-plugin", "2.0.0", [tool]),
			),
		).rejects.toThrow(PluginLifecycleError);
		const upgraded = (await lifecycle.pluginHost.list()).find(
			(plugin) => plugin.id === "manifest-only-plugin",
		);
		expect(upgraded?.version).toBe("1.0.0");
		expect(upgraded?.tools).toEqual([]);
		expect(
			lifecycle.pluginHost.tools().some((entry) => entry.name === "manifest-only-plugin.ping"),
		).toBe(false);

		const downgradeName = "manifest-only-downgrade";
		const downgradeManifest = (version: string, tools: PluginManifest["tools"] = []) =>
			manifestOnlyManifest(
				downgradeName,
				version,
				tools.map((entry) => ({ ...entry, name: `${downgradeName}.ping` })),
			);
		await lifecycle.pluginHost.install(downgradeManifest("2.0.0"), { migrations: [] });
		await expect(
			lifecycle.pluginHost.downgrade(
				downgradeName,
				downgradeManifest("1.0.0", [{ ...tool, name: `${downgradeName}.ping` }]),
			),
		).rejects.toThrow(PluginLifecycleError);
		expect(
			(await lifecycle.pluginHost.list()).find((plugin) => plugin.id === downgradeName)?.version,
		).toBe("2.0.0");
	});

	test("programmatic runtime module install exposes registered tools and uninstalls cleanly", async () => {
		const { lifecycle } = await createHarness();
		const manifest: PluginManifest = pluginManifestSchema.parse({
			apiVersion: "1",
			kind: "third-party",
			name: "runtime-tools",
			permissions: ["tools"],
			tools: [
				{
					description: "Synthetic runtime ping",
					name: "runtime-tools.ping",
					parameters: { properties: {}, type: "object" },
					requiredPermissions: [],
				},
			],
			version: "1.0.0",
		});
		const plugin: TsukaimaPlugin = {
			manifest,
			setup(context) {
				context.tools.register({
					description: "Synthetic runtime ping",
					execute: () => ({
						content: [{ text: "pong", type: "text" }],
					}),
					name: "runtime-tools.ping",
					parameters: { properties: {}, type: "object" },
					requiredPermissions: [],
				});
			},
		};
		const installed = await lifecycle.pluginHost.install(manifest, { plugin, migrations: [] });
		expect(installed.tools).toContain("runtime-tools.ping");
		expect(lifecycle.pluginHost.context("runtime-tools")).toBeDefined();
		const invoked = await lifecycle.pluginHost.invokeTool("runtime-tools.ping", {}, {});
		expect(invoked).toEqual(
			expect.objectContaining({
				ok: true,
				result: expect.objectContaining({
					content: [{ text: "pong", type: "text" }],
				}),
			}),
		);
		expect(await lifecycle.pluginHost.uninstall("runtime-tools", { retainData: false })).toBe(true);
		expect(lifecycle.pluginHost.context("runtime-tools")).toBeUndefined();
		expect(lifecycle.pluginHost.tools().some((tool) => tool.name === "runtime-tools.ping")).toBe(
			false,
		);
	});

	test("manifest-only installs keep the full install/upgrade/quarantine/recover/uninstall lifecycle", async () => {
		const { lifecycle } = await createHarness();
		const manifest = pluginManifestSchema.parse({
			apiVersion: "1",
			kind: "third-party",
			name: "manifest-only-lifecycle",
			permissions: [],
			version: "1.0.0",
		});
		await lifecycle.pluginHost.install(manifest, { migrations: [] });
		expect((await lifecycle.pluginHost.list()).some((plugin) => plugin.id === manifest.name)).toBe(
			true,
		);
		const upgraded = await lifecycle.pluginHost.upgrade(manifest.name, {
			...manifest,
			version: "2.0.0",
		});
		expect(upgraded.version).toBe("2.0.0");
		for (let index = 0; index < 3; index += 1) {
			await lifecycle.pluginHost.recordPluginFailure(manifest.name, "synthetic failure");
		}
		const quarantined = (await lifecycle.pluginHost.list()).find(
			(plugin) => plugin.id === manifest.name,
		);
		expect(quarantined?.lifecycle).toEqual(
			expect.objectContaining({
				failureCount: 3,
				quarantineReason: "synthetic failure",
			}),
		);
		expect(quarantined?.lifecycle?.quarantinedAt).not.toBeNull();
		const recovered = await lifecycle.pluginHost.recover(manifest.name);
		expect(recovered.lifecycle).toEqual(
			expect.objectContaining({ failureCount: 0, quarantinedAt: null }),
		);
		expect(await lifecycle.pluginHost.uninstall(manifest.name, { retainData: false })).toBe(true);
		expect((await lifecycle.pluginHost.list()).some((plugin) => plugin.id === manifest.name)).toBe(
			false,
		);
	});
});

describe("workspace caller authorization", () => {
	test("a domain DB read failure fails closed instead of allowing the workspace tool", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		const originalSelect = database.select;
		try {
			database.select = (() => {
				throw new Error("synthetic caller read failure");
			}) as typeof database.select;
			const denied = await executeTool(
				workspaceToolsExtension(lifecycle),
				"workspace_spawn",
				{ goal: "Synthetic unavailable-caller task" },
				session.durableConversationId,
			);
			expect(denied.isError).toBe(true);
			expect(resultText(denied)).toContain("disallowed_chat_kind");
		} finally {
			database.select = originalSelect;
		}
	});

	test("a settled turn's sender binding never authorizes the next turn", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const binding = lifecycle as unknown as {
			boundTurnSender(conversationId: string): string | null | undefined;
			noteTurnSender(turn: {
				conversationId: string;
				senderExternalId?: string;
				submissionRequestId: string;
			}): void;
			settleTurnSender(conversationId: string, submissionRequestId: string): void;
		};
		// The admin turn ended without an answer (empty final text or an interrupted run).
		binding.noteTurnSender({
			conversationId: session.durableConversationId,
			senderExternalId: "10002",
			submissionRequestId: "synthetic-settled-turn",
		});
		binding.settleTurnSender(session.durableConversationId, "synthetic-settled-turn");
		expect(binding.boundTurnSender(session.durableConversationId)).toBeUndefined();

		// The next turn's non-admin sender is authoritative even though an admin spoke last.
		binding.noteTurnSender({
			conversationId: session.durableConversationId,
			senderExternalId: "10003",
			submissionRequestId: "synthetic-next-turn",
		});
		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic next-turn task" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("admin_required");
	});

	test("an ambient admin message cannot upgrade a turn bound to a non-admin sender", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("database missing");
		// The active turn was triggered by the non-admin sender. Bind it exactly as
		// `onTurnAdmitted` does before an admin speaks ambiently.
		const noteTurnSender = (
			lifecycle as unknown as {
				noteTurnSender(turn: {
					conversationId: string;
					senderExternalId?: string;
					submissionRequestId: string;
				}): void;
			}
		).noteTurnSender.bind(lifecycle);
		noteTurnSender({
			conversationId: session.durableConversationId,
			senderExternalId: "10003",
			submissionRequestId: "synthetic-ambient-turn",
		});
		await database.insert(messages).values({
			chatObjectId: session.chatId ?? undefined,
			contentText: "synthetic ambient admin message",
			conversationId: session.sessionId,
			direction: "inbound",
			id: randomUUID(),
			ingestedAt: new Date().toISOString(),
			kind: "onebot-v11",
			occurredAt: new Date(Date.now() + 5_000).toISOString(),
			platformMessageId: `msg-${randomUUID()}`,
			senderDisplayName: "Synthetic admin",
			senderExternalId: "10002",
		});
		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic TOCTOU task" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("admin_required");
		const audits = await database.select().from(auditLog);
		const denial = audits.find(
			(row) => row.action === "workspace-tool.workspace_spawn" && row.result === "denied",
		);
		expect(auditPayload(denial!)).toEqual(
			expect.objectContaining({ callerId: "10003", reason: "admin_required" }),
		);
	});
});

function lastUserText(request: WireRequest): string {
	for (const message of [...(request.messages ?? [])].toReversed()) {
		if (message.role !== "user") continue;
		return typeof message.content === "string"
			? message.content
			: JSON.stringify(message.content ?? "");
	}
	return "";
}

describe("scheduled chat execution", () => {
	test("runs a separate scheduled instruction, dedupes its continuation, and rechecks MCP authority", async () => {
		const scheduledInputs: string[] = [];
		const mcpDecisions: boolean[] = [];
		const continuationIds: string[] = [];
		const completed: string[] = [];
		let mcpName = "";
		let rootId: string | undefined;
		const { lifecycle } = await createHarness(async (_input, init) => {
			const request = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
			const task = lastUserText(request);
			const last = request.messages?.at(-1);
			if (task.includes("Synthetic request to schedule a check")) {
				if (last?.role === "tool") {
					rootId = String(parseOutput(last.content).scheduleId);
					return Response.json(textResponse("Synthetic schedule created"));
				}
				return Response.json(
					toolCallResponse(
						"schedule_create",
						{
							delayMs: 3_600_000,
							prompt: "Synthetic first check",
							timeZone: "Asia/Taipei",
						},
						"create-check",
					),
				);
			}
			if (!task.includes("[Scheduled task]") || !task.includes("Synthetic")) {
				return Response.json(textResponse("Synthetic chat reply"));
			}
			if (last?.role !== "tool") {
				scheduledInputs.push(task);
				return Response.json(toolCallResponse(mcpName, {}, `mcp-check-${scheduledInputs.length}`));
			}
			if (task.includes("Synthetic next check") || task.includes("Synthetic WebUI check")) {
				completed.push(task);
				return Response.json(textResponse("Synthetic check finished"));
			}
			if (last.tool_call_id?.startsWith("mcp-check")) {
				return Response.json(
					toolCallResponse(
						"schedule_continue",
						{
							delayMs: 3_600_000,
							prompt: "Synthetic next check",
						},
						"continue-once",
					),
				);
			}
			const next = parseOutput(last.content);
			continuationIds.push(String(next.scheduleId));
			if (last.tool_call_id === "continue-once") {
				return Response.json(
					toolCallResponse(
						"schedule_continue",
						{
							delayMs: 7_200_000,
							prompt: "Synthetic duplicate check",
						},
						"continue-twice",
					),
				);
			}
			completed.push(task);
			return Response.json(textResponse("Synthetic first check finished"));
		});
		const session = await seedImSession(lifecycle, {});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		const mcp = lifecycle.pluginHost.context("mcp");
		if (mcp === undefined) throw new Error("MCP plugin missing");
		const fakeTool = "mcp.synthetic.check";
		mcp.tools.register({
			description: "Check synthetic state",
			execute: async (_input, invocation) => {
				const allowed = isAdminMcpCaller(invocation);
				mcpDecisions.push(allowed);
				return {
					content: [{ text: allowed ? "Synthetic MCP ok" : "admin_required", type: "text" }],
				};
			},
			name: fakeTool,
			parameters: { type: "object" },
			policy: { lazy: false },
			requiredPermissions: [],
		});
		mcpName = lifecycle.pluginHost.modelToolNames("mcp").find((name) => name.includes("check"))!;
		expect(mcpName).toBeDefined();
		const host = lifecycle.conversationHost!;
		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "synthetic-schedule-admin",
				platformConversationId: session.platformConversationId,
				senderId: "10002",
				text: "Synthetic request to schedule a check",
			}),
			forceSubmit: true,
			submittedAtMs: Date.now(),
		});
		const root = await waitFor(() => rootId);
		expect((await lifecycle.schedules.get(root))?.ownerId).toBe("10002");
		await host.append({
			collectOnly: true,
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "synthetic-unrelated-message",
				platformConversationId: session.platformConversationId,
				senderId: "10003",
				text: "Synthetic unrelated chat already resolved",
			}),
			submittedAtMs: Date.now(),
		});
		const occurrence = await lifecycle.schedules.runNow(root);
		await waitUntil(() => completed.length === 1);
		expect(scheduledInputs[0]).toContain(occurrence.scheduledFor);
		expect(scheduledInputs[0]).toContain("Asia/Taipei");
		expect(scheduledInputs[0]).toContain("send the reminder anew");
		expect(scheduledInputs[0]).not.toContain("Synthetic unrelated chat already resolved");
		expect(mcpDecisions).toEqual([true]);
		expect(continuationIds).toHaveLength(2);
		expect(continuationIds[0]).toBe(continuationIds[1]);
		const child = await lifecycle.schedules.get(continuationIds[0]!);
		expect(child?.ownerId).toBe("10002");
		expect(child?.prompt).toBe("Synthetic next check");
		expect(child?.timeZone).toBe("Asia/Taipei");

		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: [] });
		await lifecycle.schedules.runNow(child!.id);
		await waitUntil(() => completed.length === 2);
		expect(mcpDecisions).toEqual([true, false]);
		expect(await lifecycle.schedules.list({ sessionId: session.sessionId })).toHaveLength(2);

		const webui = await lifecycle.schedules.create({
			actionKind: "agent_turn",
			ownerId: "webui-admin",
			ownerKind: "user",
			prompt: "Synthetic WebUI check",
			recurrence: { at: new Date(Date.now() + 3_600_000).toISOString(), kind: "once" },
			source: "webui",
			targetSessionId: session.sessionId,
			timeZone: "UTC",
			title: "Synthetic WebUI schedule",
		});
		await lifecycle.schedules.runNow(webui.id);
		await waitUntil(() => completed.length === 3);
		expect(mcpDecisions).toEqual([true, false, true]);
	});
});

async function waitForDenialAudit(
	lifecycle: TsukaimaLifecycle,
	callerId: string,
	timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("database missing");
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const rows = await database.select().from(auditLog);
		const denial = rows.find(
			(row) =>
				row.action === "workspace-tool.workspace_spawn" &&
				row.result === "denied" &&
				auditPayload(row).callerId === callerId,
		);
		if (denial !== undefined) return auditPayload(denial);
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for the ${callerId} denial audit`);
}

/** Stalls the admin run so the test can settle or steer it before it answers. */
function slowAdminFetch(adminMarker: string, followUpMarker?: string) {
	return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
		const last = request.messages?.at(-1);
		if (followUpMarker !== undefined && lastUserText(request).includes(followUpMarker)) {
			if (last?.role === "tool") return Response.json(textResponse("Synthetic follow-up done"));
			const id = `call-${randomUUID()}`;
			return Response.json(
				toolCallResponse("workspace_spawn", { goal: "Synthetic denied delegation" }, id),
			);
		}
		if (lastUserText(request).includes(adminMarker)) {
			await new Promise<void>((resolve) => {
				if (init?.signal?.aborted === true) return resolve();
				const timer = setTimeout(resolve, 800);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			return Response.json(textResponse("slow synthetic admin answer"));
		}
		return Response.json(textResponse("ok"));
	};
}

describe("submission-scoped turn sender binding", () => {
	interface AdmittedBindingTurn {
		readonly conversationId: string;
		readonly senderExternalId?: string;
		readonly submissionRequestId: string;
		readonly midRun?: boolean;
		readonly whenBusy?: "steer" | "follow-up";
	}

	function senderBinding(lifecycle: TsukaimaLifecycle): {
		boundTurnSender: (conversationId: string) => string | null | undefined;
		noteTurnSender: (turn: AdmittedBindingTurn) => void;
		settleTurnSender: (conversationId: string, submissionRequestId: string) => void;
	} {
		return lifecycle as unknown as {
			boundTurnSender: (conversationId: string) => string | null | undefined;
			noteTurnSender: (turn: AdmittedBindingTurn) => void;
			settleTurnSender: (conversationId: string, submissionRequestId: string) => void;
		};
	}

	test("an admin turn ending with empty final text never authorizes the next non-admin turn", async () => {
		let adminSendAttempted = false;
		const scriptedFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
			const last = request.messages?.at(-1);
			if (lastUserText(request).includes("synthetic non-admin follow-up")) {
				if (last?.role === "tool") return Response.json(textResponse("Synthetic follow-up done"));
				const id = `call-${randomUUID()}`;
				return Response.json(
					toolCallResponse("workspace_spawn", { goal: "Synthetic denied delegation" }, id),
				);
			}
			if (last?.role === "tool") return Response.json(textResponse(""));
			const sendTool = toolNames(request).find(
				(name) => resolveToolName(name) === "onebot-napcat.send",
			);
			expect(sendTool).toBeDefined();
			adminSendAttempted = true;
			const id = `call-${randomUUID()}`;
			return Response.json(toolCallResponse(sendTool!, { text: "synthetic direct send" }, id));
		};

		const { lifecycle } = await createHarness(scriptedFetch as typeof fetch);
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		const binding = senderBinding(lifecycle);
		const now = Date.now();
		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "turn-one-direct-send",
				platformConversationId: session.platformConversationId,
				senderId: "10002",
				text: "synthetic admin direct send",
			}),
			forceSubmit: true,
			submittedAtMs: now,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10002");
		// Empty final text means `onAnswer` never fires; settlement must still release the turn.
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === undefined);
		expect(adminSendAttempted).toBe(true);

		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "turn-two-follow-up",
				platformConversationId: session.platformConversationId,
				senderId: "10003",
				text: "synthetic non-admin follow-up",
			}),
			forceSubmit: true,
			submittedAtMs: now + 1,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10003");
		const denial = await waitForDenialAudit(lifecycle, "10003");
		expect(denial).toEqual(expect.objectContaining({ reason: "admin_required" }));
	});

	test("an interrupted admin turn never authorizes the next non-admin turn", async () => {
		const scriptedFetch = slowAdminFetch(
			"synthetic admin interrupted turn",
			"synthetic non-admin after interrupt",
		);

		const { lifecycle } = await createHarness(scriptedFetch as typeof fetch);
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		const binding = senderBinding(lifecycle);
		const now = Date.now();
		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "interrupted-admin-turn",
				platformConversationId: session.platformConversationId,
				senderId: "10002",
				text: "synthetic admin interrupted turn",
			}),
			forceSubmit: true,
			submittedAtMs: now,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10002");
		await host.abortConversation(session.durableConversationId);
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === undefined);

		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "after-interrupt-follow-up",
				platformConversationId: session.platformConversationId,
				senderId: "10003",
				text: "synthetic non-admin after interrupt",
			}),
			forceSubmit: true,
			submittedAtMs: now + 1,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10003");
		const denial = await waitForDenialAudit(lifecycle, "10003");
		expect(denial).toEqual(expect.objectContaining({ reason: "admin_required" }));
	});

	test("a non-admin steer into an admin run makes the merged run fail closed", async () => {
		const scriptedFetch = slowAdminFetch("synthetic admin running turn");

		const { lifecycle } = await createHarness(scriptedFetch as typeof fetch);
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		const binding = senderBinding(lifecycle);
		const now = Date.now();
		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "admin-running-turn",
				platformConversationId: session.platformConversationId,
				senderId: "10002",
				text: "synthetic admin running turn",
			}),
			forceSubmit: true,
			submittedAtMs: now,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10002");

		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "non-admin-steer",
				platformConversationId: session.platformConversationId,
				senderId: "10003",
				text: "synthetic non-admin steer",
			}),
			forceSubmit: true,
			submittedAtMs: now + 1,
			whenBusy: "steer",
		});
		// The steer is inserted after the admin's entry, and the mixed run fails closed.
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === null);
		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic mixed-speaker delegation" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("admin_required");
		await host.abortConversation(session.durableConversationId);
	});

	test("a refused submit rolls its sender binding back instead of polluting the next turn", async () => {
		const { lifecycle } = await createHarness();
		const session = await seedImSession(lifecycle, {
			messages: [{ senderExternalId: "10002" }],
		});
		await lifecycle.updatePluginConfig("onebot-napcat", { adminUsers: ["10002"] });
		await lifecycle.conversationPolicy.update({
			conversationId: session.sessionId,
			policy: { workspaceDelegationEnabled: true },
			scope: "conversation",
		});
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("host missing");
		const binding = senderBinding(lifecycle);
		const options = (
			host as unknown as {
				options: {
					onTurnAdmitted: ((turn: AdmittedBindingTurn) => Promise<void> | void) | undefined;
				};
			}
		).options;
		const originalAdmission = options.onTurnAdmitted;
		let refused = false;
		try {
			// Refuse the submit after the binding was announced, exactly as a failing commit does.
			options.onTurnAdmitted = async (turn) => {
				await originalAdmission?.(turn);
				refused = true;
				throw new Error("synthetic refused submit");
			};
			const now = Date.now();
			await expect(
				host.append({
					conversationId: session.durableConversationId,
					envelope: envelope({
						id: "refused-admin-turn",
						platformConversationId: session.platformConversationId,
						senderId: "10002",
						text: "synthetic refused admin turn",
					}),
					forceSubmit: true,
					submittedAtMs: now,
				}),
			).rejects.toThrow("synthetic refused submit");
		} finally {
			options.onTurnAdmitted = originalAdmission;
		}
		expect(refused).toBe(true);
		expect(binding.boundTurnSender(session.durableConversationId)).toBeUndefined();

		await host.append({
			conversationId: session.durableConversationId,
			envelope: envelope({
				id: "after-refused-turn",
				platformConversationId: session.platformConversationId,
				senderId: "10003",
				text: "synthetic non-admin after refusal",
			}),
			forceSubmit: true,
			submittedAtMs: Date.now() + 1,
		});
		await waitUntil(() => binding.boundTurnSender(session.durableConversationId) === "10003");
		const denied = await executeTool(
			workspaceToolsExtension(lifecycle),
			"workspace_spawn",
			{ goal: "Synthetic next-turn delegation" },
			session.durableConversationId,
		);
		expect(denied.isError).toBe(true);
		expect(resultText(denied)).toContain("admin_required");
	});
});

describe("plugin runtime boundary: kind and restart bypass vectors", () => {
	test("a builtin-labelled manifest without a runtime module still cannot declare tools", async () => {
		const { lifecycle } = await createHarness();
		const manifest = {
			...manifestOnlyManifest("builtin-tool-plugin", "1.0.0", [
				{
					description: "Synthetic builtin tool",
					name: "builtin-tool-plugin.ping",
					parameters: { properties: {}, type: "object" },
					requiredPermissions: [],
				},
			]),
			kind: "builtin" as const,
		};
		await expect(lifecycle.pluginHost.install(manifest, { migrations: [] })).rejects.toThrow(
			PluginLifecycleError,
		);
		expect((await lifecycle.pluginHost.list()).some((plugin) => plugin.id === manifest.name)).toBe(
			false,
		);
	});

	test("a restart cannot turn a manifest-only plugin into a runtime plugin", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-runtime-restart-"));
		directories.push(directory);
		const config = {
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		};
		const first = createApp(config);
		lifecycles.push(first.lifecycle);
		await first.lifecycle.start();
		await first.lifecycle.pluginHost.install(
			manifestOnlyManifest("restart-manifest-plugin", "1.0.0"),
			{ migrations: [] },
		);
		await first.lifecycle.stop();

		// A fresh process only sees persisted install state; the runtime module set is empty.
		const second = createApp(config);
		lifecycles.push(second.lifecycle);
		await second.lifecycle.start();
		await expect(
			second.lifecycle.pluginHost.upgrade(
				"restart-manifest-plugin",
				manifestOnlyManifest("restart-manifest-plugin", "2.0.0", [
					{
						description: "Synthetic restart tool",
						name: "restart-manifest-plugin.ping",
						parameters: { properties: {}, type: "object" },
						requiredPermissions: [],
					},
				]),
			),
		).rejects.toThrow(PluginLifecycleError);
	});
});

describe("workspace tool authorization matrix", () => {
	test("workspace chats may use coding tools but never spawn another workspace", () => {
		const spawn = authorizeWorkspaceToolCall({
			caller: { chatKind: "workspace", domainConversationId: "session-1" },
			toolName: "workspace_spawn",
		});
		expect(spawn).toMatchObject({ allowed: false, reason: "workspace_spawn_not_permitted" });
		expect(
			authorizeWorkspaceToolCall({
				caller: { chatKind: "workspace", domainConversationId: "session-1" },
				toolName: "workspace_git_identity",
			}).allowed,
		).toBe(true);
		expect(
			authorizeWorkspaceToolCall({
				caller: { chatKind: "webui", domainConversationId: "session-1" },
				toolName: "workspace_git_identity",
			}),
		).toMatchObject({ allowed: false, reason: "workspace_coding_tool_denied" });
		expect(
			authorizeWorkspaceToolCall({
				caller: { chatKind: "webui", domainConversationId: "session-1" },
				toolName: "workspace_spawn",
			}).allowed,
		).toBe(true);
		for (const chatKind of [undefined, "task", "plugin"] as const) {
			expect(
				authorizeWorkspaceToolCall({
					caller: {
						...(chatKind === undefined ? {} : { chatKind }),
						domainConversationId: "session-1",
					},
					toolName: "workspace_spawn",
				}),
			).toMatchObject({ allowed: false, reason: "disallowed_chat_kind" });
		}
	});

	test("sandbox tools allow ordinary IM senders while coding delegation stays admin-only", () => {
		const policy = { sandboxWorkspaceEnabled: true };
		for (const chatKind of ["private", "group"] as const) {
			expect(
				authorizeSandboxToolCall({
					caller: {
						chatKind,
						domainConversationId: "session-1",
						isAdmin: false,
						senderPlatformId: "synthetic-user",
					},
					policy,
					toolName: "sandbox_spawn",
				}).allowed,
			).toBe(true);
			expect(
				authorizeWorkspaceToolCall({
					caller: {
						chatKind,
						domainConversationId: "session-1",
						isAdmin: false,
						senderPlatformId: "synthetic-user",
					},
					policy: { workspaceDelegationEnabled: true },
					toolName: "workspace_spawn",
				}),
			).toMatchObject({ allowed: false, reason: "admin_required" });
		}
	});

	test("sandbox tools fail closed for disabled policy, missing senders, and non-chat surfaces", () => {
		expect(
			authorizeSandboxToolCall({
				caller: {
					chatKind: "group",
					domainConversationId: "session-1",
					isAdmin: false,
				},
				policy: { sandboxWorkspaceEnabled: true },
				toolName: "sandbox_spawn",
			}),
		).toMatchObject({ allowed: false, reason: "sender_required" });
		expect(
			authorizeSandboxToolCall({
				caller: {
					chatKind: "group",
					domainConversationId: "session-1",
					senderPlatformId: "synthetic-user",
				},
				policy: { sandboxWorkspaceEnabled: false },
				toolName: "sandbox_spawn",
			}),
		).toMatchObject({ allowed: false, reason: "sandbox_workspace_disabled" });
		for (const chatKind of ["workspace", "task", "plugin", undefined] as const) {
			expect(
				authorizeSandboxToolCall({
					caller: {
						...(chatKind === undefined ? {} : { chatKind }),
						domainConversationId: "session-1",
						senderPlatformId: "synthetic-user",
					},
					policy: { sandboxWorkspaceEnabled: true },
					toolName: "sandbox_spawn",
				}).allowed,
			).toBe(false);
		}
	});
});
