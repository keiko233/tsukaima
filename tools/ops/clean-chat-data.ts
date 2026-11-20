import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

const auditSkips = `
	action = 'proactive.decision' AND result = 'denied' AND target_kind = 'conversation'
	AND CASE WHEN json_valid(payload_json) THEN
		json_extract(payload_json, '$.kind') = 'tick'
		AND json_extract(payload_json, '$.gateResult') = 'skipped'
		AND json_extract(payload_json, '$.deliveryStatus') IS NULL
		AND json_extract(payload_json, '$.marker') IS NULL
		AND json_type(payload_json, '$.skippedReason') = 'text'
	ELSE 0 END`;
const decisionSkips = `
	kind = 'tick' AND gate_result = 'skipped' AND task_id IS NULL
	AND delivery_status IS NULL AND marker IS NULL AND skipped_reason IS NOT NULL`;
const memoryCandidates = `
	WITH approved AS MATERIALIZED (
		SELECT DISTINCT target_id FROM audit_log WHERE target_kind = 'memory'
			AND action IN ('memory.active', 'memory.approve') AND result = 'ok'
	)
	SELECT m.id, CASE WHEN c.kind = 'group' THEN c.id ELSE NULL END AS group_id
	FROM memories m
	LEFT JOIN messages msg ON msg.id = m.source_message_id
	LEFT JOIN conversations c ON c.id = coalesce(m.source_conversation_id, msg.conversation_id)
	WHERE m.created_by = 'task' AND m.scope = 'global' AND m.status = 'active'
		AND m.revoked_at IS NULL AND m.extraction_model IS NOT NULL
		AND (c.kind IN ('private', 'workspace') OR (
			m.pinned = 0 AND NOT EXISTS (
				SELECT 1 FROM approved a WHERE a.target_id = m.id
			)
		))`;

function verify(db: Database, check: "integrity_check" | "quick_check") {
	const results = db.query<Record<typeof check, string>, []>(`PRAGMA ${check}`).all();
	if (results.length !== 1 || results[0]?.[check] !== "ok") {
		throw new Error("SQLite integrity check failed");
	}
}

function checkpoint(db: Database) {
	const result = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
	if (result?.busy !== 0) throw new Error("SQLite checkpoint is busy");
}

export function cleanChatData(directory: string, apply: boolean) {
	const staging = realpathSync(directory);
	const domainPath = resolve(staging, "domain.sqlite");
	const schedulerPath = resolve(staging, "plugins/proactive_scheduler.sqlite");
	if (apply) {
		const live = process.env.TSUKAIMA_DATA_DIR;
		if (live && staging === realpathSync(live)) throw new Error("Use a staging copy of the data");
		for (const file of [domainPath, schedulerPath]) {
			if (realpathSync(file) !== file || statSync(file).nlink !== 1) {
				throw new Error("Use independent SQLite copies without symlinks or hard links");
			}
		}
	}
	const options = { create: false, readonly: !apply };
	using domain = new Database(domainPath, options);
	using scheduler = new Database(schedulerPath, options);
	const auditCount = domain.query<{ count: number }, []>(
		`SELECT count(*) AS count FROM audit_log WHERE ${auditSkips}`,
	);
	const decisionCount = scheduler.query<{ count: number }, []>(
		`SELECT count(*) AS count FROM plugin_proactive_scheduler_decisions WHERE ${decisionSkips}`,
	);
	const memories = domain.query<{ id: string; group_id: string | null }, []>(memoryCandidates);
	const report = {
		auditSkips: auditCount.get()?.count ?? 0,
		decisionSkips: decisionCount.get()?.count ?? 0,
		pendingMemories: 0,
		revokedMemories: 0,
	};
	const candidates = memories.all();
	for (const candidate of candidates) {
		if (candidate.group_id !== null) report.pendingMemories++;
		else report.revokedMemories++;
	}
	if (!apply) return report;

	for (const db of [domain, scheduler]) {
		db.run("PRAGMA busy_timeout = 5000");
		checkpoint(db);
		verify(db, "quick_check");
	}
	domain
		.transaction(() => {
			const now = new Date().toISOString();
			const demote = domain.query(
				`UPDATE memories SET scope = 'conversation', visibility = 'private',
					conversation_id = ?, source_conversation_id = ?, dedupe_key = NULL,
					status = 'pending', updated_at = ? WHERE id = ?`,
			);
			const revoke = domain.query(
				"UPDATE memories SET status = 'revoked', revoked_at = ?, updated_at = ?, dedupe_key = NULL WHERE id = ?",
			);
			for (const { id, group_id: groupId } of candidates) {
				if (groupId === null) revoke.run(now, now, id);
				else demote.run(groupId, groupId, now, id);
			}
			domain.run(`DELETE FROM audit_log WHERE ${auditSkips}`);
			if (report.auditSkips + candidates.length > 0) {
				domain.run(
					`INSERT INTO audit_log (id, occurred_at, actor_kind, action, target_kind, result, payload_json)
				VALUES (?, ?, 'system', 'ops.clean-chat-data', 'database', 'ok', ?)`,
					[
						randomUUID(),
						now,
						JSON.stringify({
							auditSkips: report.auditSkips,
							pendingMemories: report.pendingMemories,
							revokedMemories: report.revokedMemories,
						}),
					],
				);
			}
		})
		.immediate();
	scheduler.run(`DELETE FROM plugin_proactive_scheduler_decisions WHERE ${decisionSkips}`);
	for (const db of [domain, scheduler]) {
		db.run("VACUUM");
		checkpoint(db);
		verify(db, "integrity_check");
	}
	return report;
}

if (import.meta.main) {
	const [mode, directory, ...extra] = Bun.argv.slice(2);
	if ((mode !== "--plan" && mode !== "--apply-to-copy") || !directory || extra.length) {
		throw new Error(
			"Usage: bun tools/ops/clean-chat-data.ts (--plan | --apply-to-copy) <data-dir>",
		);
	}
	console.log(JSON.stringify({ mode, ...cleanChatData(directory, mode === "--apply-to-copy") }));
}
