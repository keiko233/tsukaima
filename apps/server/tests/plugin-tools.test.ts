import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { PiDurableConversationHost, createOpenAICompatibleModelPort } from "@tsukaima/core";
import { auditLog } from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import {
	createPluginToolsExtension,
	pluginManifestSchema,
	providerSafeToolName,
	type TsukaimaPlugin,
} from "@tsukaima/sdk";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { loadConfig } from "../src/config.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";
import { builtinPlugins } from "../src/plugins/builtin.ts";

const directories: string[] = [];
/** The model sees a provider-safe alias; plugin routing and audit keep the original name. */
const SAFE_ECHO_TOOL_NAME = providerSafeToolName("fake-tools.echo");

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "plugin-tools-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

interface CapturedTool {
	readonly function?: { readonly name?: string };
}

interface CapturedRequest {
	readonly messages: readonly unknown[];
	readonly tools?: readonly CapturedTool[];
}

function createCapturingModel() {
	const requests: CapturedRequest[] = [];
	const model = createOpenAICompatibleModelPort(
		{
			apiKey: "test-key",
			baseUrl: "http://capture.invalid/v1",
			fetch: (async (_input, init) => {
				const request = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest;
				const call = requests.length;
				requests.push(request);
				const payload =
					call === 0
						? {
								choices: [
									{
										finish_reason: "tool_calls",
										message: {
											content: null,
											tool_calls: [
												{
													function: {
														arguments: '{"query":"echo"}',
														name: "tool_search",
													},
													id: "search-1",
													type: "function",
												},
											],
										},
									},
								],
								id: "resp-0",
								model: "capture-model",
								usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
							}
						: call === 1
							? {
									choices: [
										{
											finish_reason: "tool_calls",
											message: {
												content: null,
												tool_calls: [
													{
														function: {
															arguments: '{"text":"ping"}',
															name: SAFE_ECHO_TOOL_NAME,
														},
														id: "call-1",
														type: "function",
													},
												],
											},
										},
									],
									id: "resp-1",
									model: "capture-model",
									usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
								}
							: {
									choices: [{ finish_reason: "stop", message: { content: "done" } }],
									id: "resp-2",
									model: "capture-model",
									usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
								};
				return new Response(JSON.stringify(payload), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}) as typeof fetch,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "capture-model" }],
	);
	return { model, requests };
}

const echoTool = {
	description: "Echo text",
	execute: (input: Record<string, unknown>) => ({
		content: [{ text: `echo:${String(input.text)}`, type: "text" as const }],
	}),
	name: "fake-tools.echo",
	parameters: {
		properties: { text: { type: "string" } },
		required: ["text"],
		type: "object",
	},
	requiredPermissions: ["conversation.read"] as const,
};

function fakeToolsPlugin(seen: Record<string, unknown>[]): TsukaimaPlugin {
	return {
		manifest: pluginManifestSchema.parse({
			apiVersion: "1",
			kind: "first-party",
			name: "fake-tools",
			permissions: ["conversation.read"],
			version: "0.1.0",
		}),
		setup(context) {
			context.tools.register({
				...echoTool,
				execute(input) {
					seen.push(input);
					return echoTool.execute(input);
				},
			});
		},
	};
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("plugin tools", () => {
	test("offers plugin tools to the model and routes the call through the plugin host", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-tools-"));
		directories.push(directory);
		const { model, requests } = createCapturingModel();
		const seen: Record<string, unknown>[] = [];
		const lifecycle = new TsukaimaLifecycle(
			loadConfig({
				TSUKAIMA_DATA_DIR: directory,
				TSUKAIMA_PORT: "7420",
			}),
			{
				env: {},
				model,
				plugins: [...builtinPlugins, fakeToolsPlugin(seen)],
			},
		);
		await lifecycle.start();
		try {
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("Conversation host is not initialized");
			expect(
				host.registry
					.snapshot()
					.tools()
					.map(({ tool }) => tool.name),
			).toContain(SAFE_ECHO_TOOL_NAME);

			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("plugin-tool-message", "ping"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await waitFor(() => (requests.length >= 3 ? true : undefined));

			expect(requests[0]?.tools?.map((tool) => tool.function?.name)).not.toContain(
				SAFE_ECHO_TOOL_NAME,
			);
			expect(requests[0]?.tools?.map((tool) => tool.function?.name)).toContain("tool_search");
			expect(requests[1]?.tools?.map((tool) => tool.function?.name)).toContain(SAFE_ECHO_TOOL_NAME);
			expect(seen).toEqual([{ text: "ping" }]);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not initialized");
			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "plugin.tool.invoke"));
			expect(audits).toEqual([
				expect.objectContaining({
					result: "ok",
					targetId: "fake-tools.echo",
					targetKind: "plugin-tool",
				}),
			]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("backfills the tools extension for a conversation created before installation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-plugin-tools-backfill-"));
		directories.push(directory);
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const { model, requests } = createCapturingModel();
		const host = new PiDurableConversationHost({
			model,
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
		});
		try {
			const conversationId = await host.createConversation();
			host.installExtensions([
				createPluginToolsExtension(
					() => [echoTool],
					async (_name, input) => ({
						ok: true,
						result: {
							content: [{ text: `echo:${String(input.text)}`, type: "text" }],
						},
					}),
				),
			]);
			await host.append({
				conversationId,
				envelope: envelope("plugin-tool-backfill", "ping"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await waitFor(() => (requests.length >= 3 ? true : undefined));
			expect(requests[0]?.tools?.map((tool) => tool.function?.name)).not.toContain(
				SAFE_ECHO_TOOL_NAME,
			);
			expect(requests[1]?.tools?.map((tool) => tool.function?.name)).toContain(SAFE_ECHO_TOOL_NAME);
		} finally {
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		}
	});
});
