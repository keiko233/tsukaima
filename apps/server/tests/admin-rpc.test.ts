import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatSummary,
	diagnosticsDataSchema,
	type DiagnosticsData,
	logSnapshotSchema,
} from "@tsukaima/contracts";
import type { OneBotTransport } from "@tsukaima/onebot";
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
			{ onebotTransportFactory: onebot.createTransport },
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
		expect(logs.entries.every((entry) => entry.text.includes("tsukaima::server"))).toBe(true);

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

		const plugins = await request("admin/plugins/list");
		expect(Array.isArray(plugins)).toBe(true);

		const initialSettings = await request("admin/settings/get");
		expect(initialSettings).toEqual({
			logLevel: "info",
			openAiApiKeySet: false,
			onebotAccessTokenSet: false,
		});
		const updatedSettings = await request("admin/settings/update", {
			logLevel: "debug",
			openAiApiKey: "provider-secret",
			openAiBaseUrl: "https://magpie.example/v1",
			openAiModelId: "magpie-chat",
			onebotAccessToken: "test-token",
			onebotWsUrl: "ws://127.0.0.1:3001",
		});
		expect(updatedSettings).toEqual({
			logLevel: "debug",
			openAiApiKeySet: true,
			openAiBaseUrl: "https://magpie.example/v1",
			openAiModelId: "magpie-chat",
			onebotAccessTokenSet: true,
			onebotWsUrl: "ws://127.0.0.1:3001",
		});
		expect(JSON.stringify(updatedSettings)).not.toContain("test-token");
		expect(JSON.stringify(updatedSettings)).not.toContain("provider-secret");
		expect(lifecycle.logLevel).toBe("debug");
		expect(onebot.urls).toEqual(["ws://127.0.0.1:3001"]);
		expect(lifecycle.channels.get("onebot")?.diagnostics().restartRequired).toBe(false);
		expect(lifecycle.providerRestartRequired).toBe(true);
		expect(lifecycle.channels.get("onebot")?.diagnostics().state).toBe("connecting");

		await request("admin/settings/update", { onebotWsUrl: "ws://127.0.0.1:3100" });
		expect(onebot.urls).toEqual(["ws://127.0.0.1:3001", "ws://127.0.0.1:3100"]);
		expect(lifecycle.channels.get("onebot")?.diagnostics().restartRequired).toBe(false);
		expect(lifecycle.channels.get("onebot")?.diagnostics().state).toBe("connecting");

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

	test("fetches provider models through the server without returning the API key", async () => {
		const provider = Bun.serve({
			fetch(request) {
				const url = new URL(request.url);
				expect(url.pathname).toBe("/v1/models");
				expect(request.headers.get("authorization")).toBe("Bearer unsaved-provider-secret");
				return Response.json({
					data: [{ id: "model-b", owned_by: "vendor" }, { id: "model-a" }],
					object: "list",
				});
			},
			port: 0,
		});
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-admin-model-list-"));
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
			const response = await app.handle(
				new Request("http://localhost/rpc/admin/settings/models", {
					body: JSON.stringify({
						json: {
							apiKey: "unsaved-provider-secret",
							baseUrl: `http://127.0.0.1:${provider.port}/v1`,
						},
					}),
					headers: { cookie, "content-type": "application/json" },
					method: "POST",
				}),
			);
			const result = (await response.json()) as { json: unknown };
			expect(response.status).toBe(200);

			expect(result.json).toEqual({
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
				models: [{ id: "model-a" }, { id: "model-b", ownedBy: "vendor" }],
			});
			expect(JSON.stringify(result.json)).not.toContain("unsaved-provider-secret");
		} finally {
			provider.stop(true);
			await lifecycle.stop();
		}
	});
});
