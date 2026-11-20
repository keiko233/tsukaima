import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import { auditLog, chatObjects, conversations, messages, pluginInstallStates } from "@tsukaima/db";
import type { DurableExtension } from "@tsukaima/core";
import { PluginLifecycleError } from "@tsukaima/plugin-registry";
import { pluginManifestSchema, type PluginManifest, type TsukaimaPlugin } from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";
import type { TsukaimaLifecycle } from "../src/lifecycle.ts";
import { resolveImCallerContext } from "../src/services/im-caller-context.ts";
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
		expect(enabledNames).not.toContain("proactive-scheduler_schedule");
		expect(enabledNames).not.toContain("proactive-scheduler_list");
		expect(enabledNames).not.toContain("proactive-scheduler_cancel");

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

	test("coding, database, hook, and self-iteration tools are denied and audited from IM", async () => {
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
		const selfIteration = await lifecycle.pluginHost.invokeTool(
			"self-iteration.analyze",
			{ action: "read", path: "src/app.ts" },
			{ conversationId: session.durableConversationId },
		);
		expect(selfIteration.ok).toBe(false);
		if (selfIteration.ok === false) {
			expect(["unauthorized", "task_kind_denied", "permission_denied"]).toContain(
				selfIteration.reason,
			);
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
		expect(
			audits.some(
				(row) =>
					row.action === "plugin-tool.denied" &&
					row.result === "denied" &&
					row.actorId === "10002" &&
					auditPayload(row).tool === "self-iteration.analyze",
			),
		).toBe(true);
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
