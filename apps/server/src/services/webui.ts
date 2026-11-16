import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
	messagePartSchema,
	type MessageDeliveryMode,
	type MessagePage,
	type MessagePart,
	type MessageSummary as ContractMessageSummary,
	type RunStep,
	type SessionContextStats,
	type SessionsAbortResult,
	type SessionsCompactResult,
} from "@tsukaima/contracts";
import {
	chatObjects,
	conversationMembers,
	conversations,
	identities,
	messages,
	requests,
	userAliases,
	users,
} from "@tsukaima/db";
import type { TsukaimaLifecycle } from "../lifecycle.ts";
import { collectRunSteps } from "./run-steps.ts";

type ChatKind = "private" | "group" | "webui" | "workspace" | "task" | "plugin";

/** Store the adapter's own kind; the WebUI must not know which platforms exist. */
const toMessageKind = (channelKind: string | undefined): string => channelKind ?? "plugin";

export interface SessionSummary {
	createdAt: string;
	id: string;
	isReceiving: boolean;
	kind: string;
	latestMessage: MessageSummary | null;
	status: string;
	title: string;
	updatedAt: string;
}

export interface ChatSummary {
	channelId: string | null;
	createdAt: string;
	id: string;
	kind: ChatKind;
	pinned: boolean;
	platformConversationId: string | null;
	sessions: SessionSummary[];
	status: string;
	title: string;
	updatedAt: string;
}

/**
 * The contract's shape, not a hand-written copy. A local redeclaration silently drifted from the
 * schema the WebUI parses, so a field added on one side was invisible to the other.
 */
export type MessageSummary = ContractMessageSummary;

export interface SessionDetail {
	channelId: string | null;
	chat: {
		id: string;
		kind: ChatKind;
		platformConversationId: string | null;
		status: string;
		title: string;
	};
	createdAt: string;
	id: string;
	isReceiving: boolean;
	kind: string;
	status: string;
	title: string;
	updatedAt: string;
}

type MessageRow = typeof messages.$inferSelect;
type RequestRow = typeof requests.$inferSelect;

function parseParts(value: string | null): MessagePart[] {
	if (value === null) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((part) => {
			const result = messagePartSchema.safeParse(part);
			return result.success ? [result.data] : [];
		});
	} catch {
		return [];
	}
}

function toMessageSummary(row: MessageRow): MessageSummary {
	const isWebui =
		row.kind === "webui" || row.direction === "outbound" || row.senderExternalId === "webui-admin";
	const isBot = row.kind === "assistant";
	return {
		contentText: row.contentText ?? "",
		direction: row.direction,
		deliveryStatus: row.deliveryStatus,
		durableEntryId: row.durableEntryId,
		id: row.id,
		kind: row.kind,
		occurredAt: row.occurredAt,
		parts: parseParts(row.partsJson),
		platformMessageId: row.platformMessageId,
		replyToMessageId: row.replyToMessageId,
		senderDisplayName: row.senderDisplayName ?? (isWebui ? "WebUI" : "Unknown"),
		senderExternalId: row.senderExternalId,
		// The WebUI operator is the system side of a local conversation, not a channel user: it
		// drives the bot directly, so it is distinguished from the people in the chat.
		senderKind: isBot
			? "assistant"
			: row.senderExternalId === "webui-admin"
				? "system"
				: row.senderExternalId === "tsukaima"
					? "assistant"
					: "human",
		triggerClassification: row.triggerClassification,
	};
}

function requireDatabase(lifecycle: TsukaimaLifecycle) {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("Database is not ready");
	return database;
}

const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 200;

interface MessageCursor {
	id: string;
	occurredAt: string;
}

/** Raised for a cursor the service did not mint; the RPC layer maps it to INVALID_INPUT. */
export class MessageCursorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MessageCursorError";
	}
}

function encodeMessageCursor(row: MessageCursor): string {
	return Buffer.from(JSON.stringify(row), "utf8").toString("base64url");
}

function decodeMessageCursor(cursor: string): MessageCursor {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (typeof parsed === "object" && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (
				typeof record.id === "string" &&
				record.id.length > 0 &&
				typeof record.occurredAt === "string" &&
				record.occurredAt.length > 0
			) {
				return { id: record.id, occurredAt: record.occurredAt };
			}
		}
	} catch {
		// Fall through to the stable error below.
	}
	throw new MessageCursorError("Invalid message cursor");
}

export async function listChats(
	lifecycle: TsukaimaLifecycle,
	options: { status?: "active" | "archived" | "all" } = {},
): Promise<ChatSummary[]> {
	const database = requireDatabase(lifecycle);
	const status = options.status ?? "active";
	const objectRows = await database
		.select()
		.from(chatObjects)
		.where(
			and(
				ne(chatObjects.kind, "workspace"),
				status === "all"
					? undefined
					: eq(chatObjects.status, status === "archived" ? "archived" : "active"),
			),
		)
		.orderBy(desc(chatObjects.pinned), desc(chatObjects.updatedAt));
	const ids = objectRows.map((row) => row.id);
	const sessionRows =
		ids.length === 0
			? []
			: await database
					.select()
					.from(conversations)
					.where(inArray(conversations.chatObjectId, ids))
					.orderBy(desc(conversations.updatedAt));
	const sessionIds = sessionRows.map((row) => row.id);
	// Only the newest message of each session reaches the wire. Rank in SQLite and fetch those
	// rows by primary key: selecting every message for every session pulled tens of megabytes of
	// text into JS just to throw all but one row per session away, which made this query the
	// slowest page-load RPC and could fail under memory pressure.
	const latestIds: { id: string }[] = [];
	if (sessionIds.length > 0) {
		const ranked = database
			.select({
				id: messages.id,
				rank: sql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.occurredAt} desc, ${messages.id} desc)`.as(
					"message_rank",
				),
			})
			.from(messages)
			.where(inArray(messages.conversationId, sessionIds))
			.as("ranked_messages");
		const rows = await database.select({ id: ranked.id }).from(ranked).where(eq(ranked.rank, 1));
		for (const row of rows) latestIds.push(row);
	}
	const latestBySession = new Map<string, MessageSummary>();
	if (latestIds.length > 0) {
		const messageRows = await database
			.select()
			.from(messages)
			.where(
				inArray(
					messages.id,
					latestIds.map((row) => row.id),
				),
			);
		for (const row of messageRows) {
			latestBySession.set(row.conversationId, toMessageSummary(row));
		}
	}
	return objectRows.map((object) => ({
		channelId: object.channelId,
		createdAt: object.createdAt,
		id: object.id,
		kind: object.kind,
		pinned: object.pinned === 1,
		platformConversationId: object.platformConversationId,
		sessions: sessionRows
			.filter((session) => session.chatObjectId === object.id)
			.map((session) => ({
				createdAt: session.createdAt,
				id: session.id,
				isReceiving: session.isReceiving === 1,
				kind: session.kind,
				latestMessage: latestBySession.get(session.id) ?? null,
				status: session.status,
				title: session.title ?? session.id,
				updatedAt: session.updatedAt,
			})),
		status: object.status,
		title: object.title,
		updatedAt: object.updatedAt,
	}));
}

export async function getSession(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
): Promise<SessionDetail | null> {
	const database = requireDatabase(lifecycle);
	const [row] = await database
		.select({
			chat: {
				id: chatObjects.id,
				kind: chatObjects.kind,
				platformConversationId: chatObjects.platformConversationId,
				status: chatObjects.status,
				title: chatObjects.title,
			},
			chatChannelId: chatObjects.channelId,
			session: {
				createdAt: conversations.createdAt,
				id: conversations.id,
				isReceiving: conversations.isReceiving,
				kind: conversations.kind,
				status: conversations.status,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			},
		})
		.from(conversations)
		.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (row === undefined) return null;
	return {
		channelId: row.chatChannelId,
		chat: row.chat,
		createdAt: row.session.createdAt,
		id: row.session.id,
		isReceiving: row.session.isReceiving === 1,
		kind: row.session.kind,
		status: row.session.status,
		title: row.session.title ?? row.session.id,
		updatedAt: row.session.updatedAt,
	};
}

function contextSectionLabel(key: string): string {
	switch (key) {
		case "tsukaima-persona":
			return "Persona";
		case "tsukaima-policy":
			return "Policy";
		case "tsukaima-memory":
			return "Memories";
		case "instructions":
			return "Instructions";
		case "system":
			return "System";
		default:
			return key;
	}
}

export async function getSessionContextStats(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
): Promise<SessionContextStats | null> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [session] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) return null;

	const policy = await lifecycle.conversationPolicy.ensureHostPolicy(
		sessionId,
		session.durableConversationId,
	);
	const codingTools = lifecycle.pluginHost.modelToolNames("self-iteration");
	const omittedTools = policy.capabilities.includes("coding") ? [] : codingTools;
	const [inspection, contextDetails] = await Promise.all([
		host.inspectConversationContext(session.durableConversationId, { omittedTools }),
		lifecycle.contextProvider.inspectContext(session.durableConversationId),
	]);
	if (inspection === undefined) return null;

	return {
		...inspection,
		memories: contextDetails.memories,
		personaName: contextDetails.personaName,
		sections: inspection.sections.map((section) => ({
			key: section.key,
			label: contextSectionLabel(section.key),
			tokens: section.tokens,
		})),
		tools: inspection.tools.map((tool) => ({ ...tool })),
	};
}

export async function compactSessionContext(
	lifecycle: TsukaimaLifecycle,
	input: { instructions?: string; sessionId: string },
): Promise<SessionsCompactResult> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [session] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	await lifecycle.conversationPolicy.ensureHostPolicy(
		input.sessionId,
		session.durableConversationId,
	);
	const result = await host.compactConversation(session.durableConversationId, input.instructions);
	await lifecycle.writeAudit({
		action: "session.compact",
		actorKind: "user",
		payload: {
			compacted: result.compacted,
			hasInstructions: (input.instructions?.trim().length ?? 0) > 0,
		},
		result: "ok",
		targetId: input.sessionId,
		targetKind: "session",
	});
	return result;
}

export async function resetSessionContext(
	lifecycle: TsukaimaLifecycle,
	input: { handoff?: string; sessionId: string },
): Promise<void> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [session] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	await host.resetConversation(session.durableConversationId, input.handoff);
	await lifecycle.writeAudit({
		action: "session.reset-context",
		actorKind: "user",
		payload: {
			hasHandoff: (input.handoff?.trim().length ?? 0) > 0,
		},
		result: "ok",
		targetId: input.sessionId,
		targetKind: "session",
	});
}

export async function abortSessionRun(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
): Promise<SessionsAbortResult> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [session] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	const cancelledPendingOutput = lifecycle.replyDispatcher.cancelPendingOutput(
		session.durableConversationId,
	);
	await host.abortConversation(session.durableConversationId);
	await lifecycle.writeAudit({
		action: "session.abort",
		actorKind: "user",
		payload: { cancelledPendingOutput },
		result: "ok",
		targetId: sessionId,
		targetKind: "session",
	});
	return { cancelledPendingOutput, ok: true };
}

export async function createLocalChat(
	lifecycle: TsukaimaLifecycle,
	input: { sessionTitle: string; title: string },
): Promise<{ chatId: string; sessionId: string }> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const durableConversationId = await host.createConversation();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		createdAt: now,
		id: chatId,
		kind: "webui",
		title: input.title.trim(),
		updatedAt: now,
	});
	await database.insert(conversations).values({
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "webui",
		title: input.sessionTitle.trim(),
		updatedAt: now,
	});
	await lifecycle.writeAudit({
		action: "chat.create",
		payload: { chatId, sessionId },
		result: "ok",
		targetId: chatId,
		targetKind: "chat",
	});
	return { chatId, sessionId };
}

export async function createSession(
	lifecycle: TsukaimaLifecycle,
	chatObjectId: string,
	title: string,
): Promise<{ id: string }> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [chat] = await database
		.select()
		.from(chatObjects)
		.where(eq(chatObjects.id, chatObjectId))
		.limit(1);
	if (chat === undefined) throw new Error("Chat object not found");
	if (chat.status !== "active") throw new Error("Chat object is archived");
	const durableConversationId = await host.createConversation();
	const id = randomUUID();
	const now = new Date().toISOString();
	await database.insert(conversations).values({
		channelId: chat.channelId,
		chatObjectId: chat.id,
		createdAt: now,
		durableConversationId,
		id,
		isReceiving: 0,
		kind: chat.kind,
		platformConversationId: chat.platformConversationId,
		title: title.trim(),
		updatedAt: now,
	});
	await database.update(chatObjects).set({ updatedAt: now }).where(eq(chatObjects.id, chat.id));
	await lifecycle.writeAudit({
		action: "session.create",
		payload: { chatObjectId },
		result: "ok",
		targetId: id,
		targetKind: "session",
	});
	return { id };
}

export async function updateSession(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
	patch: { status?: "active" | "archived"; title?: string },
): Promise<void> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select()
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	if (patch.status === "archived" && session.isReceiving === 1) {
		throw new Error("Choose another receiving session before archiving this one");
	}
	if (session.chatObjectId === null) throw new Error("Session has no chat object");
	const title = patch.title?.trim();
	if (title !== undefined && title.length === 0) throw new Error("Session title is required");
	const now = new Date().toISOString();
	await database
		.update(conversations)
		.set({
			...(!(patch.status === undefined) ? { status: patch.status } : {}),
			...(!(title === undefined) ? { title } : {}),
			updatedAt: now,
		})
		.where(eq(conversations.id, sessionId));
	await database
		.update(chatObjects)
		.set({ updatedAt: now })
		.where(eq(chatObjects.id, session.chatObjectId));
	await lifecycle.writeAudit({
		action: patch.status === undefined ? "session.rename" : `session.${patch.status}`,
		payload: patch,
		result: "ok",
		targetId: sessionId,
		targetKind: "session",
	});
}

export async function setReceivingSession(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
): Promise<void> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select()
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	if (session.status !== "active") throw new Error("Only active sessions can receive messages");
	if (session.chatObjectId === null) throw new Error("Session has no chat object");
	await database
		.update(conversations)
		.set({ isReceiving: 0 })
		.where(eq(conversations.chatObjectId, session.chatObjectId));
	await database
		.update(conversations)
		.set({ isReceiving: 1 })
		.where(eq(conversations.id, sessionId));
	await lifecycle.writeAudit({
		action: "session.set-receiving",
		result: "ok",
		targetId: sessionId,
		targetKind: "session",
	});
}

export async function listMessages(
	lifecycle: TsukaimaLifecycle,
	sessionId: string,
): Promise<MessageSummary[]> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select()
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	const rows = await database
		.select()
		.from(messages)
		.where(eq(messages.conversationId, sessionId))
		.orderBy(asc(messages.occurredAt), asc(messages.id));
	return rows.map(toMessageSummary);
}

/**
 * One reverse-cursor page of a session transcript.
 *
 * Pages are fetched newest-first so the newest page never has to scan the whole conversation,
 * then reversed before returning so the client always receives chronological rows. The cursor
 * is the `(occurredAt, id)` of the oldest row in the page: `occurredAt` alone is not unique and
 * would skip or repeat every message that shares a millisecond with the page boundary.
 */
export async function listMessagePage(
	lifecycle: TsukaimaLifecycle,
	input: { cursor?: string | undefined; limit?: number | undefined; sessionId: string },
): Promise<MessagePage> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select()
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");

	const limit = Math.min(
		Math.max(input.limit ?? DEFAULT_MESSAGE_PAGE_SIZE, 1),
		MAX_MESSAGE_PAGE_SIZE,
	);
	const cursor = input.cursor === undefined ? null : decodeMessageCursor(input.cursor);
	const filters =
		cursor === null
			? eq(messages.conversationId, input.sessionId)
			: and(
					eq(messages.conversationId, input.sessionId),
					or(
						lt(messages.occurredAt, cursor.occurredAt),
						and(eq(messages.occurredAt, cursor.occurredAt), lt(messages.id, cursor.id)),
					),
				);

	// Fetch one extra row to learn whether an older page exists without a second count query.
	const rows = await database
		.select()
		.from(messages)
		.where(filters)
		.orderBy(desc(messages.occurredAt), desc(messages.id))
		.limit(limit + 1);
	const pageRows = rows.slice(0, limit);
	const oldest = pageRows.at(-1);
	return {
		messages: pageRows.toReversed().map(toMessageSummary),
		nextCursor:
			rows.length > limit && oldest !== undefined
				? encodeMessageCursor({ id: oldest.id, occurredAt: oldest.occurredAt })
				: null,
	};
}

/** The transcript row a live event points at, or `null` when it has been removed. */
export async function getSessionMessage(
	lifecycle: TsukaimaLifecycle,
	input: { durableEntryId?: string | undefined; messageId?: string | undefined; sessionId: string },
): Promise<MessageSummary | null> {
	const database = requireDatabase(lifecycle);
	// Inbound channel events carry the platform message id, not the domain row id. Local WebUI
	// sends use the row id as their envelope id, so both lookup keys have to be considered.
	const lookup =
		input.messageId === undefined
			? input.durableEntryId === undefined
				? undefined
				: eq(messages.durableEntryId, input.durableEntryId)
			: or(eq(messages.id, input.messageId), eq(messages.platformMessageId, input.messageId));
	if (lookup === undefined) throw new Error("Message lookup is missing");
	const [row] = await database
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, input.sessionId), lookup))
		.orderBy(desc(messages.occurredAt), desc(messages.id))
		.limit(1);
	return row === undefined ? null : toMessageSummary(row);
}

/**
 * Steps of one completed assistant turn, read from the durable transcript.
 *
 * The live `pi.live` document only exists while a run is in flight, so a transcript that wants
 * to keep showing the agent's work after the answer lands has to read the durable entries. The
 * caller identifies the turn by the assistant message's `durableEntryId`.
 */
export async function listRunSteps(
	lifecycle: TsukaimaLifecycle,
	input: { entryId: string; sessionId: string },
): Promise<{ durationSeconds?: number; steps: RunStep[] }> {
	const database = requireDatabase(lifecycle);
	const host = lifecycle.conversationHost;
	if (host === undefined) throw new Error("Conversation host is not ready");
	const [session] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	const entries = await host.listEntries(session.durableConversationId, 500);
	const durable = collectRunSteps(
		entries.map((entry) => ({
			data: entry.data,
			id: String(entry.id),
			kind: entry.kind,
			model: entry.model,
		})),
		input.entryId,
	);
	// `pi.live` is cleared when a run settles, and some providers do not copy reasoning into
	// the durable assistant entry. The KV cache kept the final live process chain keyed by the
	// durable answer id, so the transcript can still show what the agent thought and ran.
	const cached = await lifecycle.liveRuns.final(input.entryId);
	if (cached === undefined) return durable;
	const durationSeconds = durable.durationSeconds ?? cached.durationSeconds;
	const withDuration = durationSeconds === undefined ? {} : { durationSeconds };
	const cachedThinking = cached.steps.filter((step) => step.kind === "thinking");
	const durableHasThinking = durable.steps.some((step) => step.kind === "thinking");
	if (durable.steps.length === 0) {
		return { ...withDuration, steps: [...cached.steps] };
	}
	if (!durableHasThinking && cachedThinking.length > 0) {
		return { ...withDuration, steps: [...cachedThinking, ...durable.steps] };
	}
	return durable;
}

export async function sendMessage(
	lifecycle: TsukaimaLifecycle,
	input: {
		mode?: MessageDeliveryMode;
		sessionId: string;
		target: "channel" | "tsukaima";
		text: string;
	},
): Promise<MessageSummary> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select({ chat: chatObjects, session: conversations })
		.from(conversations)
		.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	if (session.session.status !== "active") throw new Error("Session is archived");
	if (session.chat.status !== "active") throw new Error("Chat object is archived");
	const text = input.text.trim();
	if (text.length === 0) throw new Error("Message is empty");
	const id = randomUUID();
	const now = new Date().toISOString();
	if (input.target === "channel") {
		if (session.chat.kind !== "private" && session.chat.kind !== "group") {
			throw new Error("This chat has no external channel");
		}
		const platformConversationId = session.chat.platformConversationId;
		const channelId = session.chat.channelId;
		if (platformConversationId === null) {
			throw new Error("External chat has no destination id");
		}
		if (channelId === null) {
			throw new Error("External chat has no channel");
		}
		const channelKind = lifecycle.channels.get(channelId)?.kind;
		await database.insert(messages).values({
			chatObjectId: session.chat.id,
			contentText: text,
			conversationId: session.session.id,
			direction: "outbound",
			deliveryStatus: "pending",
			id,
			ingestedAt: now,
			kind: toMessageKind(channelKind),
			occurredAt: now,
			partsJson: JSON.stringify([{ text, type: "text" }]),
			senderDisplayName: "WebUI admin",
			senderExternalId: "webui-admin",
			updatedAt: now,
		});
		try {
			const parts: MessagePart[] = [{ text, type: "text" }];
			const result = await lifecycle.channels.send(
				channelId,
				session.chat.kind,
				platformConversationId,
				parts,
			);
			const platformMessageId = result.platformMessageId ?? null;
			await database
				.update(messages)
				.set({ deliveryStatus: "sent", platformMessageId, updatedAt: new Date().toISOString() })
				.where(eq(messages.id, id));
			await lifecycle.writeAudit({
				action: "message.send-channel",
				payload: {
					chatKind: session.chat.kind,
					platformConversationId: session.chat.platformConversationId,
				},
				result: "ok",
				targetId: session.session.id,
				targetKind: "session",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const deliveryStatus = /timeout/i.test(message) ? "uncertain" : "failed";
			await database
				.update(messages)
				.set({ deliveryStatus, updatedAt: new Date().toISOString() })
				.where(eq(messages.id, id));
			await lifecycle.writeAudit({
				action: "message.send-channel",
				payload: {
					chatKind: session.chat.kind,
					platformConversationId: session.chat.platformConversationId,
				},
				reason: message,
				result: "failed",
				targetId: session.session.id,
				targetKind: "session",
			});
		}
		const [saved] = await database.select().from(messages).where(eq(messages.id, id)).limit(1);
		if (saved === undefined) throw new Error("Failed to persist outbound message");
		return toMessageSummary(saved);
	}

	const sent = await lifecycle.sessionMessaging.sendAgentMessage({
		...(input.mode === undefined ? {} : { deliveryMode: input.mode }),
		sessionId: session.session.id,
		source: "webui",
		text,
	});
	const [saved] = await database
		.select()
		.from(messages)
		.where(eq(messages.id, sent.messageId))
		.limit(1);
	if (saved === undefined) throw new Error("Failed to persist message");
	return toMessageSummary(saved);
}

export async function listUsers(lifecycle: TsukaimaLifecycle): Promise<
	Array<{
		displayName: string;
		identities: Array<{
			displayName: string | null;
			externalId: string;
			id: string;
			platform: string;
			platformAccountId: string;
		}>;
		id: string;
		kind: "human" | "bot" | "system";
		notes: string | null;
		preferredName: string | null;
		trustLevel: string;
	}>
> {
	const database = requireDatabase(lifecycle);
	const userRows = await database.select().from(users).orderBy(users.displayName);
	const identityRows =
		userRows.length === 0
			? []
			: await database
					.select()
					.from(identities)
					.where(
						inArray(
							identities.canonicalUserId,
							userRows.map((row) => row.id),
						),
					);
	return userRows.map((user) => ({
		displayName: user.displayName ?? user.preferredName ?? user.id,
		identities: identityRows
			.filter((identity) => identity.canonicalUserId === user.id)
			.map((identity) => ({
				displayName: identity.displayName,
				externalId: identity.externalId,
				id: identity.id,
				platform: identity.platform,
				platformAccountId: identity.platformAccountId,
			})),
		id: user.id,
		kind: user.kind,
		notes: user.notes,
		preferredName: user.preferredName,
		trustLevel: user.trustLevel,
	}));
}

export async function getUser(lifecycle: TsukaimaLifecycle, userId: string) {
	const knownUsers = await listUsers(lifecycle);
	const user = knownUsers.find((entry) => entry.id === userId);
	if (user === undefined) return null;
	const database = requireDatabase(lifecycle);
	const aliases = await database.select().from(userAliases).where(eq(userAliases.userId, userId));
	const externalIds = user.identities.map((identity) => identity.externalId);
	const chats =
		externalIds.length === 0
			? []
			: await database
					.select()
					.from(chatObjects)
					.where(
						and(
							eq(chatObjects.kind, "private"),
							inArray(chatObjects.platformConversationId, externalIds),
						),
					);
	const chatIds = chats.map((chat) => chat.id);
	const sessions =
		chatIds.length === 0
			? []
			: await database
					.select()
					.from(conversations)
					.where(inArray(conversations.chatObjectId, chatIds));
	const groups = await database
		.select({
			chat: chatObjects,
			member: conversationMembers,
		})
		.from(conversationMembers)
		.innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
		.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
		.where(and(eq(conversationMembers.userId, userId), eq(chatObjects.kind, "group")));
	return {
		...user,
		aliases: aliases.map((alias) => alias.alias),
		chats: chats.map((chat) => ({
			...chat,
			sessions: sessions.filter((session) => session.chatObjectId === chat.id),
		})),
		groups: [...new Map(groups.map((row) => [row.chat.id, row.chat])).values()],
	};
}

export async function listGroups(lifecycle: TsukaimaLifecycle) {
	const database = requireDatabase(lifecycle);
	const groups = await database
		.select()
		.from(chatObjects)
		.where(eq(chatObjects.kind, "group"))
		.orderBy(desc(chatObjects.updatedAt));
	const chatIds = groups.map((group) => group.id);
	const sessions =
		chatIds.length === 0
			? []
			: await database
					.select()
					.from(conversations)
					.where(inArray(conversations.chatObjectId, chatIds));
	const sessionIds = sessions.map((session) => session.id);
	const members =
		sessionIds.length === 0
			? []
			: await database
					.select({
						conversationId: conversationMembers.conversationId,
						userId: conversationMembers.userId,
					})
					.from(conversationMembers)
					.where(inArray(conversationMembers.conversationId, sessionIds));
	return groups.map((group) => {
		const groupSessions = sessions.filter((session) => session.chatObjectId === group.id);
		const memberCount = new Set(
			members
				.filter((member) => groupSessions.some((session) => session.id === member.conversationId))
				.map((member) => member.userId),
		).size;
		return {
			channelId: group.channelId,
			createdAt: group.createdAt,
			id: group.id,
			memberCount,
			platformConversationId: group.platformConversationId,
			sessionCount: groupSessions.length,
			status: group.status,
			title: group.title,
			updatedAt: group.updatedAt,
		};
	});
}

export async function getGroup(lifecycle: TsukaimaLifecycle, groupId: string) {
	const groups = await listGroups(lifecycle);
	const group = groups.find((entry) => entry.id === groupId);
	if (group === undefined) return null;
	const database = requireDatabase(lifecycle);
	const sessions = await database
		.select()
		.from(conversations)
		.where(eq(conversations.chatObjectId, groupId))
		.orderBy(desc(conversations.updatedAt));
	const sessionIds = sessions.map((session) => session.id);
	const memberRows =
		sessionIds.length === 0
			? []
			: await database
					.select({
						displayName: users.displayName,
						platformRole: conversationMembers.platformRole,
						role: conversationMembers.role,
						userId: users.id,
					})
					.from(conversationMembers)
					.innerJoin(users, eq(users.id, conversationMembers.userId))
					.where(inArray(conversationMembers.conversationId, sessionIds));
	const members = [
		...new Map(
			memberRows.map((member) => [
				member.userId,
				{
					...member,
					displayName: member.displayName ?? member.userId,
				},
			]),
		).values(),
	];
	return { ...group, members, sessions };
}

export async function listRequests(
	lifecycle: TsukaimaLifecycle,
	options: { status?: "all" | "pending" | "processed" } = {},
): Promise<RequestRow[]> {
	const database = requireDatabase(lifecycle);
	const status = options.status ?? "all";
	return database
		.select()
		.from(requests)
		.where(
			status === "all"
				? undefined
				: status === "pending"
					? eq(requests.status, "pending")
					: or(
							eq(requests.status, "approved"),
							eq(requests.status, "rejected"),
							eq(requests.status, "failed"),
							eq(requests.status, "uncertain"),
						),
		)
		.orderBy(desc(requests.createdAt));
}

export async function getRequest(
	lifecycle: TsukaimaLifecycle,
	requestId: string,
): Promise<RequestRow | null> {
	const database = requireDatabase(lifecycle);
	const [row] = await database.select().from(requests).where(eq(requests.id, requestId)).limit(1);
	return row ?? null;
}

export async function respondToRequest(
	lifecycle: TsukaimaLifecycle,
	input: { action: "approve" | "reject"; reason?: string; requestId: string },
): Promise<RequestRow> {
	await lifecycle.resolveChannelRequest(input.requestId, input.action, input.reason);
	const request = await getRequest(lifecycle, input.requestId);
	if (request === null) throw new Error("Request not found");
	return request;
}
