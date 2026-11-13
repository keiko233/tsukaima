import { describe, expect, test } from "bun:test";
import { createPluginContext, pluginManifestSchema, type PluginModelProvider } from "@elaina/sdk";
import { openAiCompatiblePlugin } from "./index.ts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

describe("openai-compatible plugin", () => {
	test("manifest matches the packaged elaina.plugin.json", async () => {
		const packaged = (await Bun.file(
			new URL("../elaina.plugin.json", import.meta.url),
		).json()) as unknown;
		expect(pluginManifestSchema.parse(packaged)).toEqual(openAiCompatibleManifest);
	});

	test("registers a provider that is only configured when all fields are present", async () => {
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({ apiKey: "test-key", baseUrl: "https://models.example/v1" }),
				onChange: () => () => {},
			},
		});
		openAiCompatiblePlugin.prepare?.(context);
		const provider = context.models.getProvider(
			OPENAI_COMPATIBLE_PROVIDER_ID,
		) as PluginModelProvider;
		expect(provider).toBeDefined();
		expect(await provider.isConfigured?.()).toBe(false);
	});

	test("builds a model port when configured and carries usage callbacks", async () => {
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({
					apiKey: "test-key",
					baseUrl: "https://models.example/v1",
					modelId: "chat-model",
				}),
				onChange: () => () => {},
			},
		});
		openAiCompatiblePlugin.prepare?.(context);
		const provider = context.models.getProvider(
			OPENAI_COMPATIBLE_PROVIDER_ID,
		) as PluginModelProvider;
		expect(await provider.isConfigured?.()).toBe(true);
		const port = await provider.createPort();
		expect(port.providerId).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
		expect(port.modelId).toBe("chat-model");
	});
});
