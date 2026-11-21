import { randomUUID } from "node:crypto";
import type { AuditEntry, PluginLogger, PluginMediaApi } from "@tsukaima/sdk";
import { normalizeLabel, sanitizeModelText } from "./domain.ts";
import type { StickerItem, StickerPack } from "./domain.ts";
import { elapsedMs, traceLog } from "./logging.ts";
import type { StickerRepository } from "./repository.ts";
import { STICKER_SEMANTIC_CATEGORIES } from "./semantic.ts";

export interface StickerSearchInput {
	readonly emotion?: string;
	readonly limit?: number;
	readonly packId?: string;
	readonly personaId?: string;
	readonly query?: string;
	readonly tags?: readonly string[];
}

export interface StickerCandidate {
	readonly description: string;
	readonly emotions: readonly string[];
	readonly enabled: boolean;
	readonly hash: string;
	readonly height: number | null;
	readonly itemId: string;
	readonly keywords: readonly string[];
	readonly labels: readonly string[];
	readonly lastUsedAt: string | null;
	readonly mimeType: string;
	readonly name: string;
	readonly packId: string;
	readonly packName: string;
	readonly personaIds: readonly string[];
	readonly reviewStatus: string;
	readonly score: number;
	readonly tags: readonly string[];
	readonly useCount: number;
	readonly width: number | null;
}

export interface AvailableStickerPack {
	readonly itemCount: number;
	readonly name: string;
	readonly packId: string;
	readonly personaIds: readonly string[];
	readonly sampleEmotions: readonly string[];
	readonly tags: readonly string[];
}

export interface StickerSendResolution {
	readonly availablePacks?: readonly AvailableStickerPack[];
	readonly item: StickerItem;
	readonly matchedBy: "query" | "fallback";
	readonly pack: StickerPack;
}

export interface StickerChooseResult {
	readonly conversationId: string;
	readonly directive: string;
	readonly expiresAt: string;
	readonly itemId: string;
	readonly sendToken: string;
}

export interface StickerSelectionOptions {
	readonly audit?: { record(entry: AuditEntry): Promise<void> };
	readonly logger?: PluginLogger | undefined;
	readonly media: PluginMediaApi;
	readonly now?: () => number;
	readonly repository: StickerRepository;
	readonly tokenTtlMs?: number;
}

const MAX_SEARCH_LIMIT = 25;
const RECENT_COOLDOWN_MS = 5 * 60_000;

/**
 * Emotion inputs arrive from a live model, not a closed enum form. Map every taxonomy term
 * (including Chinese/Japanese aliases) back to its canonical id so `开心` still matches items
 * classified as `happy`.
 */
const EMOTION_ALIASES = new Map<string, string>();
const QUERY_ALIASES = new Map<string, readonly string[]>();
for (const category of STICKER_SEMANTIC_CATEGORIES) {
	const terms = [...new Set([category.id, ...category.terms].map(normalizeLabel).filter(Boolean))];
	for (const term of terms) {
		QUERY_ALIASES.set(term, [...new Set([...(QUERY_ALIASES.get(term) ?? []), ...terms])]);
		if (category.kind === "emotion" && !EMOTION_ALIASES.has(term)) {
			EMOTION_ALIASES.set(term, category.id);
		}
	}
}

function requestedEmotions(value: string | undefined): ReadonlySet<string> {
	const result = new Set<string>();
	for (const entry of (value ?? "").split(/[,，]/u)) {
		const key = normalizeLabel(entry);
		if (key.length === 0) continue;
		result.add(EMOTION_ALIASES.get(key) ?? key);
	}
	return result;
}

const canonicalEmotion = (value: string): string => {
	const key = normalizeLabel(value);
	return EMOTION_ALIASES.get(key) ?? key;
};

/** Resolve a pack reference by id, display name, tag, or persona; partial names also match. */
function resolvePackFilter(
	packs: readonly StickerPack[],
	reference: string,
): ReadonlySet<string> | undefined {
	const normalized = normalizeLabel(reference);
	if (normalized.length === 0) return undefined;
	const matches = (pack: StickerPack, exact: boolean): boolean => {
		const name = normalizeLabel(pack.name);
		const tags = pack.tags.map(normalizeLabel);
		const personaIds = pack.personaIds.map(normalizeLabel);
		if (exact) {
			return (
				pack.id === reference ||
				name === normalized ||
				tags.includes(normalized) ||
				personaIds.includes(normalized)
			);
		}
		return (
			name.includes(normalized) ||
			tags.some((tag) => tag.includes(normalized)) ||
			personaIds.some((id) => id.includes(normalized))
		);
	};
	const exact = packs.filter((pack) => matches(pack, true));
	const matched = exact.length > 0 ? exact : packs.filter((pack) => matches(pack, false));
	return new Set(matched.map((pack) => pack.id));
}

function candidate(item: StickerItem, pack: StickerPack): StickerCandidate {
	return {
		description: sanitizeModelText(item.description),
		emotions: [...item.emotions],
		enabled: item.enabled,
		hash: item.hash,
		height: item.height,
		itemId: item.id,
		keywords: [...item.keywords],
		labels: [...item.semantic.labels],
		lastUsedAt: item.lastUsedAt,
		mimeType: item.mimeType,
		name: sanitizeModelText(item.name),
		packId: item.packId,
		packName: sanitizeModelText(pack.name),
		personaIds: [...pack.personaIds],
		reviewStatus: item.reviewStatus,
		score: item.score,
		tags: [...pack.tags],
		useCount: item.useCount,
		width: item.width,
	};
}

/**
 * Models often send several synonyms or keywords separated by spaces/commas. Treat each term as
 * an alternative (OR) instead of requiring the entire phrase to appear verbatim.
 */
const QUERY_SEPARATOR = /[\s,，、/|]+/u;

function queryTokens(query: string | undefined): readonly string[] {
	if (query === undefined) return [];
	const tokens = new Set<string>();
	for (const entry of query.split(QUERY_SEPARATOR)) {
		const token = normalizeLabel(entry);
		if (token.length === 0) continue;
		for (const alias of QUERY_ALIASES.get(token) ?? [token]) tokens.add(alias);
	}
	return [...tokens];
}

/**
 * Deterministic ranking: exact keyword/name beats substring, then emotion, persona preference,
 * score, and a cooldown that discourages recently spammed stickers.
 */
export function rankStickerItem(
	item: StickerItem,
	pack: StickerPack,
	input: StickerSearchInput,
	now = Date.now(),
): number | undefined {
	const tokens = queryTokens(input.query);
	const name = normalizeLabel(item.name);
	const description = normalizeLabel(item.description);
	const semanticDescription = normalizeLabel(item.semantic.description);
	const packName = normalizeLabel(pack.name);
	const keywords = item.keywords.map(normalizeLabel);
	const labels = item.semantic.labels.map(normalizeLabel);
	const packTags = pack.tags.map(normalizeLabel);
	const packPersonaIds = pack.personaIds.map(normalizeLabel);
	const haystacks = [
		name,
		description,
		semanticDescription,
		packName,
		...keywords,
		...labels,
		...packTags,
		...packPersonaIds,
	];
	const matched = tokens.filter((token) => haystacks.some((value) => value.includes(token)));
	if (tokens.length > 0 && matched.length === 0) return undefined;
	const emotions = requestedEmotions(input.emotion);
	if (emotions.size > 0 && !item.emotions.some((value) => emotions.has(canonicalEmotion(value)))) {
		return undefined;
	}
	if (input.personaId !== undefined && pack.personaIds.length > 0) {
		if (!pack.personaIds.includes(input.personaId)) return undefined;
	}
	const tags = (input.tags ?? []).map(normalizeLabel).filter(Boolean);
	if (tags.length > 0 && !tags.every((tag) => packTags.includes(tag))) return undefined;
	let score = item.score;
	let tokenScore = 0;
	for (const token of matched) {
		let current = 0;
		if (name === token) current = 120;
		else if (name.includes(token)) current = 60;
		if (keywords.includes(token)) current = Math.max(current, 100);
		else if (keywords.some((keyword) => keyword.includes(token))) {
			current = Math.max(current, 45);
		}
		if (labels.includes(token)) current = Math.max(current, 80);
		else if (labels.some((label) => label.includes(token))) {
			current = Math.max(current, 35);
		}
		if (description.includes(token)) current = Math.max(current, 20);
		if (semanticDescription.includes(token)) current = Math.max(current, 18);
		if (packName === token) current = Math.max(current, 180);
		else if (packName.includes(token)) current = Math.max(current, 120);
		if (packTags.includes(token)) current = Math.max(current, 140);
		else if (packTags.some((tag) => tag.includes(token))) {
			current = Math.max(current, 60);
		}
		if (packPersonaIds.includes(token)) current = Math.max(current, 160);
		else if (packPersonaIds.some((id) => id.includes(token))) {
			current = Math.max(current, 80);
		}
		tokenScore += current;
	}
	const normalizedQuery = input.query !== undefined ? normalizeLabel(input.query) : undefined;
	if (normalizedQuery !== undefined && normalizedQuery.length > 0) {
		if (
			packName === normalizedQuery ||
			packName.replace(/-/gu, "") === normalizedQuery.replace(/-/gu, "")
		) {
			tokenScore += 100;
		} else if (packName.includes(normalizedQuery)) {
			tokenScore += 50;
		}
		if (packTags.includes(normalizedQuery)) {
			tokenScore += 80;
		}
		if (packPersonaIds.includes(normalizedQuery)) {
			tokenScore += 90;
		}
	}
	// Several distinct terms matching is stronger evidence than one synonym hitting.
	score += Math.min(400, tokenScore);
	if (emotions.size > 0) score += 40;
	if (input.personaId !== undefined) {
		score += pack.personaIds.includes(input.personaId) ? 50 : 5;
	} else if (pack.personaIds.length > 0) {
		score += 10;
	}
	if (item.lastUsedAt === null) {
		score += 20;
	} else {
		const ageMs = Math.max(0, now - Date.parse(item.lastUsedAt));
		if (ageMs < RECENT_COOLDOWN_MS) score -= 40;
		else score += Math.min(20, Math.floor(ageMs / 3_600_000));
	}
	score -= Math.min(20, item.useCount * 2);
	return score;
}

/** Selection, ranking, and transient send-token issuance. */
export class StickerSelectionService {
	readonly #audit: StickerSelectionOptions["audit"];
	readonly #logger: PluginLogger | undefined;
	readonly #media: PluginMediaApi;
	readonly #now: () => number;
	readonly #repository: StickerRepository;
	readonly #tokenTtlMs: number;

	constructor(options: StickerSelectionOptions) {
		this.#audit = options.audit;
		this.#logger = options.logger;
		this.#media = options.media;
		this.#now = options.now ?? Date.now;
		this.#repository = options.repository;
		this.#tokenTtlMs = Math.max(5_000, options.tokenTtlMs ?? 120_000);
	}

	async search(input: StickerSearchInput): Promise<readonly StickerCandidate[]> {
		const startedAt = Date.now();
		const packList = await this.#repository.listPacks();
		const packs = new Map(packList.map((pack) => [pack.id, pack]));
		const packFilter =
			input.packId === undefined ? undefined : resolvePackFilter(packList, input.packId);
		const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, input.limit ?? 8));
		traceLog(this.#logger, "sticker search started", {
			emotion: input.emotion ?? null,
			limit,
			packId: input.packId ?? null,
			packMatches: packFilter === undefined ? null : packFilter.size,
			personaId: input.personaId ?? null,
			query: input.query ?? null,
			tags: input.tags ?? [],
		});
		if (packFilter !== undefined && packFilter.size === 0) {
			this.#logger?.debug("sticker search completed", {
				candidateCount: 0,
				considered: 0,
				durationMs: elapsedMs(startedAt),
				limit,
				skipped: 0,
			});
			return [];
		}
		const ranked: { candidate: StickerCandidate; score: number }[] = [];
		let considered = 0;
		let skipped = 0;
		// A resolved pack reference may cover several packs (partial name/tag match); in that
		// case scan all items and filter below instead of issuing one query per pack.
		const singlePackId =
			packFilter !== undefined && packFilter.size === 1 ? [...packFilter][0] : undefined;
		for (const item of await this.#repository.listItems(singlePackId)) {
			considered += 1;
			if (packFilter !== undefined && !packFilter.has(item.packId)) {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: "pack_filter",
				});
				continue;
			}
			const pack = packs.get(item.packId);
			if (pack === undefined || !pack.enabled) {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: pack === undefined ? "pack_missing" : "pack_disabled",
				});
				continue;
			}
			if (!item.enabled || item.revokedAt !== null || item.reviewStatus !== "approved") {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: !item.enabled
						? "item_disabled"
						: item.revokedAt !== null
							? "item_revoked"
							: "item_not_approved",
				});
				continue;
			}
			if (item.mediaId.length === 0) {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: "media_missing",
				});
				continue;
			}
			const media = await this.#media.findById(item.mediaId);
			if (media === undefined) {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: "media_missing",
				});
				continue;
			}
			const score = rankStickerItem(item, pack, input, this.#now());
			if (score === undefined) {
				skipped += 1;
				traceLog(this.#logger, "sticker candidate skipped", {
					itemId: item.id,
					packId: item.packId,
					reason: "no_match",
				});
				continue;
			}
			traceLog(this.#logger, "sticker candidate scored", {
				emotion: input.emotion ?? null,
				itemId: item.id,
				packId: item.packId,
				query: input.query ?? null,
				score,
			});
			ranked.push({ candidate: candidate(item, pack), score });
		}
		const candidates = ranked
			.toSorted(
				(left, right) =>
					right.score - left.score ||
					left.candidate.name.localeCompare(right.candidate.name, undefined, {
						sensitivity: "base",
					}) ||
					left.candidate.itemId.localeCompare(right.candidate.itemId),
			)
			.slice(0, limit)
			.map((entry) => entry.candidate);
		this.#logger?.debug("sticker search completed", {
			candidateCount: candidates.length,
			considered,
			durationMs: elapsedMs(startedAt),
			limit,
			skipped,
		});
		return candidates;
	}

	async choose(
		input: StickerSearchInput & { readonly itemId?: string; readonly conversationId?: string },
	): Promise<StickerChooseResult> {
		const startedAt = Date.now();
		const conversationId = input.conversationId?.trim();
		if (conversationId === undefined || conversationId.length === 0) {
			throw new Error("A conversation is required to choose a sticker");
		}
		traceLog(this.#logger, "sticker choose started", {
			conversationId,
			itemId: input.itemId ?? null,
			query: input.query ?? null,
		});
		let item: StickerItem | undefined;
		let pack: StickerPack | undefined;
		if (input.itemId !== undefined) {
			item = await this.#repository.getItem(input.itemId);
			if (item !== undefined) pack = await this.#repository.getPack(item.packId);
		} else {
			const [best] = await this.search({ ...input, limit: 1 });
			if (best !== undefined) {
				item = await this.#repository.getItem(best.itemId);
				if (item !== undefined) pack = await this.#repository.getPack(item.packId);
			}
		}
		if (item === undefined || pack === undefined) {
			await this.#recordDenied(conversationId, "not_found", input.itemId);
			this.#logger?.debug("sticker choose failed", {
				durationMs: elapsedMs(startedAt),
				reason: "not_found",
			});
			throw new Error("No sticker candidate matched");
		}
		const denial = await this.#selectable(item, pack);
		if (denial !== undefined) {
			await this.#recordDenied(conversationId, denial, item.id);
			this.#logger?.debug("sticker choose failed", {
				durationMs: elapsedMs(startedAt),
				itemId: item.id,
				reason: denial,
			});
			throw new Error(`Sticker is not selectable: ${denial}`);
		}
		const token = `st_${randomUUID().replace(/-/gu, "")}`;
		const expiresAt = new Date(this.#now() + this.#tokenTtlMs).toISOString();
		await this.#repository.insertToken({
			conversationId,
			expiresAt,
			itemId: item.id,
			token,
		});
		await this.#audit?.record({
			action: "sticker.token.issued",
			actorKind: "agent",
			payload: { expiresAt, itemId: item.id, packId: pack.id },
			result: "ok",
			targetId: item.id,
			targetKind: "sticker-item",
		});
		this.#logger?.debug("sticker send token issued", {
			durationMs: elapsedMs(startedAt),
			expiresAt,
			itemId: item.id,
			packId: pack.id,
			tokenIssued: true,
		});
		return {
			conversationId,
			directive: `[[sticker:${token}]]`,
			expiresAt,
			itemId: item.id,
			sendToken: token,
		};
	}

	/**
	 * Deterministic inline sticker resolution for `[表情:描述]` / `[sticker:描述]` markers.
	 * Matches the top approved, enabled sticker by query or emotion and records its usage.
	 */
	async resolveInline(
		query: string,
		options?: { readonly personaId?: string },
	): Promise<StickerItem | undefined> {
		const trimmed = query.trim();
		if (trimmed.length === 0) return undefined;
		// Try matching as a general query first, then fall back to emotion-only matching if needed.
		let [best] = await this.search({
			limit: 1,
			...(options?.personaId === undefined ? {} : { personaId: options.personaId }),
			query: trimmed,
		});
		if (best === undefined) {
			[best] = await this.search({
				emotion: trimmed,
				limit: 1,
				...(options?.personaId === undefined ? {} : { personaId: options.personaId }),
			});
		}
		if (best === undefined) return undefined;
		const item = await this.#repository.getItem(best.itemId);
		if (item === undefined) return undefined;
		const pack = await this.#repository.getPack(item.packId);
		if (pack === undefined || (await this.#selectable(item, pack)) !== undefined) {
			return undefined;
		}
		await this.#repository.recordUse(item.id);
		return item;
	}

	/**
	 * Lists all enabled sticker packs with item counts, tags, persona IDs, and sample emotions.
	 * Only counts enabled, approved, non-revoked items backed by real media.
	 */
	async listAvailablePacks(): Promise<readonly AvailableStickerPack[]> {
		const packList = await this.#repository.listPacks();
		const enabledPacks = packList.filter((pack) => pack.enabled);
		const allItems = await this.#repository.listItems();
		const mediaCache = new Map<string, boolean>();

		const hasMedia = async (mediaId: string): Promise<boolean> => {
			if (mediaId.length === 0) return false;
			const cached = mediaCache.get(mediaId);
			if (cached !== undefined) return cached;
			const found = (await this.#media.findById(mediaId)) !== undefined;
			mediaCache.set(mediaId, found);
			return found;
		};

		const result: AvailableStickerPack[] = [];
		for (const pack of enabledPacks) {
			const packItems = allItems.filter((item) => item.packId === pack.id);
			const emotionsSet = new Set<string>();
			let validCount = 0;

			for (const item of packItems) {
				if (!item.enabled || item.revokedAt !== null || item.reviewStatus !== "approved") {
					continue;
				}
				if (!(await hasMedia(item.mediaId))) {
					continue;
				}
				validCount += 1;
				for (const emotion of item.emotions) {
					const trimmed = emotion.trim();
					if (trimmed.length > 0) emotionsSet.add(trimmed);
				}
			}

			result.push({
				itemCount: validCount,
				name: sanitizeModelText(pack.name),
				packId: pack.id,
				personaIds: [...pack.personaIds],
				sampleEmotions: [...emotionsSet].slice(0, 5),
				tags: [...pack.tags],
			});
		}
		return result;
	}

	/**
	 * Single-step sticker selection for `sticker-meme.send`: resolves the best matching approved
	 * item (or an explicit `itemId`), validates that its media is present, and records the use so
	 * the tool can send it immediately. No send token is issued; immediate sending is the only
	 * path, so markers and directives are never handed back to the model.
	 * When the explicit query returns no matches, falls back to available stickers and returns
	 * `matchedBy: "fallback"` along with `availablePacks`.
	 */
	async resolveForSend(
		input: StickerSearchInput & { readonly itemId?: string; readonly conversationId: string },
	): Promise<StickerSendResolution> {
		const startedAt = Date.now();
		const conversationId = input.conversationId.trim();
		if (conversationId.length === 0) {
			throw new Error("A conversation is required to choose a sticker");
		}
		let item: StickerItem | undefined;
		let pack: StickerPack | undefined;
		let matchedBy: "query" | "fallback" = "query";
		let availablePacks: readonly AvailableStickerPack[] | undefined;

		if (input.itemId !== undefined) {
			item = await this.#repository.getItem(input.itemId);
			if (item !== undefined) pack = await this.#repository.getPack(item.packId);
		} else {
			const [best] = await this.search({ ...input, limit: 1 });
			if (best !== undefined) {
				item = await this.#repository.getItem(best.itemId);
				if (item !== undefined) pack = await this.#repository.getPack(item.packId);
			} else {
				matchedBy = "fallback";
				const fallbackCandidates =
					input.personaId !== undefined
						? await this.search({ limit: 1, personaId: input.personaId })
						: [];
				const fallbackBest = fallbackCandidates[0] ?? (await this.search({ limit: 1 }))[0];
				if (fallbackBest !== undefined) {
					item = await this.#repository.getItem(fallbackBest.itemId);
					if (item !== undefined) pack = await this.#repository.getPack(item.packId);
					availablePacks = await this.listAvailablePacks();
				}
			}
		}

		if (item === undefined || pack === undefined) {
			await this.#recordDenied(conversationId, "not_found", input.itemId);
			this.#logger?.debug("sticker choose failed", {
				durationMs: elapsedMs(startedAt),
				reason: "not_found",
			});
			throw new Error("No sticker candidate matched");
		}

		const denial = await this.#selectable(item, pack);
		if (denial !== undefined) {
			await this.#recordDenied(conversationId, denial, item.id);
			this.#logger?.debug("sticker send failed", {
				durationMs: elapsedMs(startedAt),
				itemId: item.id,
				reason: denial,
			});
			throw new Error(`Sticker is not selectable: ${denial}`);
		}
		await this.#repository.recordUse(item.id);

		return {
			...(availablePacks === undefined ? {} : { availablePacks }),
			item,
			matchedBy,
			pack,
		};
	}

	async #selectable(item: StickerItem, pack: StickerPack): Promise<string | undefined> {
		if (!pack.enabled) return "pack_disabled";
		if (!item.enabled) return "item_disabled";
		if (item.revokedAt !== null) return "item_revoked";
		if (item.reviewStatus !== "approved") return "item_not_approved";
		if (item.mediaId.length === 0) return "media_missing";
		const media = await this.#media.findById(item.mediaId);
		return media === undefined ? "media_missing" : undefined;
	}

	async #recordDenied(
		conversationId: string,
		reason: string,
		itemId: string | undefined,
	): Promise<void> {
		await this.#audit?.record({
			action: "sticker.token.denied",
			actorKind: "agent",
			payload: { conversationId, reason },
			reason,
			result: "denied",
			...(itemId === undefined ? {} : { targetId: itemId }),
			targetKind: "sticker-item",
		});
	}
}
