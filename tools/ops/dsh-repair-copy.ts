import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ledger = `source_system = 'dsh' AND status = 'imported'`;
const importedMemories = `
	SELECT DISTINCT target_id FROM migration_records WHERE ${ledger} AND target_kind = 'memories'`;
const summaryTimes = `
	WITH last_imported_message AS (
		SELECT msg.conversation_id, max(msg.occurred_at) AS corrected_at
		FROM migration_records r JOIN messages msg ON msg.id = r.target_id
		WHERE r.source_system = 'dsh' AND r.status = 'imported' AND r.target_kind = 'messages'
			AND msg.occurred_at >= '2000-01-01' AND julianday(msg.occurred_at) IS NOT NULL
		GROUP BY msg.conversation_id
	)
	SELECT m.id, msg.corrected_at FROM memories m
	JOIN (${importedMemories}) r ON r.target_id = m.id
	JOIN last_imported_message msg ON msg.conversation_id = m.conversation_id
	WHERE m.created_by = 'migration' AND m.scope = 'conversation' AND m.kind = 'summary'
		AND m.created_at >= '1970-01-01' AND m.created_at < '1970-01-02'
		AND CASE WHEN json_valid(m.evidence_json) THEN
			json_extract(m.evidence_json, '$.compactor') = 'migration'
			AND round((julianday(m.created_at) - 2440587.5) * 86400000)
				= json_extract(m.evidence_json, '$.sourceRange.end')
		ELSE 0 END`;
const crossSessionSnippets = `
	SELECT m.id FROM memories m JOIN (${importedMemories}) r ON r.target_id = m.id
	WHERE m.created_by = 'migration' AND m.kind = 'napcat-cross' AND m.scope = 'global'
		AND m.created_at = '1970-01-01T00:00:00.000Z' AND m.status = 'active'
		AND m.pinned = 0 AND m.revoked_at IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM audit_log a WHERE a.target_kind = 'memory' AND a.target_id = m.id
				AND a.action IN ('memory.active', 'memory.approve') AND a.result = 'ok'
		)
		AND CASE WHEN json_valid(m.evidence_json) THEN
			json_extract(m.evidence_json, '$.provenance.table') = 'napcat-cross'
		ELSE 0 END`;
const duplicateSummaries = `
	WITH ranked AS (
		SELECT m.id, m.pinned, row_number() OVER (
			PARTITION BY m.conversation_id, m.content, m.summary
			ORDER BY m.pinned DESC, m.created_at DESC, m.id
		) AS position
		FROM memories m JOIN (${importedMemories}) r ON r.target_id = m.id
		WHERE m.created_by = 'migration' AND m.scope = 'conversation' AND m.kind = 'summary'
			AND m.conversation_id IS NOT NULL AND m.content <> '' AND m.status = 'active'
			AND m.revoked_at IS NULL
	)
	SELECT id FROM ranked WHERE position > 1 AND pinned = 0`;

export function repairDshCopy(path: string) {
	const file = resolve(path);
	const live = process.env.TSUKAIMA_DATA_DIR;
	const configuredDomain = live ? resolve(live, "domain.sqlite") : undefined;
	if (
		realpathSync(file) !== file ||
		statSync(file).nlink !== 1 ||
		(configuredDomain !== undefined && file === configuredDomain)
	) {
		throw new Error("Use an independent SQLite copy");
	}
	using db = new Database(file, { create: false });
	db.run("PRAGMA busy_timeout = 5000");
	const report = db
		.transaction(() => {
			const now = new Date().toISOString();
			const fixedTimes = db.run(`
				WITH corrected AS MATERIALIZED (${summaryTimes})
				UPDATE memories SET created_at = (SELECT corrected_at FROM corrected WHERE id = memories.id)
				WHERE id IN (SELECT id FROM corrected)`).changes;
			const pendingSnippets = db.run(
				`UPDATE memories SET status = 'pending', visibility = 'shared', updated_at = ?
				WHERE id IN (${crossSessionSnippets})`,
				[now],
			).changes;
			const revokedDuplicates = db.run(
				`UPDATE memories SET status = 'revoked', revoked_at = ?, updated_at = ?, dedupe_key = NULL
				WHERE id IN (${duplicateSummaries})`,
				[now, now],
			).changes;
			const summary = { fixedTimes, pendingSnippets, revokedDuplicates };
			if (fixedTimes + pendingSnippets + revokedDuplicates > 0) {
				db.run(
					`INSERT INTO audit_log (id, occurred_at, actor_kind, action, target_kind, result, payload_json)
					VALUES (?, ?, 'system', 'ops.repair-dsh-import', 'database', 'ok', ?)`,
					[randomUUID(), now, JSON.stringify(summary)],
				);
			}
			return summary;
		})
		.immediate();
	const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
	const check = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
	if (checkpoint?.busy !== 0 || check.length !== 1 || check[0]?.integrity_check !== "ok") {
		throw new Error("Staged DSH database did not validate");
	}
	return report;
}

if (import.meta.main) {
	const [mode, file, ...extra] = Bun.argv.slice(2);
	if (mode !== "--apply-to-copy" || !file || extra.length) {
		throw new Error(
			"Usage: bun tools/ops/dsh-repair-copy.ts --apply-to-copy <staged-domain.sqlite>",
		);
	}
	console.log(JSON.stringify(repairDshCopy(file)));
}
