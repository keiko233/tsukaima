import { describe, expect, test } from "bun:test";
import {
	expandChannelCapabilities,
	expandLegacyChannelCapabilities,
	hasChannelCapability,
} from "./host.ts";
import { LocalModelRegistry } from "./bridges.ts";

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
});
