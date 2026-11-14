CREATE TABLE IF NOT EXISTS plugin_sticker_meme_packs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('builtin', 'imported', 'generated', 'learned')),
	enabled INTEGER NOT NULL DEFAULT 1,
	tags_json TEXT NOT NULL DEFAULT '[]',
	persona_ids_json TEXT NOT NULL DEFAULT '[]',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
