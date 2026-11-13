import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const STICKER_MEME_PLUGIN_ID = "sticker-meme";
export const STICKER_MEME_RPC_PREFIX = `${STICKER_MEME_PLUGIN_ID}.`;
export const STICKER_MEME_DIRECTIVE_PATTERN =
	/\[\[sticker:([A-Za-z0-9_-]+)\]\]|<sticker\s+token=["']([A-Za-z0-9_-]+)["']\s*\/?>/gu;

const MIGRATIONS = [
	{
		rollbackSql: "DROP TABLE IF EXISTS plugin_sticker_meme_packs;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_sticker_meme_packs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('builtin', 'imported', 'generated', 'learned')),
	enabled INTEGER NOT NULL DEFAULT 1,
	tags_json TEXT NOT NULL DEFAULT '[]',
	persona_ids_json TEXT NOT NULL DEFAULT '[]',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		version: "1",
	},
	{
		rollbackSql: "DROP TABLE IF EXISTS plugin_sticker_meme_items;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_sticker_meme_items (
	id TEXT PRIMARY KEY,
	pack_id TEXT NOT NULL REFERENCES plugin_sticker_meme_packs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	keywords_json TEXT NOT NULL DEFAULT '[]',
	emotions_json TEXT NOT NULL DEFAULT '[]',
	mime_type TEXT NOT NULL,
	media_id TEXT NOT NULL DEFAULT '',
	hash TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	enabled INTEGER NOT NULL DEFAULT 1,
	review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('approved', 'pending', 'rejected')),
	score REAL NOT NULL DEFAULT 1,
	use_count INTEGER NOT NULL DEFAULT 0,
	last_used_at TEXT,
	source_conversation_id TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		version: "2",
	},
	{
		rollbackSql: "DROP INDEX IF EXISTS plugin_sticker_meme_items_pack_idx;",
		sql: `CREATE INDEX IF NOT EXISTS plugin_sticker_meme_items_pack_idx
	ON plugin_sticker_meme_items(pack_id, review_status, enabled);`,
		version: "3",
	},
	{
		rollbackSql: "DROP INDEX IF EXISTS plugin_sticker_meme_items_hash_idx;",
		sql: `CREATE INDEX IF NOT EXISTS plugin_sticker_meme_items_hash_idx
	ON plugin_sticker_meme_items(hash);`,
		version: "4",
	},
	{
		rollbackSql: "DROP TABLE IF EXISTS plugin_sticker_meme_send_tokens;",
		sql: `CREATE TABLE IF NOT EXISTS plugin_sticker_meme_send_tokens (
	token TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES plugin_sticker_meme_items(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL
);`,
		version: "5",
	},
	{
		rollbackSql: "DROP INDEX IF EXISTS plugin_sticker_meme_send_tokens_item_idx;",
		sql: `CREATE INDEX IF NOT EXISTS plugin_sticker_meme_send_tokens_item_idx
	ON plugin_sticker_meme_send_tokens(item_id);`,
		version: "6",
	},
] as const;

export const stickerMemeManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: {
			learning: {
				properties: {
					allowGenerated: { type: "boolean" },
					dailyCap: { type: "integer" },
					duplicateThreshold: { type: "integer" },
					enabled: { type: "boolean" },
					retentionDays: { type: "integer" },
				},
				type: "object",
			},
			sendTokenTtlSeconds: { type: "integer" },
		},
		type: "object",
	},
	hooks: [{ name: "message.received" }, { name: "reply.transform" }],
	kind: "builtin",
	migrations: MIGRATIONS.map((migration) => ({ ...migration })),
	name: STICKER_MEME_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"media.read",
		"media.write",
		"storage.global",
		"channel.send",
		"conversation.read",
		"tools",
		"audit.write",
		"reply.transform",
	],
	version: "0.1.0",
});
