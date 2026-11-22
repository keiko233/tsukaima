import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lte,
	ne,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { ConversationPolicy } from "@tsukaima/contracts";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";

export const CHAT_HISTORY_SERVICE_BINDING = "tsukaima.chatHistory.service";

/** Ordinary chat surfaces only; workspace, task, and plugin sessions are never readable. */
export const CHAT_HISTORY_KINDS = ["private", "group", "webui"] as const;
export type ChatHistoryKind = (typeof CHAT_HISTORY_KINDS)[number];

const SESSION_LIMIT_MAX = 30;
const SESSION_LIMIT_DEFAULT = 15;
const SEARCH_LIMIT_MAX = 30;
const SEARCH_LIMIT_DEFAULT = 15;
const READ_LIMIT_MAX = 50;
const READ_LIMIT_DEFAULT = 20;
const MAX_QUERY_TERMS = 5;
/** Candidate rows fetched before per-session privacy filtering trims them to the caller's limit. */
const CANDIDATE_MULTIPLIER = 6;
const CANDIDATE_FLOOR = 60;
const CANDIDATE_CEILING = 300;

export interface ChatHistorySessionIdentity {
	readonly id: string;
	readonly kind: string;
	readonly title: string | null;
	readonly chatObjectId: string | null;
}

export interface ChatHistorySession extends ChatHistorySessionIdentity {
	readonly kind: ChatHistoryKind;
	readonly platformConversationId: string | null;
	readonly updatedAt: string;
	readonly redacted: boolean;
}

export interface ChatHistoryMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly sessionKind: ChatHistoryKind;
	readonly sessionTitle: string | null;
	readonly occurredAt: string;
	readonly direction: string;
	readonly senderDisplayName: string | null;
	readonly senderExternalId: string | null;
	readonly senderUserId: string | null;
	readonly contentText: string | null;
	readonly redacted: boolean;
}

export interface ChatHistoryDenial {
	readonly reason: string;
	readonly message: string;
}

export interface ChatHistorySearchResult {
	readonly messages: readonly ChatHistoryMessage[];
	readonly denied?: ChatHistoryDenial | undefined;
}

export type ChatHistoryReadResult =
	| {
			readonly ok: true;
			readonly session: ChatHistorySession;
			readonly messages: readonly ChatHistoryMessage[];
	  }
	| {
			readonly ok: false;
			readonly denied: ChatHistoryDenial;
	  };

export interface ChatHistoryServiceOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly policyService: ConversationPolicyService;
}

export interface ChatHistoryListInput {
	readonly kind?: ChatHistoryKind | undefined;
	readonly limit?: number | undefined;
	readonly query?: string | undefined;
}

export interface ChatHistorySearchInput {
	readonly after?: string | undefined;
	readonly before?: string | undefined;
	readonly kind?: ChatHistoryKind | undefined;
	readonly limit?: number | undefined;
	readonly query?: string | undefined;
	readonly sender?: string | undefined;
	readonly sessionId?: string | undefined;
}

export interface ChatHistoryReadInput {
	readonly after?: string | undefined;
	readonly aroundMessageId?: string | undefined;
	readonly before?: string | undefined;
	readonly limit?: number | undefined;
	readonly sessionId?: string | undefined;
}

interface SessionRow {
	readonly chatObjectId: string | null;
	readonly chatObjectTitle: string | null;
	readonly conversationTitle: string | null;
	readonly id: string;
	readonly kind: string;
	readonly platformConversationId: string | null;
	readonly updatedAt: string;
}

interface MessageRowWithSession {
	readonly chatObjectTitle: string | null;
	readonly contentText: string | null;
	readonly conversationId: string;
	readonly conversationKind: string;
	readonly conversationTitle: string | null;
	readonly direction: string;
	readonly id: string;
	readonly occurredAt: string;
	readonly senderDisplayName: string | null;
	readonly senderExternalId: string | null;
	readonly senderUserId: string | null;
}

type AccessResult =
	| {
			readonly allowed: true;
			readonly redacted: boolean;
	  }
	| {
			readonly allowed: false;
			readonly denied: ChatHistoryDenial;
	  };

function clamp(value: number | undefined, fallback: number, maximum: number): number {
	const requested = value === undefined || !Number.isFinite(value) ? fallback : Math.floor(value);
	return Math.min(maximum, Math.max(1, requested));
}

function combine(conditions: readonly (SQL | undefined)[]): SQL {
	const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
	return filtered.length === 0 ? sql`1 = 1` : (and(...filtered) ?? sql`1 = 1`);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function likePattern(value: string): string {
	return `%${escapeLike(value.toLowerCase())}%`;
}

function columnLike(column: SQLWrapper, value: string): SQL {
	return sql`coalesce(lower(${column}), '') LIKE ${likePattern(value)} ESCAPE '\\'`;
}

function normalizeTimestamp(value: string): string | undefined {
	// `Date.parse` accepts many loose formats, including ids like `msg-private-3`, so a cursor
	// is only treated as a timestamp when it starts with a calendar date and a time.
	if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u.test(value)) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isChatKind(value: string): value is ChatHistoryKind {
	return (CHAT_HISTORY_KINDS as readonly string[]).includes(value);
}

function titleOf(row: { chatObjectTitle: string | null; conversationTitle: string | null }) {
	const title = row.conversationTitle ?? row.chatObjectTitle;
	return title === null || title.trim().length === 0 ? null : title;
}

function toSessionIdentity(row: SessionRow): ChatHistorySessionIdentity {
	return {
		chatObjectId: row.chatObjectId,
		id: row.id,
		kind: row.kind,
		title: titleOf(row),
	};
}

function toSession(row: SessionRow, redacted: boolean): ChatHistorySession {
	if (!isChatKind(row.kind)) throw new Error("Only ordinary chat sessions are readable");
	return {
		chatObjectId: row.chatObjectId,
		id: row.id,
		kind: row.kind,
		platformConversationId: redacted ? null : row.platformConversationId,
		redacted,
		title: redacted ? null : titleOf(row),
		updatedAt: row.updatedAt,
	};
}

function toMessage(row: MessageRowWithSession, redacted: boolean): ChatHistoryMessage | undefined {
	if (!isChatKind(row.conversationKind)) return undefined;
	return {
		contentText: redacted ? null : row.contentText,
		direction: row.direction,
		id: row.id,
		occurredAt: row.occurredAt,
		redacted,
		senderDisplayName: redacted ? null : row.senderDisplayName,
		senderExternalId: redacted ? null : row.senderExternalId,
		senderUserId: redacted ? null : row.senderUserId,
		sessionId: row.conversationId,
		sessionKind: row.conversationKind,
		sessionTitle: redacted
			? null
			: titleOf({
					chatObjectTitle: row.chatObjectTitle,
					conversationTitle: row.conversationTitle,
				}),
	};
}

function denied(reason: string, message: string): AccessResult {
	return { allowed: false, denied: { message, reason } };
}

function sessionRowColumns() {
	return {
		chatObjectId: conversations.chatObjectId,
		chatObjectTitle: chatObjects.title,
		conversationTitle: conversations.title,
		id: conversations.id,
		kind: conversations.kind,
		platformConversationId: conversations.platformConversationId,
		updatedAt: conversations.updatedAt,
	};
}

function messageColumns() {
	return {
		chatObjectTitle: chatObjects.title,
		contentText: messages.contentText,
		conversationId: messages.conversationId,
		conversationKind: conversations.kind,
		conversationTitle: conversations.title,
		direction: messages.direction,
		id: messages.id,
		occurredAt: messages.occurredAt,
		senderDisplayName: messages.senderDisplayName,
		senderExternalId: messages.senderExternalId,
		senderUserId: messages.senderUserId,
	};
}

function searchableMessageConditions(): (SQL | undefined)[] {
	return [
		ne(messages.kind, "tool"),
		isNotNull(messages.contentText),
		sql`trim(coalesce(${messages.contentText}, '')) <> ''`,
	];
}

/**
 * Read-only message history lookup for ordinary chat conversations. It never writes and never
 * returns workspace, task, or plugin conversations. Cross-session reads are fail-closed:
 * both the caller's and the target's `crossSession.enabled` must allow sharing, and a group
 * conversation can only learn about a private conversation according to `privateToGroup`.
 */
export class ChatHistoryService {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #policyService: ConversationPolicyService;

	constructor(options: ChatHistoryServiceOptions) {
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::chat-history");
		this.#policyService = options.policyService;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async sessionByDurableId(
		durableConversationId: string,
	): Promise<ChatHistorySessionIdentity | undefined> {
		const rows = await this.#db()
			.select(sessionRowColumns())
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		const row = rows[0];
		return row === undefined ? undefined : toSessionIdentity(row);
	}

	async policyForConversation(conversationId: string): Promise<ConversationPolicy | undefined> {
		return this.#policyService.effectivePolicy(conversationId);
	}

	async listSessions(
		currentSessionId: string,
		input: ChatHistoryListInput = {},
	): Promise<ChatHistorySession[]> {
		const database = this.#db();
		const current = await this.#sessionById(currentSessionId);
		if (current === undefined || !isChatKind(current.kind)) return [];
		const currentPolicy = await this.#policy(current.id);
		const conditions: (SQL | undefined)[] = [
			eq(conversations.status, "active"),
			inArray(conversations.kind, [...CHAT_HISTORY_KINDS]),
		];
		if (input.kind !== undefined) conditions.push(eq(conversations.kind, input.kind));
		const query = input.query?.trim();
		if (query !== undefined && query.length > 0) {
			conditions.push(
				or(
					columnLike(conversations.id, query),
					columnLike(sql`coalesce(${conversations.title}, '')`, query),
					columnLike(chatObjects.title, query),
					columnLike(sql`coalesce(${conversations.platformConversationId}, '')`, query),
				),
			);
		}
		const limit = clamp(input.limit, SESSION_LIMIT_DEFAULT, SESSION_LIMIT_MAX);
		const rows = await database
			.select(sessionRowColumns())
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(combine(conditions))
			.orderBy(desc(conversations.updatedAt), desc(conversations.id))
			.limit(Math.min(200, Math.max(CANDIDATE_FLOOR, limit * CANDIDATE_MULTIPLIER)));
		const policies = new Map<string, ConversationPolicy>([[current.id, currentPolicy]]);
		const sessions: ChatHistorySession[] = [];
		for (const row of rows) {
			if (sessions.length >= limit) break;
			if (!isChatKind(row.kind)) continue;
			const access = await this.#accessFor(current, row, currentPolicy, policies);
			if (!access.allowed) continue;
			sessions.push(toSession(row, access.redacted));
		}
		this.#logger.debug("chat history sessions listed", {
			conversationId: current.id,
			limit,
			resultCount: sessions.length,
		});
		return sessions;
	}

	async searchMessages(
		currentSessionId: string,
		input: ChatHistorySearchInput = {},
	): Promise<ChatHistorySearchResult> {
		const database = this.#db();
		const current = await this.#sessionById(currentSessionId);
		if (current === undefined) {
			return {
				denied: { message: "Conversation not found.", reason: "session-missing" },
				messages: [],
			};
		}
		if (!isChatKind(current.kind)) {
			return {
				denied: {
					message: "Chat history is only available for ordinary chat sessions.",
					reason: "not-a-chat-session",
				},
				messages: [],
			};
		}
		const currentPolicy = await this.#policy(current.id);
		const policies = new Map<string, ConversationPolicy>([[current.id, currentPolicy]]);
		const conditions: (SQL | undefined)[] = searchableMessageConditions();
		let explicitTarget: SessionRow | undefined;
		if (input.sessionId !== undefined) {
			explicitTarget = await this.#sessionById(input.sessionId);
			if (explicitTarget === undefined) {
				return {
					denied: { message: "Conversation not found.", reason: "session-missing" },
					messages: [],
				};
			}
			const access = await this.#accessFor(current, explicitTarget, currentPolicy, policies);
			if (!access.allowed) return { denied: access.denied, messages: [] };
			if (!isChatKind(explicitTarget.kind)) {
				return {
					denied: {
						message: "Chat history is only available for ordinary chat sessions.",
						reason: "not-a-chat-session",
					},
					messages: [],
				};
			}
			conditions.push(eq(messages.conversationId, explicitTarget.id));
		} else if (currentPolicy.crossSession.enabled === false) {
			conditions.push(eq(messages.conversationId, current.id));
		}
		conditions.push(inArray(conversations.kind, [...CHAT_HISTORY_KINDS]));
		if (input.kind !== undefined) conditions.push(eq(conversations.kind, input.kind));
		const queryTerms = (input.query ?? "")
			.trim()
			.split(/\s+/u)
			.map((term) => term.trim())
			.filter((term) => term.length > 0)
			.slice(0, MAX_QUERY_TERMS);
		for (const term of queryTerms) conditions.push(columnLike(messages.contentText, term));
		const sender = input.sender?.trim();
		if (sender !== undefined && sender.length > 0) {
			const pattern = likePattern(sender);
			conditions.push(
				or(
					sql`coalesce(lower(${messages.senderDisplayName}), '') LIKE ${pattern} ESCAPE '\\'`,
					sql`coalesce(lower(${messages.senderExternalId}), '') LIKE ${pattern} ESCAPE '\\'`,
					sql`coalesce(lower(${messages.senderUserId}), '') LIKE ${pattern} ESCAPE '\\'`,
				),
			);
		}
		const after = input.after?.trim();
		if (after !== undefined && after.length > 0) {
			const timestamp = normalizeTimestamp(after);
			if (timestamp === undefined) {
				return {
					denied: { message: "Invalid after timestamp.", reason: "invalid-time" },
					messages: [],
				};
			}
			conditions.push(gte(messages.occurredAt, timestamp));
		}
		const before = input.before?.trim();
		if (before !== undefined && before.length > 0) {
			const timestamp = normalizeTimestamp(before);
			if (timestamp === undefined) {
				return {
					denied: { message: "Invalid before timestamp.", reason: "invalid-time" },
					messages: [],
				};
			}
			conditions.push(lte(messages.occurredAt, timestamp));
		}
		const limit = clamp(input.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
		const candidateLimit = Math.min(
			CANDIDATE_CEILING,
			Math.max(CANDIDATE_FLOOR, limit * CANDIDATE_MULTIPLIER),
		);
		const rows = await database
			.select(messageColumns())
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(combine(conditions))
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(candidateLimit);
		const result: ChatHistoryMessage[] = [];
		const sessionCache = new Map<string, SessionRow | undefined>([[current.id, current]]);
		for (const row of rows) {
			if (result.length >= limit) break;
			const target = await this.#sessionByIdCached(row.conversationId, sessionCache);
			if (target === undefined) continue;
			const access = await this.#accessFor(current, target, currentPolicy, policies);
			if (!access.allowed) continue;
			const message = toMessage(row, access.redacted);
			if (message !== undefined) result.push(message);
		}
		this.#logger.debug("chat history messages searched", {
			conversationId: current.id,
			limit,
			queryTerms: queryTerms.length,
			resultCount: result.length,
			sessionId: input.sessionId,
		});
		return { messages: result };
	}

	async readMessages(
		currentSessionId: string,
		input: ChatHistoryReadInput = {},
	): Promise<ChatHistoryReadResult> {
		const database = this.#db();
		const current = await this.#sessionById(currentSessionId);
		if (current === undefined) {
			return {
				denied: { message: "Conversation not found.", reason: "session-missing" },
				ok: false,
			};
		}
		if (!isChatKind(current.kind)) {
			return {
				denied: {
					message: "Chat history is only available for ordinary chat sessions.",
					reason: "not-a-chat-session",
				},
				ok: false,
			};
		}
		const targetId = input.sessionId ?? current.id;
		const target = targetId === current.id ? current : await this.#sessionById(targetId);
		if (target === undefined) {
			return {
				denied: { message: "Conversation not found.", reason: "session-missing" },
				ok: false,
			};
		}
		const currentPolicy = await this.#policy(current.id);
		const policies = new Map<string, ConversationPolicy>([[current.id, currentPolicy]]);
		const access = await this.#accessFor(current, target, currentPolicy, policies);
		if (!access.allowed) return { denied: access.denied, ok: false };
		if (access.redacted) {
			return {
				denied: {
					message:
						"A group conversation may not read private chat messages; only their existence is visible.",
					reason: "private-to-group-redacted",
				},
				ok: false,
			};
		}
		if (!isChatKind(target.kind)) {
			return {
				denied: {
					message: "Chat history is only available for ordinary chat sessions.",
					reason: "not-a-chat-session",
				},
				ok: false,
			};
		}
		const limit = clamp(input.limit, READ_LIMIT_DEFAULT, READ_LIMIT_MAX);
		const baseConditions: (SQL | undefined)[] = [
			eq(messages.conversationId, target.id),
			ne(messages.kind, "tool"),
		];
		const around = input.aroundMessageId?.trim();
		if (around !== undefined && around.length > 0) {
			const [anchor] = await database
				.select({ occurredAt: messages.occurredAt })
				.from(messages)
				.where(and(eq(messages.conversationId, target.id), eq(messages.id, around)))
				.limit(1);
			if (anchor === undefined) {
				return {
					denied: {
						message: "Message not found in that session.",
						reason: "cursor-not-found",
					},
					ok: false,
				};
			}
			const beforeLimit = Math.floor(limit / 2);
			const afterLimit = Math.ceil(limit / 2);
			const beforeRows =
				beforeLimit === 0
					? []
					: await database
							.select(messageColumns())
							.from(messages)
							.innerJoin(conversations, eq(conversations.id, messages.conversationId))
							.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
							.where(combine([...baseConditions, lte(messages.occurredAt, anchor.occurredAt)]))
							.orderBy(desc(messages.occurredAt), desc(messages.id))
							.limit(beforeLimit);
			const afterRows =
				afterLimit === 0
					? []
					: await database
							.select(messageColumns())
							.from(messages)
							.innerJoin(conversations, eq(conversations.id, messages.conversationId))
							.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
							.where(
								combine([...baseConditions, sql`${messages.occurredAt} > ${anchor.occurredAt}`]),
							)
							.orderBy(asc(messages.occurredAt), asc(messages.id))
							.limit(afterLimit);
			const chronological = [...beforeRows.toReversed(), ...afterRows];
			const rows = chronological
				.map((row) => toMessage(row, false))
				.filter((message): message is ChatHistoryMessage => message !== undefined);
			return { messages: rows, ok: true, session: this.#toAccessibleSession(target) };
		}
		const afterCursor = await this.#resolveReadCursor(database, target.id, input.after);
		if (afterCursor.invalid) {
			return { denied: afterCursor.invalid, ok: false };
		}
		const beforeCursor = await this.#resolveReadCursor(database, target.id, input.before);
		if (beforeCursor.invalid) {
			return { denied: beforeCursor.invalid, ok: false };
		}
		if (afterCursor.occurredAt !== undefined) {
			baseConditions.push(sql`${messages.occurredAt} > ${afterCursor.occurredAt}`);
		}
		if (beforeCursor.occurredAt !== undefined) {
			baseConditions.push(sql`${messages.occurredAt} < ${beforeCursor.occurredAt}`);
		}
		const hasAfter = afterCursor.occurredAt !== undefined;
		const hasBefore = beforeCursor.occurredAt !== undefined;
		// Without an `after` cursor the newest rows are fetched descending, then reversed, so
		// the default read and backward pagination stay chronological without an extra query.
		const descending = !hasAfter;
		const rows = await database
			.select(messageColumns())
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(combine(baseConditions))
			.orderBy(
				descending ? desc(messages.occurredAt) : asc(messages.occurredAt),
				descending ? desc(messages.id) : asc(messages.id),
			)
			.limit(limit);
		const chronological = descending ? rows.toReversed() : rows;
		const result = chronological
			.map((row) => toMessage(row, false))
			.filter((message): message is ChatHistoryMessage => message !== undefined);
		this.#logger.debug("chat history messages read", {
			conversationId: current.id,
			hasAfter,
			hasBefore,
			limit,
			resultCount: result.length,
			sessionId: target.id,
		});
		return { messages: result, ok: true, session: this.#toAccessibleSession(target) };
	}

	#toAccessibleSession(row: SessionRow): ChatHistorySession {
		return toSession(row, false);
	}

	async #resolveReadCursor(
		database: TsukaimaDatabase,
		sessionId: string,
		value: string | undefined,
	): Promise<{ readonly invalid?: ChatHistoryDenial; readonly occurredAt?: string }> {
		const cursor = value?.trim();
		if (cursor === undefined || cursor.length === 0) return {};
		const timestamp = normalizeTimestamp(cursor);
		if (timestamp !== undefined) return { occurredAt: timestamp };
		const [row] = await database
			.select({ occurredAt: messages.occurredAt })
			.from(messages)
			.where(and(eq(messages.conversationId, sessionId), eq(messages.id, cursor)))
			.limit(1);
		return row === undefined
			? {
					invalid: {
						message: "Cursor message not found in that session.",
						reason: "cursor-not-found",
					},
				}
			: { occurredAt: row.occurredAt };
	}

	async #sessionById(id: string): Promise<SessionRow | undefined> {
		const [row] = await this.#db()
			.select(sessionRowColumns())
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, id))
			.limit(1);
		return row;
	}

	async #sessionByIdCached(
		id: string,
		sessions: Map<string, SessionRow | undefined>,
	): Promise<SessionRow | undefined> {
		if (sessions.has(id)) return sessions.get(id);
		const session = await this.#sessionById(id);
		sessions.set(id, session);
		return session;
	}

	async #policy(sessionId: string): Promise<ConversationPolicy> {
		return this.#policyService.effectivePolicy(sessionId);
	}

	async #accessFor(
		current: SessionRow,
		target: SessionRow,
		currentPolicy: ConversationPolicy,
		policies: Map<string, ConversationPolicy>,
	): Promise<AccessResult> {
		if (!isChatKind(current.kind)) {
			return denied(
				"not-a-chat-session",
				"Chat history is only available for ordinary chat sessions.",
			);
		}
		if (!isChatKind(target.kind)) {
			return denied("not-a-chat-session", "That session is not an ordinary chat session.");
		}
		if (target.id === current.id) return { allowed: true, redacted: false };
		if (currentPolicy.crossSession.enabled === false) {
			return denied(
				"cross-session-disabled",
				"Cross-session history is disabled for this conversation.",
			);
		}
		const targetPolicy = await this.#policyCached(target.id, policies);
		if (targetPolicy.crossSession.enabled === false) {
			return denied(
				"target-cross-session-disabled",
				"That conversation does not share its history.",
			);
		}
		if (current.kind === "group" && target.kind === "private") {
			const privacy = currentPolicy.crossSession.privateToGroup;
			if (privacy === "none") {
				return denied(
					"private-to-group-none",
					"Private chat history is hidden from group conversations.",
				);
			}
			return { allowed: true, redacted: privacy !== "text" };
		}
		return { allowed: true, redacted: false };
	}

	async #policyCached(
		sessionId: string,
		policies: Map<string, ConversationPolicy>,
	): Promise<ConversationPolicy> {
		const cached = policies.get(sessionId);
		if (cached !== undefined) return cached;
		const policy = await this.#policy(sessionId);
		policies.set(sessionId, policy);
		return policy;
	}
}
