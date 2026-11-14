CREATE TABLE IF NOT EXISTS plugin_sticker_meme_send_tokens (
	token TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES plugin_sticker_meme_items(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL
);
