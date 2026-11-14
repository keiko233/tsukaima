import { describe, expect, mock, test } from "bun:test";
import { createPluginContext, pluginManifestSchema, type PluginModelProvider } from "@tsukaima/sdk";
import {
	modelCapabilities,
	modelInputModalities,
	resolveOpenAiCompatibleConfig,
	toPluginModelDescriptor,
} from "./config.ts";
import { discoverOpenAiCompatibleModels } from "./discovery.ts";
import { openAiCompatiblePlugin } from "./index.ts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

describe("openai-compatible plugin", () => {
	test("manifest matches the packaged tsukaima.plugin.json", async () => {
		const packaged = (await Bun.file(
			new URL("../tsukaima.plugin.json", import.meta.url),
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

	test("migrates the legacy modelId setting into an enabled model", () => {
		const config = resolveOpenAiCompatibleConfig({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			modelId: "legacy-chat",
		});
		expect(config?.models).toEqual([
			expect.objectContaining({
				enabled: true,
				id: "legacy-chat",
				supportsTools: true,
			}),
		]);
		expect(config?.enabledModels.map((model) => model.id)).toEqual(["legacy-chat"]);
	});

	test("publishes only enabled models with capability and modality metadata", async () => {
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({
					apiKey: "test-key",
					baseUrl: "https://models.example/v1",
					models: [
						{
							capabilities: ["coding"],
							contextWindow: 200_000,
							enabled: true,
							id: "reasoning-vision",
							maxOutputTokens: 16_384,
							supportsAudio: true,
							supportsImage: true,
							supportsReasoning: true,
							supportsTools: true,
						},
						{
							enabled: false,
							id: "disabled-model",
						},
					],
				}),
				onChange: () => () => {},
			},
		});
		openAiCompatiblePlugin.prepare?.(context);
		const provider = context.models.getProvider(
			OPENAI_COMPATIBLE_PROVIDER_ID,
		) as PluginModelProvider;
		const models = await provider.listModels?.();
		expect(models).toEqual([
			expect.objectContaining({
				capabilities: expect.arrayContaining([
					"basic-chat",
					"tool-use",
					"reasoning",
					"vision",
					"audio-input",
					"coding",
				]),
				contextWindow: 200_000,
				id: "reasoning-vision",
				input: ["text", "image", "audio"],
				maxOutputTokens: 16_384,
				reasoning: expect.objectContaining({ default: "medium" }),
			}),
		]);
		expect((await provider.createPort()).modelId).toBe("reasoning-vision");
		expect(await context.models.listModels({ capability: "vision" })).toEqual([
			expect.objectContaining({ id: "reasoning-vision", providerId: "openai-compatible" }),
		]);
	});

	test("discovers model ids and infers capabilities from OpenAI-compatible metadata", async () => {
		const fetch = mock(async () =>
			Response.json({
				data: [
					{
						architecture: { input_modalities: ["text", "image", "audio"] },
						context_length: 200_000,
						id: "provider/omni-reasoner",
						max_completion_tokens: 16_384,
						name: "Omni Reasoner",
						supported_parameters: ["tools", "reasoning"],
					},
					{
						id: "small-chat",
					},
				],
			}),
		);
		const result = await discoverOpenAiCompatibleModels({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1/",
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		expect(fetch).toHaveBeenCalledWith("https://models.example/v1/models", {
			headers: {
				accept: "application/json",
				authorization: "Bearer test-key",
			},
			method: "GET",
		});
		expect(result.models).toHaveLength(2);
		expect(result.models[0]).toMatchObject({
			contextWindow: 200_000,
			enabled: false,
			id: "provider/omni-reasoner",
			maxOutputTokens: 16_384,
			name: "Omni Reasoner",
			supportsAudio: true,
			supportsImage: true,
			supportsReasoning: true,
			supportsTools: true,
		});
		expect(result.models[1]).toMatchObject({
			id: "small-chat",
			supportsAudio: false,
			supportsImage: false,
			supportsReasoning: false,
			supportsTools: true,
		});
	});

	test("discovers capabilities from modalities.input, display_name, reasoning, and tool_call", async () => {
		const fetch = mock(async () =>
			Response.json({
				data: [
					{
						display_name: "Free Mixed",
						id: "group/free-mixed",
						modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
						reasoning: true,
						reasoning_levels: ["high"],
						supported_parameters: ["tools", "tool_choice", "reasoning"],
						tool_call: true,
					},
					{
						id: "qwen3-plain",
						input_modalities: ["text"],
						reasoning: false,
						tool_call: false,
					},
				],
			}),
		);
		const result = await discoverOpenAiCompatibleModels({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			fetch: fetch as unknown as typeof globalThis.fetch,
		});

		expect(result.models[0]).toMatchObject({
			defaultReasoningLevel: "high",
			id: "group/free-mixed",
			name: "Free Mixed",
			reasoningLevels: ["high"],
			supportsAudio: true,
			supportsImage: true,
			supportsReasoning: true,
			supportsTools: true,
		});
		expect(result.models[1]).toMatchObject({
			id: "qwen3-plain",
			supportsAudio: false,
			supportsImage: false,
			supportsReasoning: false,
			supportsTools: false,
		});
	});

	test("maps model flags to the shared plugin catalog vocabulary", () => {
		const first = resolveOpenAiCompatibleConfig({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			models: [
				{
					capabilities: ["coding", "structured-output"],
					enabled: true,
					id: "first",
					supportsImage: true,
					supportsReasoning: true,
					supportsTools: true,
				},
			],
		})?.models[0];
		if (first === undefined) throw new Error("model missing");
		expect(modelCapabilities(first)).toEqual(
			expect.arrayContaining([
				"basic-chat",
				"tool-use",
				"reasoning",
				"vision",
				"image-input",
				"coding",
				"structured-output",
			]),
		);
		expect(modelInputModalities(first)).toEqual(["text", "image"]);
		expect(toPluginModelDescriptor(first).reasoning).toEqual({
			default: "medium",
			levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
		});
	});
});
