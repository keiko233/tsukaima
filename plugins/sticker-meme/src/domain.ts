import { createHash } from "node:crypto";
import { z } from "zod";

export const stickerPackSources = ["builtin", "imported", "generated", "learned"] as const;
export const stickerReviewStatuses = ["approved", "pending", "rejected"] as const;
export const stickerSemanticSources = ["none", "heuristic", "vision", "merged", "manual"] as const;

export type StickerPackSource = (typeof stickerPackSources)[number];
export type StickerReviewStatus = (typeof stickerReviewStatuses)[number];
export type StickerSemanticSource = (typeof stickerSemanticSources)[number];

/**
 * Precomputed meaning for one sticker. Telegram only gives us an emoji and a pack title, so
 * semantic preprocessing expands that signal into searchable labels before the sticker reaches
 * the selection tool. `vision`/`merged` sources indicate an optional image model contributed to
 * the profile.
 */
export interface StickerSemanticProfile {
	readonly version: 1;
	readonly source: StickerSemanticSource;
	readonly labels: readonly string[];
	readonly emotions: readonly string[];
	readonly intents: readonly string[];
	readonly tones: readonly string[];
	readonly keywords: readonly string[];
	readonly description: string;
	readonly confidence: number;
	readonly emoji?: string;
	readonly model?: string;
}

export interface StickerPack {
	readonly id: string;
	readonly name: string;
	readonly source: StickerPackSource;
	readonly enabled: boolean;
	readonly tags: readonly string[];
	readonly personaIds: readonly string[];
	readonly metadata: Record<string, unknown>;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface StickerItem {
	readonly id: string;
	readonly packId: string;
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly emotions: readonly string[];
	readonly mimeType: string;
	readonly mediaId: string;
	readonly hash: string;
	readonly width: number | null;
	readonly height: number | null;
	readonly enabled: boolean;
	readonly reviewStatus: StickerReviewStatus;
	readonly semantic: StickerSemanticProfile;
	readonly score: number;
	readonly useCount: number;
	readonly lastUsedAt: string | null;
	readonly sourceConversationId: string | null;
	readonly revokedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface StickerPackInput {
	readonly id?: string;
	readonly name: string;
	readonly source?: StickerPackSource;
	readonly enabled?: boolean;
	readonly tags?: readonly string[];
	readonly personaIds?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export const stickerPackSourceSchema = z.enum(stickerPackSources);
export const stickerReviewStatusSchema = z.enum(stickerReviewStatuses);
export const stickerSemanticSourceSchema = z.enum(stickerSemanticSources);

const semanticLabelSchema = z.string().trim().min(1).max(64);
export const stickerSemanticProfileSchema = z.object({
	confidence: z.number().finite().min(0).max(1).default(0),
	description: z.string().max(500).default(""),
	emotions: z.array(semanticLabelSchema).max(32).default([]),
	emoji: z.string().max(64).optional(),
	intents: z.array(semanticLabelSchema).max(32).default([]),
	keywords: z.array(semanticLabelSchema).max(128).default([]),
	labels: z.array(semanticLabelSchema).max(64).default([]),
	model: z.string().max(160).optional(),
	source: stickerSemanticSourceSchema.default("none"),
	tones: z.array(semanticLabelSchema).max(32).default([]),
	version: z.literal(1).default(1),
});

export const EMPTY_SEMANTIC_PROFILE: StickerSemanticProfile = {
	confidence: 0,
	description: "",
	emotions: [],
	intents: [],
	keywords: [],
	labels: [],
	source: "none",
	tones: [],
	version: 1,
};

export function parseSemanticProfile(value: unknown): StickerSemanticProfile {
	const parsed = stickerSemanticProfileSchema.safeParse(value);
	if (!parsed.success) return EMPTY_SEMANTIC_PROFILE;
	const { emoji, model, ...rest } = parsed.data;
	return {
		...rest,
		...(emoji === undefined ? {} : { emoji }),
		...(model === undefined ? {} : { model }),
	};
}

const labelPattern = /^[\p{L}\p{N}_-]{1,32}$/u;

export function stableId(prefix: string, value: string): string {
	return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeLabel(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-");
}

export function normalizeLabels(values: readonly string[] | string | undefined): {
	readonly values: string[];
	readonly invalid: string[];
} {
	const raw = typeof values === "string" ? values.split(/[,，]/u) : (values ?? []);
	const result = new Set<string>();
	const invalid: string[] = [];
	for (const entry of raw) {
		const normalized = normalizeLabel(entry);
		if (normalized.length === 0) continue;
		if (!labelPattern.test(normalized)) {
			invalid.push(entry.trim());
			continue;
		}
		result.add(normalized);
	}
	return { invalid, values: [...result].slice(0, 64) };
}

/** Strip links and absolute paths from text that may become model-visible. */
export function sanitizeModelText(value: string): string {
	return value
		.replace(/https?:\/\/\S+/giu, "[link]")
		.replace(/(?:^|\s)(?:[A-Za-z]:\\|\/)(?:[^\s]+)/gu, " [path]")
		.replace(/\s+/gu, " ")
		.trim();
}

export function normalizeText(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value.trim() : fallback;
}

export function textList(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(/[,，]/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Reject traversal and absolute paths from imported manifests. */
export function safeRelativePath(value: string): string | undefined {
	const normalized = value
		.replace(/\\/gu, "/")
		.replace(/^\.\/+/u, "")
		.trim();
	if (normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/")) {
		return undefined;
	}
	if (normalized.split("/").some((segment) => segment === ".." || segment.length === 0)) {
		return undefined;
	}
	return normalized;
}

export function fileExtension(mimeType: string, hash: string): string {
	const byMime: Record<string, string> = {
		"image/gif": "gif",
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
	};
	return byMime[mimeType.toLowerCase()] ?? hash.slice(0, 8);
}

export function inferMimeType(fileName: string): string {
	const extension = fileName.split(".").at(-1)?.toLowerCase();
	switch (extension) {
		case "gif":
			return "image/gif";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (value === null || value === undefined || value.length === 0) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}
