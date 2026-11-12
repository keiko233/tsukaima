import type { Context } from "@earendil-works/chord/context";
import type {
	CommitResult,
	Cursor,
	ConversationQuery,
	ConversationId,
	ConversationRecord,
	DocumentAddress,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	DocumentId,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionQuery,
	SubmissionId,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@tsukaima/durable";

type Operation = () => Promise<unknown>;

export class TransientFailure extends Error {
	constructor(message = "Injected transient durable storage failure") {
		super(message);
		this.name = "TransientFailure";
	}
}

export class DurableFailure extends Error {
	constructor(
		message: string,
		options?: {
			readonly cause?: unknown;
		},
	) {
		super(message, options);
		this.name = "DurableFailure";
	}
}

export type TransientFailureScheduler = (operation: string) => boolean;

export interface TransientStorageOptions {
	readonly fail?: TransientFailureScheduler;
	readonly maxRetries?: number;
}

const defaultMaxRetries = 3;

export class TransientStorage implements Storage {
	private readonly inner: SqliteStorage;
	private readonly fail: TransientFailureScheduler | undefined;
	private readonly maxRetries: number;

	constructor(inner: SqliteStorage, options: TransientStorageOptions = {}) {
		this.inner = inner;
		this.fail = options.fail;
		this.maxRetries = options.maxRetries ?? defaultMaxRetries;
	}

	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		return await this.execute(
			"commit",
			async () => await this.inner.commit(batches, receive, context),
		);
	}

	async mintId<IdKind extends Id<IdKind>>(): Promise<IdKind> {
		return await this.execute("mintId", async () => await this.inner.mintId<IdKind>());
	}

	async conversation(
		id: ConversationId,
		context: Context,
	): Promise<ConversationRecord | undefined> {
		return await this.execute(
			"conversation",
			async () => await this.inner.conversation(id, context),
		);
	}

	async scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return await this.execute(
			"scanConversations",
			async () => await this.inner.scanConversations(query, limit, cursor, context),
		);
	}

	async entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	async entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<StoredEntry | undefined>;
	async entry(
		conversationIdOrId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<StoredEntry | undefined> {
		return await this.execute("entry", async () => {
			if (context === undefined) {
				return await this.inner.entry(conversationIdOrId as EntryId, idOrContext as Context);
			}
			return await this.inner.entry(
				conversationIdOrId as ConversationId,
				idOrContext as EntryId,
				context,
			);
		});
	}

	async findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return await this.execute(
			"findLatestHeadMarker",
			async () => await this.inner.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context),
		);
	}

	async scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return await this.execute(
			"scanEntries",
			async () => await this.inner.scanEntries(query, limit, cursor, context),
		);
	}

	async task(
		id: TaskId,
		context: Context,
	): Promise<TaskRecord<unknown, unknown, unknown> | undefined> {
		return await this.execute("task", async () => await this.inner.task(id, context));
	}

	async scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<unknown, unknown, unknown>, Cursor>> {
		return await this.execute(
			"scanTasks",
			async () => await this.inner.scanTasks(query, limit, cursor, context),
		);
	}

	async submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return await this.execute("submission", async () => await this.inner.submission(id, context));
	}

	async scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return await this.execute(
			"scanSubmissions",
			async () => await this.inner.scanSubmissions(query, limit, cursor, context),
		);
	}

	async submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return await this.execute(
			"submissionByRequest",
			async () => await this.inner.submissionByRequest(conversationId, requestId, context),
		);
	}

	async findDocument(
		address: DocumentAddress,
		at: DocumentPoint,
		context: Context,
	): Promise<DocumentRecord | undefined> {
		return await this.execute(
			"findDocument",
			async () => await this.inner.findDocument(address, at, context),
		);
	}

	async document(
		id: DocumentId,
		at: DocumentPoint,
		context: Context,
	): Promise<StoredDocument | undefined> {
		return await this.execute("document", async () => await this.inner.document(id, at, context));
	}

	async scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return await this.execute(
			"scanDocuments",
			async () => await this.inner.scanDocuments(query, limit, cursor, context),
		);
	}

	async close(context: Context): Promise<void> {
		await this.execute("close", async () => await this.inner.close(context));
	}

	private async execute<T>(operation: string, run: Operation, retry = true): Promise<T> {
		let attempt = 0;
		let lastError: unknown;
		const maxAttempts = retry ? this.maxRetries : 1;
		while (attempt < maxAttempts) {
			if (this.fail?.(operation)) {
				lastError = new TransientFailure();
				attempt += 1;
				continue;
			}
			try {
				return (await run()) as T;
			} catch (error) {
				lastError = error;
				if (!retry) break;
				attempt += 1;
			}
		}
		throw new DurableFailure(`Durable operation failed: ${operation}`, { cause: lastError });
	}
}

export interface StoredEntry {
	readonly entry: EntryRecord;
	readonly commitSeq: Seq;
}
