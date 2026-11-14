CREATE INDEX IF NOT EXISTS plugin_sticker_meme_items_pack_idx
	ON plugin_sticker_meme_items(pack_id, review_status, enabled);
