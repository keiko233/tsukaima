import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { clamp } from "es-toolkit";
import type { MessageDeliveryMode, MessagePart } from "@tsukaima/contracts";
import type { PiDurableConversationHost } from "@tsukaima/core";
import { chatObjects, conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ConversationRunAnchor, ConversationRunService } from "./conversation-runs.ts";
import type { LiveRunCache } from "./live-run-cache.ts";
import type { PromptHook, PromptHookService } from "./prompt-hooks.ts";

type ChatKind = "private" | "group" | "webui" | "workspace" | "task" | "plugin";

export interface SessionMessagingOptions {
	readonly abortWorkspace?: (sessionId: string) => Promise<boolean>;
	readonly applyToolPolicy?: (sessionId: string, durableConversationId: string) => Promise<void>;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly cancelPendingOutput?: (durableConversationId: string) => boolean;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly dispatchWorkspace?: (input: {
		readonly context?: string | undefined;
		readonly deliveryMode: MessageDeliveryMode;
		readonly messageId: string;
		readonly runAnchor?: ConversationRunAnchor | undefined;
		readonly sessionId: string;
		readonly text: string;
	}) => Promise<void>;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
	readonly hooks: PromptHookService;
	/** Live run timeline, used to freeze the segment rounds before a steer splits it. */
	readonly liveRuns?: LiveRunCache | undefined;
	/** Durable run/segment store; every message insert reserves its timeline position here. */
	readonly runs?: (() => ConversationRunService | undefined) | undefined;
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
	return mode === "steer" ? "steer" : "follow-up";
}

/**
 * Shared local-session ingress used by the chat composer, workspace tools, and durable resume
 * hooks. Queue/interrupt is a transport concern layered over the same durable conversation, so
 * both surfaces get identical semantics and persistence.
 */
export class SessionMessagingService {
	readonly #abortWorkspace: SessionMessagingOptions["abortWorkspace"];
	readonly #applyToolPolicy: SessionMessagingOptions["applyToolPolicy"];
	readonly #audit: SessionMessagingOptions["audit"];
	readonly #cancelPendingOutput: SessionMessagingOptions["cancelPendingOutput"];
	readonly #database: SessionMessagingOptions["database"];
	readonly #dispatchWorkspace: SessionMessagingOptions["dispatchWorkspace"];
	readonly #hooks: PromptHookService;
	readonly #host: SessionMessagingOptions["host"];
	readonly #logger: Logger;
	readonly #liveRuns: SessionMessagingOptions["liveRuns"];
	readonly #notifyMessageReceived: SessionMessagingOptions["notifyMessageReceived"];
	readonly #policy: SessionMessagingOptions["policy"];
	readonly #prepareTurn: SessionMessagingOptions["prepareTurn"];
	readonly #runs: SessionMessagingOptions["runs"];

	constructor(options: SessionMessagingOptions) {
		this.#abortWorkspace = options.abortWorkspace;
		this.#applyToolPolicy = options.applyToolPolicy;
		this.#audit = options.audit;
		this.#cancelPendingOutput = options.cancelPendingOutput;
		this.#database = options.database;
		this.#dispatchWorkspace = options.dispatchWorkspace;
		this.#hooks = options.hooks;
		this.#host = options.host;
		this.#liveRuns = options.liveRuns;
		this.#logger = options.logger.child("tsukaima::server::session-messaging");
		this.#notifyMessageReceived = options.notifyMessageReceived;
		this.#policy = options.policy;
		this.#prepareTurn = options.prepareTurn;
		this.#runs = options.runs;
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
			.slice(0, clamp(limit, 1, 25))
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
		const direction = input.direction ?? "inbound";
		const id = input.messageId ?? randomUUID();
		const requestedMode = input.deliveryMode ?? "steer";
		const senderName =
			input.senderName ?? (direction === "system" ? "Tsukaima scheduler" : "WebUI admin");
		const senderExternalId =
			input.senderExternalId ?? (direction === "system" ? "tsukaima-system" : "webui-admin");
		const parts: MessagePart[] = [{ text, type: "text" }];
		const runs = this.#runs?.();

		const [existing] = await database
			.select({
				deliveryMode: messages.deliveryMode,
				deliveryStatus: messages.deliveryStatus,
				id: messages.id,
				occurredAt: messages.occurredAt,
				seq: messages.seq,
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
				mode: (existing.deliveryMode as MessageDeliveryMode | null) ?? requestedMode,
			};
		}

		const activeAnchor = await runs?.activeAnchor(session.id);
		let busy = activeAnchor !== undefined;
		if (!busy && chat.kind !== "workspace") {
			try {
				busy = (await host.conversationActivity(session.durableConversationId))?.busy === true;
			} catch {
				busy = false;
			}
		}
		const deliveryMode: MessageDeliveryMode = busy ? requestedMode : "steer";
		let storedDeliveryMode: MessageDeliveryMode | null = busy ? requestedMode : null;
		let occurredAt = new Date().toISOString();
		let seq = existing?.seq !== undefined && existing.seq > 0 ? existing.seq : -1;

		if (busy && requestedMode === "interrupt") {
			const workspaceAborted = (await this.#abortWorkspace?.(session.id)) === true;
			if (!workspaceAborted) {
				this.#cancelPendingOutput?.(session.durableConversationId);
				await host.abortConversation(session.durableConversationId);
			}
			// Abort first, then freeze the run at the position it actually reached. The
			// interrupting message must be allocated after that position, never before it.
			await runs?.interruptActiveRun(session.id, this.#liveRuns?.currentRounds(session.id));
			await this.#liveRuns?.markInterrupted(session.id);
			occurredAt = new Date().toISOString();
			if (seq < 0) seq = (await runs?.allocateSeq(session.id)) ?? 0;
		}
		if (seq < 0 && !(busy && deliveryMode === "steer" && runs !== undefined)) {
			seq = (await runs?.allocateSeq(session.id)) ?? 0;
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
		// Caller context and explicit references are conversation content and stay durable; prompt
		// hooks are per-turn and reach the model only through the ephemeral turn context.
		const attachedContext = [input.context, preparedContext]
			.filter((entry): entry is string => entry !== undefined && entry.trim().length > 0)
			.join("\n\n");

		let runAnchor: ConversationRunAnchor | undefined;
		let persisted = false;
		if (busy && deliveryMode === "steer" && runs !== undefined) {
			const closed = await runs.closeActiveSegmentForSteer({
				conversationId: session.id,
				currentRounds: this.#liveRuns?.currentRounds(session.id),
			});
			if (closed !== undefined) {
				// Freeze the old segment first, then place the steer message after it and open the
				// continuation after the message, so the transcript interleaves strictly.
				if (seq < 0) seq = (await runs.allocateSeq(session.id)) ?? 0;
				await this.#persistUserMessage(database, {
					chat,
					deliveryMode: storedDeliveryMode,
					direction,
					existing,
					id,
					now: occurredAt,
					parts,
					seq,
					session,
					senderExternalId,
					senderName,
					text,
				});
				persisted = true;
				runAnchor = await runs.openSegment({
					conversationId: session.id,
					runId: closed.runId,
					triggerKind: "steer",
					triggerMessageId: id,
				});
				await this.#liveRuns?.advanceSegment(session.id, runAnchor);
			}
		}
		if (!persisted) {
			if (seq < 0) seq = (await runs?.allocateSeq(session.id)) ?? 0;
			await this.#persistUserMessage(database, {
				chat,
				deliveryMode: storedDeliveryMode,
				direction,
				existing,
				id,
				now: occurredAt,
				parts,
				seq,
				session,
				senderExternalId,
				senderName,
				text,
			});
		}
		try {
			if (chat.kind === "workspace" && this.#dispatchWorkspace !== undefined) {
				const workspaceContext = [attachedContext, hookContext ?? ""]
					.filter((entry) => entry.trim().length > 0)
					.join("\n\n");
				await this.#dispatchWorkspace({
					...(workspaceContext.length === 0 ? {} : { context: workspaceContext }),
					deliveryMode,
					messageId: id,
					...(runAnchor === undefined ? {} : { runAnchor }),
					sessionId: session.id,
					text,
				});
			} else {
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
					...(input.source === "scheduler" ? { isolated: true } : {}),
					...(input.requestId === undefined ? {} : { requestId: input.requestId }),
					submittedAtMs: Date.now(),
					...(attachedContext.length === 0 ? {} : { attachedContext }),
					...(hookContext === undefined || hookContext.trim().length === 0
						? {}
						: { turnContext: { classification: "direct" as const, promptHooks: hookContext } }),
					...(busy && deliveryMode !== "interrupt" ? { whenBusy: whenBusy(deliveryMode) } : {}),
				});
			}
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
				...(storedDeliveryMode === null ? { idle: true } : {}),
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

	async #persistUserMessage(
		database: TsukaimaDatabase,
		input: {
			readonly chat: SessionRow["chat"];
			readonly deliveryMode: MessageDeliveryMode | null;
			readonly direction: "inbound" | "system";
			readonly existing: { readonly id: string } | undefined;
			readonly id: string;
			readonly now: string;
			readonly parts: readonly MessagePart[];
			readonly seq: number;
			readonly session: SessionRow["session"];
			readonly senderExternalId: string;
			readonly senderName: string;
			readonly text: string;
		},
	): Promise<void> {
		if (input.existing === undefined) {
			await database.insert(messages).values({
				chatObjectId: input.chat.id,
				contentText: input.text,
				conversationId: input.session.id,
				deliveryMode: input.deliveryMode,
				deliveryStatus: "pending",
				direction: input.direction,
				id: input.id,
				ingestedAt: input.now,
				kind: "webui",
				occurredAt: input.now,
				partsJson: JSON.stringify(input.parts),
				seq: input.seq,
				senderDisplayName: input.senderName,
				senderExternalId: input.senderExternalId,
				updatedAt: input.now,
			});
			return;
		}
		await database
			.update(messages)
			.set({
				deliveryMode: input.deliveryMode,
				deliveryStatus: "pending",
				...(input.seq === 0 ? {} : { seq: input.seq }),
				updatedAt: input.now,
			})
			.where(eq(messages.id, input.id));
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
