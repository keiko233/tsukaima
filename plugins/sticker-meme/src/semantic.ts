import type { PluginModelInfo, PluginModelRegistry } from "@tsukaima/sdk";
import emojiLibrary from "emojilib";
import { uniq } from "es-toolkit";
import { z } from "zod";
import {
	EMPTY_SEMANTIC_PROFILE,
	normalizeLabels,
	normalizeText,
	parseSemanticProfile,
	sanitizeModelText,
	type StickerSemanticProfile,
} from "./domain.ts";
import { buildAnimatedFrameSheet, isAnimatedImage, type FrameSheet } from "./frame-sheet.ts";

export type SemanticKind = "emotion" | "intent" | "tone";

export interface SemanticCategory {
	readonly id: string;
	readonly kind: SemanticKind;
	readonly terms: readonly string[];
}

/**
 * The closed label set used by preprocessing. Keeping it closed makes model filtering
 * deterministic and prevents a vision model from inventing transient tags that the selector
 * cannot understand.
 */
export const STICKER_SEMANTIC_CATEGORIES: readonly SemanticCategory[] = [
	{
		id: "happy",
		kind: "emotion",
		terms: [
			"happy",
			"happiness",
			"glad",
			"pleased",
			"joy",
			"joyful",
			"cheerful",
			"开心",
			"高兴",
			"快乐",
			"幸せ",
			"嬉しい",
			"楽しい",
		],
	},
	{
		id: "smile",
		kind: "emotion",
		terms: [
			"smile",
			"smiling",
			"smiley",
			"grin",
			"grinning",
			"smirk",
			"微笑",
			"笑顔",
			"笑み",
			"にっこり",
		],
	},
	{
		id: "laugh",
		kind: "emotion",
		terms: [
			"laugh",
			"laughing",
			"laughter",
			"lol",
			"haha",
			"happytears",
			"爆笑",
			"草",
			"笑う",
			"大笑い",
		],
	},
	{
		id: "excited",
		kind: "emotion",
		terms: [
			"excited",
			"excitement",
			"wow",
			"amazing",
			"sparkles",
			"兴奋",
			"激动",
			"わくわく",
			"すごい",
		],
	},
	{
		id: "love",
		kind: "emotion",
		terms: [
			"love",
			"heart",
			"hearts",
			"adore",
			"kiss",
			"infatuation",
			"爱",
			"喜欢",
			"心",
			"大好き",
			"愛",
			"ハート",
		],
	},
	{
		id: "affectionate",
		kind: "emotion",
		terms: ["affection", "hug", "hugging", "cuddle", "warm", "拥抱", "抱抱", "ぎゅっ", "癒し"],
	},
	{
		id: "shy",
		kind: "emotion",
		terms: ["shy", "blush", "blushing", "照れ", "恥ずかしい", "害羞", "脸红"],
	},
	{
		id: "embarrassed",
		kind: "emotion",
		terms: ["embarrassed", "embarrassment", "shame", "awkward", "sweat", "尴尬", "汗", "困惑"],
	},
	{
		id: "sad",
		kind: "emotion",
		terms: [
			"sad",
			"sadness",
			"unhappy",
			"sorrow",
			"frown",
			"伤心",
			"难过",
			"悲しい",
			"落ち込む",
			"悲しみ",
		],
	},
	{
		id: "cry",
		kind: "emotion",
		terms: [
			"cry",
			"crying",
			"tears",
			"tear",
			"weep",
			"sob",
			"sobbing",
			"哭",
			"泪",
			"泣く",
			"涙",
			"号泣",
		],
	},
	{
		id: "angry",
		kind: "emotion",
		terms: [
			"angry",
			"mad",
			"rage",
			"furious",
			"pout",
			"anger",
			"生气",
			"愤怒",
			"怒る",
			"ぷんぷん",
			"激怒",
		],
	},
	{
		id: "annoyed",
		kind: "emotion",
		terms: [
			"annoyed",
			"annoying",
			"irritation",
			"grumpy",
			"嫌弃",
			"烦躁",
			"烦",
			"イライラ",
			"むっ",
		],
	},
	{
		id: "surprised",
		kind: "emotion",
		terms: [
			"surprised",
			"surprise",
			"shock",
			"shocked",
			"open mouth",
			"惊讶",
			"震惊",
			"びっくり",
			"驚き",
		],
	},
	{
		id: "confused",
		kind: "emotion",
		terms: [
			"confused",
			"confusion",
			"thinking",
			"think",
			"hmmm",
			"困惑",
			"疑惑",
			"思考",
			"困る",
			"考え",
		],
	},
	{
		id: "scared",
		kind: "emotion",
		terms: ["scared", "fear", "afraid", "scream", "害怕", "恐惧", "怖い", "恐い"],
	},
	{
		id: "tired",
		kind: "emotion",
		terms: ["tired", "exhausted", "weary", "累", "疲惫", "疲れ", "疲れた"],
	},
	{
		id: "sleepy",
		kind: "emotion",
		terms: ["sleepy", "sleep", "sleeping", "night", "zzz", "困", "睡觉", "眠い", "おやすみ"],
	},
	{
		id: "calm",
		kind: "emotion",
		terms: ["calm", "relaxed", "peaceful", "平静", "冷静", "落ち着く"],
	},
	{
		id: "proud",
		kind: "emotion",
		terms: ["proud", "pride", "confident", "得意", "骄傲", "自慢", "ドヤ"],
	},
	{ id: "smug", kind: "emotion", terms: ["smug", "smirk", "坏笑", "得意", "ドヤ顔"] },
	{
		id: "grateful",
		kind: "emotion",
		terms: ["grateful", "thankful", "thanks", "appreciate", "感谢", "谢谢", "ありがとう", "感謝"],
	},
	{
		id: "hopeful",
		kind: "emotion",
		terms: ["hope", "wish", "pray", "please", "希望", "祈祷", "願い"],
	},
	{ id: "lonely", kind: "emotion", terms: ["lonely", "alone", "寂寞", "孤独", "寂しい"] },
	{ id: "bored", kind: "emotion", terms: ["bored", "boring", "无聊", "退屈"] },
	{ id: "curious", kind: "emotion", terms: ["curious", "interest", "好奇", "興味"] },
	{
		id: "neutral",
		kind: "emotion",
		terms: ["neutral", "expressionless", "无表情", "平静", "無表情"],
	},
	{
		id: "greeting",
		kind: "intent",
		terms: [
			"hello",
			"hi",
			"wave",
			"waving",
			"greeting",
			"welcome",
			"你好",
			"打招呼",
			"こんにちは",
			"やあ",
		],
	},
	{
		id: "farewell",
		kind: "intent",
		terms: ["goodbye", "bye", "farewell", "再见", "拜拜", "さようなら", "またね"],
	},
	{
		id: "thanks",
		kind: "intent",
		terms: ["thank", "thanks", "thank you", "appreciate", "谢谢", "感谢", "ありがとう"],
	},
	{
		id: "apology",
		kind: "intent",
		terms: ["sorry", "apologize", "apology", "对不起", "抱歉", "ごめん", "すみません"],
	},
	{
		id: "praise",
		kind: "intent",
		terms: [
			"thumbs up",
			"thumbsup",
			"good",
			"awesome",
			"great",
			"approve",
			"praise",
			"赞",
			"棒",
			"厉害",
			"いいね",
			"すごい",
			"上手",
		],
	},
	{
		id: "comfort",
		kind: "intent",
		terms: ["comfort", "console", "hug", "安慰", "抱抱", "よしよし"],
	},
	{
		id: "encourage",
		kind: "intent",
		terms: ["encourage", "cheer", "support", "加油", "鼓励", "頑張れ"],
	},
	{
		id: "tease",
		kind: "intent",
		terms: ["tease", "teasing", "mischievous", "调侃", "调戏", "からかう", "いじわる"],
	},
	{
		id: "celebrate",
		kind: "intent",
		terms: [
			"celebrate",
			"celebration",
			"party",
			"congratulations",
			"birthday",
			"庆祝",
			"恭喜",
			"おめでとう",
		],
	},
	{
		id: "agree",
		kind: "intent",
		terms: ["agree", "yes", "ok", "okay", "accept", "同意", "对", "好", "うん", "了解"],
	},
	{
		id: "disagree",
		kind: "intent",
		terms: ["disagree", "no", "reject", "不同意", "不", "拒绝", "いや", "だめ"],
	},
	{ id: "refuse", kind: "intent", terms: ["refuse", "reject", "decline", "拒绝", "不要", "嫌"] },
	{
		id: "question",
		kind: "intent",
		terms: ["question", "huh", "what", "why", "疑问", "什么", "为什么", "なに", "なぜ"],
	},
	{ id: "wait", kind: "intent", terms: ["wait", "hold on", "等等", "稍等", "待って"] },
	{ id: "please", kind: "intent", terms: ["please", "beg", "拜托", "求", "お願い"] },
	{ id: "cheer", kind: "intent", terms: ["cheer", "hooray", "yay", "加油", "耶", "やった"] },
	{ id: "joke", kind: "intent", terms: ["joke", "funny", "lol", "玩笑", "搞笑", "面白い"] },
	{
		id: "flirt",
		kind: "intent",
		terms: ["flirt", "kiss", "wink", "调情", "亲", "キス", "ウインク"],
	},
	{ id: "complain", kind: "intent", terms: ["complain", "sigh", "抱怨", "叹气", "ため息"] },
	{ id: "request", kind: "intent", terms: ["request", "ask", "请求", "拜托", "お願い"] },
	{ id: "warn", kind: "intent", terms: ["warn", "warning", "danger", "警告", "注意"] },
	{ id: "cute", kind: "tone", terms: ["cute", "kawaii", "adorable", "可爱", "萌", "かわいい"] },
	{ id: "funny", kind: "tone", terms: ["funny", "humor", "hilarious", "搞笑", "好笑", "面白い"] },
	{
		id: "wholesome",
		kind: "tone",
		terms: ["wholesome", "warm", "gentle", "治愈", "温暖", "優しい"],
	},
	{
		id: "sarcastic",
		kind: "tone",
		terms: ["sarcastic", "irony", "ironic", "讽刺", "阴阳", "皮肉"],
	},
	{ id: "dramatic", kind: "tone", terms: ["dramatic", "drama", "戏剧", "夸张", "大げさ"] },
	{ id: "energetic", kind: "tone", terms: ["energetic", "energy", "元气", "活力", "元気"] },
	{ id: "gentle", kind: "tone", terms: ["gentle", "soft", "calm", "温柔", "轻柔", "優しい"] },
	{ id: "serious", kind: "tone", terms: ["serious", "认真", "严肃", "真剣"] },
	{ id: "cool", kind: "tone", terms: ["cool", "awesome", "酷", "帅", "かっこいい"] },
	{ id: "chaotic", kind: "tone", terms: ["chaotic", "crazy", "混乱", "疯狂", "カオス"] },
];

const categoriesById = new Map(
	STICKER_SEMANTIC_CATEGORIES.map((category) => [category.id, category]),
);
const categoryIds = new Set(categoriesById.keys());
const emojiKeys = Object.keys(emojiLibrary).toSorted((left, right) => right.length - left.length);

/** A few high-frequency sticker emoji where the literal meaning is stronger than keyword matching. */
const EMOJI_HINTS: Readonly<Record<string, readonly string[]>> = {
	"😀": ["happy", "smile"],
	"😁": ["happy", "smile", "excited"],
	"😂": ["laugh", "happy", "funny"],
	"🤣": ["laugh", "happy", "funny"],
	"😊": ["happy", "smile", "shy", "cute"],
	"😍": ["love", "happy", "affectionate"],
	"🥰": ["love", "affectionate", "wholesome"],
	"😘": ["love", "flirt"],
	"😳": ["shy", "embarrassed", "surprised"],
	"😭": ["cry", "sad"],
	"😢": ["cry", "sad"],
	"🥺": ["please", "sad", "cute", "hopeful"],
	"😡": ["angry", "annoyed"],
	"💢": ["angry", "annoyed"],
	"😤": ["proud", "annoyed", "determined"],
	"😴": ["sleepy", "tired"],
	"🤔": ["confused", "curious"],
	"😱": ["surprised", "scared"],
	"😅": ["embarrassed", "smile"],
	"🙏": ["thanks", "please", "hopeful"],
	"👍": ["praise", "agree"],
	"👎": ["disagree", "refuse"],
	"🎉": ["celebrate", "excited", "happy"],
	"❤️": ["love", "affectionate"],
	"💔": ["sad", "lonely"],
	"✨": ["excited", "cool", "happy"],
	"🔥": ["excited", "cool", "energetic"],
	"💪": ["encourage", "proud"],
	"🤗": ["affectionate", "comfort", "happy"],
	"👏": ["praise", "celebrate"],
	"🫡": ["agree", "praise"],
	"🙇": ["apology", "thanks"],
	"🤝": ["agree", "greeting"],
	"👋": ["greeting", "farewell"],
	"😏": ["smug", "tease", "sarcastic"],
	"😈": ["tease", "chaotic"],
	"💀": ["funny", "chaotic"],
	"🤡": ["funny", "chaotic"],
};

export interface StickerSemanticInput {
	readonly bytes?: Uint8Array;
	readonly emoji?: string;
	readonly index?: number;
	readonly maxLabels?: number;
	readonly mimeType?: string;
	readonly title?: string;
}

export interface StickerSemanticClassifier {
	readonly name: string;
	classify(input: StickerSemanticInput): Promise<StickerSemanticProfile>;
}

/**
 * Minimal logging port used by semantic classifiers. `PluginLogger` satisfies it structurally, so
 * hosts can pass their logger straight through; `trace`/`debug` stay optional for older loggers.
 */
export interface SemanticLogger {
	debug?(message: string, fields?: Record<string, unknown>): void;
	error?(message: string, fields?: Record<string, unknown>): void;
	trace?(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

function normalizeForMatch(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function tokensOf(value: string): string[] {
	return normalizeForMatch(value)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0);
}

const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function termScore(term: string, tokens: readonly string[], flat: string): number {
	const normalized = normalizeForMatch(term);
	if (normalized.length === 0) return 0;
	if (cjkPattern.test(normalized)) return flat.includes(normalized.replace(/\s+/gu, "")) ? 2.5 : 0;
	const compact = normalized.replace(/[\s_-]+/gu, "");
	if (compact.length < 2) return 0;
	if (tokens.includes(compact)) return 3;
	if (compact.length >= 4 && tokens.some((token) => token.startsWith(compact))) return 2.5;
	if (compact.length >= 4 && flat.includes(compact)) return 1.5;
	return 0;
}

export function extractEmojis(value: string): string[] {
	const remaining = value;
	const found: string[] = [];
	for (const key of emojiKeys) {
		if (key.length === 0 || !remaining.includes(key)) continue;
		found.push(key);
	}
	return uniq(found);
}

function collectEmojiKeywords(emoji: readonly string[]): string[] {
	const keywords: string[] = [];
	for (const value of emoji) {
		for (const keyword of emojiLibrary[value] ?? []) keywords.push(keyword);
	}
	return uniq(keywords);
}

function uniqueLabels(values: Iterable<string>, limit = 64): string[] {
	return normalizeLabels([...values]).values.slice(0, limit);
}

function describeProfile(
	title: string,
	emotions: readonly string[],
	intents: readonly string[],
	tones: readonly string[],
): string {
	const prefix =
		title.trim().length === 0
			? "Telegram sticker."
			: `Telegram sticker from ${sanitizeModelText(title).slice(0, 80)}.`;
	const parts: string[] = [];
	if (emotions.length > 0) parts.push(`expresses ${emotions.slice(0, 3).join(", ")}`);
	if (intents.length > 0) parts.push(`used for ${intents.slice(0, 3).join(", ")}`);
	if (tones.length > 0) parts.push(`${tones.slice(0, 2).join(", ")} tone`);
	const sentence =
		parts.length === 0 ? "No strong semantic signal was detected." : `${parts.join("; ")}.`;
	return `${prefix} ${sentence}`.slice(0, 240);
}

export function classifyStickerSemantics(input: StickerSemanticInput): StickerSemanticProfile {
	const title = normalizeText(input.title);
	const rawEmoji = normalizeText(input.emoji);
	const emojis = extractEmojis(`${rawEmoji} ${title}`);
	const emojiKeywords = collectEmojiKeywords(emojis);
	const titleTokens = tokensOf(title);
	const emojiTokens = tokensOf(emojiKeywords.join(" "));
	const titleFlat = normalizeForMatch(title).replace(/\s+/gu, "");
	const emojiFlat = normalizeForMatch(emojiKeywords.join(" ")).replace(/\s+/gu, "");

	const scores = new Map<string, number>();
	for (const category of STICKER_SEMANTIC_CATEGORIES) {
		let score = 0;
		for (const term of category.terms) {
			score = Math.max(
				score,
				termScore(term, titleTokens, titleFlat) * 1.2,
				termScore(term, emojiTokens, emojiFlat) * 1.5,
			);
		}
		for (const emoji of emojis) {
			if (EMOJI_HINTS[emoji]?.includes(category.id) === true) score += 3;
		}
		if (score > 0) scores.set(category.id, score);
	}

	const ranked = [...scores.entries()]
		.toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.filter(([, score]) => score >= 1.2);
	const maxLabels = Math.min(16, Math.max(1, input.maxLabels ?? 7));
	const picked = ranked.slice(0, maxLabels).map(([id]) => id);
	const labels = picked.length === 0 ? ["neutral"] : picked;
	const emotions = labels.filter((id) => categoriesById.get(id)?.kind === "emotion").slice(0, 6);
	const intents = labels.filter((id) => categoriesById.get(id)?.kind === "intent").slice(0, 6);
	const tones = labels.filter((id) => categoriesById.get(id)?.kind === "tone").slice(0, 4);
	if (emotions.length === 0 && intents.length === 0 && tones.length === 0) emotions.push("neutral");
	const keywords = uniqueLabels([
		...labels,
		...emojiKeywords.slice(0, 16),
		...titleTokens.slice(0, 10),
	]);
	const topScore = ranked[0]?.[1] ?? 0;
	return {
		confidence: Math.min(0.95, topScore === 0 ? 0.2 : 0.35 + topScore / 12),
		description: describeProfile(title, emotions, intents, tones),
		emotions,
		...(rawEmoji.length === 0 ? {} : { emoji: rawEmoji.slice(0, 64) }),
		intents,
		keywords,
		labels,
		source: "heuristic",
		tones,
		version: 1,
	};
}

export class HeuristicSemanticClassifier implements StickerSemanticClassifier {
	readonly name = "heuristic";

	async classify(input: StickerSemanticInput): Promise<StickerSemanticProfile> {
		return classifyStickerSemantics(input);
	}
}

/**
 * True when classification is deterministic and cheap enough to run inline with imports, so the
 * pipeline can skip a redundant second database write for the same item.
 */
export function isHeuristicSemanticClassifier(
	classifier: StickerSemanticClassifier | undefined,
): boolean {
	return classifier === undefined || classifier instanceof HeuristicSemanticClassifier;
}

export function mergeSemanticProfiles(
	base: StickerSemanticProfile,
	override: StickerSemanticProfile,
	maxLabels = 10,
): StickerSemanticProfile {
	const labels = uniqueLabels([...override.labels, ...base.labels], maxLabels);
	const emotions = uniqueLabels([...override.emotions, ...base.emotions], 6);
	const intents = uniqueLabels([...override.intents, ...base.intents], 6);
	const tones = uniqueLabels([...override.tones, ...base.tones], 4);
	const keywords = uniqueLabels([...override.keywords, ...base.keywords, ...labels], 64);
	const description =
		normalizeText(override.description).length > 0 ? override.description : base.description;
	return {
		confidence: Math.min(0.99, Math.max(base.confidence, override.confidence)),
		description: sanitizeModelText(description).slice(0, 1000),
		emotions,
		...((override.emoji ?? base.emoji) === undefined
			? {}
			: { emoji: override.emoji ?? base.emoji }),
		intents,
		keywords,
		labels,
		...((override.model ?? base.model) === undefined
			? {}
			: { model: (override.model ?? base.model) as string }),
		source: "merged",
		tones,
		version: 1,
	};
}

export interface VisionSemanticOptions {
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly logger?: SemanticLogger;
	readonly maxLabels?: number;
	readonly model: string;
	readonly onError?: "fallback" | "throw";
	readonly providerId?: string;
	readonly timeoutMs?: number;
	/** Replaces animated stickers with a frame contact sheet before the vision request. */
	readonly frameSheet?: (input: {
		readonly bytes: Uint8Array;
		readonly mimeType: string;
	}) => Promise<FrameSheet | undefined>;
	/** Test seam or host-model bridge. When absent the optional `openai` SDK is loaded lazily. */
	readonly complete?: (request: {
		readonly base64: string;
		readonly imageDataUrl: string;
		readonly mimeType: string;
		readonly model: string;
		readonly prompt: string;
	}) => Promise<string>;
}

const VISION_MAX_TOKENS = 2048;

const visionResponseSchema = z.object({
	confidence: z.number().finite().min(0).max(1).optional(),
	description: z.string().max(1200).optional(),
	emotions: z.array(z.string()).max(32).optional(),
	intents: z.array(z.string()).max(32).optional(),
	keywords: z.array(z.string()).max(64).optional(),
	labels: z.array(z.string()).max(32).optional(),
	tones: z.array(z.string()).max(16).optional(),
});

function parseVisionJson(content: string): unknown {
	const trimmed = content.trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
	} catch {
		return undefined;
	}
}

function promptForVision(input: StickerSemanticInput, animationFrameCount = 0): string {
	const allowedIds = STICKER_SEMANTIC_CATEGORIES.map((category) => category.id).join(", ");
	return [
		"You classify Telegram stickers for a chat assistant's semantic sticker search.",
		"Return one JSON object only, with keys: description, emotions, intents, tones, labels, keywords, confidence.",
		`Allowed labels: ${allowedIds}.`,
		"Use only allowed labels. Give 1-5 labels.",
		"description must be a detailed, specific English description of the sticker, about 2-4 informative sentences and under 900 characters.",
		"Say who or what is depicted: the character name, mascot, or series/IP when recognizable (the pack title is a useful hint), plus notable outfit, appearance, or props.",
		"Describe the visual content: facial expression, pose/action, gestures, and any visible text, captions, speech bubbles, or symbols (for example ?, hearts, sweat drop, anger vein) and what they mean.",
		"Briefly note the conversational vibe or usage context when it helps.",
		"Do not include URLs, file paths, or markdown.",
		"Include useful English and Chinese keywords when they fit.",
		...(animationFrameCount > 1
			? [
					`The attached image is a single contact sheet merged from ${animationFrameCount} frames sampled across ONE animated sticker. Read the frames left-to-right, top-to-bottom as a time sequence. Explicitly describe the full animation progression, the start -> middle -> end changes, the looping action, and any expression changes, not just a single frame.`,
				]
			: []),
		`Pack title: ${sanitizeModelText(input.title ?? "") || "(unknown)"}.`,
		`Telegram emoji: ${input.emoji ?? "(none)"}.`,
	].join("\n");
}

interface VisionImage {
	readonly bytes: Uint8Array;
	readonly frameCount: number;
	readonly mimeType: string;
}

export class VisionSemanticClassifier implements StickerSemanticClassifier {
	readonly name: string;
	readonly #apiKey: string | undefined;
	readonly #baseUrl: string | undefined;
	readonly #logger: SemanticLogger | undefined;
	readonly #maxLabels: number | undefined;
	readonly #model: string;
	readonly #onError: "fallback" | "throw";
	readonly #timeoutMs: number;
	readonly #frameSheet: (input: {
		readonly bytes: Uint8Array;
		readonly mimeType: string;
	}) => Promise<FrameSheet | undefined>;
	readonly #complete:
		| ((request: {
				readonly base64: string;
				readonly imageDataUrl: string;
				readonly mimeType: string;
				readonly model: string;
				readonly prompt: string;
		  }) => Promise<string>)
		| undefined;

	constructor(options: VisionSemanticOptions) {
		this.#apiKey = options.apiKey;
		this.#baseUrl = options.baseUrl;
		this.#logger = options.logger;
		this.#maxLabels = options.maxLabels;
		this.#model = options.model;
		this.#onError = options.onError ?? "fallback";
		this.#timeoutMs = Math.max(5_000, options.timeoutMs ?? 60_000);
		this.#frameSheet =
			options.frameSheet ??
			(async (input) =>
				await buildAnimatedFrameSheet(input.bytes, input.mimeType, {
					logger: options.logger,
				}));
		this.#complete = options.complete;
		this.name =
			options.providerId === undefined
				? `vision:${options.model}`
				: `vision:${options.providerId}/${options.model}`;
	}

	async classify(input: StickerSemanticInput): Promise<StickerSemanticProfile> {
		const base = classifyStickerSemantics(input);
		if (
			input.bytes === undefined ||
			input.bytes.byteLength === 0 ||
			input.mimeType === undefined ||
			!input.mimeType.startsWith("image/")
		) {
			this.#logger?.trace?.("vision sticker classification skipped", {
				hasBytes: input.bytes !== undefined && input.bytes.byteLength > 0,
				mimeType: input.mimeType ?? null,
				title: input.title ?? null,
			});
			return base;
		}
		const startedAt = Date.now();
		this.#logger?.trace?.("vision sticker classification started", {
			bytes: input.bytes.byteLength,
			mimeType: input.mimeType,
			model: this.#model,
			title: input.title ?? null,
		});
		try {
			const image = await this.#prepareImage(input.bytes, input.mimeType);
			const content = await this.#request(input, base, image);
			const parsed = visionResponseSchema.safeParse(parseVisionJson(content));
			if (!parsed.success) throw new Error("Vision classifier returned invalid JSON");
			const allowed = (values: readonly string[] | undefined): string[] =>
				uniqueLabels(
					(values ?? [])
						.map((value) => normalizeText(value).toLowerCase().replace(/\s+/gu, "-"))
						.filter((value) => categoryIds.has(value)),
					16,
				);
			const labels = allowed(parsed.data.labels);
			const emotions = allowed(parsed.data.emotions);
			const intents = allowed(parsed.data.intents);
			const tones = allowed(parsed.data.tones);
			const keywords = uniqueLabels(parsed.data.keywords ?? [], 64);
			const profile: StickerSemanticProfile = {
				confidence: Math.min(0.99, Math.max(0.5, parsed.data.confidence ?? 0.75)),
				description: sanitizeModelText(parsed.data.description ?? base.description).slice(0, 1000),
				emotions:
					emotions.length > 0
						? emotions
						: labels.filter((id) => categoriesById.get(id)?.kind === "emotion"),
				...(base.emoji === undefined ? {} : { emoji: base.emoji }),
				intents:
					intents.length > 0
						? intents
						: labels.filter((id) => categoriesById.get(id)?.kind === "intent"),
				keywords,
				labels: labels.length > 0 ? labels : [...emotions, ...intents, ...tones],
				model: this.#model,
				source: "vision",
				tones:
					tones.length > 0 ? tones : labels.filter((id) => categoriesById.get(id)?.kind === "tone"),
				version: 1,
			};
			const merged = mergeSemanticProfiles(base, profile, this.#maxLabels ?? 10);
			this.#logger?.debug?.("vision sticker classification completed", {
				durationMs: Date.now() - startedAt,
				labels: merged.labels.length,
				model: this.#model,
				source: merged.source,
			});
			return merged;
		} catch (error) {
			if (this.#onError === "throw") throw error;
			this.#logger?.warn("vision sticker classification failed; using heuristic profile", {
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
				model: this.#model,
			});
			return base;
		}
	}

	async #prepareImage(bytes: Uint8Array, mimeType: string): Promise<VisionImage> {
		if (!isAnimatedImage(mimeType, bytes)) {
			return { bytes, frameCount: 0, mimeType };
		}
		try {
			const sheet = await this.#frameSheet({ bytes, mimeType });
			if (sheet === undefined) return { bytes, frameCount: 0, mimeType };
			this.#logger?.debug?.("animated sticker frame sheet prepared", {
				frameCount: sheet.frameCount,
				mimeType,
				sheetBytes: sheet.bytes.byteLength,
			});
			return { bytes: sheet.bytes, frameCount: sheet.frameCount, mimeType: sheet.mimeType };
		} catch (error) {
			this.#logger?.warn("animated sticker frame sheet failed; using the original media", {
				error: error instanceof Error ? error.message : String(error),
				mimeType,
			});
			return { bytes, frameCount: 0, mimeType };
		}
	}

	async #request(
		input: StickerSemanticInput,
		base: StickerSemanticProfile,
		image: VisionImage,
	): Promise<string> {
		const mimeType = image.mimeType;
		const base64 = Buffer.from(image.bytes).toString("base64");
		const imageDataUrl = `data:${mimeType};base64,${base64}`;
		const prompt = promptForVision(input, image.frameCount);
		this.#logger?.trace?.("vision provider request started", {
			hostModel: this.#complete !== undefined,
			mimeType,
			model: this.#model,
		});
		const requestOnce = async (): Promise<string> => {
			if (this.#complete !== undefined) {
				return await this.#complete({
					base64,
					imageDataUrl,
					mimeType,
					model: this.#model,
					prompt,
				});
			}
			if (this.#apiKey === undefined || this.#apiKey.length === 0) {
				throw new Error("Semantic vision mode requires semanticApiKey and semanticModel");
			}
			const { default: OpenAI } = await import("openai");
			const client = new OpenAI({
				apiKey: this.#apiKey,
				...(this.#baseUrl === undefined ? {} : { baseURL: this.#baseUrl }),
				maxRetries: 0,
				timeout: this.#timeoutMs,
			});
			const response = await client.chat.completions.create({
				max_tokens: VISION_MAX_TOKENS,
				messages: [
					{
						content: [
							{ text: prompt, type: "text" },
							{ image_url: { url: imageDataUrl }, type: "image_url" },
						],
						role: "user",
					},
				],
				model: this.#model,
				response_format: { type: "json_object" },
				temperature: 0.2,
			});
			return response.choices[0]?.message.content ?? "";
		};
		let content = await requestOnce();
		if (content.trim().length === 0) {
			this.#logger?.warn("vision provider returned no content; retrying once", {
				model: this.#model,
			});
			content = await requestOnce();
		}
		if (content.trim().length === 0) {
			throw new Error(`Vision classifier returned no content (${base.labels.join("-")})`);
		}
		this.#logger?.trace?.("vision provider request completed", {
			contentLength: content.length,
			model: this.#model,
		});
		return content;
	}
}

export function isVisionCapablePluginModel(model: PluginModelInfo): boolean {
	return (model.input?.includes("image") ?? false) || model.capabilities.includes("vision");
}

export interface ResolveSemanticClassifierOptions {
	readonly logger?: SemanticLogger;
	readonly mode?: string;
	readonly modelId?: string;
	readonly models?: PluginModelRegistry;
	readonly providerId?: string;
}

function createHostModelClassifier(options: {
	readonly logger: SemanticLogger | undefined;
	readonly maxLabels: number | undefined;
	readonly modelId: string;
	readonly models: PluginModelRegistry;
	readonly providerId: string;
	readonly timeoutMs: number;
}): VisionSemanticClassifier {
	return new VisionSemanticClassifier({
		complete: async ({ base64, mimeType, prompt }) => {
			const response = await options.models.complete({
				maxTokens: VISION_MAX_TOKENS,
				messages: [
					{
						content: [
							{ text: prompt, type: "text" },
							{ data: base64, mimeType, type: "image" },
						],
						role: "user",
					},
				],
				modelId: options.modelId,
				providerId: options.providerId,
				signal: AbortSignal.timeout(options.timeoutMs),
				temperature: 0.2,
			});
			return response.text;
		},
		...(options.logger === undefined ? {} : { logger: options.logger }),
		...(options.maxLabels === undefined ? {} : { maxLabels: options.maxLabels }),
		model: options.modelId,
		onError: "fallback",
		providerId: options.providerId,
		timeoutMs: options.timeoutMs,
	});
}

export async function resolveSemanticClassifier(
	settings: Record<string, unknown>,
	options: ResolveSemanticClassifierOptions = {},
): Promise<StickerSemanticClassifier> {
	const mode = normalizeText(options.mode ?? settings.semanticMode, "auto");
	if (mode === "heuristic") {
		return new HeuristicSemanticClassifier();
	}
	const providerId = normalizeText(
		options.providerId !== undefined ? options.providerId : settings.semanticProviderId,
	);
	const modelId = normalizeText(
		options.modelId !== undefined ? options.modelId : settings.semanticModel,
	);
	const apiKey = normalizeText(settings.semanticApiKey);
	const baseUrl = normalizeText(settings.semanticBaseUrl);
	const maxLabels =
		typeof settings.semanticMaxLabels === "number" ? settings.semanticMaxLabels : undefined;
	const timeoutMs =
		typeof settings.semanticTimeoutSeconds === "number"
			? Math.max(5, settings.semanticTimeoutSeconds) * 1_000
			: 60_000;

	if (providerId.length > 0) {
		if (options.models === undefined) {
			throw new Error(`Model provider "${providerId}" is unavailable`);
		}
		const catalog = await options.models.listModels({ providerId });
		const selected =
			modelId.length > 0
				? catalog.find((candidate) => candidate.id === modelId)
				: (catalog.find(isVisionCapablePluginModel) ?? catalog[0]);
		if (selected === undefined) {
			throw new Error(
				modelId.length > 0
					? `Model "${modelId}" is not enabled on provider "${providerId}"`
					: `Provider "${providerId}" has no enabled models`,
			);
		}
		return createHostModelClassifier({
			logger: options.logger,
			maxLabels,
			modelId: selected.id,
			models: options.models,
			providerId: selected.providerId,
			timeoutMs,
		});
	}

	if (options.modelId !== undefined && modelId.length > 0 && options.models !== undefined) {
		const matched = await options.models.findModel(modelId);
		if (matched !== undefined) {
			return createHostModelClassifier({
				logger: options.logger,
				maxLabels,
				modelId: matched.id,
				models: options.models,
				providerId: matched.providerId,
				timeoutMs,
			});
		}
	}

	if (apiKey.length > 0 && modelId.length > 0) {
		return new VisionSemanticClassifier({
			apiKey,
			...(baseUrl.length === 0 ? {} : { baseUrl }),
			...(options.logger === undefined ? {} : { logger: options.logger }),
			...(maxLabels === undefined ? {} : { maxLabels }),
			model: modelId,
			onError: "fallback",
			timeoutMs,
		});
	}

	if (modelId.length > 0) {
		const matched = await options.models?.findModel(modelId);
		if (matched !== undefined) {
			return createHostModelClassifier({
				logger: options.logger,
				maxLabels,
				modelId: matched.id,
				models: options.models!,
				providerId: matched.providerId,
				timeoutMs,
			});
		}
		if (mode === "vision" || options.modelId !== undefined) {
			throw new Error(`Model "${modelId}" is not available from any configured provider`);
		}
	}

	if (options.models !== undefined) {
		const catalog = await options.models.listModels();
		const visionModel = catalog.find(isVisionCapablePluginModel);
		if (visionModel !== undefined) {
			return createHostModelClassifier({
				logger: options.logger,
				maxLabels,
				modelId: visionModel.id,
				models: options.models,
				providerId: visionModel.providerId,
				timeoutMs,
			});
		}
	}

	if (mode === "vision") {
		throw new Error(
			"Semantic vision mode requires a configured vision model or semanticApiKey and semanticModel",
		);
	}
	options.logger?.debug?.("semantic classifier resolved", { mode: "heuristic" });
	return new HeuristicSemanticClassifier();
}

export function createSemanticClassifier(
	settings: Record<string, unknown>,
	overrideMode?: string,
	logger?: SemanticLogger,
): StickerSemanticClassifier {
	const mode = normalizeText(overrideMode ?? settings.semanticMode, "auto");
	const apiKey = normalizeText(settings.semanticApiKey);
	const model = normalizeText(settings.semanticModel);
	const baseUrl = normalizeText(settings.semanticBaseUrl);
	const maxLabels =
		typeof settings.semanticMaxLabels === "number" ? settings.semanticMaxLabels : undefined;
	if (mode !== "heuristic" && apiKey.length > 0 && model.length > 0) {
		return new VisionSemanticClassifier({
			apiKey,
			...(baseUrl.length === 0 ? {} : { baseUrl }),
			...(logger === undefined ? {} : { logger }),
			...(maxLabels === undefined ? {} : { maxLabels }),
			model,
			onError: "fallback",
			timeoutMs:
				typeof settings.semanticTimeoutSeconds === "number"
					? Math.max(5, settings.semanticTimeoutSeconds) * 1_000
					: 60_000,
		});
	}
	if (mode === "vision") {
		throw new Error("Semantic vision mode requires semanticApiKey and semanticModel");
	}
	logger?.debug?.("semantic classifier created", { mode: "heuristic" });
	return new HeuristicSemanticClassifier();
}

export { parseSemanticProfile, EMPTY_SEMANTIC_PROFILE };
export type { StickerSemanticProfile };
