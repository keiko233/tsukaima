import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanChatData } from "./clean-chat-data.ts";

test("cleans an isolated copy and preserves real decisions and curated memories", () => {
	const directory = mkdtempSync(join(tmpdir(), "tsukaima-clean-data-"));
	const domainPath = join(directory, "domain.sqlite");
	const pluginPath = join(directory, "plugins/proactive_scheduler.sqlite");
	try {
		mkdirSync(join(directory, "plugins"));
		{
			using domain = new Database(domainPath);
			domain.exec(`
				PRAGMA journal_mode = WAL;
				CREATE TABLE audit_log (id TEXT, occurred_at TEXT, actor_kind TEXT, action TEXT,
					target_kind TEXT, target_id TEXT, result TEXT, payload_json TEXT);
				CREATE TABLE conversations (id TEXT PRIMARY KEY, kind TEXT);
				CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT);
				CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT, status TEXT, visibility TEXT,
					conversation_id TEXT, source_conversation_id TEXT, source_message_id TEXT,
					created_by TEXT, extraction_model TEXT, pinned INTEGER, revoked_at TEXT, updated_at TEXT,
					dedupe_key TEXT UNIQUE);
				INSERT INTO conversations VALUES ('group', 'group'), ('private', 'private');
				INSERT INTO messages VALUES ('group-message', 'group'), ('private-message', 'private');
				INSERT INTO audit_log (id, action, result, target_kind, target_id, payload_json) VALUES
					('routine', 'proactive.decision', 'denied', 'conversation', 'group',
						'{"kind":"tick","gateResult":"skipped","deliveryStatus":null,"skippedReason":"min_messages"}'),
					('delivery', 'proactive.decision', 'denied', 'conversation', 'group',
						'{"kind":"tick","gateResult":"skipped","deliveryStatus":"skipped","skippedReason":"channel"}'),
					('approved', 'memory.active', 'ok', 'memory', 'approved', '{}'),
					('invalid', 'proactive.decision', 'denied', 'conversation', 'group', '{');
				INSERT INTO memories (id, scope, status, visibility, source_message_id, created_by,
					extraction_model, pinned, dedupe_key) VALUES
					('group', 'global', 'active', 'shared', 'group-message', 'task', 'fake', 0, 'global-group'),
					('private', 'global', 'active', 'shared', 'private-message', 'task', 'fake', 0, 'global-private'),
					('unknown', 'global', 'active', 'shared', NULL, 'task', 'fake', 0, 'global-unknown'),
					('pinned', 'global', 'active', 'shared', 'group-message', 'task', 'fake', 1, 'global-pinned'),
					('approved', 'global', 'active', 'shared', 'group-message', 'task', 'fake', 0, 'global-approved'),
					('migrated', 'global', 'active', 'shared', NULL, 'migration', NULL, 0, 'global-migrated');
			`);
			using scheduler = new Database(pluginPath);
			scheduler.exec(`
				CREATE TABLE plugin_proactive_scheduler_decisions (id TEXT, kind TEXT, gate_result TEXT,
					task_id TEXT, delivery_status TEXT, marker TEXT, skipped_reason TEXT);
				INSERT INTO plugin_proactive_scheduler_decisions VALUES
					('routine', 'tick', 'skipped', NULL, NULL, NULL, 'min_messages'),
					('delivered', 'tick', 'delivered', NULL, 'sent', NULL, NULL),
					('task', 'tick', 'skipped', 'task-id', NULL, NULL, 'min_messages');
			`);
		}
		const planned = { auditSkips: 1, decisionSkips: 1, pendingMemories: 1, revokedMemories: 2 };
		expect(cleanChatData(directory, false)).toEqual(planned);
		expect(cleanChatData(directory, false)).toEqual(planned);
		expect(cleanChatData(directory, true)).toEqual(planned);
		expect(cleanChatData(directory, false)).toEqual({
			auditSkips: 0,
			decisionSkips: 0,
			pendingMemories: 0,
			revokedMemories: 0,
		});
		using domain = new Database(domainPath, { readonly: true });
		expect(domain.query("SELECT * FROM memories WHERE id = 'group'").get()).toMatchObject({
			conversation_id: "group",
			dedupe_key: null,
			scope: "conversation",
			status: "pending",
			visibility: "private",
		});
		expect(
			domain.query("SELECT id FROM memories WHERE status = 'active' ORDER BY id").all(),
		).toEqual([{ id: "approved" }, { id: "migrated" }, { id: "pinned" }]);
		expect(
			domain
				.query("SELECT id FROM audit_log WHERE action = 'proactive.decision' ORDER BY id")
				.all(),
		).toEqual([{ id: "delivery" }, { id: "invalid" }]);
		using scheduler = new Database(pluginPath, { readonly: true });
		expect(
			scheduler.query("SELECT id FROM plugin_proactive_scheduler_decisions ORDER BY id").all(),
		).toEqual([{ id: "delivered" }, { id: "task" }]);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
