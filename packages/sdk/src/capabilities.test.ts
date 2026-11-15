import { describe, expect, test } from "bun:test";
import {
	expandChannelCapabilities,
	expandLegacyChannelCapabilities,
	hasChannelCapability,
} from "./host.ts";
import { LocalModelRegistry } from "./bridges.ts";
import { hasModelCapability, MODEL_CAPABILITIES } from "./model-capabilities.ts";

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
});
