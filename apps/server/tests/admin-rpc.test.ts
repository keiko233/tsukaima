import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatSummary,
	diagnosticsDataSchema,
	type DiagnosticsData,
	logSnapshotSchema,
	sessionContextStatsSchema,
} from "@tsukaima/contracts";
import { auditLog } from "@tsukaima/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
import { DEFAULT_PROMPTS } from "../src/services/prompt-defaults.ts";
import { signIn } from "./test-auth.ts";

const directories: string[] = [];

const createOneBotTransportSpy = () => {
	const urls: string[] = [];
	const createTransport = (url: string): OneBotTransport => {
		urls.push(url);
		const listeners = new Map<string, () => void>();
		return {
			close: () => listeners.get("close")?.(),
			on: (name, listener) => {
				listeners.set(name, listener as () => void);
			},
			send: () => {},
		};
	};
	return { createTransport, urls };
};

const TEST_ADMIN = { password: "test-admin-password", username: "admin" };

/** Signs in through the real Better Auth HTTP surface and returns the session cookie. */
async function signInAdmin(app: ReturnType<typeof createApp>["app"]): Promise<string> {
	return signIn(app, TEST_ADMIN.username, TEST_ADMIN.password);
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("admin RPC", () => {
	test("exposes diagnostics, conversations, plugins, and model policies", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-"));
		directories.push(directory);
		const onebot = createOneBotTransportSpy();
		const { app, lifecycle } = createApp(
			{
				TSUKAIMA_ADMIN_PASSWORD: TEST_ADMIN.password,
				TSUKAIMA_ADMIN_USERNAME: TEST_ADMIN.username,
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
				TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.createTransport]]),
			},
		);
		await lifecycle.start();

		const cookie = await signInAdmin(app);
		const request = async (procedure: string, input?: unknown) => {
			const response = await app.handle(
				new Request(`http://localhost/rpc/${procedure}`, {
					body: JSON.stringify(input === undefined ? {} : { json: input }),
					headers: { cookie, "content-type": "application/json" },
					method: "POST",
				}),
			);
			const result = (await response.json()) as { json: unknown };
			if (response.status !== 200) {
				throw new Error(`RPC ${procedure} failed: ${response.status} ${JSON.stringify(result)}`);
			}
			return result.json;
		};

		// The server response is parsed through the shared contract schema, so any output drift from
		// `appContract` fails the test rather than only the client.
		const diagnostics: DiagnosticsData = diagnosticsDataSchema.parse(
			await request("admin/diagnostics/status"),
		);
		expect(diagnostics.state.state).toBe("ready");
		expect(diagnostics.processedMessages).toBe(0);
		expect(diagnostics.routingPolicies.length).toBe(1);
		const logs = logSnapshotSchema.parse(await request("admin/diagnostics/logs"));
		expect(logs.capacity).toBeGreaterThan(0);
		expect(logs.entries.length).toBeGreaterThan(0);
		expect(
			logs.entries.every(
				(entry) =>
					entry.text.includes("tsukaima::server") ||
					entry.text.includes("tsukaima::plugin::") ||
					entry.text.includes("tsukaima::core::"),
			),
		).toBe(true);

		const conversations = await request("admin/conversations/list");
		expect(Array.isArray(conversations)).toBe(true);

		const createdChat = (await request("admin/chats/createLocal", {
			sessionTitle: "Main",
			title: "Local chat",
		})) as { chatId: string; sessionId: string };
		const chats = (await request("admin/chats/list", { status: "active" })) as ChatSummary[];
		expect(chats).toHaveLength(1);
		expect(chats[0]?.id).toBe(createdChat.chatId);
		expect(chats[0]?.sessions[0]?.isReceiving).toBe(true);
		const session = (await request("admin/sessions/get", {
			sessionId: createdChat.sessionId,
		})) as { id: string; title: string } | null;
		expect(session).toEqual(expect.objectContaining({ id: createdChat.sessionId, title: "Main" }));
		const contextStats = sessionContextStatsSchema.parse(
			await request("admin/sessions/contextStats", { sessionId: createdChat.sessionId }),
		);
		expect(contextStats.contextWindow).toBeGreaterThan(0);
		expect(contextStats.usedTokens).toBeGreaterThanOrEqual(0);
		expect(
			await request("admin/sessions/contextStats", { sessionId: "missing-session" }),
		).toBeNull();

		const plugins = await request("admin/plugins/list");
		expect(Array.isArray(plugins)).toBe(true);

		const initialSettings = await request("admin/settings/get");
		expect(initialSettings).toEqual({
			logLevel: "info",
			plugins: [
				{ config: {}, id: "openai-compatible", secretsSet: [] },
				{ config: {}, id: "onebot-napcat", secretsSet: [] },
				{ config: {}, id: "memory", secretsSet: [] },
				{ config: {}, id: "proactive-scheduler", secretsSet: [] },
				{ config: {}, id: "search-fetch", secretsSet: [] },
				{ config: {}, id: "sticker-meme", secretsSet: [] },
			],
		});
		const updatedSettings = await request("admin/settings/update", { logLevel: "debug" });
		expect(updatedSettings).toEqual({
			logLevel: "debug",
			plugins: [
				{ config: {}, id: "openai-compatible", secretsSet: [] },
				{ config: {}, id: "onebot-napcat", secretsSet: [] },
				{ config: {}, id: "memory", secretsSet: [] },
				{ config: {}, id: "proactive-scheduler", secretsSet: [] },
				{ config: {}, id: "search-fetch", secretsSet: [] },
				{ config: {}, id: "sticker-meme", secretsSet: [] },
			],
		});
		expect(lifecycle.logLevel).toBe("debug");
		expect(lifecycle.providerRestartRequired).toBe(false);
		const withModelDefaults = (await request("admin/settings/update", {
			chatModel: { modelId: "fake-deterministic", providerId: "fake" },
			chatThinking: "low",
			workspaceModel: { modelId: "fake-deterministic", providerId: "fake" },
			workspaceThinking: "high",
		})) as {
			chatModel?: { modelId: string; providerId: string };
			chatThinking?: string;
			workspaceModel?: { modelId: string; providerId: string };
			workspaceThinking?: string;
		};
		expect(withModelDefaults.chatModel).toEqual({
			modelId: "fake-deterministic",
			providerId: "fake",
		});
		expect(withModelDefaults.chatThinking).toBe("low");
		expect(withModelDefaults.workspaceModel).toEqual({
			modelId: "fake-deterministic",
			providerId: "fake",
		});
		expect(withModelDefaults.workspaceThinking).toBe("high");
		const upgradeStatus = await request("admin/upgrade/status");
		expect(upgradeStatus).toBeNull();
		const upgradeHistory = await request("admin/upgrade/history");
		expect(upgradeHistory).toEqual([]);

		await lifecycle.updatePluginConfig("onebot-napcat", {
			accessToken: "test-token",
			wsUrl: "ws://127.0.0.1:3001",
		});
		expect(onebot.urls).toEqual(["ws://127.0.0.1:3001"]);
		expect(lifecycle.channels.get("onebot")?.diagnostics().restartRequired).toBe(false);
		expect(lifecycle.channels.get("onebot")?.diagnostics().state).toBe("connecting");
		const configuredSettings = (await request("admin/settings/get")) as {
			plugins: Array<{ config: Record<string, unknown>; id: string; secretsSet: string[] }>;
		};
		expect(configuredSettings.plugins).toContainEqual({
			config: { wsUrl: "ws://127.0.0.1:3001" },
			id: "onebot-napcat",
			secretsSet: ["accessToken"],
		});
		expect(JSON.stringify(configuredSettings)).not.toContain("test-token");

		await lifecycle.updatePluginConfig("onebot-napcat", { wsUrl: "ws://127.0.0.1:3100" });
		expect(onebot.urls).toEqual(["ws://127.0.0.1:3001", "ws://127.0.0.1:3100"]);

		const updated = await request("admin/modelPolicies/set", {
			capability: "basic-chat",
			primaryModel: "fake-deterministic",
			primaryProvider: "fake",
		});
		expect(updated).toHaveLength(1);
		expect((updated as { primary: { modelId: string } }[])[0]?.primary.modelId).toBe(
			"fake-deterministic",
		);

		await lifecycle.updatePluginConfig("openai-compatible", {
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			models: [
				{ enabled: true, id: "text-chat" },
				{ enabled: true, id: "vision-reasoner", supportsImage: true },
				{ enabled: true, id: "slow-chat", supportsSidechat: false },
				{ enabled: false, id: "disabled-chat" },
			],
		});
		const catalogSettings = (await request("admin/settings/get")) as {
			models?: Array<{
				capabilities: string[];
				id: string;
				pluginId?: string;
				providerId: string;
			}>;
		};
		// The plugin decides which models may classify; the host only filters on its capability.
		expect(catalogSettings.models?.map((model) => model.id)).toEqual([
			"text-chat",
			"vision-reasoner",
		]);
		expect(
			catalogSettings.models?.every((model) => model.capabilities.includes("chat.sidechat")),
		).toBe(true);
		expect(catalogSettings.models?.[0]?.pluginId).toBe("openai-compatible");
		const withSidechatModel = (await request("admin/settings/update", {
			sidechatModelId: "text-chat",
		})) as {
			models?: Array<{ id: string }>;
			sidechatModelId?: string;
		};
		expect(withSidechatModel.sidechatModelId).toBe("text-chat");
		expect(withSidechatModel.models?.map((model) => model.id)).toEqual([
			"text-chat",
			"vision-reasoner",
		]);

		const cleared = (await request("admin/diagnostics/clearLogs")) as { cleared: number };
		expect(cleared.cleared).toBeGreaterThan(0);
		const clearedLogs = (await request("admin/diagnostics/logs")) as {
			entries: Array<{ message: string }>;
		};
		// The `/rpc` transport logs its own request completion afterwards, so assert presence
		// rather than "last entry" here.
		expect(clearedLogs.entries.some((entry) => entry.message === "log buffer cleared")).toBe(true);

		await lifecycle.stop();
		expect(app).toBeDefined();
	});
});

describe("admin conversation policy and persona RPC", () => {
	test("updates policy revisions and binds personas with audit", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-policy-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_ADMIN_PASSWORD: TEST_ADMIN.password,
			TSUKAIMA_ADMIN_USERNAME: TEST_ADMIN.username,
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();
		try {
			const cookie = await signInAdmin(app);
			const request = async (procedure: string, input?: unknown) => {
				const response = await app.handle(
					new Request(`http://localhost/rpc/${procedure}`, {
						body: JSON.stringify(input === undefined ? {} : { json: input }),
						headers: { cookie, "content-type": "application/json" },
						method: "POST",
					}),
				);
				const result = (await response.json()) as { json: unknown };
				if (response.status !== 200) {
					throw new Error(`RPC ${procedure} failed: ${response.status} ${JSON.stringify(result)}`);
				}
				return result.json;
			};

			const chat = (await request("admin/chats/createLocal", {
				sessionTitle: "Main",
				title: "Policy chat",
			})) as { chatId: string; sessionId: string };

			const initial = (await request("admin/policies/get", {
				conversationId: chat.sessionId,
			})) as { policy: { version: number }; source: { scope: string } };
			expect(initial.source.scope).toBe("default");
			expect(initial.policy.version).toBe(1);

			const updated = (await request("admin/policies/update", {
				conversationId: chat.sessionId,
				policy: {
					pacing: { burstSettleMs: 321, replyCooldownMs: 100 },
					trigger: { keywords: ["hello"], privateAccess: "open" },
				},
				scope: "conversation",
			})) as { policy: { pacing: { burstSettleMs: number }; trigger: { keywords: string[] } } };
			expect(updated.policy.pacing.burstSettleMs).toBe(321);
			expect(updated.policy.trigger.keywords).toEqual(["hello"]);

			const history = (await request("admin/policies/history", {
				conversationId: chat.sessionId,
				scope: "conversation",
			})) as Array<{ isActive: boolean; policy: { version: number } }>;
			expect(history).toHaveLength(1);
			expect(history[0]?.isActive).toBe(true);

			const overridden = (await request("admin/policies/overrideAll", {
				policy: {
					compaction: { reserveTokens: 5_000, triggerTokens: 90_000 },
					pacing: { burstSettleMs: 654 },
				},
			})) as {
				updated: number;
				view: {
					policy: {
						compaction: { reserveTokens: number; triggerTokens: number };
						pacing: { burstSettleMs: number };
					};
					source: { scope: string };
				};
			};
			expect(overridden.updated).toBe(1);
			expect(overridden.view.source.scope).toBe("global");
			expect(overridden.view.policy.pacing.burstSettleMs).toBe(654);
			expect(overridden.view.policy.compaction.reserveTokens).toBe(5_000);
			expect(overridden.view.policy.compaction.triggerTokens).toBe(90_000);
			const afterOverride = (await request("admin/policies/get", {
				conversationId: chat.sessionId,
			})) as {
				policy: {
					compaction: { reserveTokens: number; triggerTokens: number };
					pacing: { burstSettleMs: number };
				};
			};
			expect(afterOverride.policy.pacing.burstSettleMs).toBe(654);
			expect(afterOverride.policy.compaction.reserveTokens).toBe(5_000);
			expect(afterOverride.policy.compaction.triggerTokens).toBe(90_000);

			const persona = (await request("admin/personas/upsert", {
				name: "Admin persona",
				prompt: "You are the admin-created persona.",
				selfAliases: ["Tsukaima"],
				summary: "Admin persona",
			})) as { id: string; version: number };
			expect(persona.version).toBe(1);
			const bumped = (await request("admin/personas/upsert", {
				id: persona.id,
				name: "Admin persona",
				prompt: "Updated prompt.",
				selfAliases: ["Tsukaima", "Lain"],
				summary: "Admin persona",
			})) as { id: string; selfAliases: string[]; version: number };
			expect(bumped.version).toBe(2);
			expect(bumped.selfAliases).toEqual(["Tsukaima", "Lain"]);

			const binding = (await request("admin/personas/bindPersona", {
				conversationId: chat.sessionId,
				personaId: persona.id,
				scope: "conversation",
			})) as { conversationId: string; personaId: string };
			expect(binding).toMatchObject({
				conversationId: chat.sessionId,
				personaId: persona.id,
			});
			const bindings = (await request("admin/personas/bindings")) as Array<{
				conversationId: string;
			}>;
			expect(bindings.some((entry) => entry.conversationId === chat.sessionId)).toBe(true);
			const personas = (await request("admin/personas/list")) as Array<{ id: string }>;
			expect(personas.filter((entry) => entry.id === persona.id)).toHaveLength(2);

			const systemPrompt = "Use short replies.";
			const editedPersona = (await request("admin/personas/updatePrompt", {
				id: persona.id,
				prompt: "Use a friendly voice.",
				version: bumped.version,
			})) as { selfAliases: string[]; version: number };
			expect(editedPersona).toMatchObject({ selfAliases: bumped.selfAliases, version: 3 });
			expect(await request("admin/prompts/agentAccess")).toBe(true);
			await request("admin/prompts/update", {
				expectedOverride: null,
				key: "chat-system",
				override: systemPrompt,
			});
			const preview = sessionContextStatsSchema.parse(
				await request("admin/sessions/contextStats", { sessionId: chat.sessionId }),
			);
			expect(preview.sections).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						key: "tsukaima-system",
						text: expect.stringContaining(systemPrompt),
					}),
					expect.objectContaining({
						key: "tsukaima-persona",
						text: expect.stringContaining("Use a friendly voice."),
					}),
				]),
			);
			await expect(
				request("admin/prompts/update", {
					expectedOverride: null,
					key: "chat-system",
					override: "A stale edit.",
				}),
			).rejects.toThrow("409");
			await expect(
				request("admin/personas/updatePrompt", {
					id: persona.id,
					prompt: "A stale persona edit.",
					version: bumped.version,
				}),
			).rejects.toThrow("409");
			await request("admin/prompts/update", {
				expectedOverride: systemPrompt,
				key: "chat-system",
				override: null,
			});
			expect(await request("admin/prompts/list")).toContainEqual({
				key: "chat-system",
				defaultText: DEFAULT_PROMPTS["chat-system"],
				override: null,
			});

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const audits = await database.select().from(auditLog);
			for (const action of [
				"policy.update",
				"policy.override-all",
				"persona.upsert",
				"persona.bind",
				"persona.update-prompt",
				"prompt.update",
			]) {
				expect(audits.some((row) => row.action === action && row.result === "ok")).toBe(true);
			}
			expect(
				audits.some(
					(row) => row.action === "admin.rpc" && row.payloadJson?.includes("policies/update"),
				),
			).toBe(true);
			expect(
				audits.some(
					(row) => row.action === "admin.rpc" && row.payloadJson?.includes("policies/overrideAll"),
				),
			).toBe(true);

			const compactResult = (await request("admin/sessions/compact", {
				instructions: "Focus on summary",
				sessionId: chat.sessionId,
			})) as { compacted: boolean; entryId: string | null; submissionId: string | null };
			expect(compactResult).toEqual({
				compacted: false,
				entryId: null,
				submissionId: null,
			});

			const resetResult = (await request("admin/sessions/resetContext", {
				handoff: "Start fresh",
				sessionId: chat.sessionId,
			})) as { ok: boolean };
			expect(resetResult).toEqual({ ok: true });

			const statsAfterReset = sessionContextStatsSchema.parse(
				await request("admin/sessions/contextStats", { sessionId: chat.sessionId }),
			);
			expect(statsAfterReset.messageCount).toBe(1);

			const abortResult = (await request("admin/sessions/abort", {
				sessionId: chat.sessionId,
			})) as { cancelledPendingOutput: boolean; ok: boolean };
			expect(abortResult).toEqual({ cancelledPendingOutput: false, ok: true });

			const updatedAudits = await database.select().from(auditLog);
			for (const action of ["session.compact", "session.reset-context", "session.abort"]) {
				expect(updatedAudits.some((row) => row.action === action && row.result === "ok")).toBe(
					true,
				);
			}
		} finally {
			await lifecycle.stop();
		}
	});
});
