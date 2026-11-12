import { eq, inArray } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	conversations,
	conversationMembers,
	type ElainaDatabase,
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
	users,
} from "@elaina/db";
import { DSH_SOURCE, type SnapshotSource } from "./dsh-inspect.ts";
import { FakeCompressor, type Compressor, type CompressionResult } from "./compressor.ts";
import {
	countRecords,
	normalizeSnapshot,
	type MigrationPlan,
	type NormalizedDatabase,
	type NormalizedMessage,
	type NormalizedSetting,
	type NormalizedSticker,
	type RecordCounts,
} from "./normalize.ts";

export interface SnapshotPaths {
	readonly source: readonly string[];
}

export interface ImportOptions {
	readonly compressor?: Compressor;
	readonly dryRunPlan?: MigrationPlan;
}

export interface ImportResult extends RecordCounts {
	readonly runId: string;
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
}

export interface RollbackResult {
	readonly runId: string;
	readonly deletedCounts: RecordCounts;
}

export interface MigrationPipeline {
	dryRun(source: SnapshotSource): Promise<MigrationPlan>;
	import(source: SnapshotSource, options?: ImportOptions): Promise<ImportResult>;
	verify(source: SnapshotSource): Promise<VerifyResult>;
	rollback(runId: string): Promise<RollbackResult>;
}

function countByKind(rows: Array<{ targetKind: string; status: string }>): RecordCounts {
	const counts = countRecords({
		users: [],
		conversations: [],
		messages: [],
		personas: [],
		memories: [],
		settings: [],
		stickers: [],
	});
	for (const row of rows) {
		if (row.status !== "imported") {
			continue;
		}
		const key = row.targetKind as keyof RecordCounts;
		if (key in counts) {
			counts[key] += 1;
		}
	}
	return counts;
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
		policyJson: setting.valueJson,
		isActive: true,
	};
}

function mediaRecord(sticker: NormalizedSticker): {
	id: string;
	kind: "sticker";
	mimeType: string;
	sha256: string;
	sizeBytes: number;
	source: "migration";
	metadataJson: string;
} {
	return {
		id: sticker.canonicalId,
		kind: "sticker",
		mimeType: sticker.mimeType,
		sha256: sticker.sourceHash,
		sizeBytes: sticker.sizeBytes,
		source: "migration",
		metadataJson: JSON.stringify({ name: sticker.name, sourceId: sticker.sourceId }),
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
	createdAt: string;
	updatedAt: string;
	createdBy: "migration";
	visibility: string;
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
		createdAt: memory.createdAt,
		updatedAt: memory.updatedAt,
		createdBy: "migration",
		visibility: "private",
	};
}

function messageRow(message: NormalizedMessage): {
	id: string;
	conversationId: string;
	direction: "inbound" | "outbound" | "system";
	durableEntryId: string | null;
	isAggregated: boolean;
	kind: string;
	occurredAt: string;
	platformMessageId: string | null;
	rawRefJson: string;
	senderUserId: string | null;
	ingestedAt: string;
} {
	return {
		id: message.sourceId,
		conversationId: message.conversationId,
		direction: message.direction,
		durableEntryId: message.durableEntryId,
		isAggregated: false,
		kind: message.kind,
		occurredAt: message.occurredAt,
		platformMessageId: message.platformMessageId,
		rawRefJson: JSON.stringify({
			sourceHash: message.sourceHash,
			attachments: message.attachments,
			position: message.position,
		}),
		senderUserId: message.senderUserId,
		ingestedAt: message.ingestedAt,
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

export function createPipeline(target: string): MigrationPipeline {
	const match = /^sqlite:(.+)$/.exec(target);
	if (!match?.[1]) {
		throw new Error("Target must be sqlite:<path>");
	}
	const databasePath = match[1];

	const withDatabase = async <T>(
		callback: (database: ElainaDatabase) => Promise<T>,
	): Promise<T> => {
		const database = await openDomainDatabase(databasePath);
		try {
			migrateDomainDatabase(database);
			return await callback(database);
		} finally {
			await database.$client.close();
		}
	};

	return {
		async dryRun(source) {
			const result = await normalizeSnapshot(source);
			return result.plan;
		},

		async import(source, options = {}) {
			if (!options.dryRunPlan) {
				throw new Error("A dry-run plan is required before import");
			}
			const normalized = await normalizeSnapshot(source);
			const compressor = options.compressor ?? new FakeCompressor();
			const runId = `dsh_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

			return withDatabase(async (database) => {
				const existingRun = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.sourceSystem, DSH_SOURCE))
					.limit(1);
				if (existingRun.length > 0) {
					throw new Error("Snapshot has already been imported; rollback first");
				}

				await database.insert(migrationRuns).values({
					id: runId,
					mode: "import",
					reportJson: JSON.stringify(options.dryRunPlan),
					startedAt: new Date().toISOString(),
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
					targetId?: string,
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

				for (const user of normalized.database.users) {
					record("users", user.canonicalId, user.sourceId, user.sourceHash);
				}
				for (const conversation of normalized.database.conversations) {
					record(
						"conversations",
						conversation.canonicalId,
						conversation.sourceId,
						conversation.sourceHash,
					);
				}
				for (const message of normalized.database.messages) {
					record("messages", message.sourceId, message.sourceId, message.sourceHash);
				}
				for (const persona of normalized.database.personas) {
					record("personas", persona.canonicalId, persona.sourceId, persona.sourceHash);
				}
				for (const memory of normalized.database.memories) {
					record("memories", memory.canonicalId, memory.sourceId, memory.sourceHash);
				}
				for (const setting of normalized.database.settings) {
					record("settings", setting.canonicalId, setting.sourceId, setting.sourceHash);
				}
				for (const sticker of normalized.database.stickers) {
					record("stickers", sticker.canonicalId, sticker.sourceId, sticker.sourceHash);
				}

				await database.transaction(async (transaction) => {
					const insert = async (table: SQLiteTable, rows: readonly unknown[]) => {
						if (rows.length > 0) {
							await transaction.insert(table).values(rows as never);
						}
					};

					await insert(
						users,
						normalized.database.users.map((user) => ({
							id: user.canonicalId,
							kind: user.kind,
							displayName: user.displayName,
							isAdmin: user.isAdmin,
						})),
					);
					await insert(
						conversations,
						normalized.database.conversations.map((conversation) => ({
							id: conversation.canonicalId,
							kind: conversation.kind,
							channelId: conversation.channelId,
							platformConversationId: conversation.platformConversationId,
							durableConversationId: conversation.durableConversationId,
							title: conversation.title,
							status: conversation.status,
							createdAt: conversation.createdAt,
							updatedAt: conversation.updatedAt,
						})),
					);
					await insert(
						conversationMembers,
						normalized.database.conversations.flatMap((conversation) =>
							conversation.memberUserIds.map((userId) => ({
								conversationId: conversation.canonicalId,
								userId,
								role: userId.includes("assistant") ? "bot" : "member",
							})),
						),
					);
					await insert(messages, normalized.database.messages.map(messageRow));
					await insert(
						personas,
						normalized.database.personas.map((persona) => ({
							id: persona.canonicalId,
							name: persona.name,
							summary: persona.summary,
							promptJson: persona.promptJson,
							behaviorJson: persona.behaviorJson,
							version: persona.version,
							isActive: true,
							createdBy: "migration",
						})),
					);
					await insert(
						personaBindings,
						normalized.database.personas.flatMap((persona) =>
							persona.boundConversationIds.map((conversationId) => ({
								id: `${persona.canonicalId}:${conversationId}`,
								conversationId,
								isActive: true,
								isGlobal: false,
								personaId: persona.canonicalId,
							})),
						),
					);
					await insert(memories, normalized.database.memories.map(memoryRow));
					await insert(policies, normalized.database.settings.map(settingsRecord));
					await insert(media, normalized.database.stickers.map(mediaRecord));
					await insert(migrationRecords, [...ledger.values()]);

					const importedRecordIds = new Set(ledger.keys());
					for (const conversation of normalized.database.conversations) {
						if (
							!normalized.database.messages.some(
								(message) => message.conversationId === conversation.canonicalId,
							)
						) {
							continue;
						}
						const compression = await compressionSummary(
							normalized.database,
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
							createdAt: new Date(compression.sourceRange.end || Date.now()).toISOString(),
							updatedAt: new Date().toISOString(),
							createdBy: "migration",
							visibility: "private",
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
						finishedAt: new Date().toISOString(),
						status: "completed",
					})
					.where(eq(migrationRuns.id, runId));

				const ledgerRows = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.migrationRunId, runId));
				return {
					runId,
					...countByKind(ledgerRows),
				};
			});
		},

		async verify(source) {
			const normalized = await normalizeSnapshot(source);
			return withDatabase(async (database) => {
				const ledgerRows = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.sourceSystem, DSH_SOURCE));
				const actualCounts = countByKind(ledgerRows);
				const expectedCounts = normalized.plan;
				const expectedChecksum = messagesChecksum(normalized.database);
				const importedMessages = await database.select().from(messages);
				const actualChecksum = String(
					importedMessages
						.filter((message) => message.rawRefJson?.includes("sourceHash"))
						.map((message) => `${message.id}:${JSON.parse(message.rawRefJson!).sourceHash}`)
						.toSorted()
						.join("\n").length || 0,
				);
				return {
					ok:
						actualCounts.messages === expectedCounts.messages &&
						actualCounts.conversations === expectedCounts.conversations &&
						actualChecksum === expectedChecksum,
					expectedCounts,
					actualCounts,
					messageChecksums: {
						expected: Number(expectedChecksum),
						actual: Number(actualChecksum),
						matched: actualChecksum === expectedChecksum ? normalized.database.messages.length : 0,
					},
				};
			});
		},

		async rollback(runId) {
			return withDatabase(async (database) => {
				const ledgerRows = await database
					.select()
					.from(migrationRecords)
					.where(eq(migrationRecords.migrationRunId, runId));
				if (ledgerRows.length === 0) {
					throw new Error(`Migration run not found: ${runId}`);
				}
				const before = countByKind(ledgerRows);
				const targetIds = ledgerRows.flatMap((row) => (row.targetId ? [row.targetId] : []));

				const inTargetIds = (column: unknown) => inArray(column as never, targetIds);
				await database.transaction(async (transaction) => {
					if (targetIds.length > 0) {
						await transaction.delete(media).where(inTargetIds(media.id));
						await transaction.delete(memories).where(inTargetIds(memories.id));
						await transaction.delete(personaBindings).where(inTargetIds(personaBindings.personaId));
						await transaction.delete(personas).where(inTargetIds(personas.id));
						await transaction.delete(policies).where(inTargetIds(policies.id));
						await transaction.delete(messages).where(inTargetIds(messages.id));
						await transaction
							.delete(conversationMembers)
							.where(inTargetIds(conversationMembers.conversationId));
						await transaction.delete(conversations).where(inTargetIds(conversations.id));
						await transaction.delete(users).where(inTargetIds(users.id));
					}
					await transaction
						.delete(migrationRecords)
						.where(eq(migrationRecords.migrationRunId, runId));
				});

				await database
					.update(migrationRuns)
					.set({ status: "rolled_back" })
					.where(eq(migrationRuns.id, runId));
				return {
					runId,
					deletedCounts: before,
				};
			});
		},
	};
}
