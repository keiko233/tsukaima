import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
	inboundReplyDecisionSchema,
	messagePartSchema,
	messageQuoteSchema,
	type MessageDeliveryMode,
	type MessagePage,
	type RunSegmentSummary,
	type MessagePart,
	type MessageReplyPreview,
	type MessageSummary as ContractMessageSummary,
	type RunStep,
	type SessionContextStats,
	type SessionsAbortResult,
	type SessionsCompactResult,
} from "@tsukaima/contracts";
import { sanitizeOutboundMetaLeaks } from "@tsukaima/core";
import {
	chatObjects,
	conversationMembers,
	conversations,
	identities,
	messages,
	requests,
	type TsukaimaDatabase,
	userAliases,
	users,
} from "@tsukaima/db";
import type { TsukaimaLifecycle } from "../lifecycle.ts";
import {
	collectMentionIds,
	loadMentionLabels,
	mentionLabelsForConversation,
	replaceMentionIds,
	type MentionLabelScope,
} from "./mention-labels.ts";
import { roundsToRunSteps } from "./conversation-runs.ts";
import { computeOmittedSessionTools } from "./session-tool-policy.ts";

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

/** Ids mentioned anywhere in these rows, read straight from the stored text. */
function messageMentionIds(rows: readonly MessageRow[]): string[] {
	const ids = new Set<string>();
	for (const row of rows) {
		if (row.contentText !== null) collectMentionIds(row.contentText, ids);
		// The resolved part text is the same string, so scanning the JSON avoids parsing it twice.
		if (row.partsJson !== null) collectMentionIds(row.partsJson, ids);
	}
	return [...ids];
}

/**
 * Conversation scopes that bind a page's mention labels to the right channel account. Multiple
 * conversations on one page share one lookup; the same numeric id under two accounts is not
 * expected in practice.
 */
function messageScopes(
	rows: readonly MessageRow[],
	sessions: readonly { channelId?: string | null | undefined; id: string }[],
): MentionLabelScope[] {
	const channelBySession = new Map(sessions.map((session) => [session.id, session.channelId]));
	const scopes = new Map<string, MentionLabelScope>();
	for (const row of rows) {
		const platformAccountId = channelBySession.get(row.conversationId);
		if (platformAccountId === null || platformAccountId === undefined) continue;
		scopes.set(row.conversationId, {
			conversationId: row.conversationId,
			platformAccountId,
		});
	}
	return [...scopes.values()];
}

async function mentionLabelsFor(
	database: TsukaimaDatabase,
	rows: readonly MessageRow[],
	sessions: readonly { channelId?: string | null | undefined; id: string }[],
) {
	return loadMentionLabels(database, messageScopes(rows, sessions), messageMentionIds(rows));
}

function readReplyDecision(raw: string | null) {
	if (raw === null) return undefined;
	try {
		return inboundReplyDecisionSchema.safeParse(JSON.parse(raw)?.replyDecision).data;
	} catch {
		return undefined;
	}
}

function readReplyQuote(raw: string | null) {
	if (raw === null) return undefined;
	try {
		return messageQuoteSchema.safeParse(JSON.parse(raw)?.target?.quote).data;
	} catch {
		return undefined;
	}
}

function replyTargetKey(conversationId: string, messageId: string): string {
	return `${conversationId}\0${messageId}`;
}

async function loadReplyTargets(
	database: TsukaimaDatabase,
	rows: readonly MessageRow[],
): Promise<Map<string, MessageRow>> {
	const conversationIds = new Set<string>();
	const replyIds = new Set<string>();
	for (const row of rows) {
		if (row.replyToMessageId === null || row.replyToMessageId.length === 0) continue;
		conversationIds.add(row.conversationId);
		replyIds.add(row.replyToMessageId);
	}
	const targets = new Map<string, MessageRow>();
	if (conversationIds.size === 0 || replyIds.size === 0) return targets;
	const idList = [...replyIds];
	const targetRows = await database
		.select()
		.from(messages)
		.where(
			and(
				inArray(messages.conversationId, [...conversationIds]),
				or(inArray(messages.platformMessageId, idList), inArray(messages.id, idList)),
			),
		);
	for (const target of targetRows) {
		targets.set(replyTargetKey(target.conversationId, target.id), target);
		if (target.platformMessageId !== null) {
			targets.set(replyTargetKey(target.conversationId, target.platformMessageId), target);
		}
	}
	return targets;
}

function buildReplyPreview(
	row: MessageRow,
	replyTarget: MessageRow | undefined,
	displayText: (text: string) => string,
): MessageReplyPreview | undefined {
	if (row.replyToMessageId === null) return undefined;
	const rawQuote = readReplyQuote(row.rawRefJson);
	if (replyTarget !== undefined) {
		const fromSelf =
			replyTarget.direction === "outbound" || replyTarget.senderExternalId === "tsukaima";
		const targetParts = parseParts(replyTarget.partsJson).map((part) =>
			part.type === "text" ? { ...part, text: displayText(part.text) } : part,
		);
		const rawText = replyTarget.contentText ?? "";
		const contentText =
			rawText.trim().length > 0
				? displayText(rawText)
				: rawQuote?.excerpt !== undefined
					? displayText(rawQuote.excerpt)
					: "";
		const senderDisplayName =
			replyTarget.senderDisplayName ?? (fromSelf ? "Tsukaima" : rawQuote?.senderDisplayName);
		return {
			contentText,
			...(fromSelf ? { fromSelf: true } : {}),
			messageId: replyTarget.id,
			parts: targetParts,
			...(senderDisplayName !== undefined && senderDisplayName.trim().length > 0
				? { senderDisplayName }
				: {}),
			...(replyTarget.senderExternalId !== null
				? { senderExternalId: replyTarget.senderExternalId }
				: {}),
		};
	}
	if (rawQuote !== undefined) {
		const senderDisplayName =
			rawQuote.fromSelf === true
				? "Tsukaima"
				: (rawQuote.senderDisplayName ?? rawQuote.senderPlatformId);
		return {
			contentText: displayText(rawQuote.excerpt ?? ""),
			...(rawQuote.fromSelf === true ? { fromSelf: true } : {}),
			...(senderDisplayName !== undefined && senderDisplayName.trim().length > 0
				? { senderDisplayName }
				: {}),
			...(rawQuote.senderPlatformId !== undefined
				? { senderExternalId: rawQuote.senderPlatformId }
				: {}),
		};
	}
	return undefined;
}

function toMessageSummary(
	row: MessageRow,
	labels: ReadonlyMap<string, string> = new Map(),
	replyTarget?: MessageRow,
): MessageSummary {
	// Rows are stored with the platform id in mention text (`@<qq>`); the transcript shows the
	// display name instead. Nothing here is persisted, so a renamed contact shows up on the next
	// read and the stored envelope keeps the id the channel actually sent.
	const isWebui =
		row.kind === "webui" || row.direction === "outbound" || row.senderExternalId === "webui-admin";
	const isBot = row.kind === "assistant";
	const replyDecision = row.direction === "inbound" ? readReplyDecision(row.rawRefJson) : undefined;
	const displayText = (text: string) =>
		replaceMentionIds(
			row.direction === "outbound" ? sanitizeOutboundMetaLeaks(text).text : text,
			labels,
		);
	const replyTo = buildReplyPreview(row, replyTarget, displayText);
	return {
		contentText: displayText(row.contentText ?? ""),
		deliveryMode: row.deliveryMode,
		direction: row.direction,
		deliveryStatus: row.deliveryStatus,
		durableEntryId: row.durableEntryId,
		id: row.id,
		kind: row.kind,
		occurredAt: row.occurredAt,
		parts: parseParts(row.partsJson).map((part) =>
			part.type === "text" ? { ...part, text: displayText(part.text) } : part,
		),
		platformMessageId: row.platformMessageId,
		...(replyTo === undefined ? {} : { replyTo }),
		replyToMessageId: row.replyToMessageId,
		replyDecision,
		runId: row.runId,
		segmentIndex: row.segmentIndex,
		seq: row.seq,
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

async function toMessageSummaries(
	database: TsukaimaDatabase,
	rows: readonly MessageRow[],
	sessions: readonly { channelId?: string | null | undefined; id: string }[],
): Promise<MessageSummary[]> {
	if (rows.length === 0) return [];
	const replyTargets = await loadReplyTargets(database, rows);
	const labels = await mentionLabelsFor(database, [...rows, ...replyTargets.values()], sessions);
	return rows.map((row) =>
		toMessageSummary(
			row,
			mentionLabelsForConversation(labels, row.conversationId),
			row.replyToMessageId === null
				? undefined
				: replyTargets.get(replyTargetKey(row.conversationId, row.replyToMessageId)),
		),
	);
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
	seq: number;
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
				return {
					id: record.id,
					occurredAt: record.occurredAt,
					seq: typeof record.seq === "number" && record.seq > 0 ? record.seq : 0,
				};
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
				rank: sql<number>`row_number() over (partition by ${messages.conversationId} order by case when ${messages.seq} > 0 then 1 else 0 end desc, ${messages.seq} desc, ${messages.occurredAt} desc, ${messages.id} desc)`.as(
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
		const summaries = await toMessageSummaries(database, messageRows, sessionRows);
		for (const summary of summaries) {
			const row = messageRows.find((item) => item.id === summary.id);
			if (row !== undefined) latestBySession.set(row.conversationId, summary);
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
		case "tsukaima-system":
			return "System instructions";
		case "tsukaima-persona":
			return "Persona";
		case "tsukaima-policy":
			return "Policy";
		case "tsukaima-memory":
		case "turn-context/memories":
			return "Memories";
		case "instructions":
			return "Instructions";
		case "system":
			return "System";
		default:
			return key.startsWith("turn-context/")
				? `Turn context: ${key.slice("turn-context/".length)}`
				: key;
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
		.select({
			chatKind: chatObjects.kind,
			durableConversationId: conversations.durableConversationId,
			sessionKind: conversations.kind,
		})
		.from(conversations)
		.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) return null;

	if ((session.chatKind ?? session.sessionKind) === "workspace") {
		return lifecycle.workspaceNative.contextStats(sessionId);
	}

	const policy = await lifecycle.conversationPolicy.ensureHostPolicy(
		sessionId,
		session.durableConversationId,
	);
	const proactiveTools = lifecycle.pluginHost.modelToolNames("proactive-scheduler");
	const kind = session.chatKind ?? session.sessionKind;
	// Same pure helper the lifecycle uses to write the durable model-tool filter, so the
	// Context Inspector preview can never disagree with the tools actually offered.
	const omittedTools = computeOmittedSessionTools({
		agentAccess: lifecycle.prompts.agentAccess(),
		capabilities: policy.capabilities,
		chatSurfaceOmitted: host.modelToolNamesNotForSurface("chat"),
		codingSurfaceOmitted: host.modelToolNamesNotForSurface("coding"),
		kind,
		proactiveTools,
		workspaceDelegationEnabled: policy.workspaceDelegationEnabled === true,
	});
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
			text: section.text,
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
		.select({
			chatKind: chatObjects.kind,
			durableConversationId: conversations.durableConversationId,
		})
		.from(conversations)
		.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	const workspaceAborted =
		session.chatKind === "workspace" ? await lifecycle.workspaceNative.abort(sessionId) : false;
	const cancelledPendingOutput = workspaceAborted
		? false
		: lifecycle.replyDispatcher.cancelPendingOutput(session.durableConversationId);
	if (!workspaceAborted) await host.abortConversation(session.durableConversationId);
	await lifecycle.conversationRuns
		.interruptActiveRun(sessionId, lifecycle.liveRuns.currentRounds(sessionId))
		.catch(() => undefined);
	await lifecycle.liveRuns.markInterrupted(sessionId).catch(() => undefined);
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
	const [previous] = await database
		.select({
			durableConversationId: conversations.durableConversationId,
			id: conversations.id,
		})
		.from(conversations)
		.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.status, "active")))
		.orderBy(desc(conversations.isReceiving), desc(conversations.updatedAt))
		.limit(1);
	const durableConversationId = await host.createConversation();
	const baseline =
		previous === undefined
			? { method: "none" as const, seeded: false, summaryChars: 0 }
			: await host.seedConversationBaseline(durableConversationId, previous.durableConversationId);
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
	if (previous !== undefined) {
		await lifecycle.conversationPolicy.inheritConversationPolicy(previous.id, id);
	}
	await database.update(chatObjects).set({ updatedAt: now }).where(eq(chatObjects.id, chat.id));
	await lifecycle.writeAudit({
		action: "session.create",
		payload: {
			baselineMethod: baseline.method,
			baselineSeeded: baseline.seeded,
			chatObjectId,
			...(previous === undefined ? {} : { previousSessionId: previous.id }),
		},
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
	const seqGroup = sql<number>`case when ${messages.seq} > 0 then 1 else 0 end`;
	const rows = await database
		.select()
		.from(messages)
		.where(eq(messages.conversationId, sessionId))
		.orderBy(asc(seqGroup), asc(messages.seq), asc(messages.occurredAt), asc(messages.id));
	return toMessageSummaries(database, rows, [session]);
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
	const seqGroup = sql<number>`case when ${messages.seq} > 0 then 1 else 0 end`;
	const cursorGroup = cursor === null ? 1 : cursor.seq > 0 ? 1 : 0;
	const filters =
		cursor === null
			? eq(messages.conversationId, input.sessionId)
			: and(
					eq(messages.conversationId, input.sessionId),
					or(
						lt(seqGroup, cursorGroup),
						and(
							eq(seqGroup, cursorGroup),
							or(
								lt(messages.seq, cursor.seq),
								and(
									eq(messages.seq, cursor.seq),
									or(
										lt(messages.occurredAt, cursor.occurredAt),
										and(eq(messages.occurredAt, cursor.occurredAt), lt(messages.id, cursor.id)),
									),
								),
							),
						),
					),
				);

	// Fetch one extra row to learn whether an older page exists without a second count query.
	const rows = await database
		.select()
		.from(messages)
		.where(filters)
		.orderBy(desc(seqGroup), desc(messages.seq), desc(messages.occurredAt), desc(messages.id))
		.limit(limit + 1);
	const pageRows = rows.slice(0, limit);
	const oldest = pageRows.at(-1);
	const orderedRows = pageRows.toReversed();
	const seqs = orderedRows.map((row) => row.seq).filter((seq) => seq > 0);
	const minSeq = seqs.length === 0 ? 0 : Math.min(...seqs);
	const maxSeq = seqs.length === 0 ? minSeq : Math.max(...seqs);
	const runSegments =
		orderedRows.length === 0
			? input.cursor === undefined
				? await lifecycle.conversationRuns.listSegmentsForConversation(input.sessionId)
				: []
			: await lifecycle.conversationRuns.listSegmentsForConversation(
					input.sessionId,
					input.cursor === undefined ? { minSeq } : { maxSeq, minSeq },
				);
	return {
		messages: await toMessageSummaries(database, orderedRows, [session]),
		nextCursor:
			rows.length > limit && oldest !== undefined
				? encodeMessageCursor({
						id: oldest.id,
						occurredAt: oldest.occurredAt,
						seq: oldest.seq,
					})
				: null,
		runSegments,
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
	if (row === undefined) return null;
	const [session] = await database
		.select({ channelId: conversations.channelId })
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	const [summary] = await toMessageSummaries(
		database,
		[row],
		[{ channelId: session?.channelId ?? null, id: input.sessionId }],
	);
	return summary ?? null;
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
	input: {
		entryId?: string | undefined;
		runId?: string | undefined;
		runSegmentId?: string | undefined;
		sessionId: string;
	},
): Promise<{
	durationSeconds?: number;
	rounds: RunSegmentSummary["rounds"];
	segment?: RunSegmentSummary;
	steps: RunStep[];
}> {
	const database = requireDatabase(lifecycle);
	const [session] = await database
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.id, input.sessionId))
		.limit(1);
	if (session === undefined) throw new Error("Session not found");
	const runs = lifecycle.conversationRuns;
	let segment: RunSegmentSummary | undefined;
	if (input.runSegmentId !== undefined) {
		segment = await runs.getSegmentById(input.runSegmentId);
	} else if (input.runId !== undefined) {
		segment = await runs.getLatestSegmentSummaryForRun(input.runId);
	} else if (input.entryId !== undefined) {
		segment = await runs.getSegmentForEntry(input.sessionId, input.entryId);
	}
	if (segment === undefined) return { rounds: [], steps: [] };
	const durationSeconds =
		segment.durationMs === null ? undefined : Math.round((segment.durationMs / 1_000) * 10) / 10;
	return {
		...(durationSeconds === undefined ? {} : { durationSeconds }),
		rounds: segment.rounds,
		segment,
		steps: roundsToRunSteps(segment.rounds),
	};
}

export async function sendMessage(
	lifecycle: TsukaimaLifecycle,
	input: {
		mode?: MessageDeliveryMode;
		references?: readonly { messageId?: string | undefined; sessionId: string }[];
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
		const runs = lifecycle.conversationRuns;
		const activeAnchor = await runs.activeAnchor(session.session.id);
		const seq = await runs.allocateSeq(session.session.id);
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
			...(activeAnchor === undefined
				? {}
				: { runId: activeAnchor.runId, segmentIndex: activeAnchor.segmentIndex }),
			seq,
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
		const labels = await loadMentionLabels(
			database,
			[{ conversationId: session.session.id, platformAccountId: channelId }],
			collectMentionIds(text),
		);
		return toMessageSummary(saved, mentionLabelsForConversation(labels, saved.conversationId));
	}

	const sent = await lifecycle.sessionMessaging.sendAgentMessage({
		...(input.mode === undefined ? {} : { deliveryMode: input.mode }),
		...(input.references === undefined ? {} : { references: input.references }),
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
	const labels = await loadMentionLabels(
		database,
		session.session.channelId === null
			? []
			: [
					{
						conversationId: session.session.id,
						platformAccountId: session.session.channelId,
					},
				],
		collectMentionIds(text),
	);
	return toMessageSummary(saved, mentionLabelsForConversation(labels, saved.conversationId));
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
