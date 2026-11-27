import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	createPluginContext,
	pluginManifestSchema,
	type PluginLogger,
	type PluginModelProvider,
} from "@tsukaima/sdk";
import {
	modelCapabilities,
	modelInputModalities,
	modelOutputModalities,
	openAiCompatibleProviderIdForProfile,
	resolveOpenAiCompatibleConfig,
	resolveOpenAiCompatibleProfiles,
	toPluginModelDescriptor,
} from "./config.ts";
import { discoverOpenAiCompatibleModels } from "./discovery.ts";
import { openAiCompatiblePlugin } from "./index.ts";
import { OPENAI_COMPATIBLE_PROVIDER_ID, openAiCompatibleManifest } from "./manifest.ts";

interface LogRecord {
	readonly details?: unknown;
	readonly level: string;
	readonly message: string;
}

function createRecordingLogger(records: LogRecord[]): PluginLogger {
	const write =
		(level: string) =>
		(message: string, details?: unknown): void => {
			records.push({ details, level, message });
		};
	return {
		debug: write("debug"),
		error: write("error"),
		info: write("info"),
		trace: write("trace"),
		warn: write("warn"),
	};
}

function findRecord(records: readonly LogRecord[], message: string): LogRecord | undefined {
	return records.find((record) => record.message === message);
}

function readDurationMs(record: LogRecord | undefined): unknown {
	const details = record?.details;
	if (typeof details !== "object" || details === null || !("durationMs" in details)) {
		return undefined;
	}
	return (details as { durationMs?: unknown }).durationMs;
}

function asFetch(
	handler: (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
	return handler as unknown as typeof globalThis.fetch;
}

function createMutableSettings(initial: Record<string, unknown>) {
	let current = initial;
	const listeners = new Set<(value: Record<string, unknown>) => void>();
	return {
		settings: {
			get: async () => current,
			onChange: (callback: (value: Record<string, unknown>) => void) => {
				listeners.add(callback);
				return () => {
					listeners.delete(callback);
				};
			},
		},
		set(value: Record<string, unknown>) {
			current = value;
			for (const listener of listeners) listener(current);
		},
	};
}

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
		await openAiCompatiblePlugin.prepare?.(context);
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
		await openAiCompatiblePlugin.prepare?.(context);
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

	test("resolves legacy settings as the default profile and provider id", () => {
		const profiles = resolveOpenAiCompatibleProfiles({
			apiKey: "legacy-key",
			baseUrl: "https://legacy.example/v1",
			models: [{ enabled: true, id: "legacy-chat" }],
		});
		expect(profiles).toHaveLength(1);
		expect(profiles[0]).toMatchObject({
			apiKey: "legacy-key",
			id: "default",
			providerId: "openai-compatible",
		});
		expect(profiles[0]?.enabledModels.map((model) => model.id)).toEqual(["legacy-chat"]);
		expect(openAiCompatibleProviderIdForProfile("default")).toBe("openai-compatible");
		expect(openAiCompatibleProviderIdForProfile("secondary")).toBe("openai-compatible:secondary");
	});

	test("registers a distinct provider for every configured profile", async () => {
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({
					profileApiKeys: { default: "primary-key", secondary: "secondary-key" },
					profiles: [
						{
							baseUrl: "https://primary.example/v1",
							enabled: true,
							id: "default",
							models: [{ enabled: true, id: "primary-chat" }],
						},
						{
							baseUrl: "https://secondary.example/v1",
							enabled: true,
							id: "secondary",
							models: [{ enabled: true, id: "secondary-chat" }],
						},
					],
				}),
				onChange: () => () => {},
			},
		});
		await openAiCompatiblePlugin.prepare?.(context);

		const primary = context.models.getProvider("openai-compatible") as
			| PluginModelProvider
			| undefined;
		const secondary = context.models.getProvider(
			openAiCompatibleProviderIdForProfile("secondary"),
		) as PluginModelProvider | undefined;
		expect(primary).toBeDefined();
		expect(secondary).toBeDefined();
		expect(await primary?.isConfigured?.()).toBe(true);
		expect(await secondary?.isConfigured?.()).toBe(true);
		expect((await primary?.listModels?.())?.map((model) => model.id)).toEqual(["primary-chat"]);
		expect((await secondary?.listModels?.())?.map((model) => model.id)).toEqual(["secondary-chat"]);
		const port = await secondary?.createPort();
		expect(port?.providerId).toBe("openai-compatible:secondary");
		expect(port?.modelId).toBe("secondary-chat");
	});

	test("skips an incomplete secondary profile without breaking the default profile", async () => {
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({
					profileApiKeys: { default: "primary-key" },
					profiles: [
						{
							baseUrl: "https://primary.example/v1",
							enabled: true,
							id: "default",
							models: [{ enabled: true, id: "primary-chat" }],
						},
						{
							baseUrl: "https://secondary.example/v1",
							enabled: true,
							id: "secondary",
							models: [{ enabled: true, id: "secondary-chat" }],
						},
						{
							baseUrl: "",
							enabled: true,
							id: "broken",
							models: [{ enabled: true, id: "broken-chat" }],
						},
					],
				}),
				onChange: () => () => {},
			},
		});
		await openAiCompatiblePlugin.prepare?.(context);

		expect(context.models.listProviders().map((provider) => provider.id)).toEqual([
			"openai-compatible",
		]);
		const primary = context.models.getProvider("openai-compatible") as PluginModelProvider;
		expect(await primary.isConfigured?.()).toBe(true);
		expect(
			context.models.getProvider(openAiCompatibleProviderIdForProfile("secondary")),
		).toBeUndefined();
		expect(
			context.models.getProvider(openAiCompatibleProviderIdForProfile("broken")),
		).toBeUndefined();
	});

	test("syncs provider registrations when settings change", async () => {
		const controller = createMutableSettings({
			apiKey: "primary-key",
			baseUrl: "https://primary.example/v1",
			models: [{ enabled: true, id: "primary-chat" }],
		});
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: controller.settings,
		});
		await openAiCompatiblePlugin.prepare?.(context);
		expect(
			context.models.getProvider(openAiCompatibleProviderIdForProfile("secondary")),
		).toBeUndefined();

		controller.set({
			profileApiKeys: { default: "primary-key", secondary: "secondary-key" },
			profiles: [
				{
					baseUrl: "https://primary.example/v1",
					enabled: true,
					id: "default",
					models: [{ enabled: true, id: "primary-chat" }],
				},
				{
					baseUrl: "https://secondary.example/v1",
					enabled: true,
					id: "secondary",
					models: [{ enabled: true, id: "secondary-chat" }],
				},
			],
		});
		expect(await context.models.getProvider("openai-compatible")?.isConfigured?.()).toBe(true);
		expect(
			await context.models
				.getProvider(openAiCompatibleProviderIdForProfile("secondary"))
				?.isConfigured?.(),
		).toBe(true);

		controller.set({
			profileApiKeys: { default: "primary-key" },
			profiles: [
				{
					baseUrl: "https://primary.example/v1",
					enabled: true,
					id: "default",
					models: [{ enabled: true, id: "primary-chat" }],
				},
			],
		});
		expect(
			context.models.getProvider(openAiCompatibleProviderIdForProfile("secondary")),
		).toBeUndefined();
		expect(context.models.getProvider("openai-compatible")).toBeDefined();

		openAiCompatiblePlugin.teardown?.(context);
		expect(context.models.listProviders()).toHaveLength(0);
	});

	test("uses the selected profile's key for model discovery", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () => Response.json({ data: [{ id: "secondary-chat" }] })),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						profileApiKeys: {
							default: "primary-key",
							secondary: "secondary-key",
						},
						profiles: [
							{
								baseUrl: "https://primary.example/v1",
								enabled: true,
								id: "default",
								models: [{ enabled: true, id: "primary-chat" }],
							},
							{
								baseUrl: "https://secondary.example/v1",
								enabled: true,
								id: "secondary",
								models: [{ enabled: true, id: "secondary-chat" }],
							},
						],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.setup?.(context);
			const invokeRpc = (
				context.rpc as unknown as {
					invoke(method: string, input: unknown): Promise<unknown>;
				}
			).invoke.bind(context.rpc);
			const result = (await invokeRpc("models.discover", {
				profileId: "secondary",
			})) as { readonly models: readonly { readonly id: string }[] };
			expect(result.models.map((model) => model.id)).toEqual(["secondary-chat"]);
			expect(fetchSpy).toHaveBeenCalledWith("https://secondary.example/v1/models", {
				headers: {
					accept: "application/json",
					authorization: "Bearer secondary-key",
				},
				method: "GET",
			});
		} finally {
			fetchSpy.mockRestore();
		}
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
		await openAiCompatiblePlugin.prepare?.(context);
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

	test("logs model port construction without exposing the api key", async () => {
		const records: LogRecord[] = [];
		const context = createPluginContext({
			grantedPermissions: ["model.call", "settings"],
			logger: createRecordingLogger(records),
			manifest: openAiCompatibleManifest,
			pluginId: "openai-compatible",
			settings: {
				get: async () => ({
					apiKey: "secret-key",
					baseUrl: "https://models.example/v1",
					modelId: "chat-model",
				}),
				onChange: () => () => {},
			},
		});
		await openAiCompatiblePlugin.prepare?.(context);
		const provider = context.models.getProvider(
			OPENAI_COMPATIBLE_PROVIDER_ID,
		) as PluginModelProvider;
		await provider.createPort();

		expect(records).toContainEqual({
			details: {
				baseUrl: "https://models.example/v1",
				defaultModelId: "chat-model",
				modelCount: 1,
				providerId: "openai-compatible",
			},
			level: "debug",
			message: "OpenAI-compatible model port created",
		});
		expect(JSON.stringify(records)).not.toContain("secret-key");
	});

	test("logs setup, settings refreshes, discovery, and teardown", async () => {
		const records: LogRecord[] = [];
		let refresh: (() => void) | undefined;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () => Response.json({ data: [{ id: "chat-model" }, { id: "embed-small" }] })),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				logger: createRecordingLogger(records),
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "secret-key",
						baseUrl: "https://models.example/v1",
						modelId: "chat-model",
					}),
					onChange: (callback) => {
						refresh = () => {
							callback({});
						};
						return () => {};
					},
				},
			});
			await openAiCompatiblePlugin.setup?.(context);
			expect(findRecord(records, "OpenAI-compatible settings refreshed")?.details).toEqual({
				baseUrl: "https://models.example/v1",
				configured: true,
				enabledModels: 1,
				profiles: 1,
			});
			refresh?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(
				records.filter((record) => record.message === "OpenAI-compatible settings refreshed"),
			).toHaveLength(2);

			const invokeRpc = (
				context.rpc as unknown as {
					invoke(method: string, input: unknown): Promise<unknown>;
				}
			).invoke.bind(context.rpc);
			const result = (await invokeRpc("models.discover", {})) as {
				readonly models: readonly unknown[];
			};
			expect(result.models).toHaveLength(2);
			expect(findRecord(records, "OpenAI-compatible model discovery started")?.details).toEqual({
				baseUrl: "https://models.example/v1",
			});
			const completed = findRecord(records, "OpenAI-compatible model discovery completed");
			expect(completed?.details).toMatchObject({
				baseUrl: "https://models.example/v1",
				discoveredCount: 2,
			});
			expect(typeof readDurationMs(completed)).toBe("number");
			expect(records).toContainEqual({
				details: undefined,
				level: "info",
				message: "OpenAI-compatible plugin ready",
			});

			openAiCompatiblePlugin.teardown?.(context);
			expect(records).toContainEqual({
				details: undefined,
				level: "info",
				message: "OpenAI-compatible plugin stopped",
			});
			expect(JSON.stringify(records)).not.toContain("secret-key");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("logs discovery trace and debug without logging the api key", async () => {
		const records: LogRecord[] = [];
		const fetch = mock(async () => Response.json({ data: [{ id: "first" }, { id: "second" }] }));
		await discoverOpenAiCompatibleModels({
			apiKey: "secret-key",
			baseUrl: "https://models.example/v1/",
			fetch: fetch as unknown as typeof globalThis.fetch,
			logger: createRecordingLogger(records),
		});

		expect(records.map((record) => record.level)).toEqual(["trace", "debug"]);
		expect(records[0]?.details).toEqual({ baseUrl: "https://models.example/v1" });
		expect(records[1]?.details).toMatchObject({
			baseUrl: "https://models.example/v1",
			discoveredCount: 2,
		});
		expect(typeof readDurationMs(records[1])).toBe("number");
		expect(JSON.stringify(records)).not.toContain("secret-key");
	});

	test("warns on discovery HTTP errors and invalid JSON without logging the api key", async () => {
		const httpRecords: LogRecord[] = [];
		await expect(
			discoverOpenAiCompatibleModels({
				apiKey: "secret-key",
				baseUrl: "https://models.example/v1",
				fetch: mock(
					async () => new Response("nope", { status: 401 }),
				) as unknown as typeof globalThis.fetch,
				logger: createRecordingLogger(httpRecords),
			}),
		).rejects.toThrow("Model discovery failed (401)");
		expect(httpRecords).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: "OpenAI-compatible model discovery was rejected",
			}),
		);
		expect(JSON.stringify(httpRecords)).not.toContain("secret-key");

		const jsonRecords: LogRecord[] = [];
		await expect(
			discoverOpenAiCompatibleModels({
				apiKey: "secret-key",
				baseUrl: "https://models.example/v1",
				fetch: mock(
					async () => new Response("not json", { status: 200 }),
				) as unknown as typeof globalThis.fetch,
				logger: createRecordingLogger(jsonRecords),
			}),
		).rejects.toThrow("invalid JSON");
		expect(jsonRecords).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: "OpenAI-compatible model discovery returned invalid JSON",
			}),
		);
		expect(JSON.stringify(jsonRecords)).not.toContain("secret-key");
	});

	test("logs embedding trace and debug and warns on rejected requests", async () => {
		const records: LogRecord[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () =>
				Response.json({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }] }),
			),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				logger: createRecordingLogger(records),
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "secret-key",
						baseUrl: "https://models.example/v1",
						models: [{ capabilities: ["embedding"], enabled: true, id: "embed-small" }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.embed === undefined) throw new Error("embed port missing");
			const result = await provider.embed({ texts: ["hello", "world"] });
			expect(result.vectors).toEqual([[0.1, 0.2], [0.3]]);

			expect(findRecord(records, "OpenAI-compatible embedding request")?.details).toEqual({
				modelId: "embed-small",
				providerId: "openai-compatible",
				textCount: 2,
				textPreviewLength: 10,
			});
			const completed = findRecord(records, "OpenAI-compatible embedding completed");
			expect(completed?.details).toMatchObject({
				count: 2,
				modelId: "embed-small",
				vectorCount: 2,
			});
			expect(typeof readDurationMs(completed)).toBe("number");
			expect(completed?.level).toBe("debug");
			expect(JSON.stringify(records)).not.toContain("secret-key");

			fetchSpy.mockImplementation(asFetch(async () => new Response("denied", { status: 403 })));
			await expect(provider.embed({ texts: ["hello"] })).rejects.toThrow(
				"Embedding request failed with 403",
			);
			expect(
				findRecord(records, "OpenAI-compatible embedding request rejected")?.details,
			).toMatchObject({ modelId: "embed-small", status: 403 });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("logs transcription trace and debug and warns on rejected requests", async () => {
		const records: LogRecord[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () => Response.json({ language: "en", text: "hello there" })),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				logger: createRecordingLogger(records),
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "secret-key",
						baseUrl: "https://models.example/v1",
						models: [{ capabilities: ["audio.transcribe"], enabled: true, id: "whisper" }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.transcribeAudio === undefined) throw new Error("audio port missing");
			const result = await provider.transcribeAudio({
				audio: new Uint8Array([1, 2, 3, 4]),
				mimeType: "audio/wav",
			});
			expect(result.text).toBe("hello there");

			expect(findRecord(records, "OpenAI-compatible transcription request")?.details).toEqual({
				bytes: 4,
				mimeType: "audio/wav",
				modelId: "whisper",
				providerId: "openai-compatible",
			});
			const completed = findRecord(records, "OpenAI-compatible transcription completed");
			expect(completed?.details).toMatchObject({
				language: "en",
				modelId: "whisper",
				textChars: 11,
			});
			expect(typeof readDurationMs(completed)).toBe("number");
			expect(completed?.level).toBe("debug");
			expect(JSON.stringify(records)).not.toContain("secret-key");

			fetchSpy.mockImplementation(asFetch(async () => new Response("denied", { status: 429 })));
			await expect(provider.transcribeAudio({ audio: new Uint8Array([1]) })).rejects.toThrow(
				"Audio transcription failed with 429",
			);
			expect(
				findRecord(records, "OpenAI-compatible transcription request rejected")?.details,
			).toMatchObject({ modelId: "whisper", status: 429 });
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("generates images through the JSON generations endpoint", async () => {
		const calls: { readonly init?: RequestInit; readonly url: string }[] = [];
		const encoded = Buffer.from([1, 2, 3]).toString("base64");
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async (input, init) => {
				calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
				return Response.json({
					data: [
						{ b64_json: encoded, revised_prompt: "synthetic revised" },
						{ url: "https://cdn.example/synthetic.png" },
					],
				});
			}),
		);
		try {
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
								enabled: true,
								id: "image-1",
								supportsImageGeneration: true,
								supportsReasoning: false,
								supportsSidechat: false,
								supportsTools: false,
							},
						],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.generateImage === undefined) throw new Error("image port missing");
			const controller = new AbortController();
			const result = await provider.generateImage({
				count: 2,
				prompt: "synthetic prompt",
				signal: controller.signal,
				size: "512x512",
			});

			expect(result.providerId).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
			expect(result.modelId).toBe("image-1");
			expect(result.images).toEqual([
				{
					bytes: new Uint8Array([1, 2, 3]),
					mimeType: "image/png",
					revisedPrompt: "synthetic revised",
				},
				{ mimeType: "image/png", url: "https://cdn.example/synthetic.png" },
			]);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://models.example/v1/images/generations");
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
				model: "image-1",
				n: 2,
				prompt: "synthetic prompt",
				response_format: "b64_json",
				size: "512x512",
			});
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("edits images through the multipart edits endpoint", async () => {
		const calls: { readonly init?: RequestInit; readonly url: string }[] = [];
		const encoded = Buffer.from([4, 5, 6]).toString("base64");
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async (input, init) => {
				calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
				return Response.json({ data: [{ b64_json: encoded }] });
			}),
		);
		try {
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
								capabilities: ["image.edit"],
								enabled: true,
								id: "image-edit-1",
								supportsImageGeneration: true,
								supportsReasoning: false,
								supportsSidechat: false,
								supportsTools: false,
							},
						],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.generateImage === undefined) throw new Error("image port missing");
			const controller = new AbortController();
			const firstReference = new Uint8Array([9, 8, 7]);
			const secondReference = new Uint8Array([6, 5, 4]);
			const result = await provider.generateImage({
				count: 1,
				prompt: "synthetic edit",
				referenceImages: [
					{ bytes: firstReference, mimeType: "image/png" },
					{ bytes: secondReference, mimeType: "image/jpeg" },
				],
				signal: controller.signal,
				size: "1024x1024",
			});

			expect(result).toEqual({
				images: [{ bytes: new Uint8Array([4, 5, 6]), mimeType: "image/png" }],
				modelId: "image-edit-1",
				providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("https://models.example/v1/images/edits");
			const form = calls[0]?.init?.body;
			if (!(form instanceof FormData)) throw new Error("expected a FormData body");
			expect(form.get("model")).toBe("image-edit-1");
			expect(form.get("prompt")).toBe("synthetic edit");
			expect(form.get("n")).toBe("1");
			expect(form.get("size")).toBe("1024x1024");
			expect(form.get("response_format")).toBe("b64_json");
			const images = form.getAll("image");
			expect(images).toHaveLength(2);
			const [firstImage, secondImage] = images;
			if (!(firstImage instanceof Blob) || !(secondImage instanceof Blob)) {
				throw new Error("expected image blobs");
			}
			expect(firstImage.type).toBe("image/png");
			expect(secondImage.type).toBe("image/jpeg");
			expect(new Uint8Array(await firstImage.arrayBuffer())).toEqual(firstReference);
			expect(new Uint8Array(await secondImage.arrayBuffer())).toEqual(secondReference);
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("rejects image requests when no image-generation model is enabled", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () => Response.json({ data: [] })),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "test-key",
						baseUrl: "https://models.example/v1",
						models: [{ enabled: true, id: "chat-1" }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.generateImage === undefined) throw new Error("image port missing");
			await expect(provider.generateImage({ prompt: "synthetic prompt" })).rejects.toThrow(
				"No enabled image-generation model is configured",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("submits and polls a video job until it completes with a URL", async () => {
		const calls: { readonly init?: RequestInit; readonly url: string }[] = [];
		let pollCount = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async (input, init) => {
				calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
				if (init?.method === "POST") {
					return Response.json({ id: "video-job-1", status: "queued" });
				}
				pollCount += 1;
				if (pollCount === 1) return Response.json({ progress: 25, status: "queued" });
				if (pollCount === 2) return Response.json({ progress: 80, status: "in_progress" });
				return Response.json({
					mime_type: "video/mp4",
					status: "completed",
					url: "https://cdn.example/synthetic.mp4",
				});
			}),
		);
		try {
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
								enabled: true,
								id: "video-1",
								supportsSidechat: false,
								supportsTools: false,
								supportsVideoGeneration: true,
							},
						],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.submitVideoJob === undefined || provider.pollVideoJob === undefined) {
				throw new Error("video port missing");
			}
			const controller = new AbortController();
			const handle = await provider.submitVideoJob({
				aspectRatio: "16:9",
				durationSeconds: 4,
				modelId: "video-1",
				prompt: "synthetic prompt",
				resolution: "1280x720",
				seed: 7,
				signal: controller.signal,
			});

			expect(handle).toEqual({
				jobId: "video-job-1",
				modelId: "video-1",
				pollAfterMs: 3_000,
				providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
			});
			expect(calls[0]?.url).toBe("https://models.example/v1/videos");
			expect(calls[0]?.init?.method).toBe("POST");
			expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
				aspect_ratio: "16:9",
				model: "video-1",
				prompt: "synthetic prompt",
				resolution: "1280x720",
				seconds: 4,
				seed: 7,
			});
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");

			expect(await provider.pollVideoJob(handle, controller.signal)).toEqual({
				pollAfterMs: 3_000,
				progress: 25,
				status: "queued",
			});
			expect(await provider.pollVideoJob(handle, controller.signal)).toEqual({
				pollAfterMs: 3_000,
				progress: 80,
				status: "running",
			});
			expect(await provider.pollVideoJob(handle, controller.signal)).toEqual({
				status: "succeeded",
				video: { mimeType: "video/mp4", url: "https://cdn.example/synthetic.mp4" },
			});
			expect(calls[1]?.url).toBe("https://models.example/v1/videos/video-job-1");
			expect(calls[1]?.init?.method).toBe("GET");
			expect(calls[1]?.init?.signal).toBe(controller.signal);
			expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe("Bearer test-key");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("maps a completed video job with inline base64 bytes", async () => {
		const encoded = Buffer.from([7, 8, 9]).toString("base64");
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async (_input, init) =>
				init?.method === "POST"
					? Response.json({ id: "video-job-b64" })
					: Response.json({
							b64_json: encoded,
							mime_type: "video/webm",
							status: "succeeded",
						}),
			),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "test-key",
						baseUrl: "https://models.example/v1",
						models: [{ enabled: true, id: "video-1", supportsVideoGeneration: true }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.submitVideoJob === undefined || provider.pollVideoJob === undefined) {
				throw new Error("video port missing");
			}
			const handle = await provider.submitVideoJob({ prompt: "synthetic prompt" });
			expect(handle.modelId).toBe("video-1");
			expect(await provider.pollVideoJob(handle)).toEqual({
				status: "succeeded",
				video: { bytes: new Uint8Array([7, 8, 9]), mimeType: "video/webm" },
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("maps failed and cancelled video jobs", async () => {
		let pollCount = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async (_input, init) => {
				if (init?.method === "POST") return Response.json({ id: "video-job-failed" });
				pollCount += 1;
				return pollCount === 1
					? Response.json({ error: { message: "synthetic failure" }, status: "failed" })
					: Response.json({ status: "cancelled" });
			}),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "test-key",
						baseUrl: "https://models.example/v1",
						models: [{ enabled: true, id: "video-1", supportsVideoGeneration: true }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.submitVideoJob === undefined || provider.pollVideoJob === undefined) {
				throw new Error("video port missing");
			}
			const handle = await provider.submitVideoJob({ prompt: "synthetic prompt" });
			expect(await provider.pollVideoJob(handle)).toEqual({
				error: "synthetic failure",
				status: "failed",
			});
			expect(await provider.pollVideoJob(handle)).toEqual({
				error: "Video generation failed",
				status: "failed",
			});
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("rejects video requests when no video model is enabled", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			asFetch(async () => Response.json({ id: "unused" })),
		);
		try {
			const context = createPluginContext({
				grantedPermissions: ["model.call", "settings"],
				manifest: openAiCompatibleManifest,
				pluginId: "openai-compatible",
				settings: {
					get: async () => ({
						apiKey: "test-key",
						baseUrl: "https://models.example/v1",
						models: [{ enabled: true, id: "chat-1" }],
					}),
					onChange: () => () => {},
				},
			});
			await openAiCompatiblePlugin.prepare?.(context);
			const provider = context.models.getProvider(
				OPENAI_COMPATIBLE_PROVIDER_ID,
			) as PluginModelProvider;
			if (provider.submitVideoJob === undefined) throw new Error("video port missing");
			await expect(provider.submitVideoJob({ prompt: "synthetic prompt" })).rejects.toThrow(
				"No enabled video-generation model is configured",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("maps video flags to capabilities and output modalities", () => {
		const config = resolveOpenAiCompatibleConfig({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			models: [
				{
					enabled: true,
					id: "video-1",
					supportsImage: true,
					supportsReasoning: false,
					supportsSidechat: false,
					supportsTools: false,
					supportsVideoGeneration: true,
				},
				{
					capabilities: ["video.image2video"],
					enabled: true,
					id: "video-2",
					supportsReasoning: false,
					supportsSidechat: false,
					supportsTools: false,
				},
			],
		});
		const first = config?.models[0];
		const second = config?.models[1];
		if (first === undefined || second === undefined) throw new Error("model missing");
		expect(modelCapabilities(first)).toEqual(
			expect.arrayContaining(["video.generate", "video.image2video"]),
		);
		expect(modelOutputModalities(first)).toEqual(["video"]);
		expect(modelCapabilities(second)).toContain("video.image2video");
		expect(modelOutputModalities(second)).toEqual(["video"]);
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
		expect(modelCapabilities(first)).toContain("chat.sidechat");
		expect(modelInputModalities(first)).toEqual(["text", "image"]);
		expect(toPluginModelDescriptor(first).reasoning).toEqual({
			default: "medium",
			levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
		});
	});

	test("lets the model opt out of the sidechat capability", () => {
		const config = resolveOpenAiCompatibleConfig({
			apiKey: "test-key",
			baseUrl: "https://models.example/v1",
			models: [{ enabled: true, id: "slow", supportsSidechat: false }],
		});
		const model = config?.models[0];
		if (model === undefined) throw new Error("model missing");
		expect(model.supportsSidechat).toBe(false);
		expect(modelCapabilities(model)).not.toContain("chat.sidechat");
	});
});
