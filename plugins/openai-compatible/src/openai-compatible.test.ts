import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	createPluginContext,
	pluginManifestSchema,
	type PluginLogger,
	type PluginModelProvider,
} from "@elaina/sdk";
import {
	modelCapabilities,
	modelInputModalities,
	resolveOpenAiCompatibleConfig,
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

function asFetch(handler: () => Promise<Response>): typeof globalThis.fetch {
	return handler as unknown as typeof globalThis.fetch;
}

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
		openAiCompatiblePlugin.prepare?.(context);
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
			openAiCompatiblePlugin.prepare?.(context);
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
			openAiCompatiblePlugin.prepare?.(context);
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
