import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	ADMIN_SETTINGS_TOOL_NAMES,
	authorizeAdminSettingsToolCall,
	createAdminSettingsToolsExtension,
	type AdminSettingsPluginPort,
	type AdminSettingsToolsOptions,
} from "../src/services/admin-settings-tools.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { readGitIdentity, writeGitIdentity } from "../src/services/git-identity.ts";
import { resolveImCallerContext } from "../src/services/im-caller-context.ts";
import type { PluginHostEntry } from "../src/services/plugin-host.ts";
import type { PluginSettingsStore } from "../src/services/plugin-settings.ts";
import { readRuntimeSettings } from "../src/runtime-settings.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const logger = {
	child: () => logger,
	debug: () => undefined,
	error: () => undefined,
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
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-settings-"));
	temporaryDirectories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return {
		cleanup: async () => {
			try {
				database.$client.close();
			} catch {}
			await fs.rm(directory, { force: true, recursive: true });
		},
		database,
		directory,
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
		title: "Synthetic admin settings chat",
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
		title: "Synthetic admin settings chat",
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
	return { durableConversationId, sessionId };
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
	const parsed: unknown = JSON.parse(resultText(result));
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
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

function createPolicy(database: TsukaimaDatabase): ConversationPolicyService {
	return new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
}

interface FakePluginPort {
	readonly port: AdminSettingsPluginPort;
	readonly state: {
		config: Record<string, unknown>;
		enabled: boolean;
		reloads: number;
	};
}

function createPluginPort(secret: string): FakePluginPort {
	const state = {
		config: { apiKey: secret, region: "synthetic-region" } as Record<string, unknown>,
		enabled: true,
		reloads: 0,
	};
	const secretKeys = ["apiKey"];
	const publicView = () => {
		const config: Record<string, unknown> = {};
		const secretsSet: string[] = [];
		for (const [key, value] of Object.entries(state.config)) {
			if (secretKeys.includes(key)) {
				if (value !== undefined && value !== null && value !== "") secretsSet.push(key);
				continue;
			}
			config[key] = value;
		}
		return { config, id: "synthetic-plugin", secretsSet };
	};
	const entry = (): PluginHostEntry => {
		const view = publicView();
		return {
			apiVersion: "1",
			config: view.config,
			enabled: state.enabled ? 1 : 0,
			id: "synthetic-plugin",
			kind: "builtin",
			modelProviders: [],
			name: "synthetic-plugin",
			permissions: [],
			rpcMethods: [],
			runMode: "host",
			secretKeys: [...secretKeys],
			secretsSet: view.secretsSet,
			status: null,
			tools: [],
			ui: [],
			version: "1.0.0",
		};
	};
	return {
		port: {
			configViews: async () => [{ ...publicView() }],
			list: async () => [entry()],
			reload: async (pluginId) => {
				if (pluginId !== "synthetic-plugin") throw new Error(`unknown plugin ${pluginId}`);
				state.reloads += 1;
				return entry();
			},
			setEnabled: async (pluginId, enabled) => {
				if (pluginId !== "synthetic-plugin") throw new Error(`unknown plugin ${pluginId}`);
				state.enabled = enabled;
			},
			updateConfig: async (pluginId, config) => {
				if (pluginId !== "synthetic-plugin") throw new Error(`unknown plugin ${pluginId}`);
				Object.assign(state.config, config);
			},
		},
		state,
	};
}

function createExtension(input: {
	readonly adminUsers: readonly string[];
	readonly applyRuntimeSettings?: (
		settings: Parameters<AdminSettingsToolsOptions["applyRuntimeSettings"]>[0],
	) => void;
	readonly availableModels?: AdminSettingsToolsOptions["availableModels"];
	readonly database: TsukaimaDatabase;
	readonly plugins?: AdminSettingsPluginPort;
	readonly policy?: ConversationPolicyService;
	readonly turnBoundSender: string | null | undefined;
}): {
	readonly audits: AuditEntry[];
	readonly extension: DurableExtension;
	readonly policy: ConversationPolicyService;
} {
	const audits: AuditEntry[] = [];
	const policy = input.policy ?? createPolicy(input.database);
	const extension = createAdminSettingsToolsExtension({
		applyRuntimeSettings: input.applyRuntimeSettings ?? (() => undefined),
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
			return authorizeAdminSettingsToolCall({ caller, toolName });
		},
		...(input.availableModels === undefined ? {} : { availableModels: input.availableModels }),
		database: () => input.database,
		logger,
		plugins: input.plugins ?? createPluginPort("synthetic-secret").port,
		policy,
		resolveSessionId: async (durableConversationId) => {
			const [row] = await input.database
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.durableConversationId, durableConversationId))
				.limit(1);
			return row?.id;
		},
	});
	return { audits, extension, policy };
}

describe("admin settings authorization", () => {
	test("webui and coding workspaces are allowed while sandbox workspaces and unknown kinds fail closed", () => {
		expect(
			authorizeAdminSettingsToolCall({
				caller: { chatKind: "webui", domainConversationId: "session-synthetic" },
				toolName: "settings_get",
			}),
		).toMatchObject({ allowed: true });
		expect(
			authorizeAdminSettingsToolCall({
				caller: {
					chatKind: "workspace",
					domainConversationId: "session-synthetic",
					isAdmin: true,
					workspaceKind: "coding",
				},
				toolName: "settings_get",
			}),
		).toMatchObject({ allowed: true });
		expect(
			authorizeAdminSettingsToolCall({
				caller: {
					chatKind: "workspace",
					domainConversationId: "session-synthetic",
					isAdmin: false,
					workspaceKind: "sandbox",
				},
				toolName: "settings_get",
			}),
		).toMatchObject({ allowed: false, reason: "admin_required" });
		for (const caller of [
			{},
			{ chatKind: "task" },
			{ chatKind: "plugin" },
			{ chatKind: "unknown" },
		] as const) {
			expect(authorizeAdminSettingsToolCall({ caller, toolName: "settings_get" })).toMatchObject({
				allowed: false,
				reason: "disallowed_chat_kind",
			});
		}
		expect(
			authorizeAdminSettingsToolCall({
				caller: { chatKind: "webui" },
				toolName: "not_an_admin_tool",
			}),
		).toMatchObject({ allowed: false, reason: "unknown_admin_tool" });
	});

	test("non-admin IM private and group callers are denied", () => {
		for (const chatKind of ["private", "group"] as const) {
			expect(
				authorizeAdminSettingsToolCall({
					caller: { chatKind, domainConversationId: "session-synthetic" },
					toolName: "policy_update",
				}),
			).toMatchObject({ allowed: false, reason: "admin_required" });
		}
	});

	test("admin IM caller with a turn-bound sender is allowed", () => {
		expect(
			authorizeAdminSettingsToolCall({
				caller: {
					chatKind: "group",
					domainConversationId: "session-synthetic",
					isAdmin: true,
					senderPlatformId: "10002",
				},
				toolName: "plugin_configure",
			}),
		).toMatchObject({ allowed: true, callerId: "10002", isAdmin: true });
	});

	test("ADMIN_SETTINGS_TOOL_NAMES is the complete admin surface", () => {
		expect([...ADMIN_SETTINGS_TOOL_NAMES]).toEqual([
			"settings_get",
			"settings_update",
			"policy_get",
			"policy_update",
			"plugin_list",
			"plugin_configure",
			"persona_manage",
		]);
	});
});

describe("admin settings runtime authorization", () => {
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
				turnBoundSender: "10003",
			});
			const result = await invokeTool(
				extension,
				"settings_update",
				{ logLevel: "warn" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("admin_required");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.settings_update",
				actorId: "10003",
				actorKind: "user",
				reason: "admin_required",
				result: "denied",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("a proactive group turn without a turn-bound sender fails closed", async () => {
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
				turnBoundSender: null,
			});
			const result = await invokeTool(
				extension,
				"policy_update",
				{ policy: { memoryEnabled: false }, scope: "global" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("admin_required");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.policy_update",
				result: "denied",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("a webui administrator can call the tools", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(extension, "settings_get", {}, session.durableConversationId);
			expect(result.isError).toBeUndefined();
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.settings_get",
				actorKind: "agent",
				result: "ok",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});
});

describe("admin settings tools", () => {
	test("settings_get returns runtime settings, git identity, and the model catalog", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				availableModels: async () => [
					{
						capabilities: ["basic-chat"],
						id: "synthetic-model",
						providerId: "synthetic-provider",
						reasoningLevels: ["low", "high"],
					},
				],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(extension, "settings_get", {}, session.durableConversationId);
			const decoded = decodeResult(result);
			expect(decoded.settings).toMatchObject({ logLevel: "info" });
			expect(decoded.gitIdentity).toEqual({
				email: "tsukaima-upgrade@localhost",
				name: "tsukaima-upgrade",
			});
			expect(decoded.availableModels).toEqual([
				{
					capabilities: ["basic-chat"],
					id: "synthetic-model",
					providerId: "synthetic-provider",
					reasoningLevels: ["low", "high"],
				},
			]);
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.settings_get",
				result: "ok",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("settings_update persists settings, applies them live, and can write git identity", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const applied: Parameters<AdminSettingsToolsOptions["applyRuntimeSettings"]>[0][] = [];
			const { audits, extension } = createExtension({
				adminUsers: [],
				applyRuntimeSettings: (settings) => {
					applied.push(settings);
				},
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"settings_update",
				{
					gitIdentity: { email: "bot@example.test", name: "Synthetic Bot" },
					logLevel: "warn",
					sidechatModelId: "synthetic-sidechat",
				},
				session.durableConversationId,
			);
			const decoded = decodeResult(result);
			expect(decoded.settings).toMatchObject({
				logLevel: "warn",
				sidechatModelId: "synthetic-sidechat",
			});
			expect(decoded.gitIdentity).toEqual({
				email: "bot@example.test",
				name: "Synthetic Bot",
			});
			expect(applied).toHaveLength(1);
			expect(applied[0]?.logLevel).toBe("warn");
			expect((await readRuntimeSettings(harness.database)).logLevel).toBe("warn");
			expect(await readGitIdentity(harness.database)).toEqual({
				email: "bot@example.test",
				name: "Synthetic Bot",
			});
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.settings_update",
				payload: {
					changedKeys: ["logLevel", "sidechatModelId"],
					gitIdentity: true,
				},
				result: "ok",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("settings_update with only a git identity skips the runtime patch", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const applied: unknown[] = [];
			await writeGitIdentity(harness.database, {
				email: "before@example.test",
				name: "Before",
			});
			const { extension } = createExtension({
				adminUsers: [],
				applyRuntimeSettings: (settings) => {
					applied.push(settings);
				},
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"settings_update",
				{ gitIdentity: { email: "after@example.test", name: "After" } },
				session.durableConversationId,
			);
			expect(result.isError).toBeUndefined();
			expect(await readGitIdentity(harness.database)).toEqual({
				email: "after@example.test",
				name: "After",
			});
			expect(applied).toHaveLength(0);
		} finally {
			await harness.cleanup();
		}
	});

	test("settings_update rejects an empty patch and audits the failure", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"settings_update",
				{},
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("at least one setting must be provided");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.settings_update",
				reason: "at least one setting must be provided",
				result: "failed",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("policy_get and policy_update handle global and current-conversation scopes", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension, policy } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const globalGet = decodeResult(
				await invokeTool(
					extension,
					"policy_get",
					{ scope: "global" },
					session.durableConversationId,
				),
			);
			expect(globalGet.source).toMatchObject({ conversationId: null, scope: "default" });

			const globalUpdate = decodeResult(
				await invokeTool(
					extension,
					"policy_update",
					{ policy: { memoryEnabled: false }, scope: "global" },
					session.durableConversationId,
				),
			);
			expect(globalUpdate.source).toMatchObject({ conversationId: null, scope: "global" });
			expect(globalUpdate.policy).toMatchObject({ memoryEnabled: false });

			const currentGet = decodeResult(
				await invokeTool(extension, "policy_get", {}, session.durableConversationId),
			);
			expect(currentGet.source).toMatchObject({
				conversationId: session.sessionId,
				scope: "global",
			});
			expect(currentGet.policy).toMatchObject({ memoryEnabled: false });

			const conversationUpdate = decodeResult(
				await invokeTool(
					extension,
					"policy_update",
					{ policy: { enabled: false }, scope: "conversation" },
					session.durableConversationId,
				),
			);
			expect(conversationUpdate.source).toMatchObject({
				conversationId: session.sessionId,
				scope: "conversation",
			});
			expect(conversationUpdate.policy).toMatchObject({ enabled: false });

			const defaultGet = decodeResult(
				await invokeTool(extension, "policy_get", {}, session.durableConversationId),
			);
			expect(defaultGet.source).toMatchObject({
				conversationId: session.sessionId,
				scope: "conversation",
			});
			expect(defaultGet.policy).toMatchObject({ enabled: false, memoryEnabled: false });
			expect(await policy.effectivePolicy(session.sessionId)).toMatchObject({
				enabled: false,
			});
			expect(
				audits.findLast((entry) => entry.action === "admin-settings.policy_update"),
			).toMatchObject({
				action: "admin-settings.policy_update",
				result: "ok",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("policy_update rejects an invalid patch and audits the failure", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"policy_update",
				{ policy: { notAPolicyKey: true }, scope: "global" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.policy_update",
				result: "failed",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("plugin_list masks secret values and reports secret key names only", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				plugins: createPluginPort("synthetic-secret-value").port,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(extension, "plugin_list", {}, session.durableConversationId);
			const text = resultText(result);
			expect(text).not.toContain("synthetic-secret-value");
			const decoded = decodeResult(result);
			const plugins = decoded.plugins as Record<string, unknown>[];
			expect(plugins).toHaveLength(1);
			expect(plugins[0]).toMatchObject({
				config: { region: "synthetic-region" },
				enabled: true,
				id: "synthetic-plugin",
				secretsSet: ["apiKey"],
				version: "1.0.0",
			});
			expect(JSON.stringify(plugins[0])).not.toContain("synthetic-secret-value");
			expect(JSON.stringify(audits)).not.toContain("synthetic-secret-value");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.plugin_list",
				payload: { pluginCount: 1 },
				result: "ok",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("plugin_configure updates config, toggles enablement, and reloads without leaking secrets", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const fake = createPluginPort("synthetic-secret-value");
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				plugins: fake.port,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"plugin_configure",
				{
					config: { apiKey: "rotated-secret-value", region: "synthetic-region-2" },
					enabled: false,
					pluginId: "synthetic-plugin",
					reload: true,
				},
				session.durableConversationId,
			);
			const text = resultText(result);
			expect(text).not.toContain("rotated-secret-value");
			expect(text).not.toContain("synthetic-secret-value");
			const decoded = decodeResult(result);
			expect(decoded).toMatchObject({
				config: { region: "synthetic-region-2" },
				enabled: false,
				pluginId: "synthetic-plugin",
				reloaded: true,
				secretsSet: ["apiKey"],
			});
			expect(JSON.stringify(decoded)).not.toContain("rotated-secret-value");
			expect(fake.state.reloads).toBe(1);
			expect(fake.state.enabled).toBe(false);
			expect(fake.state.config.region).toBe("synthetic-region-2");
			expect(JSON.stringify(audits)).not.toContain("rotated-secret-value");
			expect(JSON.stringify(audits)).not.toContain("synthetic-secret-value");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.plugin_configure",
				payload: {
					configKeys: ["apiKey", "region"],
					enabled: false,
					pluginId: "synthetic-plugin",
					reload: true,
				},
				result: "ok",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("plugin_configure rejects an unknown plugin and audits the failure", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				plugins: createPluginPort("synthetic-secret-value").port,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"plugin_configure",
				{ enabled: true, pluginId: "missing-plugin" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("unknown plugin");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.plugin_configure",
				result: "failed",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("persona_manage lists, upserts, and binds personas", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const empty = decodeResult(
				await invokeTool(
					extension,
					"persona_manage",
					{ action: "list" },
					session.durableConversationId,
				),
			);
			expect(empty).toEqual({ bindings: [], personas: [] });

			const upserted = decodeResult(
				await invokeTool(
					extension,
					"persona_manage",
					{
						action: "upsert",
						name: "Synthetic Persona",
						prompt: "You are a synthetic test persona.",
						selfAliases: ["Synthetic"],
						summary: "Synthetic persona for tests.",
					},
					session.durableConversationId,
				),
			);
			const persona = upserted.persona as Record<string, unknown>;
			expect(persona).toMatchObject({
				isActive: true,
				name: "Synthetic Persona",
				selfAliases: ["Synthetic"],
				version: 1,
			});
			expect(typeof persona.id).toBe("string");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.persona_manage",
				payload: { action: "upsert", personaId: persona.id },
				result: "ok",
			});

			const bound = decodeResult(
				await invokeTool(
					extension,
					"persona_manage",
					{ action: "bind", personaId: persona.id, scope: "conversation" },
					session.durableConversationId,
				),
			);
			expect(bound.binding).toMatchObject({
				conversationId: session.sessionId,
				isActive: true,
				personaId: persona.id,
			});

			const listed = decodeResult(
				await invokeTool(
					extension,
					"persona_manage",
					{ action: "list" },
					session.durableConversationId,
				),
			);
			expect((listed.personas as unknown[]).length).toBe(1);
			expect(listed.bindings as unknown[]).toHaveLength(1);
		} finally {
			await harness.cleanup();
		}
	});

	test("persona_manage rejects an unknown action and audits the failure", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, { kind: "webui" });
			const { audits, extension } = createExtension({
				adminUsers: [],
				database: harness.database,
				turnBoundSender: undefined,
			});
			const result = await invokeTool(
				extension,
				"persona_manage",
				{ action: "unknown" },
				session.durableConversationId,
			);
			expect(result.isError).toBe(true);
			expect(resultText(result)).toContain("action must be list, upsert, or bind");
			expect(audits.at(-1)).toMatchObject({
				action: "admin-settings.persona_manage",
				result: "failed",
				targetKind: "admin-settings",
			});
		} finally {
			await harness.cleanup();
		}
	});
});
