import { describe, expect, test } from "bun:test";
import { messagePartSchema, messagePartText, messagePartsText, type MessagePart } from "./base.ts";

describe("message parts", () => {
	test("keeps legacy hash-only image/sticker rows readable", () => {
		expect(messagePartSchema.parse({ sha256: "legacy-hash", type: "image" })).toEqual({
			sha256: "legacy-hash",
			type: "image",
		});
		expect(messagePartSchema.parse({ sha256: "legacy-sticker", type: "sticker" })).toEqual({
			sha256: "legacy-sticker",
			type: "sticker",
		});
		expect(messagePartText({ sha256: "legacy-hash", type: "image" })).toBe("[image]");
	});

	test("accepts all seven part variants with safe media references", () => {
		const parts: MessagePart[] = [
			{ text: "hello", type: "text" },
			{ mediaId: "media-image", mimeType: "image/png", type: "image" },
			{ channelRef: "face:123", type: "sticker" },
			{
				mediaId: "media-audio",
				transcript: "spoken words",
				transcriptStatus: "ok",
				type: "audio",
			},
			{ mediaId: "media-video", type: "video" },
			{ fileName: "report.pdf", mediaId: "media-file", type: "file" },
			{
				nativeType: "json-card",
				safeFields: { truncated: true },
				summary: "Card summary",
				type: "channel-native",
			},
		];
		for (const part of parts) expect(messagePartSchema.parse(part)).toEqual(part);
		expect(messagePartsText(parts)).toBe(
			"hello [image] [sticker] [voice: spoken words] [video] [file: report.pdf] Card summary",
		);
	});

	test("requires a resolvable reference for media parts", () => {
		expect(() => messagePartSchema.parse({ type: "image" })).toThrow();
		expect(() => messagePartSchema.parse({ fileName: "x.txt", type: "file" })).toThrow();
		expect(
			messagePartSchema.parse({ fileName: "x.txt", sourceUrl: "https://x.test/x", type: "file" }),
		).toEqual({ fileName: "x.txt", sourceUrl: "https://x.test/x", type: "file" });
	});
});
