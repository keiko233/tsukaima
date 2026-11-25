import { describe, expect, test } from "bun:test";
import type { PluginContext, PluginLogger } from "@tsukaima/sdk";
import {
	EMPTY_SEMANTIC_PROFILE,
	parseSemanticProfile,
	type StickerItem,
	type StickerPack,
} from "./domain.ts";
import {
	rankStickerItem,
	type StickerCandidate,
	type StickerSelectionService,
} from "./selection.ts";
import {
	classifyStickerSemantics,
	mergeSemanticProfiles,
	VisionSemanticClassifier,
} from "./semantic.ts";
import { registerStickerTools } from "./tools.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const longDescription = (
	"A detailed character description covering who is depicted, the outfit, facial expression, pose, " +
	"visible symbols, text, and the animated motion progression. "
)
	.repeat(12)
	.slice(0, 1000)
	.trimEnd();

function stubLogger(): PluginLogger {
	return {
		debug: () => undefined,
		error: () => undefined,
		info: () => undefined,
		trace: () => undefined,
		warn: () => undefined,
	} as unknown as PluginLogger;
}

describe("detailed vision sticker classification", () => {
	test("asks for character, content, symbols, context, and animation detail in prompts", async () => {
		const prompts: string[] = [];
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async (request) => {
				prompts.push(request.prompt);
				return JSON.stringify({ description: "A mascot waves.", labels: ["happy"] });
			},
			model: "vision-test",
		});
		await classifier.classify({
			bytes: bytes("still-bytes"),
			emoji: "😀",
			mimeType: "image/png",
			title: "Example mascot pack",
		});
		expect(prompts).toHaveLength(1);
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("detailed, specific");
		expect(prompt).toContain("who or what is depicted");
		expect(prompt).toContain("character name");
		expect(prompt).toContain("facial expression");
		expect(prompt).toContain("visible text");
		expect(prompt).toContain("usage context");
		expect(prompt).toContain("English and Chinese keywords");
		expect(prompt).toContain("under 900 characters");
		expect(prompt).not.toContain("one short English sentence");
		expect(prompt).not.toContain("contact sheet");
	});

	test("asks for the whole motion progression when reading an animated contact sheet", async () => {
		const prompts: string[] = [];
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async (request) => {
				prompts.push(request.prompt);
				return JSON.stringify({ description: "A mascot spins and grins.", labels: ["happy"] });
			},
			frameSheet: async () => ({
				bytes: bytes("sheet"),
				frameCount: 6,
				mimeType: "image/png",
			}),
			model: "vision-test",
		});
		await classifier.classify({
			bytes: bytes("animated-gif"),
			mimeType: "image/gif",
			title: "Animated pack",
		});
		expect(prompts).toHaveLength(1);
		const prompt = prompts[0] ?? "";
		expect(prompt).toContain("contact sheet merged from 6 frames");
		expect(prompt).toContain("left-to-right, top-to-bottom");
		expect(prompt).toContain("full animation progression");
		expect(prompt).toContain("start -> middle -> end");
		expect(prompt).toContain("looping action");
		expect(prompt).toContain("expression changes");
	});

	test("preserves long descriptions through classify, merge, and parsing", async () => {
		expect(longDescription.length).toBeGreaterThan(240);

		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () =>
				JSON.stringify({
					confidence: 0.9,
					description: longDescription,
					keywords: ["mascot", "wave"],
					labels: ["happy"],
				}),
			model: "vision-test",
		});
		const profile = await classifier.classify({
			bytes: bytes("image-bytes"),
			emoji: "😀",
			mimeType: "image/png",
			title: "Example mascot pack",
		});
		expect(profile.description).toBe(longDescription);
		expect(profile.description.length).toBeGreaterThan(240);

		const merged = mergeSemanticProfiles(classifyStickerSemantics({ title: "Example pack" }), {
			...EMPTY_SEMANTIC_PROFILE,
			confidence: 0.9,
			description: longDescription,
			labels: ["happy"],
			source: "vision",
		});
		expect(merged.description).toBe(longDescription);

		const parsed = parseSemanticProfile({
			confidence: 0.8,
			description: longDescription,
			labels: ["happy"],
			source: "vision",
		});
		expect(parsed.description).toBe(longDescription);
	});
});

describe("compact sticker-meme.search output", () => {
	test("returns only compact preview fields and still ranks deep description matches", async () => {
		const fullDescription = `${longDescription} The spacewhale only appears at the very end.`;
		const candidate: StickerCandidate = {
			description: fullDescription,
			emotions: ["happy", "joy", "excited", "love", "cute", "smile"],
			enabled: true,
			hash: "a".repeat(64),
			height: 320,
			itemId: "compact-item",
			keywords: [
				"happy",
				"joy",
				"wave",
				"waving",
				"wave",
				"blue-hoodie",
				"question-mark",
				"hearts",
				"sweat-drop",
				"anger-vein",
			],
			labels: ["happy", "laugh", "praise", "greet", "cute", "love", "smile"],
			lastUsedAt: null,
			mimeType: "image/webp",
			name: "compact-item",
			packId: "pack-compact",
			packName: "Compact Pack",
			personaIds: ["persona-1"],
			reviewStatus: "approved",
			score: 12,
			tags: ["mascot"],
			useCount: 3,
			width: 320,
		};

		const registered: {
			description: string;
			execute(
				input: Record<string, unknown>,
				invocation: { readonly conversationId?: string },
			): Promise<{ readonly content: readonly { readonly text?: string }[] }>;
			name: string;
		}[] = [];
		const logger = stubLogger();
		const context = {
			logger,
			tools: {
				register: (tool: (typeof registered)[number]) => void registered.push(tool),
			},
		} as unknown as PluginContext;
		const selection = {
			listAvailablePacks: async () => [],
			search: async () => [candidate],
		} as unknown as StickerSelectionService;
		registerStickerTools(context, selection, logger);

		const searchTool = registered.find((tool) => tool.name === "sticker-meme.search");
		expect(searchTool).toBeDefined();
		expect(searchTool?.description).toContain("compact previews");
		expect(searchTool?.description).toContain("sticker-meme.view");

		const result = await searchTool?.execute({ query: "mascot" }, { conversationId: "conv-1" });
		const parsed = JSON.parse(result?.content[0]?.text ?? "{}") as {
			candidates: readonly Record<string, unknown>[];
			count: number;
		};
		expect(parsed.count).toBe(1);
		const compact = parsed.candidates[0] ?? {};

		expect(compact.itemId).toBe("compact-item");
		expect(compact.name).toBe("compact-item");
		expect(compact.packId).toBe("pack-compact");
		expect(compact.packName).toBe("Compact Pack");
		expect(typeof compact.description).toBe("string");
		expect((compact.description as string).length).toBeLessThanOrEqual(120);
		expect((compact.description as string).endsWith("…")).toBe(true);
		expect((compact.emotions as readonly string[]).length).toBe(4);
		expect((compact.labels as readonly string[]).length).toBe(5);
		expect((compact.keywords as readonly string[]).length).toBeLessThanOrEqual(6);
		expect(new Set(compact.keywords as readonly string[]).size).toBe(
			(compact.keywords as readonly string[]).length,
		);
		expect(compact.keywords).not.toContain("happy");
		expect(compact.keywords).not.toContain("joy");
		expect(compact.keywords).not.toContain("laugh");

		for (const field of [
			"hash",
			"enabled",
			"reviewStatus",
			"width",
			"height",
			"lastUsedAt",
			"useCount",
			"score",
			"personaIds",
			"tags",
			"mimeType",
		]) {
			expect(compact).not.toHaveProperty(field);
		}

		const item: StickerItem = {
			createdAt: "2026-01-01T00:00:00.000Z",
			description: fullDescription,
			emotions: ["happy"],
			enabled: true,
			hash: "b".repeat(64),
			height: null,
			id: "compact-item",
			keywords: ["happy"],
			lastUsedAt: null,
			mediaId: "media-1",
			mimeType: "image/webp",
			name: "compact-item",
			packId: "pack-compact",
			reviewStatus: "approved",
			revokedAt: null,
			score: 1,
			semantic: {
				...EMPTY_SEMANTIC_PROFILE,
				confidence: 0.8,
				description: longDescription,
				labels: ["happy"],
				source: "vision",
			},
			sourceConversationId: null,
			updatedAt: "2026-01-01T00:00:00.000Z",
			useCount: 0,
			width: null,
		};
		const pack: StickerPack = {
			createdAt: "2026-01-01T00:00:00.000Z",
			enabled: true,
			id: "pack-compact",
			metadata: {},
			name: "Compact Pack",
			personaIds: [],
			source: "imported",
			tags: [],
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		expect(item.description.length).toBeGreaterThan(300);
		const score = rankStickerItem(item, pack, { query: "spacewhale" });
		expect(score).toBeDefined();
		expect(score).toBeGreaterThan(0);
	});
});
