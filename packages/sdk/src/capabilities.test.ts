import { describe, expect, test } from "bun:test";
import {
	expandChannelCapabilities,
	expandLegacyChannelCapabilities,
	hasChannelCapability,
} from "./host.ts";
import { LocalModelRegistry } from "./bridges.ts";
import { hasModelCapability, MODEL_CAPABILITIES } from "./model-capabilities.ts";
import type {
	PluginDecisionChoiceRequest,
	PluginImageGenerateRequest,
	PluginModelCompleteRequest,
	PluginModelDescriptor,
} from "./types.ts";

describe("channel capabilities", () => {
	test("maps legacy capabilities to the granular machine-readable set", () => {
		expect(expandLegacyChannelCapabilities("send")).toContain("send.text");
		expect(expandLegacyChannelCapabilities("send")).toContain("send.image");
		expect(expandLegacyChannelCapabilities("interact")).toContain("interact.poke");
		expect(expandLegacyChannelCapabilities("group-manage")).toEqual(["manage.group"]);
		expect(expandLegacyChannelCapabilities("read-info")).toEqual(["read.history"]);
		expect(expandLegacyChannelCapabilities("read-media")).toEqual(["fetch.media"]);
		expect(new Set(expandChannelCapabilities(["send", "upload"]))).toEqual(
			new Set(["send.text", "send.image", "send.audio", "send.video", "send.file", "fetch.media"]),
		);
		expect(hasChannelCapability(["send"], "send.image")).toBe(true);
		expect(hasChannelCapability(["send.text"], "send")).toBe(true);
		expect(hasChannelCapability(["send.text"], "send.image")).toBe(false);
		expect(hasChannelCapability(["interact.poke"], "interact.poke")).toBe(true);
	});
});

describe("model capability ports", () => {
	test("discovers embedding and audio-transcribe models and routes optional ports", async () => {
		const models = new LocalModelRegistry();
		models.registerProvider({
			id: "provider",
			createPort: () => {
				throw new Error("chat port not used");
			},
			embed: ({ texts }) => ({
				modelId: "embed-1",
				providerId: "provider",
				vectors: texts.map((text) => [text.length]),
			}),
			listModels: () => [
				{
					capabilities: ["embedding"],
					id: "embed-1",
					input: ["text"],
				},
				{
					capabilities: ["audio.transcribe"],
					id: "stt-1",
					input: ["audio"],
				},
			],
			transcribeAudio: () => ({
				modelId: "stt-1",
				providerId: "provider",
				text: "hello",
			}),
		});

		expect((await models.listModels({ capability: "embedding" }))[0]?.id).toBe("embed-1");
		expect((await models.listModels({ capability: "audio.transcribe" }))[0]?.id).toBe("stt-1");
		expect((await models.findModel("stt-1"))?.providerId).toBe("provider");
		expect(await models.embed({ modelId: "embed-1", texts: ["a", "bb"] })).toEqual({
			modelId: "embed-1",
			providerId: "provider",
			vectors: [[1], [2]],
		});
		expect(
			await models.transcribeAudio({
				audio: new Uint8Array([1, 2, 3]),
				modelId: "stt-1",
			}),
		).toEqual({ modelId: "stt-1", providerId: "provider", text: "hello" });
	});

	test("routes multimodal completions through provider.complete and port.completeSimple", async () => {
		const models = new LocalModelRegistry();
		const capturedPortCalls: Array<{
			modelId: string;
			systemPrompt?: string;
			messages: unknown[];
		}> = [];
		models.registerProvider({
			complete: ({ modelId, providerId }) => ({
				modelId: modelId ?? "direct-default",
				providerId: providerId ?? "direct",
				text: `direct:${modelId}`,
			}),
			createPort: () => {
				throw new Error("port not used when complete() is provided");
			},
			id: "direct",
			listModels: () => [
				{
					capabilities: ["vision"],
					id: "direct-vision",
					input: ["text", "image"],
				},
			],
		});
		models.registerProvider({
			createPort: () => ({
				modelId: "port-chat",
				models: {
					completeSimple: async (
						model: { readonly id: string },
						context: { readonly systemPrompt?: string; readonly messages: unknown[] },
					) => {
						capturedPortCalls.push({
							messages: context.messages,
							modelId: model.id,
							...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
						});
						if (model.id === "port-fail") {
							return {
								errorMessage: "Upstream 429",
								stopReason: "error",
							};
						}
						return {
							content: [{ text: `port:${model.id}`, type: "text" }],
							stopReason: "stop",
						};
					},
					getModel: (_providerId: string, modelId: string) =>
						modelId === "port-vision" || modelId === "port-fail" ? { id: modelId } : undefined,
				},
				providerId: "port-provider",
			}),
			id: "port-provider",
			listModels: () => [
				{ capabilities: ["vision"], id: "port-vision", input: ["text", "image"] },
				{ capabilities: ["basic-chat"], id: "port-fail", input: ["text"] },
			],
		});

		const directResult = await models.complete({
			messages: [{ content: "hi", role: "user" }],
			modelId: "direct-vision",
			providerId: "direct",
		});
		expect(directResult).toEqual({
			modelId: "direct-vision",
			providerId: "direct",
			text: "direct:direct-vision",
		});

		const portResult = await models.complete({
			messages: [
				{ content: "System instruction", role: "system" },
				{
					content: [
						{ text: "Describe sticker", type: "text" },
						{ data: "aGVsbG8=", mimeType: "image/webp", type: "image" },
					],
					role: "user",
				},
			],
			modelId: "port-vision",
			providerId: "port-provider",
		});
		expect(portResult).toEqual({
			modelId: "port-vision",
			providerId: "port-provider",
			text: "port:port-vision",
		});
		expect(capturedPortCalls[0]).toMatchObject({
			modelId: "port-vision",
			systemPrompt: "System instruction",
		});
		expect(capturedPortCalls[0]?.messages[0]).toMatchObject({
			content: [
				{ text: "Describe sticker", type: "text" },
				{ data: "aGVsbG8=", mimeType: "image/webp", type: "image" },
			],
			role: "user",
		});

		await expect(
			models.complete({
				messages: [{ content: "fail", role: "user" }],
				modelId: "port-fail",
				providerId: "port-provider",
			}),
		).rejects.toThrow("Upstream 429");

		await expect(
			models.complete({
				messages: [{ content: "missing", role: "user" }],
				modelId: "does-not-exist",
				providerId: "port-provider",
			}),
		).rejects.toThrow("not enabled");
	});
});

describe("model capabilities", () => {
	test("provides the shared vocabulary plugins and the host agree on", () => {
		expect(MODEL_CAPABILITIES.sidechat).toBe("chat.sidechat");
		expect(
			hasModelCapability({ capabilities: [MODEL_CAPABILITIES.sidechat] }, "chat.sidechat"),
		).toBe(true);
		expect(hasModelCapability({ capabilities: ["basic-chat"] }, MODEL_CAPABILITIES.sidechat)).toBe(
			false,
		);
	});

	test("exposes the standardized capability tags", () => {
		expect(MODEL_CAPABILITIES.audioTranscribe).toBe("audio.transcribe");
		expect(MODEL_CAPABILITIES.audioTts).toBe("audio.tts");
		expect(MODEL_CAPABILITIES.decisionChoice).toBe("decision.choice");
		expect(MODEL_CAPABILITIES.embedding).toBe("embedding");
		expect(MODEL_CAPABILITIES.imageEdit).toBe("image.edit");
		expect(MODEL_CAPABILITIES.imageGenerate).toBe("image.generate");
		expect(MODEL_CAPABILITIES.videoGenerate).toBe("video.generate");
		expect(MODEL_CAPABILITIES.videoImageToVideo).toBe("video.image2video");
	});

	test("describes output modalities on model descriptors", async () => {
		const models = new LocalModelRegistry();
		const descriptor: PluginModelDescriptor = {
			capabilities: [MODEL_CAPABILITIES.imageGenerate],
			id: "image-1",
			input: ["text"],
			output: ["image"],
		};
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "media",
			listModels: () => [descriptor],
		});
		const [model] = await models.listModels({ capability: MODEL_CAPABILITIES.imageGenerate });
		expect(model?.output).toEqual(["image"]);
	});
});

describe("decision choice port", () => {
	test("calls a native decideChoice provider port directly", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginDecisionChoiceRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			decideChoice: (request) => {
				calls.push(request);
				return {
					choice: "approve",
					modelId: request.modelId ?? "pick-1",
					providerId: "picker",
				};
			},
			id: "picker",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.decisionChoice], id: "pick-1" }],
		});
		const result = await models.decideChoice({
			context: "synthetic context",
			instructions: "choose",
			options: { approve: "yes", reject: "no" },
			providerId: "picker",
		});
		expect(result).toEqual({ choice: "approve", modelId: "pick-1", providerId: "picker" });
		expect(calls[0]?.modelId).toBe("pick-1");
		expect(calls[0]?.providerId).toBe("picker");
	});

	test("falls back to a JSON completion adapter when no native port exists", async () => {
		const models = new LocalModelRegistry();
		const completions: PluginModelCompleteRequest[] = [];
		models.registerProvider({
			complete: (request) => {
				completions.push(request);
				return {
					modelId: request.modelId ?? "chat-1",
					providerId: "fallback",
					text: '{"decision":"Second","confidence":1.4,"reason":"better fit"}',
				};
			},
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "fallback",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.decisionChoice], id: "chat-1" }],
		});
		const result = await models.decideChoice({
			context: "synthetic context",
			instructions: "choose wisely",
			maxTokens: 128,
			options: { first: "first option", second: "second option" },
		});
		expect(result).toEqual({
			choice: "second",
			confidence: 1,
			modelId: "chat-1",
			providerId: "fallback",
			reason: "better fit",
		});
		const prompt = String(completions[0]?.messages[0]?.content);
		expect(prompt).toContain("choose wisely");
		expect(prompt).toContain("synthetic context");
		expect(prompt).toContain("second: second option");
		expect(completions[0]?.maxTokens).toBe(128);
		expect(completions[0]?.reasoning).toBe("minimal");
		expect(completions[0]?.temperature).toBe(0);
	});

	test("rejects a native choice that is not a provided option", async () => {
		const models = new LocalModelRegistry();
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			decideChoice: () => ({ choice: "maybe", modelId: "pick-1", providerId: "picker" }),
			id: "picker",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.decisionChoice], id: "pick-1" }],
		});
		await expect(
			models.decideChoice({
				context: "synthetic context",
				instructions: "choose",
				options: { approve: "yes", reject: "no" },
				providerId: "picker",
			}),
		).rejects.toThrow("not one of the provided options");
	});
});

describe("image generation port", () => {
	test("routes by capability to the first configured image provider", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginImageGenerateRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: () => {
				throw new Error("chat provider must not generate images");
			},
			id: "chat",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.basicChat], id: "chat-1" }],
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: (request) => {
				calls.push(request);
				return {
					images: [{ mimeType: "image/png", url: "https://cdn.example/synthetic-1.png" }],
					modelId: request.modelId ?? "image-1",
					providerId: "image",
				};
			},
			id: "image",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageGenerate], id: "image-1" }],
		});

		const result = await models.generateImage({ prompt: "synthetic prompt" });

		expect(result).toEqual({
			images: [{ mimeType: "image/png", url: "https://cdn.example/synthetic-1.png" }],
			modelId: "image-1",
			providerId: "image",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			modelId: "image-1",
			prompt: "synthetic prompt",
			providerId: "image",
		});
	});

	test("honors providerId, modelId, and model-only targeting", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginImageGenerateRequest[] = [];
		const makeProvider = (id: string, modelId: string) => ({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: (request: PluginImageGenerateRequest) => {
				calls.push(request);
				return {
					images: [{ mimeType: "image/png" }],
					modelId: request.modelId ?? modelId,
					providerId: id,
				};
			},
			id,
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageGenerate], id: modelId }],
		});
		models.registerProvider(makeProvider("alpha", "alpha-1"));
		models.registerProvider(makeProvider("beta", "beta-2"));

		const targeted = await models.generateImage({
			modelId: "beta-2",
			prompt: "synthetic prompt",
			providerId: "beta",
		});
		expect(targeted).toMatchObject({ modelId: "beta-2", providerId: "beta" });

		const byModel = await models.generateImage({
			modelId: "alpha-1",
			prompt: "synthetic prompt",
		});
		expect(byModel).toMatchObject({ modelId: "alpha-1", providerId: "alpha" });

		expect(calls[0]).toMatchObject({ modelId: "beta-2", providerId: "beta" });
		expect(calls[1]).toMatchObject({ modelId: "alpha-1", providerId: "alpha" });

		await expect(
			models.generateImage({ modelId: "missing-9", prompt: "synthetic prompt" }),
		).rejects.toThrow("not available");
	});

	test("prefers image.edit when referenceImages are supplied", async () => {
		const models = new LocalModelRegistry();
		const generateCalls: PluginImageGenerateRequest[] = [];
		const editCalls: PluginImageGenerateRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: (request) => {
				generateCalls.push(request);
				return { images: [{ mimeType: "image/png" }], modelId: "gen-1", providerId: "gen" };
			},
			id: "gen",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageGenerate], id: "gen-1" }],
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "edit",
			imageGenerate: {
				generateImage: (request) => {
					editCalls.push(request);
					return { images: [{ mimeType: "image/png" }], modelId: "edit-1", providerId: "edit" };
				},
			},
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageEdit], id: "edit-1" }],
		});

		const result = await models.generateImage({
			prompt: "synthetic restyle",
			referenceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
		});

		expect(result).toMatchObject({ modelId: "edit-1", providerId: "edit" });
		expect(generateCalls).toHaveLength(0);
		expect(editCalls).toHaveLength(1);
		expect(editCalls[0]?.referenceImages?.[0]?.mimeType).toBe("image/png");
	});

	test("rejects unconfigured, unregistered, non-image, and disabled-model targets", async () => {
		const models = new LocalModelRegistry();
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: () => ({ images: [], modelId: "off-1", providerId: "off" }),
			id: "off",
			isConfigured: () => false,
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageGenerate], id: "off-1" }],
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "chat",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.basicChat], id: "chat-1" }],
		});
		await expect(models.generateImage({ prompt: "synthetic prompt" })).rejects.toThrow(
			"No configured model provider",
		);
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: () => ({ images: [], modelId: "image-1", providerId: "image" }),
			id: "image",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.imageGenerate], id: "image-1" }],
		});
		await expect(
			models.generateImage({ prompt: "synthetic prompt", providerId: "off" }),
		).rejects.toThrow("not configured");
		await expect(
			models.generateImage({ prompt: "synthetic prompt", providerId: "unknown" }),
		).rejects.toThrow("not registered");
		await expect(
			models.generateImage({ prompt: "synthetic prompt", providerId: "chat" }),
		).rejects.toThrow("does not support image generation");
		await expect(
			models.generateImage({
				modelId: "image-2",
				prompt: "synthetic prompt",
				providerId: "image",
			}),
		).rejects.toThrow("not enabled");
	});

	test("rejects already-aborted requests", async () => {
		const models = new LocalModelRegistry();
		const controller = new AbortController();
		controller.abort();
		await expect(
			models.generateImage({ prompt: "synthetic prompt", signal: controller.signal }),
		).rejects.toThrow("aborted");
	});
});
