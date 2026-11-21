import type { PluginDatabaseApi } from "@tsukaima/sdk";
import {
	EMPTY_SEMANTIC_PROFILE,
	normalizeLabels,
	normalizeText,
	parseJson,
	parseSemanticProfile,
	stableId,
	type StickerItem,
	type StickerPack,
	type StickerPackInput,
	type StickerPackSource,
	type StickerReviewStatus,
	type StickerSemanticProfile,
} from "./domain.ts";

interface PackRow {
	created_at: string;
	enabled: number;
	id: string;
	metadata_json: string;
	name: string;
	persona_ids_json: string;
	source: StickerPackSource;
	tags_json: string;
	updated_at: string;
}

interface ItemRow {
	created_at: string;
	description: string;
	emotions_json: string;
	enabled: number;
	hash: string;
	height: number | null;
	id: string;
	keywords_json: string;
	last_used_at: string | null;
	media_id: string;
	mime_type: string;
	name: string;
	pack_id: string;
	review_status: StickerReviewStatus;
	revoked_at: string | null;
	score: number;
	semantic_json: string;
	source_conversation_id: string | null;
	updated_at: string;
	use_count: number;
	width: number | null;
}

interface TokenRow {
	conversation_id: string;
	expires_at: string;
	item_id: string;
	token: string;
	used_at: string | null;
}

export interface StickerItemInput {
	readonly id?: string;
	readonly packId: string;
	readonly name: string;
	readonly description?: string;
	readonly keywords?: readonly string[];
	readonly emotions?: readonly string[];
	readonly mimeType: string;
	readonly mediaId?: string;
	readonly hash: string;
	readonly width?: number | null;
	readonly height?: number | null;
	readonly enabled?: boolean;
	readonly reviewStatus?: StickerReviewStatus;
	readonly score?: number;
	readonly semantic?: StickerSemanticProfile;
	readonly sourceConversationId?: string | null;
	readonly revokedAt?: string | null;
}

export interface StickerItemPatch {
	readonly name?: string;
	readonly description?: string;
	readonly keywords?: readonly string[];
	readonly emotions?: readonly string[];
	readonly enabled?: boolean;
	readonly reviewStatus?: StickerReviewStatus;
	readonly score?: number;
	readonly semantic?: StickerSemanticProfile;
	readonly revokedAt?: string | null;
}

export interface TokenConsumeResult {
	readonly itemId?: string;
	readonly failure?: "expired" | "unknown" | "used" | "wrong_conversation";
}

const packFromRow = (row: PackRow): StickerPack => ({
	createdAt: row.created_at,
	enabled: row.enabled === 1,
	id: row.id,
	metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
	name: row.name,
	personaIds: parseJson<string[]>(row.persona_ids_json, []),
	source: row.source,
	tags: parseJson<string[]>(row.tags_json, []),
	updatedAt: row.updated_at,
});

const itemFromRow = (row: ItemRow): StickerItem => ({
	createdAt: row.created_at,
	description: row.description,
	emotions: parseJson<string[]>(row.emotions_json, []),
	enabled: row.enabled === 1,
	hash: row.hash,
	height: row.height,
	id: row.id,
	keywords: parseJson<string[]>(row.keywords_json, []),
	lastUsedAt: row.last_used_at,
	mediaId: row.media_id,
	mimeType: row.mime_type,
	name: row.name,
	packId: row.pack_id,
	reviewStatus: row.review_status,
	revokedAt: row.revoked_at,
	score: row.score,
	semantic: parseSemanticProfile(parseJson<unknown>(row.semantic_json, EMPTY_SEMANTIC_PROFILE)),
	sourceConversationId: row.source_conversation_id,
	updatedAt: row.updated_at,
	useCount: row.use_count,
	width: row.width,
});

/** SQL repository for the plugin-owned `plugin_sticker_meme_*` schema. */
export class StickerRepository {
	readonly #database: PluginDatabaseApi;
	readonly #now: () => number;

	constructor(database: PluginDatabaseApi, options: { readonly now?: () => number } = {}) {
		this.#database = database;
		this.#now = options.now ?? Date.now;
	}

	async listPacks(): Promise<readonly StickerPack[]> {
		const rows = await this.#database.query<PackRow>(
			"SELECT * FROM plugin_sticker_meme_packs ORDER BY name COLLATE NOCASE, id",
		);
		return rows.map(packFromRow);
	}

	async getPack(id: string): Promise<StickerPack | undefined> {
		const [row] = await this.#database.query<PackRow>(
			"SELECT * FROM plugin_sticker_meme_packs WHERE id = ? LIMIT 1",
			[id],
		);
		return row === undefined ? undefined : packFromRow(row);
	}

	async savePack(input: StickerPackInput): Promise<StickerPack> {
		const existing = input.id === undefined ? undefined : await this.getPack(input.id);
		const now = new Date(this.#now()).toISOString();
		const id = existing?.id ?? input.id ?? stableId("pack", `${normalizeText(input.name)}:${now}`);
		const tags = normalizeLabels(input.tags ?? existing?.tags).values;
		const personaIds = normalizeLabels(input.personaIds ?? existing?.personaIds).values;
		const metadata = input.metadata ?? existing?.metadata ?? {};
		const source = input.source ?? existing?.source ?? "imported";
		const enabled = input.enabled ?? existing?.enabled ?? true;
		if (existing === undefined) {
			await this.#database.query(
				`INSERT INTO plugin_sticker_meme_packs
				(id, name, source, enabled, tags_json, persona_ids_json, metadata_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					normalizeText(input.name, id),
					source,
					enabled ? 1 : 0,
					JSON.stringify(tags),
					JSON.stringify(personaIds),
					JSON.stringify(metadata),
					now,
					now,
				],
			);
		} else {
			await this.#database.query(
				`UPDATE plugin_sticker_meme_packs SET
					name = ?, source = ?, enabled = ?, tags_json = ?, persona_ids_json = ?,
					metadata_json = ?, updated_at = ?
				WHERE id = ?`,
				[
					normalizeText(input.name, existing.name),
					source,
					enabled ? 1 : 0,
					JSON.stringify(tags),
					JSON.stringify(personaIds),
					JSON.stringify(metadata),
					now,
					id,
				],
			);
		}
		const stored = await this.getPack(id);
		if (stored === undefined) throw new Error("Failed to persist sticker pack");
		return stored;
	}

	async togglePack(id: string, enabled: boolean): Promise<StickerPack | undefined> {
		await this.#database.query(
			"UPDATE plugin_sticker_meme_packs SET enabled = ?, updated_at = ? WHERE id = ?",
			[enabled ? 1 : 0, new Date(this.#now()).toISOString(), id],
		);
		return await this.getPack(id);
	}

	async deletePack(id: string): Promise<void> {
		await this.#database.query(
			`DELETE FROM plugin_sticker_meme_send_tokens
			WHERE item_id IN (SELECT id FROM plugin_sticker_meme_items WHERE pack_id = ?)`,
			[id],
		);
		await this.#database.query("DELETE FROM plugin_sticker_meme_items WHERE pack_id = ?", [id]);
		await this.#database.query("DELETE FROM plugin_sticker_meme_packs WHERE id = ?", [id]);
	}

	/**
	 * Bounded ready-to-copy captions for the ephemeral chat context. Only approved, enabled items
	 * backed by real media are eligible, and the query is capped so prompt rendering stays cheap.
	 */
	async listCaptionHints(limit = 3): Promise<
		readonly {
			readonly caption: string;
			readonly id: string;
			readonly name: string;
			readonly packId: string;
		}[]
	> {
		const bounded = Math.max(1, Math.min(10, Math.floor(limit)));
		const rows = await this.#database.query<{
			caption: string;
			id: string;
			name: string;
			pack_id: string;
		}>(
			`SELECT i.id AS id, i.name AS name, i.pack_id AS pack_id,
				COALESCE(NULLIF(TRIM(i.name), ''), NULLIF(TRIM(i.description), '')) AS caption
			FROM plugin_sticker_meme_items i
			INNER JOIN plugin_sticker_meme_packs p ON p.id = i.pack_id
			WHERE i.enabled = 1
				AND i.revoked_at IS NULL
				AND i.review_status = 'approved'
				AND i.media_id <> ''
				AND p.enabled = 1
				AND COALESCE(NULLIF(TRIM(i.name), ''), NULLIF(TRIM(i.description), '')) <> ''
			ORDER BY i.score DESC, i.use_count ASC, i.name COLLATE NOCASE, i.id
			LIMIT ?`,
			[bounded],
		);
		return rows.map((row) => ({
			caption: row.caption,
			id: row.id,
			name: row.name,
			packId: row.pack_id,
		}));
	}

	async listItems(packId?: string): Promise<readonly StickerItem[]> {
		const rows =
			packId === undefined
				? await this.#database.query<ItemRow>(
						"SELECT * FROM plugin_sticker_meme_items ORDER BY created_at DESC, id",
					)
				: await this.#database.query<ItemRow>(
						"SELECT * FROM plugin_sticker_meme_items WHERE pack_id = ? ORDER BY created_at DESC, id",
						[packId],
					);
		return rows.map(itemFromRow);
	}

	async getItem(id: string): Promise<StickerItem | undefined> {
		const [row] = await this.#database.query<ItemRow>(
			"SELECT * FROM plugin_sticker_meme_items WHERE id = ? LIMIT 1",
			[id],
		);
		return row === undefined ? undefined : itemFromRow(row);
	}

	async findItemsByHash(hash: string): Promise<readonly StickerItem[]> {
		const rows = await this.#database.query<ItemRow>(
			"SELECT * FROM plugin_sticker_meme_items WHERE hash = ? ORDER BY created_at",
			[hash],
		);
		return rows.map(itemFromRow);
	}

	async upsertItem(input: StickerItemInput): Promise<StickerItem> {
		const now = new Date(this.#now()).toISOString();
		const id =
			input.id ??
			stableId("item", `${input.packId}:${input.name}:${input.hash}:${input.mediaId ?? ""}`);
		const keywords = normalizeLabels(input.keywords).values;
		const emotions = normalizeLabels(input.emotions).values;
		const semantic = input.semantic ?? EMPTY_SEMANTIC_PROFILE;
		await this.#database.query(
			`INSERT INTO plugin_sticker_meme_items
			(id, pack_id, name, description, keywords_json, emotions_json, mime_type, media_id, hash,
			 width, height, enabled, review_status, score, semantic_json, use_count, last_used_at,
			 source_conversation_id, revoked_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				pack_id = excluded.pack_id,
				name = excluded.name,
				description = excluded.description,
				keywords_json = excluded.keywords_json,
				emotions_json = excluded.emotions_json,
				mime_type = excluded.mime_type,
				media_id = excluded.media_id,
				hash = excluded.hash,
				width = excluded.width,
				height = excluded.height,
				enabled = excluded.enabled,
				review_status = excluded.review_status,
				score = excluded.score,
				semantic_json = excluded.semantic_json,
				source_conversation_id = excluded.source_conversation_id,
				revoked_at = excluded.revoked_at,
				updated_at = excluded.updated_at`,
			[
				id,
				input.packId,
				input.name,
				input.description ?? "",
				JSON.stringify(keywords),
				JSON.stringify(emotions),
				input.mimeType,
				input.mediaId ?? "",
				input.hash,
				input.width ?? null,
				input.height ?? null,
				input.enabled === false ? 0 : 1,
				input.reviewStatus ?? "pending",
				input.score ?? 1,
				JSON.stringify(semantic),
				input.sourceConversationId ?? null,
				input.revokedAt ?? null,
				now,
				now,
			],
		);
		const stored = await this.getItem(id);
		if (stored === undefined) throw new Error("Failed to persist sticker item");
		return stored;
	}

	async updateItem(id: string, patch: StickerItemPatch): Promise<StickerItem | undefined> {
		const existing = await this.getItem(id);
		if (existing === undefined) return undefined;
		const keywords =
			patch.keywords === undefined ? existing.keywords : normalizeLabels(patch.keywords).values;
		const emotions =
			patch.emotions === undefined ? existing.emotions : normalizeLabels(patch.emotions).values;
		const semantic = patch.semantic ?? existing.semantic;
		await this.#database.query(
			`UPDATE plugin_sticker_meme_items SET
				name = ?, description = ?, keywords_json = ?, emotions_json = ?, enabled = ?,
				review_status = ?, score = ?, semantic_json = ?, revoked_at = ?, updated_at = ?
			WHERE id = ?`,
			[
				patch.name ?? existing.name,
				patch.description ?? existing.description,
				JSON.stringify(keywords),
				JSON.stringify(emotions),
				(patch.enabled ?? existing.enabled) ? 1 : 0,
				patch.reviewStatus ?? existing.reviewStatus,
				patch.score ?? existing.score,
				JSON.stringify(semantic),
				patch.revokedAt === undefined ? existing.revokedAt : patch.revokedAt,
				new Date(this.#now()).toISOString(),
				id,
			],
		);
		return await this.getItem(id);
	}

	async deleteItem(id: string): Promise<void> {
		await this.#database.query("DELETE FROM plugin_sticker_meme_send_tokens WHERE item_id = ?", [
			id,
		]);
		await this.#database.query("DELETE FROM plugin_sticker_meme_items WHERE id = ?", [id]);
	}

	async purgeExpiredCandidates(beforeIso: string): Promise<number> {
		const rows = await this.#database.query<{ id: string }>(
			`SELECT id FROM plugin_sticker_meme_items
			WHERE review_status = 'pending' AND created_at < ?`,
			[beforeIso],
		);
		for (const row of rows) await this.deleteItem(row.id);
		return rows.length;
	}

	async countItemsSince(sinceIso: string): Promise<number> {
		const [row] = await this.#database.query<{ count: number }>(
			"SELECT COUNT(*) AS count FROM plugin_sticker_meme_items WHERE created_at >= ?",
			[sinceIso],
		);
		return Number(row?.count ?? 0);
	}

	async stats(): Promise<{
		readonly approved: number;
		readonly items: number;
		readonly packs: number;
		readonly pending: number;
		readonly rejected: number;
		readonly revoked: number;
		readonly sends: number;
		readonly usage: number;
	}> {
		const [itemRow] = await this.#database.query<{
			approved: number;
			items: number;
			pending: number;
			rejected: number;
			revoked: number;
			usage: number;
		}>(
			`SELECT COUNT(*) AS items,
				SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved,
				SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
				SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
				SUM(use_count) AS usage
			FROM plugin_sticker_meme_items`,
		);
		const [packRow] = await this.#database.query<{ packs: number }>(
			"SELECT COUNT(*) AS packs FROM plugin_sticker_meme_packs",
		);
		const [tokenRow] = await this.#database.query<{ sends: number }>(
			"SELECT COUNT(*) AS sends FROM plugin_sticker_meme_send_tokens WHERE used_at IS NOT NULL",
		);
		return {
			approved: Number(itemRow?.approved ?? 0),
			items: Number(itemRow?.items ?? 0),
			packs: Number(packRow?.packs ?? 0),
			pending: Number(itemRow?.pending ?? 0),
			rejected: Number(itemRow?.rejected ?? 0),
			revoked: Number(itemRow?.revoked ?? 0),
			sends: Number(tokenRow?.sends ?? 0),
			usage: Number(itemRow?.usage ?? 0),
		};
	}

	async insertToken(input: {
		readonly conversationId: string;
		readonly expiresAt: string;
		readonly itemId: string;
		readonly token: string;
	}): Promise<void> {
		await this.#database.query(
			`INSERT INTO plugin_sticker_meme_send_tokens
			(token, item_id, conversation_id, expires_at, used_at, created_at)
			VALUES (?, ?, ?, ?, NULL, ?)`,
			[
				input.token,
				input.itemId,
				input.conversationId,
				input.expiresAt,
				new Date(this.#now()).toISOString(),
			],
		);
	}

	async consumeToken(token: string, conversationId: string): Promise<TokenConsumeResult> {
		const [existing] = await this.#database.query<TokenRow>(
			"SELECT * FROM plugin_sticker_meme_send_tokens WHERE token = ? LIMIT 1",
			[token],
		);
		if (existing === undefined) return { failure: "unknown" };
		if (existing.conversation_id !== conversationId) return { failure: "wrong_conversation" };
		if (existing.used_at !== null) return { failure: "used" };
		const nowIso = new Date(this.#now()).toISOString();
		if (existing.expires_at <= nowIso) return { failure: "expired" };
		const updated = await this.#database.query<{ item_id: string }>(
			`UPDATE plugin_sticker_meme_send_tokens SET used_at = ?
			WHERE token = ? AND conversation_id = ? AND used_at IS NULL AND expires_at > ?
			RETURNING item_id`,
			[nowIso, token, conversationId, nowIso],
		);
		const itemId = updated[0]?.item_id;
		if (itemId === undefined) return { failure: "used" };
		await this.#database.query(
			`UPDATE plugin_sticker_meme_items SET
				use_count = use_count + 1, last_used_at = ?, updated_at = ?
			WHERE id = ?`,
			[nowIso, nowIso, itemId],
		);
		return { itemId };
	}

	async recordUse(itemId: string): Promise<void> {
		const nowIso = new Date(this.#now()).toISOString();
		await this.#database.query(
			`UPDATE plugin_sticker_meme_items SET
				use_count = use_count + 1, last_used_at = ?, updated_at = ?
			WHERE id = ?`,
			[nowIso, nowIso, itemId],
		);
	}

	async getToken(token: string): Promise<
		| {
				readonly conversationId: string;
				readonly expiresAt: string;
				readonly itemId: string;
				readonly usedAt: string | null;
		  }
		| undefined
	> {
		const [row] = await this.#database.query<TokenRow>(
			"SELECT * FROM plugin_sticker_meme_send_tokens WHERE token = ? LIMIT 1",
			[token],
		);
		return row === undefined
			? undefined
			: {
					conversationId: row.conversation_id,
					expiresAt: row.expires_at,
					itemId: row.item_id,
					usedAt: row.used_at,
				};
	}

	async countTokens(): Promise<number> {
		const [row] = await this.#database.query<{ count: number }>(
			"SELECT COUNT(*) AS count FROM plugin_sticker_meme_send_tokens",
		);
		return Number(row?.count ?? 0);
	}
}
