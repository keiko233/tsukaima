import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createConsolePluginLogger,
	createPluginContext,
	LocalModelRegistry,
	LocalPluginEventBridge,
	LocalRpcBridge,
	type PluginMediaRecord,
	type PluginOutboundApi,
} from "@tsukaima/sdk";
import { MODEL_CAPABILITIES } from "@tsukaima/sdk/model-capabilities";
import { AcpRuntimeInstaller } from "./installer.ts";
import { ACP_PATHS_BINDING, ACP_PLUGIN_ID, acpManifest } from "./manifest.ts";
import { createAcpPlugin } from "./index.ts";

const MOCK_AGENT_PATH = resolve(import.meta.dirname, "fixtures", "mock-acp-agent.ts");

const createdDirs: string[] = [];

const fakeExec = async () => ({ exitCode: 0, stderr: "", stdout: "1.2.3\n" });

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir !== undefined) await rm(dir, { force: true, recursive: true });
	}
});

describe("createAcpPlugin integration", () => {
	test("registers multi-profile providers, probes models, runs runtime RPCs, and delivers capability media", async () => {
		const root = await tempDir("tsukaima-acp-plugin-");
		const toolsRootDir = join(root, "tools");
		const artifactsRootDir = join(root, "artifacts");
		let settingsValue: Record<string, unknown> = {
			profiles: [
				{
					args: [MOCK_AGENT_PATH],
					command: process.execPath,
					enableAsModelProvider: true,
					enabled: true,
					id: "mock-codex",
					models: [
						{
							enabled: true,
							id: "mock-model-1",
							supportsImage: true,
							supportsImageGeneration: true,
							supportsTools: true,
						},
					],
					preset: "codex",
					supportsCapabilityTool: true,
					supportsImageGeneration: true,
				},
			],
		};
		const settingsListeners = new Set<(next: unknown) => void | Promise<void>>();
		const storedBlobs = new Map<string, Uint8Array>();
		const sentMessages: Array<{
			readonly conversationId: string;
			readonly parts: readonly unknown[];
		}> = [];

		const installer = new AcpRuntimeInstaller({
			exec: fakeExec,
			resolvePathBinary: () => undefined,
			toolsRootDir,
		});
		const plugin = createAcpPlugin({ installer });

		const models = new LocalModelRegistry();
		const rpc = new LocalRpcBridge();
		const outbound: PluginOutboundApi = {
			recordInteraction: async () => {},
			send: async () => ({}),
			sendToConversation: async (input) => {
				sentMessages.push({ conversationId: input.conversationId, parts: input.parts });
				return { platformMessageId: "msg-1" };
			},
		};
		const context = createPluginContext({
			dependencies: {
				get: <T = unknown>(key: string) =>
					(key === ACP_PATHS_BINDING ? { artifactsRootDir, toolsRootDir } : undefined) as
						| T
						| undefined,
			},
			events: new LocalPluginEventBridge(),
			logger: createConsolePluginLogger(),
			manifest: acpManifest,
			media: {
				findById: async (id) => {
					const bytes = storedBlobs.get(id);
					if (bytes === undefined) return undefined;
					return {
						createdAt: new Date().toISOString(),
						durationMs: null,
						expiresAt: null,
						height: null,
						id,
						kind: "image",
						mimeType: "image/png",
						sha256: `sha-${id}`,
						sizeBytes: bytes.byteLength,
						source: "generated",
						width: null,
					};
				},
				findBySha: async () => undefined,
				readBytes: async (id) => {
					const bytes = storedBlobs.get(id);
					if (bytes === undefined) throw new Error(`Missing media ${id}`);
					return bytes;
				},
				store: async (input): Promise<PluginMediaRecord> => {
					const id = `media-${storedBlobs.size + 1}`;
					storedBlobs.set(id, input.bytes);
					return {
						createdAt: new Date().toISOString(),
						durationMs: input.durationMs ?? null,
						expiresAt: input.expiresAt ?? null,
						height: input.height ?? null,
						id,
						kind: input.kind,
						mimeType: input.mimeType ?? "application/octet-stream",
						sha256: `sha-${id}`,
						sizeBytes: input.bytes.byteLength,
						source: input.source ?? "generated",
						width: input.width ?? null,
					};
				},
			},
			models,
			outbound,
			pluginId: ACP_PLUGIN_ID,
			rpc,
			settings: {
				get: async () => settingsValue,
				onChange: (handler) => {
					settingsListeners.add(handler);
					return () => settingsListeners.delete(handler);
				},
			},
		});
		const tools = context.tools;

		try {
			await plugin.prepare?.(context);
			await plugin.setup?.(context);

			const catalog = await models.listModels({ providerId: "acp:mock-codex" });
			expect(catalog.map((m) => m.id)).toEqual(["mock-model-1"]);
			expect(catalog[0]?.capabilities).toContain(MODEL_CAPABILITIES.imageGenerate);

			const completed = await models.complete({
				messages: [{ content: "ping", role: "user" }],
				providerId: "acp:mock-codex",
			});
			expect(completed.text).toContain("Echo: ping");

			const probe = (await rpc.invoke("probe", { profileId: "mock-codex" })) as {
				readonly ok: boolean;
				readonly models: readonly { readonly id: string }[];
			};
			expect(probe.ok).toBe(true);
			expect(probe.models.map((m) => m.id)).toEqual(["mock-model-1", "mock-model-2"]);

			const installRes = (await rpc.invoke("runtime.install", { id: "codex-acp" })) as {
				readonly ok: boolean;
			};
			expect(installRes.ok).toBe(true);
			const statusRes = (await rpc.invoke("runtime.status", {})) as {
				readonly toolsRootDir: string;
			};
			expect(statusRes.toolsRootDir).toBe(toolsRootDir);

			// Verify acp.run_capability extracts inline image from [trigger-image], stores it, and delivers it.
			const capResult = await tools.invoke(
				"acp.run_capability",
				{ profileId: "mock-codex", prompt: "generate [trigger-image]" },
				{ chatKind: "webui", conversationId: "conv-1" },
			);
			expect(capResult.ok).toBe(true);
			expect(sentMessages).toHaveLength(1);
			expect(sentMessages[0]?.parts[0]).toMatchObject({ type: "image", mimeType: "image/png" });

			// Verify models.generateImage extracts inline image from mock agent via [trigger-image].
			const genImage = await models.generateImage({
				prompt: "draw [trigger-image]",
				providerId: "acp:mock-codex",
			});
			expect(genImage.images).toHaveLength(1);
			expect(genImage.images[0]?.mimeType).toBe("image/png");

			// Verify IM chat is denied unless allowedCapabilityChat or admin.
			await expect(
				tools.invoke(
					"acp.run_capability",
					{ profileId: "mock-codex", prompt: "hello" },
					{ chatKind: "group", conversationId: "conv-2", isAdmin: false },
				),
			).rejects.toThrow("not enabled for IM chat");

			// Verify settings change dynamically updates registered providers and tools.
			settingsValue = { profiles: [] };
			for (const listener of settingsListeners) await listener(settingsValue);
			expect(await models.listModels({ providerId: "acp:mock-codex" })).toHaveLength(0);
			expect(tools.list()).toHaveLength(0);
		} finally {
			await plugin.teardown?.(context);
		}
	});
});
