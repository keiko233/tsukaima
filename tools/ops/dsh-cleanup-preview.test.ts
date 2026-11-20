import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDshCleanup } from "./dsh-cleanup-preview.ts";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

test("previews deterministic DSH cleanup candidates without exposing row data", () => {
	const directory = mkdtempSync(join(tmpdir(), "tsukaima-dsh-cleanup-preview-"));
	const databasePath = join(directory, "domain.sqlite");
	try {
		const database = new Database(databasePath);
		try {
			database.exec(`
				CREATE TABLE chat_objects (id TEXT PRIMARY KEY);
				CREATE TABLE conversations (
					id TEXT PRIMARY KEY,
					kind TEXT NOT NULL,
					channel_id TEXT,
					status TEXT NOT NULL,
					title TEXT,
					created_at TEXT NOT NULL
				);
				CREATE TABLE messages (
					id TEXT PRIMARY KEY,
					conversation_id TEXT NOT NULL,
					kind TEXT NOT NULL,
					direction TEXT NOT NULL DEFAULT 'outbound',
					occurred_at TEXT NOT NULL,
					platform_message_id TEXT,
					raw_ref_json TEXT,
					reply_to_message_id TEXT
				);
				CREATE TABLE memories (
					id TEXT PRIMARY KEY,
					scope TEXT NOT NULL,
					kind TEXT NOT NULL,
					status TEXT NOT NULL,
					visibility TEXT NOT NULL,
					pinned INTEGER NOT NULL DEFAULT 0,
					conversation_id TEXT,
					source_message_id TEXT,
					content TEXT NOT NULL,
					summary TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
				CREATE TABLE migration_records (
					source_system TEXT NOT NULL,
					status TEXT NOT NULL,
					target_kind TEXT NOT NULL,
					target_id TEXT NOT NULL,
					source_id TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
			database.exec(`
				INSERT INTO chat_objects VALUES
					('chat-webui'), ('chat-task'), ('chat-test-user'), ('chat-test-empty'), ('chat-group');
				INSERT INTO conversations (id, kind, channel_id, status, title, created_at) VALUES
					('conversation-webui', 'webui', 'webui', 'active', 'Synthetic work', '2026-01-01T00:00:00.000Z'),
					('conversation-task', 'task', 'dsh', 'active', 'Synthetic task', '1970-01-01T00:00:00.000Z'),
					('conversation-test-user', 'webui', 'webui', 'active', 'Test user dialogue', '2026-01-02T00:00:00.000Z'),
					('conversation-test-empty', 'webui', 'webui', 'active', 'Test empty dialogue', '2026-01-03T00:00:00.000Z'),
					('conversation-group', 'group', 'onebot', 'active', 'Synthetic group', '2026-01-04T00:00:00.000Z');
			`);
			database.exec(`
				INSERT INTO messages
					(id, conversation_id, kind, occurred_at, platform_message_id, raw_ref_json, reply_to_message_id)
				VALUES
					('message-user', 'conversation-webui', 'user', '2026-02-01T12:00:00.000Z', 'platform-user', '{"sourceHash":"synthetic"}', NULL),
					('message-tool-auto', 'conversation-webui', 'tool', '1970-01-01T00:00:00.000Z', 'platform-tool-auto', '{"sourceHash":"synthetic"}', NULL),
					('message-tool-referenced', 'conversation-webui', 'tool', '2026-02-01T12:01:00.000Z', 'platform-tool-ref', '{"sourceHash":"synthetic"}', NULL),
					('message-tool-reply', 'conversation-webui', 'user', '2026-02-01T12:02:00.000Z', 'platform-reply', '{"sourceHash":"synthetic"}', 'platform-tool-ref'),
					('message-future', 'conversation-webui', 'user', '2099-01-01T00:00:00.000Z', 'platform-future', '{"sourceHash":"synthetic"}', NULL),
					('message-invalid', 'conversation-webui', 'user', 'not-a-timestamp', 'platform-invalid', '{"sourceHash":"synthetic"}', NULL),
					('message-no-hash', 'conversation-webui', 'assistant', '2026-02-01T12:03:00.000Z', 'platform-no-hash', '{}', NULL),
					('message-tool-group', 'conversation-group', 'tool', '2026-02-02T12:00:00.000Z', 'platform-tool-group', '{"sourceHash":"synthetic"}', NULL),
					('message-test-user', 'conversation-test-user', 'user', '2026-02-03T12:00:00.000Z', 'platform-test-user', '{"sourceHash":"synthetic"}', NULL),
					('message-test-empty', 'conversation-test-empty', 'assistant', '2026-02-04T12:00:00.000Z', 'platform-test-empty', '{"sourceHash":"synthetic"}', NULL),
					('message-tool-task', 'conversation-task', 'tool', '2026-02-05T12:00:00.000Z', 'platform-tool-task', '{"sourceHash":"synthetic"}', NULL),
					('message-unimported-tool', 'conversation-webui', 'tool', '2026-02-06T12:00:00.000Z', 'platform-unimported', '{"sourceHash":"synthetic"}', NULL);
				UPDATE messages SET direction = 'inbound' WHERE kind = 'user';
			`);
			database.exec(`
				INSERT INTO memories
					(id, scope, kind, status, visibility, pinned, conversation_id, source_message_id, content, summary, created_at)
				VALUES
					('memory-global-pending', 'global', 'fact', 'pending', 'shared', 0, NULL, NULL,
						'Synthetic preference at /home/example/synthetic.txt', 'Synthetic preference', '1970-01-01T00:00:00.000Z'),
					('memory-global-unsafe', 'global', 'fact', 'active', 'shared', 0, NULL, NULL,
						'api_key = syntheticValue123', 'Synthetic unsafe', '2026-02-01T00:00:00.000Z'),
					('memory-summary-one', 'conversation', 'summary', 'active', 'private', 1, 'conversation-webui', 'message-user',
						'Synthetic summary alpha.', 'Synthetic summary alpha.', '2026-02-01T00:00:00.000Z'),
					('memory-summary-two', 'conversation', 'summary', 'active', 'private', 0, 'conversation-webui', 'message-user',
						'Synthetic summary alpha.', 'Synthetic summary alpha.', '2026-02-01T00:01:00.000Z'),
					('memory-summary-three', 'conversation', 'summary', 'active', 'private', 1, 'conversation-webui', 'message-user',
						'Synthetic summary alpha.', 'Synthetic summary alpha.', '2026-02-01T00:02:00.000Z'),
					('memory-summary-near', 'conversation', 'summary', 'active', 'private', 0, 'conversation-webui', 'message-user',
						'Synthetic summary alpha!', 'Synthetic summary alpha!', '2026-02-01T00:03:00.000Z'),
					('memory-summary-orphan', 'conversation', 'summary', 'active', 'private', 0, NULL, NULL,
						'Synthetic orphan summary.', 'Synthetic orphan summary.', '2026-02-01T00:04:00.000Z');
			`);
			database.exec(`
				INSERT INTO migration_records
					(source_system, status, target_kind, target_id, source_id, created_at)
				VALUES
					('dsh', 'imported', 'conversations', 'conversation-webui', 'session-work-synthetic', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'conversations', 'conversation-task', 'session-task-synthetic', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'conversations', 'conversation-test-user', 'test-session-alpha', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'conversations', 'conversation-test-empty', 'test-session-beta', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'conversations', 'conversation-group', 'session-group-synthetic', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-user', 'message-user-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-tool-auto', 'message-tool-auto-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-tool-referenced', 'message-tool-ref-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-tool-reply', 'message-tool-reply-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-future', 'message-future-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-invalid', 'message-invalid-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-no-hash', 'message-no-hash-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-tool-group', 'message-tool-group-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-test-user', 'message-test-user-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-test-empty', 'message-test-empty-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'message-tool-task', 'message-tool-task-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'messages', 'missing-message', 'missing-message-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-global-pending', 'memory-global-pending-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-global-unsafe', 'memory-global-unsafe-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-summary-one', 'memory-summary-one-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-summary-two', 'memory-summary-two-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-summary-three', 'memory-summary-three-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-summary-near', 'memory-summary-near-source', '2026-03-01T00:00:00.000Z'),
					('dsh', 'imported', 'memories', 'memory-summary-orphan', 'memory-summary-orphan-source', '2026-03-01T00:00:00.000Z');
			`);
		} finally {
			database.close();
		}

		const before = readFileSync(databasePath);
		const report = previewDshCleanup(databasePath, { now: NOW });
		expect(readFileSync(databasePath)).toEqual(before);
		expect(report).toMatchObject({
			checks: {
				importedMessagesWithoutSourceHash: 1,
				importedSummariesWithoutConversation: 1,
				ledgerOrphanTargets: 1,
				unimportedToolMessages: 1,
			},
			duplicateSummaries: {
				importedSummaries: 5,
				autoRemoveCandidates: 1,
				exactDuplicateGroups: 1,
				exactRedundantRows: 2,
				nearReviewGroups: 1,
				pinnedReviewRows: 1,
			},
			mode: "dsh-cleanup-preview",
			provenance: {
				importedConversations: 5,
				importedMemories: 7,
				importedMessages: 11,
				ledgerRecords: 24,
				orphanTargetRows: 1,
			},
			readOnly: true,
			sharedMemories: {
				activeGlobal: 1,
				activeShared: 1,
				autoQuarantineCandidates: 1,
				hardUnsafeSignals: 1,
				importedGlobalTotal: 2,
				pendingForReview: 1,
				semanticReviewCandidates: 0,
			},
			testSessions: {
				activeWithoutUserMessages: 1,
				autoArchiveCandidates: 1,
				explicitTestSessions: 2,
				importedWebui: 3,
				semanticReviewCandidates: 1,
				withUserMessages: 1,
			},
			timestamps: {
				conversations: { epochFallback: 1, total: 5 },
				memories: { epochFallback: 1, total: 7 },
				messages: { epochFallback: 1, future: 1, invalid: 1, total: 11 },
			},
			toolTraces: {
				autoHideCandidates: 2,
				byConversationKind: { group: 1, task: 1, webui: 2 },
				importedTotal: 4,
				onebotConversation: 1,
				referencedByMemory: 0,
				referencedByMessage: 1,
				reviewRequired: 2,
				unimportedToolMessages: 1,
			},
		});
		const serialized = JSON.stringify(report);
		for (const privateValue of [
			"Synthetic summary alpha",
			"api_key",
			"syntheticValue123",
			"test-session-alpha",
			"conversation-webui",
			"message-tool-auto",
			"/home/example",
		]) {
			expect(serialized).not.toContain(privateValue);
		}
		expect(report.timestamps.messages.normal).toBe(8);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
