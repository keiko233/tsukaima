import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_2000_MS = Date.parse("2000-01-01T00:00:00.000Z");
const REQUIRED_TABLES = [
	"chat_objects",
	"conversations",
	"memories",
	"messages",
	"migration_records",
] as const;

interface TimestampCounts {
	readonly total: number;
	readonly normal: number;
	readonly epochFallback: number;
	readonly before2000Other: number;
	readonly future: number;
	readonly invalid: number;
}

interface ToolTraceRow {
	readonly conversationKind: string;
	readonly channelId: string | null;
	readonly referencedByMessage: number;
	readonly referencedByMemory: number;
}

interface SharedMemoryRow {
	readonly status: string;
	readonly visibility: string;
	readonly content: string;
	readonly summary: string;
}

interface SummaryRow {
	readonly id: string;
	readonly conversationId: string | null;
	readonly content: string;
	readonly summary: string;
	readonly status: string;
	readonly pinned: number;
	readonly createdAt: string;
}

interface TestSessionRow {
	readonly id: string;
	readonly sourceId: string;
	readonly title: string | null;
	readonly status: string;
	readonly userMessages: number;
}

export interface DshCleanupPreviewReport {
	readonly mode: "dsh-cleanup-preview";
	readonly readOnly: true;
	readonly generatedAt: string;
	readonly provenance: {
		readonly ledgerRecords: number;
		readonly importedConversations: number;
		readonly importedMessages: number;
		readonly importedMemories: number;
		readonly orphanTargetRows: number;
		readonly messagesWithoutSourceHash: number;
	};
	readonly timestamps: {
		readonly messages: TimestampCounts;
		readonly memories: TimestampCounts;
		readonly conversations: TimestampCounts;
	};
	readonly toolTraces: {
		readonly importedTotal: number;
		readonly autoHideCandidates: number;
		readonly reviewRequired: number;
		readonly referencedByMessage: number;
		readonly referencedByMemory: number;
		readonly onebotConversation: number;
		readonly unimportedToolMessages: number;
		readonly byConversationKind: Readonly<Record<string, number>>;
	};
	readonly sharedMemories: {
		readonly importedGlobalTotal: number;
		readonly activeGlobal: number;
		readonly pendingForReview: number;
		readonly activeShared: number;
		readonly activePrivate: number;
		readonly inactive: number;
		readonly hardUnsafeSignals: number;
		readonly noisySignals: number;
		readonly autoQuarantineCandidates: number;
		readonly semanticReviewCandidates: number;
	};
	readonly duplicateSummaries: {
		readonly importedSummaries: number;
		readonly exactDuplicateGroups: number;
		readonly exactRedundantRows: number;
		readonly autoRemoveCandidates: number;
		readonly pinnedReviewRows: number;
		readonly nearDuplicateGroups: number;
		readonly nearReviewGroups: number;
	};
	readonly testSessions: {
		readonly importedWebui: number;
		readonly explicitTestSessions: number;
		readonly alreadyArchived: number;
		readonly activeWithoutUserMessages: number;
		readonly withUserMessages: number;
		readonly autoArchiveCandidates: number;
		readonly semanticReviewCandidates: number;
	};
	readonly checks: {
		readonly ledgerOrphanTargets: number;
		readonly importedMessagesWithoutSourceHash: number;
		readonly unimportedToolMessages: number;
		readonly importedSummariesWithoutConversation: number;
	};
	readonly autoRules: readonly string[];
	readonly reviewRules: readonly string[];
}

function scalar(database: Database, sql: string, ...parameters: (string | number)[]): number {
	const row = database.query<{ count: number }, (string | number)[]>(sql).get(...parameters);
	return Number(row?.count ?? 0);
}

function records(database: Database, sql: string): Record<string, unknown>[] {
	return database.query<Record<string, unknown>, []>(sql).all();
}

function timestampCounts(values: readonly unknown[], nowMs: number): TimestampCounts {
	const counts = {
		before2000Other: 0,
		epochFallback: 0,
		future: 0,
		invalid: 0,
		normal: 0,
		total: values.length,
	};
	for (const value of values) {
		const parsed =
			typeof value === "number" && Number.isFinite(value)
				? value
				: typeof value === "string"
					? Date.parse(value)
					: Number.NaN;
		if (!Number.isFinite(parsed)) {
			counts.invalid += 1;
		} else if (parsed === 0) {
			counts.epochFallback += 1;
		} else if (parsed < YEAR_2000_MS) {
			counts.before2000Other += 1;
		} else if (parsed > nowMs + DAY_MS) {
			counts.future += 1;
		} else {
			counts.normal += 1;
		}
	}
	return counts;
}

function looksCredentialLike(text: string): boolean {
	return /\b(?:api[ _-]?key|access[ _-]?token|auth(?:orization)?[ _-]?token|password|passwd|secret)\b\s*[:=]\s*['"`]?[A-Za-z0-9._~+/=-]{6,}/i.test(
		text,
	);
}

function looksNoisy(text: string): boolean {
	return (
		text.length > 4_000 ||
		/```|\bTraceback \(most recent call last\)|\bnpm ERR!|\berror TS\d+|\b(?:DEBUG|WARN|INFO)\b/i.test(
			text,
		) ||
		/\b(?:https?|wss?):\/\//i.test(text) ||
		/(?:^|[\s"'])(?:\/(?:home|Users|workspace|var|opt|srv)\/|[A-Za-z]:\\\\)/i.test(text)
	);
}

function exactSummaryKey(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function nearSummaryKey(text: string): string {
	return exactSummaryKey(text)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function explicitTestSession(sourceId: string, title: string | null): boolean {
	return (
		/(?:^|[-_/:.])(?:test|tests)(?:[-_/:.]|$)/i.test(sourceId) ||
		(/\b(?:test|tests)\b/i.test(title ?? "") && /^\s*(?:test|tests)\b/i.test(title ?? ""))
	);
}

function keeperFirst(left: SummaryRow, right: SummaryRow): number {
	return (
		right.pinned - left.pinned ||
		(left.status === "active" ? 0 : 1) - (right.status === "active" ? 0 : 1) ||
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id)
	);
}

function summarizeSummaries(rows: readonly SummaryRow[]) {
	const exactGroups = new Map<string, SummaryRow[]>();
	const nearGroups = new Map<string, SummaryRow[]>();
	for (const row of rows) {
		const exact = exactSummaryKey(row.content);
		if (exact === "") continue;
		const scope = row.conversationId ?? "";
		const exactKey = `${scope}\u0000${exact}`;
		const nearKey = `${scope}\u0000${nearSummaryKey(row.content)}`;
		exactGroups.set(exactKey, [...(exactGroups.get(exactKey) ?? []), row]);
		nearGroups.set(nearKey, [...(nearGroups.get(nearKey) ?? []), row]);
	}

	let exactDuplicateGroups = 0;
	let exactRedundantRows = 0;
	let autoRemoveCandidates = 0;
	let pinnedReviewRows = 0;
	for (const group of exactGroups.values()) {
		if (group.length < 2) continue;
		exactDuplicateGroups += 1;
		const redundant = group.toSorted(keeperFirst).slice(1);
		exactRedundantRows += redundant.length;
		for (const row of redundant) {
			if (row.pinned !== 0) pinnedReviewRows += 1;
			else autoRemoveCandidates += 1;
		}
	}

	let nearDuplicateGroups = 0;
	let nearReviewGroups = 0;
	for (const group of nearGroups.values()) {
		if (group.length < 2) continue;
		nearDuplicateGroups += 1;
		const exactKeys = new Set(group.map((row) => exactSummaryKey(row.content)));
		if (exactKeys.size > 1) nearReviewGroups += 1;
	}
	return {
		autoRemoveCandidates,
		exactDuplicateGroups,
		exactRedundantRows,
		nearDuplicateGroups,
		nearReviewGroups,
		pinnedReviewRows,
	};
}

function requiredTables(database: Database): Set<string> {
	return new Set(
		database
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.all()
			.map((row) => row.name),
	);
}

/**
 * Read-only aggregate preview for DSH-imported data. It deliberately returns no row IDs,
 * source paths, conversation titles, or memory text, so its output can be shared safely.
 */
export function previewDshCleanup(
	databasePath: string,
	options: { readonly now?: number } = {},
): DshCleanupPreviewReport {
	const nowMs = options.now ?? Date.now();
	const path = resolve(databasePath);
	if (!statSync(path).isFile()) throw new Error("Database path is not a file");
	const database = new Database(path, { create: false, readonly: true });
	try {
		database.run("PRAGMA query_only = ON");
		const tables = requiredTables(database);
		const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
		if (missing.length > 0) throw new Error("Database is missing required tables");

		const importedMessages = scalar(
			database,
			`SELECT COUNT(*) AS count
			FROM messages m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'messages' AND r.target_id = m.id`,
		);
		const importedConversations = scalar(
			database,
			`SELECT COUNT(*) AS count
			FROM conversations c
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'conversations' AND r.target_id = c.id`,
		);
		const importedMemories = scalar(
			database,
			`SELECT COUNT(*) AS count
			FROM memories m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'memories' AND r.target_id = m.id`,
		);
		const ledgerRecords = scalar(
			database,
			"SELECT COUNT(*) AS count FROM migration_records WHERE source_system = 'dsh'",
		);
		const orphanTargetRows =
			scalar(
				database,
				`SELECT COUNT(*) AS count FROM migration_records r
				WHERE r.source_system = 'dsh' AND r.status = 'imported' AND r.target_kind = 'messages'
					AND NOT EXISTS (SELECT 1 FROM messages t WHERE t.id = r.target_id)`,
			) +
			scalar(
				database,
				`SELECT COUNT(*) AS count FROM migration_records r
				WHERE r.source_system = 'dsh' AND r.status = 'imported' AND r.target_kind = 'conversations'
					AND NOT EXISTS (SELECT 1 FROM conversations t WHERE t.id = r.target_id)`,
			) +
			scalar(
				database,
				`SELECT COUNT(*) AS count FROM migration_records r
				WHERE r.source_system = 'dsh' AND r.status = 'imported' AND r.target_kind = 'memories'
					AND NOT EXISTS (SELECT 1 FROM memories t WHERE t.id = r.target_id)`,
			) +
			scalar(
				database,
				`SELECT COUNT(*) AS count FROM migration_records r
				WHERE r.source_system = 'dsh' AND r.status = 'imported' AND r.target_kind = 'chatObjects'
					AND NOT EXISTS (SELECT 1 FROM chat_objects t WHERE t.id = r.target_id)`,
			);

		const messageTimes = records(
			database,
			`SELECT m.occurred_at AS occurredAt FROM messages m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'messages' AND r.target_id = m.id`,
		).map((row) => row.occurredAt);
		const memoryTimes = records(
			database,
			`SELECT m.created_at AS createdAt FROM memories m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'memories' AND r.target_id = m.id`,
		).map((row) => row.createdAt);
		const conversationTimes = records(
			database,
			`SELECT c.created_at AS createdAt FROM conversations c
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'conversations' AND r.target_id = c.id`,
		).map((row) => row.createdAt);

		const toolRows = records(
			database,
			`WITH replies AS MATERIALIZED (
				SELECT DISTINCT reply_to_message_id AS id FROM messages WHERE reply_to_message_id IS NOT NULL
			), memory_sources AS MATERIALIZED (
				SELECT DISTINCT source_message_id AS id FROM memories WHERE source_message_id IS NOT NULL
			)
			SELECT c.kind AS conversationKind, c.channel_id AS channelId,
				(reply_id.id IS NOT NULL OR reply_platform.id IS NOT NULL) AS referencedByMessage,
				(memory_sources.id IS NOT NULL) AS referencedByMemory
			FROM messages m
			JOIN conversations c ON c.id = m.conversation_id
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'messages' AND r.target_id = m.id
			LEFT JOIN replies reply_id ON reply_id.id = m.id
			LEFT JOIN replies reply_platform ON reply_platform.id = m.platform_message_id
			LEFT JOIN memory_sources ON memory_sources.id = m.id
			WHERE m.kind = 'tool'`,
		) as unknown as ToolTraceRow[];
		const byConversationKind: Record<string, number> = {};
		let autoHideCandidates = 0;
		let reviewRequired = 0;
		let referencedByMessage = 0;
		let referencedByMemory = 0;
		let onebotConversation = 0;
		for (const row of toolRows) {
			byConversationKind[row.conversationKind] =
				(byConversationKind[row.conversationKind] ?? 0) + 1;
			const referenced =
				Number(row.referencedByMessage) !== 0 || Number(row.referencedByMemory) !== 0;
			if (Number(row.referencedByMessage) !== 0) referencedByMessage += 1;
			if (Number(row.referencedByMemory) !== 0) referencedByMemory += 1;
			if (row.channelId === "onebot") onebotConversation += 1;
			const nonPublicTrace =
				row.channelId !== "onebot" && ["webui", "workspace", "task"].includes(row.conversationKind);
			if (nonPublicTrace && !referenced) autoHideCandidates += 1;
			else reviewRequired += 1;
		}
		const unimportedToolMessages = scalar(
			database,
			`SELECT COUNT(*) AS count FROM (
				SELECT id FROM messages WHERE kind = 'tool'
				EXCEPT
				SELECT target_id FROM migration_records
				WHERE source_system = 'dsh' AND status = 'imported' AND target_kind = 'messages'
			)`,
		);

		const sharedRows = records(
			database,
			`SELECT m.status AS status, m.visibility AS visibility,
				m.content AS content, m.summary AS summary
			FROM memories m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'memories' AND r.target_id = m.id
			WHERE m.scope = 'global'`,
		) as unknown as SharedMemoryRow[];
		let pendingForReview = 0;
		let activeShared = 0;
		let activePrivate = 0;
		let inactive = 0;
		let hardUnsafeSignals = 0;
		let noisySignals = 0;
		let autoQuarantineCandidates = 0;
		for (const row of sharedRows) {
			const text = `${row.summary}\n${row.content}`;
			const credentialLike = looksCredentialLike(text);
			const noisy = looksNoisy(text);
			if (credentialLike) hardUnsafeSignals += 1;
			if (credentialLike || noisy) noisySignals += 1;
			if (row.status === "pending") pendingForReview += 1;
			else if (row.status === "active" && row.visibility === "shared") activeShared += 1;
			else if (row.status === "active") activePrivate += 1;
			else inactive += 1;
			if (row.status === "active" && credentialLike) autoQuarantineCandidates += 1;
		}
		const activeGlobal = activeShared + activePrivate;

		const summaryRows = records(
			database,
			`SELECT m.id AS id, m.conversation_id AS conversationId,
				m.content AS content, m.summary AS summary, m.status AS status,
				m.pinned AS pinned, m.created_at AS createdAt
			FROM memories m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'memories' AND r.target_id = m.id
			WHERE m.kind = 'summary' AND m.status IN ('active', 'pending')`,
		) as unknown as SummaryRow[];
		const summaries = summarizeSummaries(summaryRows);

		const testRows = records(
			database,
			`SELECT c.id AS id, r.source_id AS sourceId, c.title AS title, c.status AS status,
				SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END) AS userMessages
			FROM conversations c
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'conversations' AND r.target_id = c.id
			LEFT JOIN messages m ON m.conversation_id = c.id
			WHERE c.kind = 'webui'
			GROUP BY c.id, r.source_id, c.title, c.status`,
		) as unknown as TestSessionRow[];
		const explicitTests = testRows.filter((row) =>
			explicitTestSession(String(row.sourceId), row.title),
		);
		const alreadyArchived = explicitTests.filter((row) => row.status === "archived").length;
		const activeWithoutUserMessages = explicitTests.filter(
			(row) => row.status !== "archived" && Number(row.userMessages) === 0,
		).length;
		const withUserMessages = explicitTests.filter((row) => Number(row.userMessages) > 0).length;

		const importedMessagesWithoutSourceHash = scalar(
			database,
			`SELECT COUNT(*) AS count FROM messages m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'messages' AND r.target_id = m.id
			WHERE m.raw_ref_json IS NULL OR m.raw_ref_json NOT LIKE '%"sourceHash"%'`,
		);
		const importedSummariesWithoutConversation = scalar(
			database,
			`SELECT COUNT(*) AS count FROM memories m
			JOIN migration_records r
				ON r.source_system = 'dsh' AND r.status = 'imported'
				AND r.target_kind = 'memories' AND r.target_id = m.id
			WHERE m.kind = 'summary' AND m.conversation_id IS NULL`,
		);

		return {
			autoRules: [
				"Treat an exact epoch fallback timestamp as unknown; do not replay it as real chronology.",
				"Hide unreferenced imported tool traces in webui, workspace, and task conversations.",
				"Quarantine active imported global memories with hard credential-like content.",
				"Remove unpinned members of exact duplicate summary groups, keeping one deterministic row.",
				"Archive explicitly named test WebUI sessions that contain no user messages.",
			],
			checks: {
				importedMessagesWithoutSourceHash,
				importedSummariesWithoutConversation,
				ledgerOrphanTargets: orphanTargetRows,
				unimportedToolMessages,
			},
			duplicateSummaries: {
				...summaries,
				importedSummaries: summaryRows.length,
			},
			generatedAt: new Date(nowMs).toISOString(),
			mode: "dsh-cleanup-preview",
			provenance: {
				importedConversations,
				importedMemories,
				importedMessages,
				ledgerRecords,
				messagesWithoutSourceHash: importedMessagesWithoutSourceHash,
				orphanTargetRows,
			},
			readOnly: true,
			reviewRules: [
				"Review timestamp rows without an exact epoch fallback; missing time cannot be reconstructed from order alone.",
				"Review imported tool traces referenced by a message or memory, and all OneBot chat traces.",
				"Review active imported global memories that are noisy but not credential-like.",
				"Review pinned duplicate summaries and summaries that differ only by case or punctuation.",
				"Review test sessions with user messages before deleting any conversation content.",
			],
			sharedMemories: {
				activeGlobal: activeGlobal,
				activePrivate,
				activeShared,
				autoQuarantineCandidates,
				hardUnsafeSignals,
				importedGlobalTotal: sharedRows.length,
				inactive,
				noisySignals,
				pendingForReview,
				semanticReviewCandidates: activeGlobal - autoQuarantineCandidates,
			},
			testSessions: {
				activeWithoutUserMessages,
				alreadyArchived,
				autoArchiveCandidates: activeWithoutUserMessages,
				explicitTestSessions: explicitTests.length,
				importedWebui: testRows.length,
				semanticReviewCandidates: withUserMessages,
				withUserMessages,
			},
			timestamps: {
				conversations: timestampCounts(conversationTimes, nowMs),
				memories: timestampCounts(memoryTimes, nowMs),
				messages: timestampCounts(messageTimes, nowMs),
			},
			toolTraces: {
				autoHideCandidates,
				byConversationKind: Object.fromEntries(
					Object.entries(byConversationKind).toSorted(([left], [right]) =>
						left.localeCompare(right),
					),
				),
				importedTotal: toolRows.length,
				onebotConversation,
				referencedByMemory,
				referencedByMessage,
				reviewRequired,
				unimportedToolMessages,
			},
		};
	} finally {
		database.close();
	}
}

if (import.meta.main) {
	const argumentsToParse = Bun.argv.slice(2);
	let databasePath: string | undefined;
	let now: number | undefined;
	for (let index = 0; index < argumentsToParse.length; index += 1) {
		const argument = argumentsToParse[index]!;
		if (argument === "--db") {
			databasePath = argumentsToParse[index + 1];
			index += 1;
		} else if (argument === "--now") {
			const value = argumentsToParse[index + 1];
			now = value === undefined ? Number.NaN : Date.parse(value);
			index += 1;
		} else {
			throw new Error(
				"Usage: bun tools/ops/dsh-cleanup-preview.ts --db <domain.sqlite> [--now <ISO>]",
			);
		}
	}
	if (databasePath === undefined) {
		throw new Error(
			"Usage: bun tools/ops/dsh-cleanup-preview.ts --db <domain.sqlite> [--now <ISO>]",
		);
	}
	if (now !== undefined && !Number.isFinite(now)) throw new Error("--now must be an ISO timestamp");
	try {
		const report = previewDshCleanup(databasePath, now === undefined ? {} : { now });
		console.log(JSON.stringify(report, null, 2));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const sanitized = message
			.replaceAll(databasePath, "<database>")
			.replaceAll(resolve(databasePath), "<database>");
		console.error(`DSH cleanup preview failed: ${sanitized}`);
		process.exitCode = 1;
	}
}
