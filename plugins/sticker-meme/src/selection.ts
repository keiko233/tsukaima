import { randomUUID } from "node:crypto";
import type { AuditEntry, PluginLogger, PluginMediaApi } from "@tsukaima/sdk";
import { normalizeLabel, sanitizeModelText } from "./domain.ts";
import type { StickerItem, StickerPack } from "./domain.ts";
import type { StickerRepository } from "./repository.ts";

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
	readonly personaIds: readonly string[];
	readonly reviewStatus: string;
	readonly score: number;
	readonly tags: readonly string[];
	readonly useCount: number;
	readonly width: number | null;
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
	readonly logger?: PluginLogger;
	readonly media: PluginMediaApi;
	readonly now?: () => number;
	readonly repository: StickerRepository;
	readonly tokenTtlMs?: number;
}

const MAX_SEARCH_LIMIT = 25;
const RECENT_COOLDOWN_MS = 5 * 60_000;

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
		personaIds: [...pack.personaIds],
		reviewStatus: item.reviewStatus,
		score: item.score,
		tags: [...pack.tags],
		useCount: item.useCount,
		width: item.width,
	};
}

function textMatches(item: StickerItem, query: string): boolean {
	const normalizedQuery = normalizeLabel(query);
	if (normalizedQuery.length === 0) return true;
	const haystacks = [
		normalizeLabel(item.name),
		normalizeLabel(item.description),
		normalizeLabel(item.semantic.description),
		...item.keywords.map(normalizeLabel),
		...item.semantic.labels.map(normalizeLabel),
	];
	return haystacks.some((value) => value.includes(normalizedQuery));
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
	const query = normalizeLabel(input.query ?? "");
	if (!textMatches(item, query)) return undefined;
	const emotion = normalizeLabel(input.emotion ?? "");
	if (emotion.length > 0 && !item.emotions.some((value) => value === emotion)) {
		return undefined;
	}
	if (input.packId !== undefined && item.packId !== input.packId) return undefined;
	if (input.personaId !== undefined && pack.personaIds.length > 0) {
		if (!pack.personaIds.includes(input.personaId)) return undefined;
	}
	const tags = (input.tags ?? []).map(normalizeLabel).filter(Boolean);
	if (tags.length > 0 && !tags.every((tag) => pack.tags.includes(tag))) return undefined;

	let score = item.score;
	if (query.length > 0) {
		const name = normalizeLabel(item.name);
		if (name === query) score += 120;
		else if (name.includes(query)) score += 60;
		const keywordScores = item.keywords.map(normalizeLabel);
		if (keywordScores.includes(query)) score += 100;
		else if (keywordScores.some((keyword) => keyword.includes(query))) score += 45;
		const semanticScores = item.semantic.labels.map(normalizeLabel);
		if (semanticScores.includes(query)) score += 80;
		else if (semanticScores.some((label) => label.includes(query))) score += 35;
		if (normalizeLabel(item.description).includes(query)) score += 20;
		if (normalizeLabel(item.semantic.description).includes(query)) score += 18;
	}
	if (emotion.length > 0) score += 40;
	if (input.personaId !== undefined) {
		score += pack.personaIds.includes(input.personaId) ? 25 : 5;
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
		const packs = new Map((await this.#repository.listPacks()).map((pack) => [pack.id, pack]));
		const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, input.limit ?? 8));
		const ranked: { candidate: StickerCandidate; score: number }[] = [];
		for (const item of await this.#repository.listItems(input.packId)) {
			const pack = packs.get(item.packId);
			if (pack === undefined || !pack.enabled) continue;
			if (!item.enabled || item.revokedAt !== null || item.reviewStatus !== "approved") continue;
			if (item.mediaId.length === 0) continue;
			const media = await this.#media.findById(item.mediaId);
			if (media === undefined) continue;
			const score = rankStickerItem(item, pack, input, this.#now());
			if (score === undefined) continue;
			ranked.push({ candidate: candidate(item, pack), score });
		}
		return ranked
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
	}

	async choose(
		input: StickerSearchInput & { readonly itemId?: string; readonly conversationId?: string },
	): Promise<StickerChooseResult> {
		const conversationId = input.conversationId?.trim();
		if (conversationId === undefined || conversationId.length === 0) {
			throw new Error("A conversation is required to choose a sticker");
		}
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
			throw new Error("No sticker candidate matched");
		}
		const denial = await this.#selectable(item, pack);
		if (denial !== undefined) {
			await this.#recordDenied(conversationId, denial, item.id);
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
			expiresAt,
			itemId: item.id,
		});
		return {
			conversationId,
			directive: `[[sticker:${token}]]`,
			expiresAt,
			itemId: item.id,
			sendToken: token,
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
