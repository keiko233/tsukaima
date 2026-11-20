import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairDshCopy } from "./dsh-repair-copy.ts";

test("repairs only provenance-confirmed DSH rows on a copy and is idempotent", () => {
	const root = mkdtempSync(join(tmpdir(), "tsukaima-dsh-repair-"));
	const path = join(root, "domain.sqlite");
	try {
		{
			using db = new Database(path);
			db.exec(`
				CREATE TABLE audit_log (id TEXT, occurred_at TEXT, actor_kind TEXT, action TEXT,
					target_kind TEXT, target_id TEXT, result TEXT, payload_json TEXT);
				CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, occurred_at TEXT);
				CREATE TABLE migration_records (target_id TEXT, target_kind TEXT, source_system TEXT, status TEXT);
				CREATE TABLE memories (id TEXT PRIMARY KEY, conversation_id TEXT, scope TEXT, kind TEXT,
					created_by TEXT DEFAULT 'migration', created_at TEXT, content TEXT, summary TEXT,
					evidence_json TEXT, status TEXT DEFAULT 'active', visibility TEXT DEFAULT 'private',
					pinned INTEGER DEFAULT 0, revoked_at TEXT, updated_at TEXT, dedupe_key TEXT);
				INSERT INTO messages VALUES ('imported-message', 'chat', '2026-01-01T00:00:00.000Z'),
					('new-message', 'chat', '2026-02-01T00:00:00.000Z');
				INSERT INTO memories (id, conversation_id, scope, kind, created_at, content, summary, evidence_json, pinned)
					VALUES ('bad-time', 'chat', 'conversation', 'summary', '1970-01-01T00:00:00.057Z',
						'Fresh context', 'Fresh context', '{"compactor":"migration","sourceRange":{"end":57}}', 0),
					('mismatched-offset', 'chat', 'conversation', 'summary', '1970-01-01T00:00:00.059Z',
						'Other context', 'Other context', '{"compactor":"migration","sourceRange":{"end":57}}', 0),
					('keeper', 'chat', 'conversation', 'summary', '2025-01-01T00:00:00.000Z',
						'Same content', 'Same summary', '{}', 1),
					('dup', 'chat', 'conversation', 'summary', '2025-01-02T00:00:00.000Z',
						'Same content', 'Same summary', '{}', 0),
					('cross', NULL, 'global', 'napcat-cross', '1970-01-01T00:00:00.000Z',
						'Short snippet', 'Short snippet', '{"provenance":{"table":"napcat-cross"}}', 0),
					('approved', NULL, 'global', 'napcat-cross', '1970-01-01T00:00:00.000Z',
						'Curated snippet', 'Curated snippet', '{"provenance":{"table":"napcat-cross"}}', 0);
				INSERT INTO migration_records
					SELECT id, 'memories', 'dsh', 'imported' FROM memories;
				INSERT INTO migration_records VALUES ('imported-message', 'messages', 'dsh', 'imported');
				INSERT INTO audit_log (id, action, target_kind, target_id, result)
					VALUES ('approval', 'memory.active', 'memory', 'approved', 'ok');
			`);
		}
		expect(repairDshCopy(path)).toEqual({
			fixedTimes: 1,
			pendingSnippets: 1,
			revokedDuplicates: 1,
		});
		expect(repairDshCopy(path)).toEqual({
			fixedTimes: 0,
			pendingSnippets: 0,
			revokedDuplicates: 0,
		});
		using db = new Database(path, { readonly: true });
		expect(db.query("SELECT created_at FROM memories WHERE id = 'bad-time'").get()).toEqual({
			created_at: "2026-01-01T00:00:00.000Z",
		});
		expect(db.query("SELECT id, status FROM memories ORDER BY id").all()).toEqual([
			{ id: "approved", status: "active" },
			{ id: "bad-time", status: "active" },
			{ id: "cross", status: "pending" },
			{ id: "dup", status: "revoked" },
			{ id: "keeper", status: "active" },
			{ id: "mismatched-offset", status: "active" },
		]);
		expect(db.query("SELECT count(*) AS count FROM migration_records").get()).toEqual({ count: 7 });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
