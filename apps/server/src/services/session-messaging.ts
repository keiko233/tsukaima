import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MessageDeliveryMode, MessagePart } from "@tsukaima/contracts";
import type { PiDurableConversationHost } from "@tsukaima/core";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { PromptHook, PromptHookService } from "./prompt-hooks.ts";

type ChatKind = "private" | "group" | "webui" | "workspace" | "task" | "plugin";

export interface SessionMessagingOptions {
	readonly applyToolPolicy?: (sessionId: string, durableConversationId: string) => Promise<void>;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly cancelPendingOutput?: (durableConversationId: string) => boolean;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
	readonly hooks: PromptHookService;
	readonly prepareTurn?: (
		sessionId: string,
		input: PrepareTurnInput,
	) => Promise<string | undefined>;
	readonly notifyMessageReceived?: (input: {
		readonly chatObjectId: string;
		readonly messageId: string;
		readonly sessionId: string;
	}) => void;
	readonly policy: {
		ensureHostPolicy: (sessionId: string, durableConversationId: string) => Promise<unknown>;
	};
}

export interface SendAgentMessageInput {
	readonly context?: string;
	readonly deliveryMode?: MessageDeliveryMode;
	readonly direction?: "inbound" | "system";
	/** Stable domain message id for an idempotent retry. */
	readonly messageId?: string;
	readonly references?: readonly {
		readonly messageId?: string | undefined;
		readonly sessionId: string;
	}[];
	/** Stable durable submission id for an idempotent retry. */
	readonly requestId?: string;
	readonly senderExternalId?: string;
	readonly senderName?: string;
	readonly sessionId: string;
	readonly source?: "resume-hook" | "scheduler" | "session-tool" | "webui";
	readonly text: string;
}

export interface SendAgentMessageResult {
	readonly chatObjectId: string;
	readonly durableConversationId: string;
	readonly messageId: string;
	readonly mode: MessageDeliveryMode;
}

export interface PrepareTurnInput {
	readonly references?: readonly {
		readonly messageId?: string | undefined;
		readonly sessionId: string;
	}[];
	readonly text: string;
}

interface SessionRow {
	readonly chat: typeof chatObjects.$inferSelect;
	readonly session: typeof conversations.$inferSelect;
}

function whenBusy(mode: MessageDeliveryMode): "steer" | "follow-up" {
	return mode === "queue" ? "steer" : "follow-up";
}

/**
 * Shared local-session ingress used by the chat composer, workspace tools, and durable resume
 * hooks. Queue/interrupt is a transport concern layered over the same durable conversation, so
 * both surfaces get identical semantics and persistence.
 */
export class SessionMessagingService {
	readonly #applyToolPolicy: SessionMessagingOptions["applyToolPolicy"];
	readonly #audit: SessionMessagingOptions["audit"];
	readonly #cancelPendingOutput: SessionMessagingOptions["cancelPendingOutput"];
	readonly #database: SessionMessagingOptions["database"];
	readonly #hooks: PromptHookService;
	readonly #host: SessionMessagingOptions["host"];
	readonly #logger: Logger;
	readonly #notifyMessageReceived: SessionMessagingOptions["notifyMessageReceived"];
	readonly #policy: SessionMessagingOptions["policy"];
	readonly #prepareTurn: SessionMessagingOptions["prepareTurn"];

	constructor(options: SessionMessagingOptions) {
		this.#applyToolPolicy = options.applyToolPolicy;
		this.#audit = options.audit;
		this.#cancelPendingOutput = options.cancelPendingOutput;
		this.#database = options.database;
		this.#hooks = options.hooks;
		this.#host = options.host;
		this.#logger = options.logger.child("tsukaima::server::session-messaging");
		this.#notifyMessageReceived = options.notifyMessageReceived;
		this.#policy = options.policy;
		this.#prepareTurn = options.prepareTurn;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	#hostRequired(): PiDurableConversationHost {
		const host = this.#host();
		if (host === undefined) throw new Error("Conversation host is not ready");
		return host;
	}

	async session(sessionId: string): Promise<SessionRow> {
		const [row] = await this.#db()
			.select({ chat: chatObjects, session: conversations })
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, sessionId))
			.limit(1);
		if (row === undefined) throw new Error("Session not found");
		return row;
	}

	async searchSessions(
		query: string,
		limit = 10,
	): Promise<
		Array<{
			readonly chatId: string;
			readonly chatTitle: string;
			readonly id: string;
			readonly kind: ChatKind;
			readonly title: string;
			readonly updatedAt: string;
		}>
	> {
		const database = this.#db();
		const rows = await database
			.select({
				chatId: chatObjects.id,
				chatTitle: chatObjects.title,
				chatKind: chatObjects.kind,
				id: conversations.id,
				kind: conversations.kind,
				title: conversations.title,
				updatedAt: conversations.updatedAt,
			})
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.status, "active"))
			.orderBy(conversations.updatedAt)
			.limit(500);
		const needle = query.trim().toLowerCase();
		return rows
			.toReversed()
			.filter((row) => {
				if (needle.length === 0) return true;
				return [row.id, row.title ?? "", row.chatTitle, row.chatKind].some((value) =>
					value.toLowerCase().includes(needle),
				);
			})
			.slice(0, Math.max(1, Math.min(limit, 25)))
			.map((row) => ({
				chatId: row.chatId,
				chatTitle: row.chatTitle,
				id: row.id,
				kind: row.kind as ChatKind,
				title: row.title ?? row.chatTitle,
				updatedAt: row.updatedAt,
			}));
	}

	async sendAgentMessage(input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
		const database = this.#db();
		const host = this.#hostRequired();
		const { chat, session } = await this.session(input.sessionId);
		if (session.status !== "active") throw new Error("Session is archived");
		if (chat.status !== "active") throw new Error("Chat object is archived");
		const text = input.text.trim();
		if (text.length === 0) throw new Error("Message is empty");
		const deliveryMode = input.deliveryMode ?? "queue";
		const direction = input.direction ?? "inbound";
		const now = new Date().toISOString();
		const id = input.messageId ?? randomUUID();
		const senderName =
			input.senderName ?? (direction === "system" ? "Tsukaima scheduler" : "WebUI admin");
		const senderExternalId =
			input.senderExternalId ?? (direction === "system" ? "tsukaima-system" : "webui-admin");
		const parts: MessagePart[] = [{ text, type: "text" }];

		if (deliveryMode === "interrupt") {
			this.#cancelPendingOutput?.(session.durableConversationId);
			await host.abortConversation(session.durableConversationId);
		}
		const preparedContext = await this.#prepareTurn?.(session.id, {
			...(input.references === undefined ? {} : { references: input.references }),
			text,
		});
		try {
			await this.#applyToolPolicy?.(session.id, session.durableConversationId);
		} catch (error) {
			// Fail closed: a turn whose tool policy could not be applied runs with no model tools.
			await host.setModelToolAllowlist(session.durableConversationId, []);
			this.#logger.warn("session tool policy failed; disabling model tools", {
				error: error instanceof Error ? error.message : String(error),
				sessionId: session.id,
			});
		}
		await this.#policy.ensureHostPolicy(session.id, session.durableConversationId);
		const hookContext = await this.#hooks.renderContext(session.id);
		const triggerContext = [input.context, preparedContext, hookContext]
			.filter((entry): entry is string => entry !== undefined && entry.trim().length > 0)
			.join("\n\n");

		const [existing] = await database
			.select({
				deliveryStatus: messages.deliveryStatus,
				id: messages.id,
			})
			.from(messages)
			.where(eq(messages.id, id))
			.limit(1);
		if (
			existing !== undefined &&
			(existing.deliveryStatus === "accepted" || existing.deliveryStatus === "sent")
		) {
			return {
				chatObjectId: chat.id,
				durableConversationId: session.durableConversationId,
				messageId: id,
				mode: deliveryMode,
			};
		}
		if (existing === undefined) {
			await database.insert(messages).values({
				chatObjectId: chat.id,
				contentText: text,
				conversationId: session.id,
				direction,
				deliveryStatus: "pending",
				id,
				ingestedAt: now,
				kind: "webui",
				occurredAt: now,
				partsJson: JSON.stringify(parts),
				senderDisplayName: senderName,
				senderExternalId,
				updatedAt: now,
			});
		} else {
			await database
				.update(messages)
				.set({ deliveryStatus: "pending", updatedAt: now })
				.where(eq(messages.id, id));
		}
		try {
			await host.append({
				conversationId: session.durableConversationId,
				envelope: {
					channelId: "webui",
					channelKind: "webui",
					conversationKey: { kind: "webui" },
					id,
					mentions: [],
					parts,
					sender: {
						displayName: senderName,
						id: senderExternalId,
						isBot: direction === "system",
						platformId: senderExternalId,
					},
					source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
				},
				forceSubmit: true,
				...(input.requestId === undefined ? {} : { requestId: input.requestId }),
				submittedAtMs: Date.now(),
				...(triggerContext.length === 0 ? {} : { triggerContext }),
				whenBusy: whenBusy(deliveryMode),
			});
			await database
				.update(messages)
				.set({ deliveryStatus: "accepted", updatedAt: new Date().toISOString() })
				.where(eq(messages.id, id));
		} catch (error) {
			await database
				.update(messages)
				.set({ deliveryStatus: "failed", updatedAt: new Date().toISOString() })
				.where(eq(messages.id, id));
			throw error;
		}
		const updatedAt = new Date().toISOString();
		await Promise.all([
			database.update(conversations).set({ updatedAt }).where(eq(conversations.id, session.id)),
			database.update(chatObjects).set({ updatedAt }).where(eq(chatObjects.id, chat.id)),
		]);
		this.#notifyMessageReceived?.({
			chatObjectId: chat.id,
			messageId: id,
			sessionId: session.id,
		});
		await this.#audit?.({
			action: `session.message.${deliveryMode}`,
			actorId: senderExternalId,
			actorKind: direction === "system" ? "system" : "user",
			payload: {
				chatKind: chat.kind,
				deliveryMode,
				source: input.source ?? "session-tool",
			},
			result: "ok",
			targetId: session.id,
			targetKind: "session",
		});
		this.#logger.debug("agent message submitted", {
			chatKind: chat.kind,
			deliveryMode,
			messageId: id,
			sessionId: session.id,
		});
		return {
			chatObjectId: chat.id,
			durableConversationId: session.durableConversationId,
			messageId: id,
			mode: deliveryMode,
		};
	}

	async dispatchResumeHook(hook: PromptHook): Promise<void> {
		const targetSessionId = hook.targetSessionId;
		if (targetSessionId === null) throw new Error("Resume hook has no target session");
		await this.sendAgentMessage({
			context: [
				"[Durable resume hook] The process restarted and this reserved task is now due.",
				"Continue from the saved context. If the work is already complete, report that instead of repeating it.",
			].join("\n"),
			direction: "system",
			sessionId: targetSessionId,
			source: "resume-hook",
			text: hook.prompt,
		});
	}
}
