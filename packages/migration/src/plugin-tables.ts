import type { ElainaDatabase } from "@elaina/db";

type PluginDatabase = Pick<ElainaDatabase, "$client">;
import type { ImportedMemeItem, ImportedMemePack } from "./meme-import.ts";
import type { ImportedScheduledTask } from "./schedule-request-import.ts";
import type { ImportedSchedulerState } from "./memory-import.ts";

const STICKER_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS plugin_sticker_meme_items (
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
);
CREATE INDEX IF NOT EXISTS plugin_sticker_meme_items_pack_idx
	ON plugin_sticker_meme_items(pack_id, review_status, enabled);
CREATE INDEX IF NOT EXISTS plugin_sticker_meme_items_hash_idx
	ON plugin_sticker_meme_items(hash);
CREATE TABLE IF NOT EXISTS plugin_sticker_meme_send_tokens (
	token TEXT PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES plugin_sticker_meme_items(id) ON DELETE CASCADE,
	conversation_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_sticker_meme_send_tokens_item_idx
	ON plugin_sticker_meme_send_tokens(item_id);
`;

const PROACTIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_tasks (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL DEFAULT '',
	conversation_id TEXT NOT NULL,
	chat_object_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('remind', 'nudge', 'proactive', 'workflow')),
	prompt TEXT NOT NULL,
	scheduled_for_ms INTEGER NOT NULL,
	due_window_ms INTEGER,
	repeat_json TEXT NOT NULL DEFAULT 'null',
	cancel_if_replied INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	attempts INTEGER NOT NULL DEFAULT 0,
	occurrences INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled', 'failed', 'skipped')),
	last_error TEXT,
	created_by_kind TEXT NOT NULL,
	created_by_id TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_tasks_status_idx
	ON plugin_proactive_scheduler_tasks(status, scheduled_for_ms);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_tasks_conversation_idx
	ON plugin_proactive_scheduler_tasks(conversation_id, status);
CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_state (
	conversation_id TEXT PRIMARY KEY,
	last_message_at_ms INTEGER,
	last_inbound_at_ms INTEGER,
	last_outbound_at_ms INTEGER,
	inbound_count INTEGER NOT NULL DEFAULT 0,
	unanswered_streak INTEGER NOT NULL DEFAULT 0,
	refused_count INTEGER NOT NULL DEFAULT 0,
	silence_until_ms INTEGER,
	active_hours_histogram_json TEXT NOT NULL DEFAULT '{}',
	warmness REAL NOT NULL DEFAULT 0,
	openers_json TEXT NOT NULL DEFAULT '[]',
	daily_count_date TEXT,
	daily_count INTEGER NOT NULL DEFAULT 0,
	hourly_window_ms INTEGER,
	hourly_count INTEGER NOT NULL DEFAULT 0,
	updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_proactive_scheduler_decisions (
	id TEXT PRIMARY KEY,
	task_id TEXT,
	kind TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	gate_json TEXT NOT NULL DEFAULT '[]',
	gate_result TEXT NOT NULL,
	marker TEXT,
	delivery_status TEXT,
	skipped_reason TEXT,
	created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plugin_proactive_scheduler_decisions_conversation_idx
	ON plugin_proactive_scheduler_decisions(conversation_id, created_at_ms);
`;

export function ensureStickerMemeSchema(database: PluginDatabase): void {
	database.$client.exec(STICKER_SCHEMA);
}

export function ensureProactiveSchedulerSchema(database: PluginDatabase): void {
	database.$client.exec(PROACTIVE_SCHEMA);
}

export interface ImportedPluginWriteResult {
	readonly stickerItems: number;
	readonly stickerPacks: number;
	readonly tasks: number;
	readonly states: number;
}

export function insertStickerMemeData(
	database: PluginDatabase,
	input: {
		readonly packs: readonly ImportedMemePack[];
		readonly items: readonly ImportedMemeItem[];
		readonly now?: string;
	},
): ImportedPluginWriteResult {
	ensureStickerMemeSchema(database);
	const now = input.now ?? new Date().toISOString();
	const databaseHandle = database.$client;
	for (const pack of input.packs) {
		databaseHandle
			.query(
				`INSERT INTO plugin_sticker_meme_packs
				(id, name, source, enabled, tags_json, persona_ids_json, metadata_json, created_at, updated_at)
				VALUES (?, ?, 'imported', 0, ?, '[]', ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					source = excluded.source,
					enabled = 0,
					tags_json = excluded.tags_json,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at`,
			)
			.run(
				pack.id,
				pack.name,
				JSON.stringify(pack.tags),
				JSON.stringify({
					...pack.metadata,
					disabledUntilVerified: true,
					version: pack.version,
				}),
				now,
				now,
			);
	}
	for (const item of input.items) {
		databaseHandle
			.query(
				`INSERT INTO plugin_sticker_meme_items
				(id, pack_id, name, description, keywords_json, emotions_json, mime_type, media_id, hash,
				 width, height, enabled, review_status, score, use_count, last_used_at,
				 source_conversation_id, revoked_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'pending', 1, 0, NULL, NULL, NULL, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					pack_id = excluded.pack_id,
					name = excluded.name,
					description = excluded.description,
					keywords_json = excluded.keywords_json,
					emotions_json = excluded.emotions_json,
					mime_type = excluded.mime_type,
					media_id = excluded.media_id,
					hash = excluded.hash,
					enabled = 0,
					review_status = 'pending',
					updated_at = excluded.updated_at`,
			)
			.run(
				item.id,
				item.packId,
				item.name,
				item.description,
				JSON.stringify(item.keywords),
				JSON.stringify(item.emotions),
				item.mimeType,
				item.mediaId,
				item.fileHash ?? "",
				now,
				now,
			);
	}
	return {
		stickerItems: input.items.length,
		stickerPacks: input.packs.length,
		states: 0,
		tasks: 0,
	};
}

export function insertProactiveSchedulerData(
	database: PluginDatabase,
	input: {
		readonly tasks: readonly ImportedScheduledTask[];
		readonly states: readonly ImportedSchedulerState[];
	},
): ImportedPluginWriteResult {
	ensureProactiveSchedulerSchema(database);
	const databaseHandle = database.$client;
	for (const task of input.tasks) {
		databaseHandle
			.query(
				`INSERT INTO plugin_proactive_scheduler_tasks
				(id, task_id, conversation_id, chat_object_id, kind, prompt, scheduled_for_ms,
				 due_window_ms, repeat_json, cancel_if_replied, max_attempts, attempts, occurrences,
				 status, last_error, created_by_kind, created_by_id, created_at_ms, updated_at_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					task_id = excluded.task_id,
					status = excluded.status,
					attempts = excluded.attempts,
					occurrences = excluded.occurrences,
					last_error = excluded.last_error,
					scheduled_for_ms = excluded.scheduled_for_ms,
					updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				task.id,
				task.taskId,
				task.conversationId,
				task.chatObjectId,
				task.kind,
				task.prompt,
				task.scheduledForMs,
				task.dueWindowMs,
				task.repeatIntervalMs === null
					? "null"
					: JSON.stringify({ intervalMs: task.repeatIntervalMs }),
				task.cancelIfReplied ? 1 : 0,
				task.maxAttempts,
				task.attempts,
				task.occurrences,
				task.status,
				task.lastError,
				task.createdByKind,
				task.createdById,
				task.createdAtMs,
				task.updatedAtMs,
			);
	}
	for (const state of input.states) {
		databaseHandle
			.query(
				`INSERT INTO plugin_proactive_scheduler_state
				(conversation_id, last_message_at_ms, last_inbound_at_ms, last_outbound_at_ms,
				 inbound_count, unanswered_streak, refused_count, silence_until_ms,
				 active_hours_histogram_json, warmness, openers_json, daily_count_date,
				 daily_count, hourly_window_ms, hourly_count, updated_at_ms)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(conversation_id) DO UPDATE SET
					last_message_at_ms = excluded.last_message_at_ms,
					last_inbound_at_ms = excluded.last_inbound_at_ms,
					last_outbound_at_ms = excluded.last_outbound_at_ms,
					inbound_count = excluded.inbound_count,
					unanswered_streak = excluded.unanswered_streak,
					refused_count = excluded.refused_count,
					silence_until_ms = excluded.silence_until_ms,
					active_hours_histogram_json = excluded.active_hours_histogram_json,
					warmness = excluded.warmness,
					openers_json = excluded.openers_json,
					daily_count_date = excluded.daily_count_date,
					daily_count = excluded.daily_count,
					hourly_window_ms = excluded.hourly_window_ms,
					hourly_count = excluded.hourly_count,
					updated_at_ms = excluded.updated_at_ms`,
			)
			.run(
				state.conversationId,
				state.lastMessageAtMs,
				state.lastInboundAtMs,
				state.lastOutboundAtMs,
				state.inboundCount,
				state.unansweredStreak,
				state.refusedCount,
				state.silenceUntilMs,
				JSON.stringify(state.activeHoursHistogram),
				state.warmness,
				JSON.stringify(state.openers),
				state.dailyCountDate,
				state.dailyCount,
				state.hourlyWindowMs,
				state.hourlyCount,
				state.updatedAtMs,
			);
	}
	return {
		stickerItems: 0,
		stickerPacks: 0,
		states: input.states.length,
		tasks: input.tasks.length,
	};
}
