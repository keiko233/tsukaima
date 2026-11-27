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
	PluginVideoGenerateRequest,
	PluginVideoJobHandle,
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

const jobHandle = (providerId: string, modelId: string, jobId: string): PluginVideoJobHandle => ({
	jobId,
	modelId,
	providerId,
});

describe("video generation port", () => {
	test("submits through the first configured video provider and resolves model + provider", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginVideoGenerateRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "chat",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.basicChat], id: "chat-1" }],
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "video",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "video-1" }],
			submitVideoJob: (request) => {
				calls.push(request);
				return {
					jobId: "job-1",
					modelId: request.modelId ?? "video-1",
					providerId: "video",
				};
			},
		});

		const submitted = await models.submitVideoJob({ prompt: "synthetic prompt" });

		expect(submitted).toEqual({ jobId: "job-1", modelId: "video-1", providerId: "video" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			modelId: "video-1",
			prompt: "synthetic prompt",
			providerId: "video",
		});
	});

	test("submits through an object-shaped videoGenerate port", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginVideoGenerateRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "video",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "video-1" }],
			videoGenerate: {
				pollVideoJob: () => ({ status: "running" }),
				submitVideoJob: (request) => {
					calls.push(request);
					return {
						jobId: "job-port",
						modelId: request.modelId ?? "video-1",
						providerId: "video",
					};
				},
			},
		});

		const submitted = await models.submitVideoJob({ prompt: "synthetic prompt" });

		expect(submitted).toEqual({ jobId: "job-port", modelId: "video-1", providerId: "video" });
		expect(calls[0]).toMatchObject({ providerId: "video" });
	});

	test("honors explicit providerId and modelId targeting", async () => {
		const models = new LocalModelRegistry();
		const calls: PluginVideoGenerateRequest[] = [];
		const makeProvider = (id: string, modelId: string) => ({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id,
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: modelId }],
			submitVideoJob: (request: PluginVideoGenerateRequest) => {
				calls.push(request);
				return { jobId: `${id}-job`, modelId: request.modelId ?? modelId, providerId: id };
			},
		});
		models.registerProvider(makeProvider("alpha", "alpha-1"));
		models.registerProvider(makeProvider("beta", "beta-2"));

		const targeted = await models.submitVideoJob({
			modelId: "beta-2",
			prompt: "synthetic prompt",
			providerId: "beta",
		});
		expect(targeted).toMatchObject({ modelId: "beta-2", providerId: "beta" });

		const byModel = await models.submitVideoJob({ modelId: "alpha-1", prompt: "synthetic prompt" });
		expect(byModel).toMatchObject({ modelId: "alpha-1", providerId: "alpha" });

		await expect(
			models.submitVideoJob({ modelId: "missing-9", prompt: "synthetic prompt" }),
		).rejects.toThrow("not available");
	});

	test("prefers video.image2video when referenceImages are supplied", async () => {
		const models = new LocalModelRegistry();
		const generateCalls: PluginVideoGenerateRequest[] = [];
		const imageToVideoCalls: PluginVideoGenerateRequest[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "gen",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "gen-1" }],
			submitVideoJob: (request) => {
				generateCalls.push(request);
				return { jobId: "gen-job", modelId: "gen-1", providerId: "gen" };
			},
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "i2v",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoImageToVideo], id: "i2v-1" }],
			submitVideoJob: (request) => {
				imageToVideoCalls.push(request);
				return { jobId: "i2v-job", modelId: "i2v-1", providerId: "i2v" };
			},
		});

		const imageToVideo = await models.submitVideoJob({
			prompt: "synthetic animate",
			referenceImages: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }],
		});
		expect(imageToVideo).toMatchObject({ modelId: "i2v-1", providerId: "i2v" });
		expect(imageToVideoCalls).toHaveLength(1);
		expect(generateCalls).toHaveLength(0);

		const textToVideo = await models.submitVideoJob({ prompt: "synthetic prompt" });
		expect(textToVideo).toMatchObject({ modelId: "gen-1", providerId: "gen" });
		expect(generateCalls).toHaveLength(1);
		expect(imageToVideoCalls).toHaveLength(1);
	});

	test("polls queued, running, succeeded, and failed job states", async () => {
		const models = new LocalModelRegistry();
		const polled: PluginVideoJobHandle[] = [];
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "video",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "video-1" }],
			pollVideoJob: (handle) => {
				polled.push(handle);
				switch (handle.jobId) {
					case "queued":
						return { pollAfterMs: 500, progress: 5, status: "queued" };
					case "running":
						return { pollAfterMs: 250, progress: 60, status: "running" };
					case "succeeded":
						return {
							status: "succeeded",
							video: { durationMs: 4000, mimeType: "video/mp4", url: "https://cdn.example/v.mp4" },
						};
					default:
						return { error: "synthetic failure", retryable: true, status: "failed" };
				}
			},
			submitVideoJob: () => ({ jobId: "queued", modelId: "video-1", providerId: "video" }),
		});

		expect(await models.pollVideoJob(jobHandle("video", "video-1", "queued"))).toEqual({
			pollAfterMs: 500,
			progress: 5,
			status: "queued",
		});
		expect(await models.pollVideoJob(jobHandle("video", "video-1", "running"))).toEqual({
			pollAfterMs: 250,
			progress: 60,
			status: "running",
		});
		expect(await models.pollVideoJob(jobHandle("video", "video-1", "succeeded"))).toEqual({
			status: "succeeded",
			video: { durationMs: 4000, mimeType: "video/mp4", url: "https://cdn.example/v.mp4" },
		});
		expect(await models.pollVideoJob(jobHandle("video", "video-1", "failed"))).toEqual({
			error: "synthetic failure",
			retryable: true,
			status: "failed",
		});
		expect(polled.map((handle) => handle.jobId)).toEqual([
			"queued",
			"running",
			"succeeded",
			"failed",
		]);
	});

	test("polls through an object-shaped videoGenerate port", async () => {
		const models = new LocalModelRegistry();
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "video",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "video-1" }],
			videoGenerate: {
				pollVideoJob: () => ({ status: "running" }),
				submitVideoJob: () => ({ jobId: "job-port", modelId: "video-1", providerId: "video" }),
			},
		});

		expect(await models.pollVideoJob(jobHandle("video", "video-1", "job-port"))).toEqual({
			status: "running",
		});
	});

	test("cancels through provider.cancelVideoJob, the port, or a no-op", async () => {
		const models = new LocalModelRegistry();
		const cancelled: PluginVideoJobHandle[] = [];
		const portCancelled: PluginVideoJobHandle[] = [];
		models.registerProvider({
			cancelVideoJob: (handle) => {
				cancelled.push(handle);
			},
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "direct",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "direct-1" }],
			pollVideoJob: () => ({ status: "running" }),
			submitVideoJob: () => ({ jobId: "direct-job", modelId: "direct-1", providerId: "direct" }),
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "port",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "port-1" }],
			videoGenerate: {
				cancelVideoJob: (handle) => {
					portCancelled.push(handle);
				},
				pollVideoJob: () => ({ status: "running" }),
				submitVideoJob: () => ({ jobId: "port-job", modelId: "port-1", providerId: "port" }),
			},
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "plain",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "plain-1" }],
			pollVideoJob: () => ({ status: "running" }),
			submitVideoJob: () => ({ jobId: "plain-job", modelId: "plain-1", providerId: "plain" }),
		});

		await models.cancelVideoJob(jobHandle("direct", "direct-1", "direct-job"));
		await models.cancelVideoJob(jobHandle("port", "port-1", "port-job"));
		await expect(
			models.cancelVideoJob(jobHandle("plain", "plain-1", "plain-job")),
		).resolves.toBeUndefined();
		expect(cancelled.map((handle) => handle.jobId)).toEqual(["direct-job"]);
		expect(portCancelled.map((handle) => handle.jobId)).toEqual(["port-job"]);
		await expect(models.cancelVideoJob(jobHandle("unknown", "video-1", "job-1"))).rejects.toThrow(
			"not registered",
		);
	});

	test("rejects unconfigured, unregistered, non-video, and disabled-model targets", async () => {
		const models = new LocalModelRegistry();
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "off",
			isConfigured: () => false,
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "off-1" }],
			pollVideoJob: () => ({ status: "running" }),
			submitVideoJob: () => ({ jobId: "off-job", modelId: "off-1", providerId: "off" }),
		});
		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "chat",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.basicChat], id: "chat-1" }],
		});

		await expect(models.submitVideoJob({ prompt: "synthetic prompt" })).rejects.toThrow(
			"No configured model provider",
		);
		await expect(
			models.submitVideoJob({ prompt: "synthetic prompt", providerId: "unknown" }),
		).rejects.toThrow("not registered");
		await expect(
			models.submitVideoJob({ prompt: "synthetic prompt", providerId: "off" }),
		).rejects.toThrow("not configured");
		await expect(
			models.submitVideoJob({ prompt: "synthetic prompt", providerId: "chat" }),
		).rejects.toThrow("does not support video generation");

		models.registerProvider({
			createPort: () => {
				throw new Error("chat port not used");
			},
			id: "video",
			listModels: () => [{ capabilities: [MODEL_CAPABILITIES.videoGenerate], id: "video-1" }],
			pollVideoJob: () => ({ status: "running" }),
			submitVideoJob: () => ({ jobId: "job-1", modelId: "video-1", providerId: "video" }),
		});
		await expect(
			models.submitVideoJob({
				modelId: "video-2",
				prompt: "synthetic prompt",
				providerId: "video",
			}),
		).rejects.toThrow("not enabled");
		await expect(models.pollVideoJob(jobHandle("unknown", "video-1", "job-1"))).rejects.toThrow(
			"not registered",
		);
		await expect(models.pollVideoJob(jobHandle("off", "off-1", "job-1"))).rejects.toThrow(
			"not configured",
		);
	});

	test("rejects already-aborted submission and poll requests", async () => {
		const models = new LocalModelRegistry();
		const controller = new AbortController();
		controller.abort();
		await expect(
			models.submitVideoJob({ prompt: "synthetic prompt", signal: controller.signal }),
		).rejects.toThrow("aborted");
		await expect(
			models.pollVideoJob(jobHandle("video", "video-1", "job-1"), controller.signal),
		).rejects.toThrow("aborted");
	});
});
