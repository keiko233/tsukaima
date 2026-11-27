import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import type {
	PluginContext,
	PluginGeneratedImage,
	PluginImageGenerateRequest,
	PluginImageGenerateResult,
	PluginModelProvider,
	TsukaimaPlugin,
} from "@tsukaima/sdk";
import { z } from "zod";
import {
	modelCapabilities,
	readOpenAiCompatibleConnection,
	readOpenAiCompatibleProfiles,
	resolveOpenAiCompatibleProfiles,
	toPluginModelDescriptor,
	type ReadOpenAiCompatibleProfile,
} from "./config.ts";
import { discoverOpenAiCompatibleModels } from "./discovery.ts";
import { openAiCompatibleManifest } from "./manifest.ts";

export {
	OPENAI_COMPATIBLE_DISCOVER_RPC,
	OPENAI_COMPATIBLE_PLUGIN_ID,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./manifest.ts";
export {
	createOpenAiCompatibleModel,
	modelCapabilities,
	modelInputModalities,
	openAiCompatibleConfigSchema,
	openAiCompatibleModelSchema,
	openAiCompatibleProfileSchema,
	openAiCompatibleProviderIdForProfile,
	openAiCompatibleReasoningLevelSchema,
	readOpenAiCompatibleModels,
	readOpenAiCompatibleProfiles,
	resolveOpenAiCompatibleConfig,
	resolveOpenAiCompatibleProfiles,
	toPluginModelDescriptor,
} from "./config.ts";
export type {
	OpenAiCompatibleConfig,
	OpenAiCompatibleModel,
	OpenAiCompatibleProfile,
	OpenAiCompatibleReasoningLevel,
	ReadOpenAiCompatibleProfile,
	ResolvedOpenAiCompatibleConfig,
	ResolvedOpenAiCompatibleProfile,
} from "./config.ts";
export { discoverOpenAiCompatibleModels } from "./discovery.ts";

const discoverInputSchema = z
	.object({
		apiKey: z.string().min(1).optional(),
		baseUrl: z.string().url().optional(),
		profileId: z.string().trim().min(1).optional(),
	})
	.optional();

interface RuntimeState {
	readonly providers: Map<string, () => void>;
	readonly settingsUnsubscribers: Set<() => void>;
}

interface ImageResponseItem {
	readonly b64_json?: string;
	readonly revised_prompt?: string;
	readonly url?: string;
}

const runtimeStates = new WeakMap<object, RuntimeState>();

function runtimeState(context: PluginContext): RuntimeState {
	const existing = runtimeStates.get(context);
	if (existing !== undefined) return existing;
	const state: RuntimeState = {
		providers: new Map(),
		settingsUnsubscribers: new Set(),
	};
	runtimeStates.set(context, state);
	return state;
}

async function readPluginSettings(context: PluginContext): Promise<Record<string, unknown>> {
	return ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createProvider(
	context: PluginContext,
	profile: ReadOpenAiCompatibleProfile,
): PluginModelProvider {
	const providerId = profile.providerId;
	const baseUrl = profile.baseUrl.trim();
	const apiKey = profile.apiKey ?? "";
	const enabledModels = profile.models.filter((model) => model.enabled);
	const configured = baseUrl.length > 0 && apiKey.trim().length > 0 && enabledModels.length > 0;

	return {
		id: providerId,
		async isConfigured() {
			return configured;
		},
		async listModels() {
			return configured ? enabledModels.map(toPluginModelDescriptor) : [];
		},
		async embed(request) {
			const startedAt = performance.now();
			if (!configured) throw new Error("OpenAI-compatible provider is not configured");
			const model =
				enabledModels.find(
					(candidate) =>
						candidate.id === request.modelId && modelCapabilities(candidate).includes("embedding"),
				) ?? enabledModels.find((candidate) => modelCapabilities(candidate).includes("embedding"));
			if (model === undefined) {
				throw new Error("No enabled embedding model is configured");
			}
			context.logger.trace("OpenAI-compatible embedding request", {
				modelId: model.id,
				providerId,
				textCount: request.texts.length,
				textPreviewLength: request.texts.reduce((total, text) => total + text.length, 0),
			});
			let response: Response;
			try {
				response = await fetch(`${baseUrl.replace(/\/$/u, "")}/embeddings`, {
					body: JSON.stringify({ input: request.texts, model: model.id }),
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
					},
					method: "POST",
				});
			} catch (error) {
				context.logger.error("OpenAI-compatible embedding request failed", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					error,
				});
				throw error;
			}
			if (!response.ok) {
				context.logger.warn("OpenAI-compatible embedding request rejected", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					status: response.status,
				});
				throw new Error(`Embedding request failed with ${response.status}`);
			}
			const payload = (await response.json()) as {
				data?: readonly { readonly embedding?: readonly number[] }[];
			};
			const vectors = (payload.data ?? []).map((item) => item.embedding ?? []);
			context.logger.debug("OpenAI-compatible embedding completed", {
				count: request.texts.length,
				durationMs: Math.round(performance.now() - startedAt),
				modelId: model.id,
				providerId,
				vectorCount: vectors.length,
			});
			return {
				modelId: model.id,
				providerId,
				vectors,
			};
		},
		async transcribeAudio(request) {
			const startedAt = performance.now();
			if (!configured) throw new Error("OpenAI-compatible provider is not configured");
			const model =
				enabledModels.find(
					(candidate) =>
						candidate.id === request.modelId &&
						modelCapabilities(candidate).includes("audio.transcribe"),
				) ??
				enabledModels.find((candidate) =>
					modelCapabilities(candidate).includes("audio.transcribe"),
				);
			if (model === undefined) {
				throw new Error("No enabled audio-transcribe model is configured");
			}
			const form = new FormData();
			form.set("model", model.id);
			const bytes =
				typeof request.audio === "string"
					? new TextEncoder().encode(request.audio)
					: request.audio instanceof ArrayBuffer
						? new Uint8Array(request.audio)
						: request.audio;
			const mimeType = request.mimeType ?? "application/octet-stream";
			form.set("file", new Blob([bytes], { type: mimeType }), "audio");
			context.logger.trace("OpenAI-compatible transcription request", {
				bytes: bytes.byteLength,
				mimeType,
				modelId: model.id,
				providerId,
			});
			let response: Response;
			try {
				response = await fetch(`${baseUrl.replace(/\/$/u, "")}/audio/transcriptions`, {
					body: form,
					headers: { authorization: `Bearer ${apiKey}` },
					method: "POST",
				});
			} catch (error) {
				context.logger.error("OpenAI-compatible transcription request failed", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					error,
				});
				throw error;
			}
			if (!response.ok) {
				context.logger.warn("OpenAI-compatible transcription request rejected", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					status: response.status,
				});
				throw new Error(`Audio transcription failed with ${response.status}`);
			}
			const payload = (await response.json()) as {
				language?: string;
				text?: string;
			};
			const text = payload.text ?? "";
			context.logger.debug("OpenAI-compatible transcription completed", {
				durationMs: Math.round(performance.now() - startedAt),
				language: payload.language,
				modelId: model.id,
				providerId,
				textChars: text.length,
			});
			return {
				...(payload.language === undefined ? {} : { language: payload.language }),
				modelId: model.id,
				providerId,
				text,
			};
		},
		async generateImage(request: PluginImageGenerateRequest): Promise<PluginImageGenerateResult> {
			const startedAt = performance.now();
			if (!configured) throw new Error("OpenAI-compatible provider is not configured");
			const supportsImage = (candidate: (typeof enabledModels)[number]): boolean => {
				const capabilities = modelCapabilities(candidate);
				return capabilities.includes("image.generate") || capabilities.includes("image.edit");
			};
			const model =
				enabledModels.find(
					(candidate) => candidate.id === request.modelId && supportsImage(candidate),
				) ?? enabledModels.find(supportsImage);
			if (model === undefined) {
				throw new Error("No enabled image-generation model is configured");
			}
			const normalizedBaseUrl = baseUrl.replace(/\/$/u, "");
			const referenceImages = request.referenceImages ?? [];
			const usesReferenceImages = referenceImages.length > 0;
			context.logger.trace("OpenAI-compatible image request", {
				count: request.count,
				modelId: model.id,
				providerId,
				referenceCount: referenceImages.length,
				size: request.size,
			});
			let response: Response;
			try {
				if (usesReferenceImages) {
					const form = new FormData();
					form.set("model", model.id);
					form.set("prompt", request.prompt);
					if (request.count !== undefined && request.count > 0) {
						form.set("n", String(request.count));
					}
					if (request.size !== undefined) form.set("size", request.size);
					form.set("response_format", "b64_json");
					for (const reference of referenceImages) {
						form.append(
							"image",
							new Blob([reference.bytes], { type: reference.mimeType }),
							"image",
						);
					}
					response = await fetch(`${normalizedBaseUrl}/images/edits`, {
						body: form,
						headers: { authorization: `Bearer ${apiKey}` },
						method: "POST",
						...(request.signal === undefined ? {} : { signal: request.signal }),
					});
				} else {
					response = await fetch(`${normalizedBaseUrl}/images/generations`, {
						body: JSON.stringify({
							model: model.id,
							prompt: request.prompt,
							...(request.count === undefined || request.count <= 0 ? {} : { n: request.count }),
							...(request.size === undefined ? {} : { size: request.size }),
							response_format: "b64_json",
						}),
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
						},
						method: "POST",
						...(request.signal === undefined ? {} : { signal: request.signal }),
					});
				}
			} catch (error) {
				context.logger.error("OpenAI-compatible image request failed", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					error,
				});
				throw error;
			}
			if (!response.ok) {
				context.logger.warn("OpenAI-compatible image request rejected", {
					durationMs: Math.round(performance.now() - startedAt),
					modelId: model.id,
					providerId,
					status: response.status,
				});
				throw new Error(`Image generation request failed with ${response.status}`);
			}
			const payload = (await response.json()) as {
				readonly data?: readonly ImageResponseItem[];
			};
			const images: PluginGeneratedImage[] = [];
			for (const item of payload.data ?? []) {
				const revisedPrompt =
					item.revised_prompt === undefined ? {} : { revisedPrompt: item.revised_prompt };
				if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
					images.push({
						...revisedPrompt,
						bytes: Uint8Array.from(Buffer.from(item.b64_json, "base64")),
						mimeType: "image/png",
					});
					continue;
				}
				if (typeof item.url === "string" && item.url.length > 0) {
					images.push({ ...revisedPrompt, mimeType: "image/png", url: item.url });
				}
			}
			context.logger.debug("OpenAI-compatible image request completed", {
				durationMs: Math.round(performance.now() - startedAt),
				imageCount: images.length,
				modelId: model.id,
				providerId,
			});
			return { images, modelId: model.id, providerId };
		},
		async createPort(options = {}) {
			if (!configured) throw new Error("OpenAI-compatible provider is not configured");
			const portLogger = context.logger.child?.("openai") ?? context.logger;
			const port = createOpenAICompatibleModelPort(
				{
					apiKey,
					baseUrl,
					logger: portLogger,
					...(options.onMessage === undefined
						? {}
						: {
								onMessage: (message) => {
									options.onMessage?.(message);
								},
							}),
					providerId,
				},
				enabledModels.map((model) => ({
					capabilities: modelCapabilities(model),
					contextWindow: model.contextWindow,
					defaultReasoningLevel: model.defaultReasoningLevel,
					inputModalities: model.supportsImage ? ["text", "image"] : ["text"],
					maxOutputTokens: model.maxOutputTokens,
					modelId: model.id,
					...(model.name === undefined ? {} : { name: model.name }),
					reasoningLevels: model.reasoningLevels,
					supportsReasoning: model.supportsReasoning,
					supportsTools: model.supportsTools,
					...(model.temperature === undefined ? {} : { temperature: model.temperature }),
					...(model.topP === undefined ? {} : { topP: model.topP }),
					...(model.stop === undefined ? {} : { stop: model.stop }),
					...(model.requestTimeoutMs === undefined
						? {}
						: { requestTimeoutMs: model.requestTimeoutMs }),
				})),
			);
			context.logger.debug("OpenAI-compatible model port created", {
				baseUrl,
				defaultModelId: port.modelId,
				modelCount: enabledModels.length,
				providerId,
			});
			return port;
		},
	};
}

/**
 * Reconciles the host model registry with the current settings. Providers are unregistered
 * before re-registering so a settings change never trips the host's duplicate-id guard.
 */
function syncProviders(context: PluginContext, raw: Record<string, unknown>): void {
	const state = runtimeState(context);
	const desired = new Map<string, ReadOpenAiCompatibleProfile>();
	for (const profile of resolveOpenAiCompatibleProfiles(raw)) {
		desired.set(profile.providerId, profile);
	}
	const defaultProfile = readOpenAiCompatibleProfiles(raw).find(
		(profile) => profile.id === "default" && profile.enabled,
	);
	if (defaultProfile !== undefined && !desired.has(defaultProfile.providerId)) {
		desired.set(defaultProfile.providerId, defaultProfile);
	}
	for (const [providerId, unregister] of state.providers) {
		if (desired.has(providerId)) continue;
		unregister();
		state.providers.delete(providerId);
	}
	for (const profile of desired.values()) {
		state.providers.get(profile.providerId)?.();
		state.providers.delete(profile.providerId);
		const unregister = context.models.registerProvider(createProvider(context, profile));
		state.providers.set(profile.providerId, unregister);
	}
}

/**
 * A model provider plugin. It registers a factory rather than a live port so the host can
 * decide when to build the model catalog and can inject usage accounting.
 */
export const openAiCompatiblePlugin: TsukaimaPlugin = {
	manifest: openAiCompatibleManifest,
	async prepare(context) {
		const state = runtimeState(context);
		syncProviders(context, await readPluginSettings(context));
		const unsubscribe = context.settings?.onChange((value) => {
			syncProviders(context, isRecord(value) ? value : {});
		});
		if (unsubscribe !== undefined) state.settingsUnsubscribers.add(unsubscribe);
		context.logger.info("OpenAI-compatible provider registered", {
			providers: state.providers.size,
		});
	},
	async setup(context) {
		const report = async (value?: Record<string, unknown>): Promise<void> => {
			const raw = value ?? (await readPluginSettings(context));
			const profiles = resolveOpenAiCompatibleProfiles(raw);
			if (profiles.length === 0) {
				context.logger.debug("OpenAI-compatible settings refreshed", { configured: false });
				context.ui.setStatus({
					code: "status_unconfigured",
					level: "unknown",
					summary: "Provider credentials or enabled models are incomplete",
				});
				return;
			}
			const defaultProfile = profiles.find((profile) => profile.id === "default") ?? profiles[0];
			if (defaultProfile === undefined) return;
			const enabledModels = profiles.reduce(
				(total, profile) => total + profile.enabledModels.length,
				0,
			);
			const savedModels = profiles.reduce((total, profile) => total + profile.models.length, 0);
			context.logger.debug("OpenAI-compatible settings refreshed", {
				baseUrl: defaultProfile.baseUrl,
				configured: true,
				enabledModels,
				profiles: profiles.length,
			});
			context.ui.setStatus({
				code: "status_configured",
				details: { baseUrl: defaultProfile.baseUrl, profiles: profiles.length },
				level: "ok",
				metrics: {
					enabled: enabledModels,
					model: defaultProfile.enabledModels[0]?.id ?? "—",
					profiles: profiles.length,
					total: savedModels,
				},
				summary:
					profiles.length === 1
						? (defaultProfile.enabledModels[0]?.id ?? "Provider configured")
						: `${profiles.length} endpoints · ${enabledModels} models`,
			});
		};
		await report();
		const state = runtimeState(context);
		const unsubscribe = context.settings?.onChange((value) => {
			void report(isRecord(value) ? value : {});
		});
		if (unsubscribe !== undefined) state.settingsUnsubscribers.add(unsubscribe);
		context.rpc.register("models.discover", async (input) => {
			const startedAt = performance.now();
			const parsed = discoverInputSchema.parse(input);
			const raw = await readPluginSettings(context);
			const stored = readOpenAiCompatibleConnection(raw);
			const profileApiKeys = isRecord(raw.profileApiKeys) ? raw.profileApiKeys : {};
			const profileId = parsed?.profileId;
			const selectedProfile =
				profileId === undefined
					? undefined
					: readOpenAiCompatibleProfiles(raw).find((profile) => profile.id === profileId);
			const profileApiKey = profileId === undefined ? undefined : profileApiKeys[profileId];
			const baseUrl = parsed?.baseUrl ?? selectedProfile?.baseUrl ?? stored.baseUrl;
			const apiKey =
				parsed?.apiKey ??
				(typeof profileApiKey === "string" ? profileApiKey : undefined) ??
				stored.apiKey;
			if (baseUrl === undefined || apiKey === undefined) {
				throw new Error("Base URL and API key are required before discovering models");
			}
			context.logger.debug("OpenAI-compatible model discovery started", { baseUrl });
			const result = await discoverOpenAiCompatibleModels({
				apiKey,
				baseUrl,
				logger: context.logger.child?.("discovery") ?? context.logger,
			});
			context.logger.debug("OpenAI-compatible model discovery completed", {
				baseUrl,
				discoveredCount: result.models.length,
				durationMs: Math.round(performance.now() - startedAt),
			});
			return result;
		});
		context.logger.info("OpenAI-compatible plugin ready");
	},
	teardown(context) {
		const state = runtimeState(context);
		for (const unregister of state.providers.values()) unregister();
		state.providers.clear();
		for (const unsubscribe of state.settingsUnsubscribers) unsubscribe();
		state.settingsUnsubscribers.clear();
		runtimeStates.delete(context);
		context.logger.info("OpenAI-compatible plugin stopped");
		context.ui.setStatus(null);
	},
};

export default openAiCompatiblePlugin;
