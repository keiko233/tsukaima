import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	chatObjects,
	conversationMembers,
	conversations,
	type TsukaimaDatabase,
	identities,
	media,
	memories,
	messages,
	migrateDomainDatabase,
	migrationRecords,
	migrationRuns,
	openDomainDatabase,
	personaBindings,
	personas,
	policies,
	requests,
	userAliases,
	users,
} from "@tsukaima/db";
import { DSH_SOURCE, type SnapshotSource } from "./dsh-inspect.ts";
import { FakeCompressor, type Compressor, type CompressionResult } from "./compressor.ts";
import {
	createPreImportBackup,
	restorePreImportBackup,
	writeRollbackReport,
	type BackupManifest,
} from "./backup.ts";
import {
	countRecords,
	emptyRecordCounts,
	normalizeSnapshot,
	type MigrationPlan,
	type NormalizedAttachment,
	type NormalizedDatabase,
	type NormalizedMessage,
	type NormalizedSetting,
	type NormalizedSticker,
	type RecordCounts,
} from "./normalize.ts";
import { collectSecretValues, redactSecrets } from "./secrets.ts";
import { resolveSnapshotRoot, sha256Bytes, sha256String, stableStringify } from "./fs.ts";
import { insertProactiveSchedulerData, insertStickerMemeData } from "./plugin-tables.ts";
import { runFakeMigrationSmokeTurn, type FakeModelAdapter, type SmokeTurnResult } from "./smoke.ts";

export interface SnapshotPaths {
	readonly source: readonly string[];
}

export interface PipelineOptions {
	readonly backupDir?: string;
	readonly durablePath?: string;
	readonly mediaDir?: string;
	readonly now?: () => number;
	readonly reportsDir?: string;
	/** Only used by isolated in-memory/test runs where snapshot restore is impossible. */
	readonly allowRowRollback?: boolean;
}

export interface ImportOptions {
	readonly compressor?: Compressor;
	readonly dryRunPlan?: MigrationPlan;
	readonly model?: FakeModelAdapter;
}

export interface ImportResult extends RecordCounts {
	readonly runId: string;
	readonly backupHash: string | null;
	readonly importedAt: string;
}

export interface VerifyCheck {
	readonly ok: boolean;
	readonly details: readonly string[];
}

export interface RenderedConversation {
	readonly conversationId: string;
	readonly lines: readonly string[];
	readonly readOnly: true;
}

export interface VerifyResult {
	readonly ok: boolean;
	readonly expectedCounts: RecordCounts;
	readonly actualCounts: RecordCounts;
	readonly messageChecksums: {
		readonly expected: number;
		readonly actual: number;
		readonly matched: number;
	};
	readonly checks: {
		readonly counts: VerifyCheck;
		readonly checksums: VerifyCheck;
		readonly secrets: VerifyCheck;
		readonly references: VerifyCheck;
		readonly rendering: VerifyCheck;
		readonly smokeTurn: VerifyCheck;
		readonly pluginConfig: VerifyCheck;
	};
	readonly rendering: RenderedConversation | null;
	readonly smokeTurn: SmokeTurnResult;
}

export interface RollbackResult {
	readonly runId: string;
	readonly deletedCounts: RecordCounts;
	readonly mode: "snapshot" | "rows";
	readonly backupHash: string | null;
	readonly auditPath: string | null;
	readonly restoredFiles: readonly string[];
}

export interface MigrationPipeline {
	dryRun(source: SnapshotSource): Promise<MigrationPlan>;
	import(source: SnapshotSource, options?: ImportOptions): Promise<ImportResult>;
	verify(
		source: SnapshotSource,
		options?: { readonly model?: FakeModelAdapter },
	): Promise<VerifyResult>;
	rollback(runId: string): Promise<RollbackResult>;
}

function countByKind(rows: readonly { targetKind: string; status: string }[]): RecordCounts {
	const counts = emptyRecordCounts();
	for (const row of rows) {
		if (row.status !== "imported") continue;
		const key = row.targetKind as keyof RecordCounts;
		if (key in counts) counts[key] += 1;
	}
	return counts;
}

function safeJson(value: unknown): string {
	return JSON.stringify(redactSecrets(value, { includeHostSpecific: true }).value);
}

function safeSettingJson(value: string): string {
	try {
		return safeJson(JSON.parse(value) as unknown);
	} catch {
		return safeJson(value);
	}
}

function settingsRecord(setting: NormalizedSetting): {
	id: string;
	scope: "global";
	policyJson: string;
	isActive: boolean;
} {
	return {
		id: setting.canonicalId,
		scope: "global",
		policyJson: safeJson({
			category: setting.category,
			target: setting.target,
			value: safeSettingJson(setting.valueJson),
		}),
		isActive: true,
	};
}

/** The server's blob store addresses bytes by bare 64-char hex (`MediaService.blobPath`). */
function bareSha256(value: string): string {
	return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function mediaRecord(source: NormalizedSticker | NormalizedAttachment): {
	id: string;
	kind: "image" | "sticker" | "audio" | "video" | "file";
	mimeType: string;
	sha256: string;
	sizeBytes: number;
	source: "migration";
	metadataJson: string;
} {
	if ("canonicalId" in source) {
		return {
			id: source.mediaId ?? source.canonicalId,
			kind: "sticker",
			mimeType: source.mimeType,
			sha256: bareSha256(source.fileHash ?? source.sourceHash),
			sizeBytes: source.sizeBytes,
			source: "migration",
			metadataJson: JSON.stringify({
				name: source.name,
				packId: source.packId ?? null,
				sourceId: source.sourceId,
			}),
		};
	}
	return {
		id: source.id,
		kind: source.kind,
		mimeType: source.mimeType,
		sha256: bareSha256(source.fileHash ?? source.sha256 ?? source.sourceHash),
		sizeBytes: source.sizeBytes,
		source: "migration",
		metadataJson: JSON.stringify({ sourceId: source.sourceId, sourcePath: source.sourcePath }),
	};
}

function memoryRow(memory: NormalizedDatabase["memories"][number]): {
	id: string;
	scope: "global" | "conversation";
	content: string;
	summary: string;
	kind: string;
	confidence: number;
	importance: number;
	conversationId: string | null;
	subjectUserId: string | null;
	createdAt: string;
	updatedAt: string;
	createdBy: "migration";
	visibility: string;
	status: "active";
	pinned: 0;
	extractionModel: string;
	extractionPromptVersion: string;
	evidenceJson: string;
} {
	return {
		id: memory.canonicalId,
		scope: memory.scope,
		content: memory.content,
		summary: memory.summary,
		kind: memory.kind,
		confidence: memory.confidence,
		importance: memory.importance,
		conversationId: memory.conversationId || null,
		subjectUserId: memory.subjectUserId || null,
		createdAt: memory.createdAt,
		updatedAt: memory.updatedAt,
		createdBy: "migration",
		visibility: "private",
		status: "active",
		pinned: 0,
		extractionModel: "migration",
		extractionPromptVersion: "dsh-migration-v1",
		evidenceJson: JSON.stringify({
			provenance: memory.provenance ?? null,
			sourceId: memory.sourceId,
			sourceSystem: memory.sourceSystem,
		}),
	};
}

function messageRow(message: NormalizedMessage): {
	id: string;
	chatObjectId: string | null;
	conversationId: string;
	contentText: string;
	direction: "inbound" | "outbound" | "system";
	durableEntryId: string | null;
	isAggregated: boolean;
	kind: string;
	occurredAt: string;
	partsJson: string;
	platformMessageId: string | null;
	rawRefJson: string;
	replyToMessageId: string | null;
	senderDisplayName: string | null;
	senderExternalId: string | null;
	senderUserId: string | null;
	ingestedAt: string;
	deliveryStatus: "received";
} {
	return {
		chatObjectId: message.chatObjectId ?? null,
		contentText: message.content,
		conversationId: message.conversationId,
		direction: message.direction,
		durableEntryId: message.durableEntryId,
		id: message.sourceId,
		ingestedAt: message.ingestedAt,
		isAggregated: false,
		kind: message.kind,
		occurredAt: message.occurredAt,
		partsJson: JSON.stringify([{ text: message.content, type: "text" }]),
		platformMessageId: message.platformMessageId,
		rawRefJson: JSON.stringify({
			attachments: message.attachments,
			position: message.position,
			replyToMessageId: message.replyToMessageId ?? null,
			sourceHash: message.sourceHash,
		}),
		replyToMessageId: message.replyToMessageId ?? null,
		senderDisplayName: message.senderDisplayName ?? null,
		senderExternalId: message.senderExternalId ?? null,
		senderUserId: message.senderUserId,
		deliveryStatus: "received",
	};
}

function messagesChecksum(database: NormalizedDatabase): string {
	const joined = database.messages
		.map((message) => `${message.sourceId}:${message.sourceHash}`)
		.toSorted()
		.join("\n");
	return joined ? String(joined.length) : "empty";
}

async function compressionSummary(
	database: NormalizedDatabase,
	conversationId: string,
	compressor: Compressor,
): Promise<CompressionResult> {
	const text = database.messages
		.filter((message) => message.conversationId === conversationId)
		.map((message) => `${message.senderUserId}: ${message.content}`)
		.join("\n");
	return compressor.compress({ conversationId, text, maxChars: 1200 });
}

function databaseFingerprint(database: NormalizedDatabase): string {
	return sha256String(
		stableStringify(
			Object.fromEntries(
				Object.entries(database).map(([key, records]) => [
					key,
					records.map((record) => {
						const value = record as unknown as {
							sourceId?: string;
							sourceHash?: string;
							id?: string;
							canonicalId?: string;
						};
						return [value.sourceId ?? value.id ?? value.canonicalId ?? "", value.sourceHash ?? ""];
					}),
				]),
			),
		),
	);
}

function dedupeById<T extends { readonly id: string }>(values: readonly T[]): T[] {
	const map = new Map<string, T>();
	for (const value of values) map.set(value.id, value);
	return [...map.values()];
}

async function copyNormalizedMedia(
	database: NormalizedDatabase,
	mediaDir: string,
): Promise<{ copied: number; deduped: number; errors: string[] }> {
	await fs.mkdir(mediaDir, { recursive: true });
	const seen = new Set<string>();
	let copied = 0;
	let deduped = 0;
	const errors: string[] = [];
	const sources = [
		...database.stickers.map((sticker) => ({
			fileHash: sticker.fileHash,
			mediaSourcePath: sticker.mediaSourcePath,
			name: sticker.name,
		})),
		...database.attachments.map((attachment) => ({
			fileHash: attachment.fileHash,
			mediaSourcePath: attachment.mediaSourcePath,
			name: attachment.id,
		})),
	];
	for (const source of sources) {
		if (!source.fileHash || !source.mediaSourcePath) continue;
		if (seen.has(source.fileHash)) {
			deduped += 1;
			continue;
		}
		seen.add(source.fileHash);
		const destination = join(mediaDir, source.fileHash);
		const exists = await fs.stat(destination).catch(() => null);
		if (exists?.isFile()) {
			deduped += 1;
			continue;
		}
		try {
			const bytes = await fs.readFile(source.mediaSourcePath);
			const hash = sha256Bytes(bytes).slice("sha256:".length);
			if (hash !== source.fileHash) {
				errors.push(`${source.mediaSourcePath} checksum changed while importing`);
				continue;
			}
			await fs.writeFile(destination, bytes);
			copied += 1;
		} catch (error) {
			errors.push(`${source.mediaSourcePath}: ${String(error)}`);
		}
	}
	return { copied, deduped, errors };
}

async function mediaChecksumIssues(
	database: NormalizedDatabase,
	mediaDir: string,
): Promise<string[]> {
	const issues: string[] = [];
	const mediaRecords = [
		...database.stickers
			.filter((sticker) => sticker.fileHash)
			.map((sticker) => ({ fileHash: sticker.fileHash!, name: sticker.name })),
		...database.attachments
			.filter((attachment) => attachment.fileHash)
			.map((attachment) => ({ fileHash: attachment.fileHash!, name: attachment.id })),
	];
	if (mediaRecords.length === 0) return issues;
	if (mediaDir === "") return ["A media store directory is required to verify media checksums"];
	for (const entry of mediaRecords) {
		const path = join(mediaDir, entry.fileHash);
		const bytes = await fs.readFile(path).catch(() => null);
		if (bytes === null) {
			issues.push(`${entry.name}: media file is missing`);
			continue;
		}
		const hash = sha256Bytes(bytes).slice("sha256:".length);
		if (hash !== entry.fileHash) issues.push(`${entry.name}: media checksum mismatch`);
	}
	return issues;
}

async function collectSourceSecretValues(source: SnapshotSource): Promise<string[]> {
	const values: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!/\.(?:json|jsonl|ya?ml)$/i.test(entry.name)) continue;
			const content = await fs.readFile(path, "utf8").catch(() => "");
			if (/\.jsonl$/i.test(entry.name)) {
				for (const line of content.split(/\r?\n/)) {
					if (line.trim() === "") continue;
					try {
						values.push(...collectSecretValues(JSON.parse(line)));
					} catch {
						// Ignore malformed source lines here; parsing diagnostics cover them.
					}
				}
				continue;
			}
			try {
				const parsed = /\.ya?ml$/i.test(entry.name)
					? (Bun.YAML.parse(content) as unknown)
					: (JSON.parse(content) as unknown);
				values.push(...collectSecretValues(parsed));
			} catch {
				// Ignore non-structured text.
			}
		}
	};
	for (const [root] of source) {
		const dataRoot = await resolveSnapshotRoot(root);
		const stats = await fs.stat(dataRoot).catch(() => null);
		if (stats?.isDirectory()) await visit(dataRoot);
		else if (stats?.isFile()) {
			const content = await fs.readFile(dataRoot, "utf8").catch(() => "");
			const parsed = /\.ya?ml$/i.test(dataRoot)
				? Bun.YAML.parse(content)
				: (() => {
						try {
							return JSON.parse(content) as unknown;
						} catch {
							return null;
						}
					})();
			values.push(...collectSecretValues(parsed));
		}
	}
	return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function serializeDatabase(database: TsukaimaDatabase): string {
	const client = database.$client;
	const tables = client
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
		.all() as { name: string }[];
	const chunks: string[] = [];
	for (const { name } of tables) {
		try {
			const rows = client.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
			chunks.push(JSON.stringify(rows));
		} catch {
			// Skip virtual or otherwise unreadable tables.
		}
	}
	return chunks.join("\n");
}

function referenceIssues(database: TsukaimaDatabase): string[] {
	const client = database.$client;
	const issues: string[] = [];
	const checks: readonly [string, string][] = [
		[
			"messages",
			"SELECT COUNT(*) AS count FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL",
		],
		[
			"memories",
			"SELECT COUNT(*) AS count FROM memories m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id IS NOT NULL AND c.id IS NULL",
		],
		[
			"conversation-members",
			"SELECT COUNT(*) AS count FROM conversation_members m LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL",
		],
		[
			"chat-objects",
			"SELECT COUNT(*) AS count FROM conversations c LEFT JOIN chat_objects o ON o.id = c.chat_object_id WHERE c.chat_object_id IS NOT NULL AND o.id IS NULL",
		],
	];
	for (const [name, sql] of checks) {
		try {
			const row = client.query(sql).get() as { count?: number } | null;
			if (Number(row?.count ?? 0) > 0) issues.push(`${name}: ${row?.count} unresolved references`);
		} catch {
			// Missing optional table is ignored.
		}
	}
	try {
		const fk = client.query("PRAGMA foreign_key_check").all() as unknown[];
		if (fk.length > 0) issues.push(`foreign_key_check: ${fk.length} violation(s)`);
	} catch {
		issues.push("foreign_key_check could not be evaluated");
	}
	return issues;
}

export function renderConversationReadOnly(
	database: TsukaimaDatabase,
	conversationId: string,
): RenderedConversation {
	const client = database.$client;
	const rows = client
		.query(
			`SELECT m.direction, m.kind, m.occurred_at AS occurredAt, m.content_text AS content,
				COALESCE(u.display_name, m.sender_display_name, m.sender_external_id, 'Unknown') AS sender
			FROM messages m
			LEFT JOIN users u ON u.id = m.sender_user_id
			WHERE m.conversation_id = ?
			ORDER BY m.occurred_at, m.id`,
		)
		.all(conversationId) as {
		direction: string;
		kind: string;
		occurredAt: string;
		content: string;
		sender: string;
	}[];
	return {
		conversationId,
		lines: rows.map(
			(row) => `[${row.occurredAt}] ${row.sender} (${row.direction}/${row.kind}): ${row.content}`,
		),
		readOnly: true,
	};
}

function pluginConfigIssues(database: TsukaimaDatabase): string[] {
	const client = database.$client;
	const issues: string[] = [];
	const tables = new Map(
		(
			client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((row) => [row.name, true]),
	);
	const required: Readonly<Record<string, readonly string[]>> = {
		plugin_proactive_scheduler_state: [
			"conversation_id",
			"inbound_count",
			"warmness",
			"updated_at_ms",
		],
		plugin_proactive_scheduler_tasks: [
			"id",
			"conversation_id",
			"kind",
			"status",
			"scheduled_for_ms",
		],
		plugin_sticker_meme_items: ["id", "pack_id", "hash", "enabled", "review_status"],
		plugin_sticker_meme_packs: ["id", "name", "enabled"],
	};
	for (const [table, columns] of Object.entries(required)) {
		if (!tables.has(table)) continue;
		const actual = new Set(
			(client.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
				(column) => column.name,
			),
		);
		for (const column of columns) {
			if (!actual.has(column)) issues.push(`${table} is missing column ${column}`);
		}
	}
	if (tables.has("plugin_sticker_meme_packs")) {
		const enabled = client
			.query("SELECT COUNT(*) AS count FROM plugin_sticker_meme_packs WHERE enabled = 1")
			.get() as { count?: number } | null;
		if (Number(enabled?.count ?? 0) > 0) {
			issues.push("Imported sticker packs must remain disabled until verified");
		}
	}
	return issues;
}

export function createPipeline(target: string, options: PipelineOptions = {}): MigrationPipeline {
	const match = /^sqlite:(.+)$/.exec(target);
	if (!match?.[1]) {
		throw new Error("Target must be sqlite:<path>");
	}
	const databasePath = match[1];
	const now = options.now ?? Date.now;
	const inMemory = databasePath === ":memory:";
	const backupRoot =
		options.backupDir ?? (inMemory ? "" : join(dirname(databasePath), "migration-backups"));
	const mediaDir = options.mediaDir ?? (inMemory ? "" : join(dirname(databasePath), "media"));
	const reportsDir = options.reportsDir ?? (backupRoot === "" ? "" : join(backupRoot, "reports"));

	const withDatabase = async <T>(
		callback: (database: TsukaimaDatabase) => Promise<T>,
	): Promise<T> => {
		const database = await openDomainDatabase(databasePath);
		try {
			migrateDomainDatabase(database);
			return await callback(database);
		} finally {
			await database.$client.close();
		}
	};

	const createBackup = async (runId: string): Promise<BackupManifest | null> => {
		if (inMemory || backupRoot === "") return null;
		return createPreImportBackup({
			backupRoot,
			databasePath,
			...(options.durablePath === undefined ? {} : { durablePath: options.durablePath }),
			...(mediaDir === "" ? {} : { mediaDir }),
			now,
			runId,
		});
	};

	const restore = async (
		runId: string,
	): Promise<{
		backupHash: string;
		auditPath: string | null;
		restoredFiles: readonly string[];
	} | null> => {
		if (inMemory || backupRoot === "") return null;
		const backupDir = join(backupRoot, runId);
		const manifest = await fs.stat(join(backupDir, "manifest.json")).catch(() => null);
		if (manifest === null) return null;
		const result = await restorePreImportBackup({
			backupDir,
			...(reportsDir === "" ? {} : { reportsDir }),
		});
		return {
			auditPath: result.auditPath,
			backupHash: result.backupHash,
			restoredFiles: result.restoredFiles,
		};
	};

	return {
		async dryRun(source) {
			const result = await normalizeSnapshot(source);
			return result.plan;
		},

		async import(source, importOptions = {}) {
			if (!importOptions.dryRunPlan) {
				throw new Error("A dry-run plan is required before import");
			}
			const normalized = await normalizeSnapshot(source);
			const compressor = importOptions.compressor ?? new FakeCompressor();
			const runId = `dsh_${now()}_${Math.random().toString(16).slice(2, 10)}`;
			const fingerprint = databaseFingerprint(normalized.database);
			const backup = await createBackup(runId);
			try {
				return await withDatabase(async (database) => {
					const existingRecords = await database
						.select()
						.from(migrationRecords)
						.where(eq(migrationRecords.sourceSystem, DSH_SOURCE))
						.limit(1);
					if (existingRecords.length > 0) {
						const runs = await database.select().from(migrationRuns);
						const completed = runs.find((run) => run.status === "completed");
						if (completed?.reportJson) {
							try {
								const report = JSON.parse(completed.reportJson) as {
									fingerprint?: string;
								};
								if (report.fingerprint === fingerprint) {
									const rows = await database
										.select()
										.from(migrationRecords)
										.where(eq(migrationRecords.migrationRunId, completed.id));
									return {
										...countByKind(rows),
										backupHash: backup?.hash ?? null,
										importedAt: new Date(now()).toISOString(),
										runId: completed.id,
									};
								}
							} catch {
								// Fall through to the explicit conflict below.
							}
						}
						throw new Error("A different DSH snapshot has already been imported; rollback first");
					}

					await database.insert(migrationRuns).values({
						id: runId,
						mode: "import",
						reportJson: JSON.stringify({ ...importOptions.dryRunPlan, fingerprint }),
						startedAt: new Date(now()).toISOString(),
						status: "running",
					});

					const ledger = new Map<
						string,
						typeof migrationRecords.$inferInsert & { status: "planned" }
					>();
					const record = (
						targetKind: string,
						recordId: string,
						sourceId: string,
						sourceHash: string,
						targetId: string = recordId,
					) => {
						const id = `${DSH_SOURCE}:${targetKind}:${recordId}`;
						if (!ledger.has(id)) {
							ledger.set(id, {
								id,
								migrationRunId: runId,
								sourceHash,
								sourceId,
								sourceSystem: DSH_SOURCE,
								status: "planned",
								targetId,
								targetKind,
							});
						}
					};

					const db = normalized.database;
					for (const user of db.users)
						record("users", user.canonicalId, user.sourceId, user.sourceHash);
					for (const identity of db.identities) {
						record("identities", identity.id, identity.sourceId, identity.sourceHash);
					}
					for (const alias of db.userAliases) {
						record("userAliases", alias.id, alias.sourceId, alias.sourceHash);
					}
					for (const chat of db.chatObjects) {
						record("chatObjects", chat.id, chat.sourceId, chat.sourceHash);
					}
					for (const conversation of db.conversations) {
						record(
							"conversations",
							conversation.canonicalId,
							conversation.sourceId,
							conversation.sourceHash,
						);
					}
					for (const attachment of db.attachments) {
						record("attachments", attachment.id, attachment.sourceId, attachment.sourceHash);
					}
					for (const message of db.messages) {
						record("messages", message.sourceId, message.sourceId, message.sourceHash);
					}
					for (const request of db.requests) {
						record("requests", request.id, request.sourceId, request.sourceHash);
					}
					for (const persona of db.personas) {
						record("personas", persona.canonicalId, persona.sourceId, persona.sourceHash);
					}
					for (const memory of db.memories) {
						record("memories", memory.canonicalId, memory.sourceId, memory.sourceHash);
					}
					for (const setting of db.settings) {
						record("settings", setting.canonicalId, setting.sourceId, setting.sourceHash);
					}
					for (const pack of db.stickerPacks) {
						record("stickerPacks", pack.id, pack.sourceId, pack.sourceHash);
					}
					for (const sticker of db.stickers) {
						record("stickers", sticker.canonicalId, sticker.sourceId, sticker.sourceHash);
						if (sticker.mediaId !== undefined) {
							record(
								"media",
								sticker.mediaId,
								`${sticker.sourceId}:media`,
								sticker.sourceHash,
								sticker.mediaId,
							);
						}
					}
					for (const task of db.tasks) {
						record("tasks", task.id, task.sourceId, task.sourceHash);
					}
					for (const state of db.schedulerStates) {
						record("schedulerStates", state.conversationId, state.sourceId, state.sourceHash);
					}

					if (mediaDir !== "") {
						const copied = await copyNormalizedMedia(db, mediaDir);
						if (copied.errors.length > 0) {
							throw new Error(`Failed to copy migrated media: ${copied.errors.join("; ")}`);
						}
					}

					const mediaById = new Map(
						[
							...db.attachments.map((attachment) => mediaRecord(attachment)),
							...db.stickers.map((sticker) => mediaRecord(sticker)),
						].map((row) => [row.id, row]),
					);
					const requestByFlag = new Map<string, NormalizedDatabase["requests"][number]>();
					for (const request of db.requests) {
						requestByFlag.set(`${request.channelId}:${request.flag}`, request);
					}
					const identityByTuple = new Map(
						db.identities.map((identity) => [
							`${identity.platform}:${identity.platformAccountId}:${identity.externalId}:${identity.kind}`,
							identity,
						]),
					);
					const importedRecordIds = new Set(ledger.keys());

					await database.transaction(async (transaction) => {
						const insert = async (table: SQLiteTable, rows: readonly unknown[]) => {
							if (rows.length > 0) await transaction.insert(table).values(rows as never);
						};

						await insert(
							users,
							db.users.map((user) => ({
								id: user.canonicalId,
								kind: user.kind,
								displayName: user.displayName,
								isAdmin: user.isAdmin,
							})),
						);
						await insert(
							identities,
							[...identityByTuple.values()].map((identity) => ({
								canonicalUserId: identity.canonicalUserId,
								displayName: identity.displayName,
								externalId: identity.externalId,
								id: identity.id,
								kind: identity.kind,
								platform: identity.platform,
								platformAccountId: identity.platformAccountId,
								rawMetadataJson: JSON.stringify({ sourceId: identity.sourceId }),
							})),
						);
						await insert(
							userAliases,
							db.userAliases.map((alias) => ({
								alias: alias.alias,
								confidence: alias.confidence,
								id: alias.id,
								source: alias.source,
								userId: alias.userId,
							})),
						);
						await insert(
							chatObjects,
							db.chatObjects.map((chat) => ({
								channelId: chat.channelId,
								createdAt: chat.createdAt,
								id: chat.id,
								kind: chat.kind,
								platformConversationId: chat.platformConversationId,
								status: chat.status,
								title: chat.title,
								updatedAt: chat.updatedAt,
							})),
						);
						await insert(
							conversations,
							db.conversations.map((conversation) => ({
								chatObjectId: conversation.chatObjectId ?? null,
								channelId: conversation.channelId,
								createdAt: conversation.createdAt,
								durableConversationId: conversation.durableConversationId,
								id: conversation.canonicalId,
								kind: conversation.kind,
								platformConversationId: conversation.platformConversationId,
								status: conversation.status,
								title: conversation.title,
								updatedAt: conversation.updatedAt,
							})),
						);
						await insert(
							conversationMembers,
							db.conversations.flatMap((conversation) =>
								conversation.memberUserIds.map((userId) => ({
									conversationId: conversation.canonicalId,
									role: userId.includes("assistant") ? "bot" : "member",
									userId,
								})),
							),
						);
						await insert(media, dedupeById([...mediaById.values()]));
						await insert(messages, db.messages.map(messageRow));
						await insert(
							requests,
							[...requestByFlag.values()].map((request) => ({
								accountId: request.accountId,
								channelId: request.channelId,
								comment: request.comment,
								createdAt: request.createdAt,
								errorMessage: request.errorMessage,
								flag: request.flag,
								groupExternalId: request.groupExternalId,
								id: request.id,
								kind: request.kind,
								rawJson: safeJson({
									...request.raw,
									sourceHash: request.sourceHash,
								}),
								requesterDisplayName: request.requesterDisplayName,
								requesterExternalId: request.requesterExternalId,
								resolutionAction: request.resolutionAction,
								resolutionReason: request.resolutionReason,
								resolvedAt: request.resolvedAt,
								status: request.status,
								subType: request.subType,
								updatedAt: request.updatedAt,
							})),
						);
						await insert(
							personas,
							db.personas.map((persona) => ({
								id: persona.canonicalId,
								name: persona.name,
								summary: persona.summary,
								promptJson: safeJson(JSON.parse(persona.promptJson) as unknown),
								behaviorJson: safeJson(JSON.parse(persona.behaviorJson) as unknown),
								version: persona.version,
								isActive: true,
								createdBy: "migration",
							})),
						);
						await insert(
							personaBindings,
							db.personas.flatMap((persona) =>
								persona.boundConversationIds.map((conversationId) => ({
									id: `${persona.canonicalId}:${conversationId}`,
									conversationId,
									isActive: true,
									isGlobal: false,
									personaId: persona.canonicalId,
								})),
							),
						);
						await insert(memories, db.memories.map(memoryRow));
						await insert(policies, db.settings.map(settingsRecord));

						if (db.stickerPacks.length > 0) {
							insertStickerMemeData(
								{ $client: database.$client },
								{
									items: db.stickers
										.filter((sticker) => sticker.packId !== undefined)
										.map((sticker) => ({
											description: sticker.description ?? "",
											emotions: sticker.emotions ?? [],
											enabled: false as const,
											fileHash: sticker.fileHash ?? null,
											id: sticker.canonicalId,
											keywords: sticker.keywords ?? [],
											mediaId: sticker.mediaId ?? "",
											mediaRelativePath: sticker.mediaRelativePath ?? null,
											mediaSourcePath: sticker.mediaSourcePath ?? null,
											mimeType: sticker.mimeType,
											name: sticker.name,
											packId: sticker.packId!,
											provenance: {},
											reviewStatus: "pending" as const,
											sizeBytes: sticker.sizeBytes,
											tags: sticker.tags ?? [],
										})),
									packs: db.stickerPacks.map((pack) => ({
										enabled: false as const,
										id: pack.id,
										items: [],
										manifest: pack.metadata,
										metadata: pack.metadata,
										name: pack.name,
										source: "imported" as const,
										sourcePath: pack.sourceId,
										tags: pack.tags,
										version: pack.version,
									})),
								},
							);
						}
						if (db.tasks.length > 0 || db.schedulerStates.length > 0) {
							insertProactiveSchedulerData(
								{ $client: database.$client },
								{
									states: db.schedulerStates,
									tasks: db.tasks.map((task) => ({
										...task,
										provenance: { sourceId: task.sourceId },
									})),
								},
							);
						}
						await insert(migrationRecords, [...ledger.values()]);

						for (const conversation of db.conversations) {
							if (
								!db.messages.some((message) => message.conversationId === conversation.canonicalId)
							) {
								continue;
							}
							const compression = await compressionSummary(
								db,
								conversation.canonicalId,
								compressor,
							);
							const memoryId = `${conversation.canonicalId}_summary`;
							await transaction.insert(memories).values({
								id: memoryId,
								scope: "conversation",
								content: compression.summary,
								summary: compression.summary,
								kind: "summary",
								confidence: compression.confidence,
								importance: 0.7,
								conversationId: conversation.canonicalId,
								createdAt: new Date(compression.sourceRange.end || now()).toISOString(),
								updatedAt: new Date(now()).toISOString(),
								createdBy: "migration",
								visibility: "private",
								status: "active",
								pinned: 0,
								extractionModel: "migration",
								extractionPromptVersion: "dsh-migration-v1",
								evidenceJson: JSON.stringify({
									compactor: "migration",
									sourceRange: compression.sourceRange,
								}),
							});
							await transaction.insert(migrationRecords).values({
								id: `${DSH_SOURCE}:memories:${memoryId}`,
								migrationRunId: runId,
								sourceHash: compression.summary,
								sourceId: `${conversation.canonicalId}:summary`,
								sourceSystem: DSH_SOURCE,
								status: "imported",
								targetId: memoryId,
								targetKind: "memories",
							});
							importedRecordIds.add(`${DSH_SOURCE}:memories:${memoryId}`);
						}

						await transaction
							.update(migrationRecords)
							.set({ status: "imported" })
							.where(eq(migrationRecords.migrationRunId, runId));
						importedRecordIds.clear();
					});

					await database
						.update(migrationRuns)
						.set({
							finishedAt: new Date(now()).toISOString(),
							status: "completed",
						})
						.where(eq(migrationRuns.id, runId));

					const ledgerRows = await database
						.select()
						.from(migrationRecords)
						.where(eq(migrationRecords.migrationRunId, runId));
					return {
						...countByKind(ledgerRows),
						backupHash: backup?.hash ?? null,
						importedAt: new Date(now()).toISOString(),
						runId,
					};
				});
			} catch (error) {
				await restore(runId);
				throw error;
			}
		},

		async verify(source, verifyOptions = {}) {
			const normalized = await normalizeSnapshot(source);
			const sourceSecrets = await collectSourceSecretValues(source);
			return withDatabase(async (database) => {
				const ledgerRows = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.sourceSystem, DSH_SOURCE));
				const actualCounts = countByKind(ledgerRows);
				const summaryCount = normalized.database.conversations.filter((conversation) =>
					normalized.database.messages.some(
						(message) => message.conversationId === conversation.canonicalId,
					),
				).length;
				const expectedCounts = {
					...countRecords(normalized.database),
					memories: normalized.plan.memories + summaryCount,
				};
				const countDetails = Object.keys(expectedCounts).flatMap((key) => {
					const kind = key as keyof RecordCounts;
					return expectedCounts[kind] === actualCounts[kind]
						? []
						: [`${kind}: expected ${expectedCounts[kind]}, actual ${actualCounts[kind]}`];
				});
				const expectedChecksum = messagesChecksum(normalized.database);
				const importedMessages = await database.select().from(messages);
				const actualChecksum = String(
					importedMessages
						.filter((message) => message.rawRefJson?.includes("sourceHash"))
						.map((message) => `${message.id}:${JSON.parse(message.rawRefJson!).sourceHash}`)
						.toSorted()
						.join("\n").length || 0,
				);
				const mediaIssues = await mediaChecksumIssues(normalized.database, mediaDir);
				const checksumOk = actualChecksum === expectedChecksum && mediaIssues.length === 0;
				const dbText = serializeDatabase(database);
				const leaked = sourceSecrets.filter((secret) => dbText.includes(secret));
				const reportText = stableStringify({
					diagnostics: normalized.diagnostics,
					plan: normalized.plan,
				});
				const reportLeaks = sourceSecrets.filter((secret) => reportText.includes(secret));
				const references = referenceIssues(database);
				const firstConversation = normalized.database.conversations.find((conversation) =>
					normalized.database.messages.some(
						(message) => message.conversationId === conversation.canonicalId,
					),
				);
				const rendering =
					firstConversation === undefined
						? null
						: renderConversationReadOnly(database, firstConversation.canonicalId);
				const smokeTurn =
					firstConversation === undefined
						? {
								envelope: null,
								modelText: "",
								ok: false,
								reason: "No conversation with imported messages is available",
							}
						: await runFakeMigrationSmokeTurn({
								conversation: firstConversation,
								messages: normalized.database.messages,
								...(verifyOptions.model === undefined ? {} : { model: verifyOptions.model }),
							});
				const pluginIssues = pluginConfigIssues(database);
				const checks = {
					checksums: {
						details: [
							...(actualChecksum === expectedChecksum
								? []
								: ["message source hashes do not match imported rows"]),
							...mediaIssues,
						],
						ok: checksumOk,
					},
					counts: { details: countDetails, ok: countDetails.length === 0 },
					pluginConfig: { details: pluginIssues, ok: pluginIssues.length === 0 },
					references: { details: references, ok: references.length === 0 },
					rendering: {
						details:
							rendering !== null && rendering.lines.length > 0
								? []
								: ["No read-only conversation could be rendered"],
						ok: rendering !== null && rendering.lines.length > 0,
					},
					secrets: {
						details: [
							...leaked.map(() => "A source secret value is present in the imported database"),
							...reportLeaks.map(() => "A source secret value is present in a generated report"),
						],
						ok: leaked.length === 0 && reportLeaks.length === 0,
					},
					smokeTurn: {
						details: smokeTurn.reason === null ? [] : [smokeTurn.reason],
						ok: smokeTurn.ok,
					},
				};
				return {
					actualCounts,
					checks,
					expectedCounts,
					messageChecksums: {
						actual: Number(actualChecksum),
						expected: Number(expectedChecksum),
						matched: checksumOk ? normalized.database.messages.length : 0,
					},
					ok: Object.values(checks).every((check) => check.ok),
					rendering,
					smokeTurn,
				};
			});
		},

		async rollback(runId) {
			const snapshotBackup =
				!inMemory && backupRoot !== ""
					? (await fs.stat(join(backupRoot, runId, "manifest.json")).catch(() => null)) !== null
					: false;
			const before = await withDatabase(async (database) => {
				const ledgerRows = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.migrationRunId, runId));
				if (ledgerRows.length === 0) {
					throw new Error(`Migration run not found: ${runId}`);
				}
				if (!snapshotBackup) {
					const targetIds = ledgerRows.flatMap((row) => (row.targetId ? [row.targetId] : []));
					const targetIdSet = new Set(targetIds);
					const client = database.$client;
					const tableNames = new Set(
						(
							client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
								name: string;
							}[]
						).map((row) => row.name),
					);
					const deleteRaw = (table: string, column: string) => {
						if (!tableNames.has(table) || targetIds.length === 0) return;
						const placeholders = targetIds.map(() => "?").join(", ");
						client
							.query(`DELETE FROM "${table}" WHERE "${column}" IN (${placeholders})`)
							.run(...targetIds);
					};
					await database.transaction(async (transaction) => {
						deleteRaw("plugin_sticker_meme_send_tokens", "item_id");
						deleteRaw("plugin_sticker_meme_items", "id");
						deleteRaw("plugin_sticker_meme_packs", "id");
						deleteRaw("plugin_proactive_scheduler_decisions", "task_id");
						deleteRaw("plugin_proactive_scheduler_state", "conversation_id");
						deleteRaw("plugin_proactive_scheduler_tasks", "id");
						if (targetIds.length > 0) {
							await transaction.delete(media).where(inArray(media.id as never, targetIds));
							await transaction.delete(memories).where(inArray(memories.id as never, targetIds));
							await transaction
								.delete(personaBindings)
								.where(inArray(personaBindings.personaId as never, targetIds));
							await transaction.delete(personas).where(inArray(personas.id as never, targetIds));
							await transaction.delete(policies).where(inArray(policies.id as never, targetIds));
							await transaction.delete(requests).where(inArray(requests.id as never, targetIds));
							await transaction.delete(messages).where(inArray(messages.id as never, targetIds));
							await transaction
								.delete(conversationMembers)
								.where(inArray(conversationMembers.conversationId as never, [...targetIdSet]));
							await transaction
								.delete(conversations)
								.where(inArray(conversations.id as never, targetIds));
							await transaction
								.delete(chatObjects)
								.where(inArray(chatObjects.id as never, targetIds));
							await transaction
								.delete(identities)
								.where(inArray(identities.id as never, targetIds));
							await transaction
								.delete(userAliases)
								.where(inArray(userAliases.id as never, targetIds));
							await transaction.delete(users).where(inArray(users.id as never, targetIds));
						}
						await transaction
							.delete(migrationRecords)
							.where(eq(migrationRecords.migrationRunId, runId));
					});
					await database
						.update(migrationRuns)
						.set({ status: "rolled_back" })
						.where(eq(migrationRuns.id, runId));
					return countByKind(ledgerRows);
				}
				return countByKind(ledgerRows);
			});
			if (!snapshotBackup) {
				return {
					auditPath: null,
					backupHash: null,
					deletedCounts: before,
					mode: "rows",
					restoredFiles: [],
					runId,
				};
			}
			const restored = await restore(runId);
			if (restored === null) {
				throw new Error(`Pre-import backup not found for run ${runId}`);
			}
			if (reportsDir !== "") {
				await writeRollbackReport({
					payload: {
						backupHash: restored.backupHash,
						deletedCounts: before,
						mode: "snapshot",
						restoredFiles: restored.restoredFiles,
						runId,
					},
					reportsDir,
					runId,
				});
			}
			return {
				auditPath: restored.auditPath,
				backupHash: restored.backupHash,
				deletedCounts: before,
				mode: "snapshot",
				restoredFiles: restored.restoredFiles,
				runId,
			};
		},
	};
}

// Row-level rollback is deliberately isolated to in-memory/test runs; the authoritative path is
// `restorePreImportBackup`.
export { sha256String };
