import { pluginManifestSchema, type PluginManifest } from "@elaina/sdk/manifest";

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
	{
		rollbackSql: "ALTER TABLE plugin_sticker_meme_items DROP COLUMN semantic_json;",
		sql: `ALTER TABLE plugin_sticker_meme_items
	ADD COLUMN semantic_json TEXT NOT NULL DEFAULT '{}';`,
		version: "7",
	},
] as const;

export const stickerMemeManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		semanticApiKey: "ELAINA_SEMANTIC_API_KEY",
		semanticBaseUrl: "ELAINA_SEMANTIC_BASE_URL",
		semanticModel: "ELAINA_SEMANTIC_MODEL",
		semanticProviderId: "ELAINA_SEMANTIC_PROVIDER_ID",
		telegramApiBaseUrl: "ELAINA_TELEGRAM_API_BASE_URL",
		telegramBotToken: "ELAINA_TELEGRAM_BOT_TOKEN",
	},
	configSchema: {
		properties: {
			importConcurrency: {
				description:
					"Parallel workers for media import (download, convert, dedupe, store). Higher values import faster.",
				title: "Import concurrency",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
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
			semanticApiKey: {
				description: "Secret API key for the optional OpenAI-compatible vision classifier.",
				title: "Semantic model API key",
				type: "string",
			},
			semanticBaseUrl: {
				description:
					"Base URL for the vision model endpoint, for example https://api.openai.com/v1.",
				title: "Semantic model base URL",
				type: "string",
			},
			semanticConcurrency: {
				description:
					"Parallel workers for semantic classification. Runs concurrently with media import.",
				title: "Semantic concurrency",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
			semanticMaxLabels: {
				description: "Maximum semantic labels stored per sticker.",
				title: "Semantic labels per sticker",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
			semanticMode: {
				description:
					"heuristic uses emoji/title only; auto uses a configured vision or selected model when available; vision requires a configured model.",
				enum: ["heuristic", "auto", "vision"],
				title: "Semantic classifier mode",
				type: "string",
			},
			semanticModel: {
				description:
					"Model id for semantic classification, from a host provider or custom endpoint.",
				title: "Semantic model",
				type: "string",
			},
			semanticProviderId: {
				description:
					"Host model provider id, for example openai-compatible. Leave empty to auto-select or use custom endpoint credentials.",
				title: "Semantic model provider",
				type: "string",
			},
			semanticTimeoutSeconds: {
				description: "Vision model request timeout in seconds.",
				title: "Semantic model timeout",
				maximum: 300,
				minimum: 5,
				type: "integer",
			},
			sendTokenTtlSeconds: { type: "integer" },
			telegramAnimatedFormat: {
				description:
					"gif renders animated Telegram TGS stickers to GIF; thumbnail keeps a still image.",
				enum: ["gif", "thumbnail"],
				title: "Animated sticker format",
				type: "string",
			},
			telegramAnimatedFps: {
				description: "GIF frame rate for animated/video Telegram stickers.",
				title: "Animated GIF FPS",
				maximum: 30,
				minimum: 1,
				type: "integer",
			},
			telegramAnimatedMaxFrames: {
				description:
					"Maximum GIF frames per sticker. Lower values import faster and produce smaller files.",
				title: "Animated GIF max frames",
				maximum: 120,
				minimum: 1,
				type: "integer",
			},
			telegramApiBaseUrl: {
				description: "Optional Telegram Bot API root. Leave empty for https://api.telegram.org.",
				title: "Telegram API base URL",
				type: "string",
			},
			telegramBotToken: {
				description:
					"Bot token from @BotFather. Stored as a secret and used only for sticker imports.",
				title: "Telegram bot token",
				type: "string",
			},
			telegramIncludeAnimated: {
				description: "Import TGS animated stickers.",
				title: "Include animated stickers",
				type: "boolean",
			},
			telegramIncludeVideo: {
				description: "Import Telegram video stickers.",
				title: "Include video stickers",
				type: "boolean",
			},
			telegramMaxStickers: {
				description: "Maximum stickers imported from one Telegram set.",
				title: "Telegram import limit",
				maximum: 200,
				minimum: 1,
				type: "integer",
			},
			telegramVideoFormat: {
				description:
					"gif uses ffmpeg when available and falls back to webm; webm keeps the original video; thumbnail uses a still image.",
				enum: ["gif", "thumbnail", "webm"],
				title: "Video sticker format",
				type: "string",
			},
		},
		type: "object",
	},
	hooks: [{ name: "message.received" }, { name: "reply.transform" }],
	kind: "builtin",
	migrations: MIGRATIONS.map((migration) => ({ ...migration })),
	name: STICKER_MEME_PLUGIN_ID,
	secretKeys: ["semanticApiKey", "telegramBotToken"],
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
