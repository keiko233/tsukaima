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
} from "@elaina/contracts";
import { auditLog } from "@elaina/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
} from "@elaina-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";
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
		const directory = await fs.mkdtemp(join(tmpdir(), "elaina-admin-"));
		directories.push(directory);
		const onebot = createOneBotTransportSpy();
		const { app, lifecycle } = createApp(
			{
				ELAINA_ADMIN_PASSWORD: TEST_ADMIN.password,
				ELAINA_ADMIN_USERNAME: TEST_ADMIN.username,
				ELAINA_DATA_DIR: directory,
				ELAINA_PORT: "7420",
				ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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
					entry.text.includes("elaina::server") ||
					entry.text.includes("elaina::plugin::") ||
					entry.text.includes("elaina::core::"),
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
				{ config: {}, id: "self-iteration", secretsSet: [] },
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
				{ config: {}, id: "self-iteration", secretsSet: [] },
				{ config: {}, id: "search-fetch", secretsSet: [] },
				{ config: {}, id: "sticker-meme", secretsSet: [] },
			],
		});
		expect(lifecycle.logLevel).toBe("debug");
		expect(lifecycle.providerRestartRequired).toBe(false);

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
		const directory = await fs.mkdtemp(join(tmpdir(), "elaina-admin-policy-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			ELAINA_ADMIN_PASSWORD: TEST_ADMIN.password,
			ELAINA_ADMIN_USERNAME: TEST_ADMIN.username,
			ELAINA_DATA_DIR: directory,
			ELAINA_PORT: "7420",
			ELAINA_WEB_ORIGIN: "http://127.0.0.1:7421",
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

			const persona = (await request("admin/personas/upsert", {
				name: "Admin persona",
				prompt: "You are the admin-created persona.",
				selfAliases: ["Elaina"],
				summary: "Admin persona",
			})) as { id: string; version: number };
			expect(persona.version).toBe(1);
			const bumped = (await request("admin/personas/upsert", {
				id: persona.id,
				name: "Admin persona",
				prompt: "Updated prompt.",
				selfAliases: ["Elaina", "Lain"],
				summary: "Admin persona",
			})) as { id: string; selfAliases: string[]; version: number };
			expect(bumped.version).toBe(2);
			expect(bumped.selfAliases).toEqual(["Elaina", "Lain"]);

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

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const audits = await database.select().from(auditLog);
			for (const action of ["policy.update", "persona.upsert", "persona.bind"]) {
				expect(audits.some((row) => row.action === action && row.result === "ok")).toBe(true);
			}
			expect(
				audits.some(
					(row) => row.action === "admin.rpc" && row.payloadJson?.includes("policies/update"),
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
