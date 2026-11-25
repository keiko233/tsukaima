import { describe, expect, test } from "bun:test";
import { LocalModelRegistry, type PluginContext, type PluginLogger } from "@tsukaima/sdk";
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
	resolveSemanticClassifier,
	type SemanticLogger,
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

interface CapturedLog {
	readonly fields: Record<string, unknown> | undefined;
	readonly level: "debug" | "error" | "trace" | "warn";
	readonly message: string;
}

function captureLogger(): { entries: CapturedLog[]; logger: SemanticLogger } {
	const entries: CapturedLog[] = [];
	const logger: SemanticLogger = {
		debug: (message, fields) => entries.push({ fields, level: "debug", message }),
		error: (message, fields) => entries.push({ fields, level: "error", message }),
		trace: (message, fields) => entries.push({ fields, level: "trace", message }),
		warn: (message, fields) => entries.push({ fields, level: "warn", message }),
	};
	return { entries, logger };
}

function providerError(status: number, message: string, headers?: Record<string, string>): Error {
	return Object.assign(new Error(message), { headers, status });
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

	test("retries once when the host model bridge returns empty content", async () => {
		const registry = new LocalModelRegistry();
		const maxTokens: number[] = [];
		let calls = 0;
		registry.registerProvider({
			id: "provider-retry",
			createPort: () => {
				throw new Error("port not used");
			},
			listModels: () => [
				{ capabilities: ["basic-chat", "vision"], id: "retry-vision", input: ["text", "image"] },
			],
			complete: async (request) => {
				calls += 1;
				maxTokens.push(request.maxTokens ?? 0);
				return {
					modelId: request.modelId ?? "retry-vision",
					providerId: request.providerId ?? "provider-retry",
					text:
						calls === 1
							? ""
							: JSON.stringify({
									confidence: 0.9,
									description: "A blue fish waves from a fishbowl.",
									emotions: ["happy"],
									keywords: ["fish", "wave"],
									labels: ["happy"],
								}),
				};
			},
		});
		const classifier = await resolveSemanticClassifier(
			{
				semanticMode: "vision",
				semanticModel: "retry-vision",
				semanticProviderId: "provider-retry",
			},
			{ models: registry },
		);
		const profile = await classifier.classify({
			bytes: bytes("image-bytes"),
			mimeType: "image/png",
			title: "Blue Fish",
		});
		expect(calls).toBe(2);
		expect(maxTokens).toEqual([2048, 2048]);
		expect(profile.source).toBe("merged");
		expect(profile.description).toBe("A blue fish waves from a fishbowl.");
	});

	test("retries a transient 429 and stores the eventual profile", async () => {
		const { entries, logger } = captureLogger();
		const delays: number[] = [];
		let calls = 0;
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () => {
				calls += 1;
				if (calls === 1) throw providerError(429, "rate limit exceeded");
				return JSON.stringify({
					confidence: 0.9,
					description: "A mascot recovers after a transient failure.",
					labels: ["happy"],
				});
			},
			logger,
			model: "vision-retry-429",
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		const profile = await classifier.classify({
			bytes: bytes("retry-bytes"),
			mimeType: "image/png",
			title: "Retry Pack",
		});
		expect(calls).toBe(2);
		expect(profile.source).toBe("merged");
		expect(profile.description).toBe("A mascot recovers after a transient failure.");
		expect(delays).toHaveLength(1);
		expect(delays[0]).toBeGreaterThanOrEqual(350);
		expect(delays[0]).toBeLessThanOrEqual(650);
		const retryWarning = entries.find(
			(entry) =>
				entry.level === "warn" && entry.message === "vision provider request failed; retrying",
		);
		expect(retryWarning?.fields?.attempt).toBe(1);
		expect(retryWarning?.fields?.maxAttempts).toBe(4);
		expect(retryWarning?.fields?.model).toBe("vision-retry-429");
		expect(typeof retryWarning?.fields?.delayMs).toBe("number");
		expect(
			entries.some((entry) => entry.message === "vision provider request succeeded after retry"),
		).toBe(true);
	});

	test("retries a transient 502 twice before succeeding", async () => {
		const { entries, logger } = captureLogger();
		let calls = 0;
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () => {
				calls += 1;
				if (calls <= 2) throw providerError(502, "Bad Gateway");
				return JSON.stringify({ description: "A gateway recovers.", labels: ["happy"] });
			},
			logger,
			model: "vision-retry-502",
			sleep: async () => undefined,
		});
		const profile = await classifier.classify({
			bytes: bytes("retry-bytes"),
			mimeType: "image/png",
			title: "Gateway Pack",
		});
		expect(calls).toBe(3);
		expect(profile.source).toBe("merged");
		expect(
			entries.filter(
				(entry) =>
					entry.level === "warn" && entry.message === "vision provider request failed; retrying",
			),
		).toHaveLength(2);
	});

	test("does not retry a permanent 400 and falls back to the heuristic profile", async () => {
		const { entries, logger } = captureLogger();
		let calls = 0;
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () => {
				calls += 1;
				throw providerError(400, "bad request");
			},
			logger,
			model: "vision-permanent-400",
			sleep: async () => {
				throw new Error("permanent failures must not sleep");
			},
		});
		const profile = await classifier.classify({
			bytes: bytes("permanent-bytes"),
			mimeType: "image/png",
			title: "Permanent failure",
		});
		expect(calls).toBe(1);
		expect(profile.source).toBe("heuristic");
		expect(
			entries.some(
				(entry) =>
					entry.level === "warn" && entry.message === "vision provider request failed; retrying",
			),
		).toBe(false);
		expect(
			entries.some(
				(entry) =>
					entry.level === "warn" &&
					entry.message === "vision sticker classification failed; using heuristic profile",
			),
		).toBe(true);
	});

	test("falls back to heuristic after exhausting the transient retry budget", async () => {
		const { entries, logger } = captureLogger();
		const delays: number[] = [];
		let calls = 0;
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () => {
				calls += 1;
				throw providerError(503, "service unavailable");
			},
			logger,
			model: "vision-retry-exhausted",
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});
		const profile = await classifier.classify({
			bytes: bytes("exhausted-bytes"),
			mimeType: "image/png",
			title: "Exhausted retries",
		});
		expect(calls).toBe(4);
		expect(delays).toHaveLength(3);
		expect(profile.source).toBe("heuristic");
		const exhausted = entries.find(
			(entry) =>
				entry.level === "warn" && entry.message === "vision provider request retries exhausted",
		);
		expect(exhausted?.fields?.attempt).toBe(4);
		expect(exhausted?.fields?.maxAttempts).toBe(4);
		expect(exhausted?.fields?.model).toBe("vision-retry-exhausted");
		expect(
			entries.some(
				(entry) =>
					entry.level === "warn" &&
					entry.message === "vision sticker classification failed; using heuristic profile",
			),
		).toBe(true);
	});

	test("retries empty content without consuming the transient retry budget", async () => {
		const { entries, logger } = captureLogger();
		let calls = 0;
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () => {
				calls += 1;
				return calls === 1
					? "   "
					: JSON.stringify({ description: "A late reply.", labels: ["happy"] });
			},
			logger,
			model: "vision-empty-retry",
			sleep: async () => undefined,
		});
		const profile = await classifier.classify({
			bytes: bytes("empty-bytes"),
			mimeType: "image/png",
			title: "Empty retry",
		});
		expect(calls).toBe(2);
		expect(profile.source).toBe("merged");
		expect(profile.description).toBe("A late reply.");
		expect(
			entries.some(
				(entry) =>
					entry.level === "warn" &&
					entry.message === "vision provider returned no content; retrying",
			),
		).toBe(true);
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
