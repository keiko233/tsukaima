import { eq } from "drizzle-orm";
import {
	chatObjects,
	conversations,
	messages,
	schedules,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { ConversationRunService } from "./conversation-runs.ts";
import type {
	ScheduleExecutionResult,
	ScheduleExecutor,
	ScheduleSnapshot,
} from "./schedule-service.ts";
import { isInQuietHours, nextQuietHoursEndMs } from "./schedule-time.ts";
import type { SessionMessagingService } from "./session-messaging.ts";

export interface ScheduleExecutorOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly channels: ChannelRegistry;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly now?: () => number;
	readonly policy: ConversationPolicyService;
	readonly runs?: (() => ConversationRunService | undefined) | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Executes one schedule occurrence through the same session ingress used by chat, or through the
 * host outbound path for a plain notification. Request/message ids derive from the occurrence so
 * a retry reuses the durable submission and transcript row.
 */
export class ScheduleExecutionService implements ScheduleExecutor {
	readonly #audit: ScheduleExecutorOptions["audit"];
	readonly #channels: ChannelRegistry;
	readonly #database: ScheduleExecutorOptions["database"];
	readonly #logger: Logger;
	readonly #messaging: SessionMessagingService;
	readonly #now: () => number;
	readonly #policy: ConversationPolicyService;
	readonly #runs: ScheduleExecutorOptions["runs"];

	constructor(options: ScheduleExecutorOptions) {
		this.#audit = options.audit;
		this.#channels = options.channels;
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::schedule-executor");
		this.#messaging = options.messaging;
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#runs = options.runs;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async execute(input: {
		readonly occurrence: import("@tsukaima/contracts").ScheduleOccurrence;
		readonly snapshot: ScheduleSnapshot;
	}): Promise<ScheduleExecutionResult> {
		const database = this.#db();
		const { occurrence, snapshot } = input;
		const [target] = await database
			.select({ chat: chatObjects, session: conversations })
			.from(conversations)
			.innerJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, snapshot.sessionId))
			.limit(1);
		if (target === undefined) throw new Error("Target session no longer exists");
		if (target.session.status !== "active") {
			await database
				.update(schedules)
				.set({
					status: "paused",
					updatedAtMs: this.#now(),
					pausedAtMs: this.#now(),
				})
				.where(eq(schedules.id, snapshot.scheduleId));
			return { result: { skipped: "session_archived" }, status: "skipped" };
		}
		if (target.chat.status !== "active") {
			await database
				.update(schedules)
				.set({
					status: "paused",
					updatedAtMs: this.#now(),
					pausedAtMs: this.#now(),
				})
				.where(eq(schedules.id, snapshot.scheduleId));
			return { result: { skipped: "chat_archived" }, status: "skipped" };
		}
		const now = this.#now();
		if (snapshot.flexWindowMs !== null) {
			const scheduledMs = Date.parse(occurrence.scheduledFor);
			if (Number.isFinite(scheduledMs) && now > scheduledMs + snapshot.flexWindowMs) {
				return { result: { skipped: "due_window_expired" }, status: "skipped" };
			}
		}
		if (snapshot.respectQuietHours) {
			const policy = await this.#policy.effectivePolicy(snapshot.sessionId);
			const quiet = policy.pacing.quietHours;
			if (quiet?.enabled === true && isInQuietHours(now, quiet, snapshot.timeZone)) {
				// One-off user-requested reminders defer to the next quiet-hours end instead of
				// permanently dropping as skipped; recurring schedules still skip the quiet slot.
				if (snapshot.recurrenceKind === "once") {
					const deferredUntilMs = nextQuietHoursEndMs(now, quiet, snapshot.timeZone);
					if (deferredUntilMs !== undefined) {
						return {
							deferredUntilMs,
							result: {
								deferred: "quiet_hours",
								deferredUntil: new Date(deferredUntilMs).toISOString(),
							},
							status: "deferred",
						};
					}
				}
				return { result: { skipped: "quiet_hours" }, status: "skipped" };
			}
		}
		const messageId = `schedule:${occurrence.id}`;
		const requestId = `schedule:${snapshot.scheduleId}:${occurrence.scheduledFor}`;
		if (snapshot.actionKind === "notify") {
			const result = await this.#notify({ target, snapshot, messageId });
			await this.#audit?.({
				action: "schedule.notify",
				actorKind: "system",
				payload: {
					messageId: result.messageId,
					scheduleId: snapshot.scheduleId,
					sessionId: snapshot.sessionId,
				},
				result: "ok",
				targetId: snapshot.scheduleId,
				targetKind: "schedule",
			});
			return result;
		}
		const sent = await this.#messaging.sendAgentMessage({
			context: `[Scheduled task] ${snapshot.title}`,
			deliveryMode: "follow-up",
			direction: "system",
			messageId,
			requestId,
			senderExternalId: "tsukaima-scheduler",
			senderName: "Tsukaima scheduler",
			sessionId: snapshot.sessionId,
			source: "scheduler",
			text: snapshot.prompt,
		});
		this.#logger.info("schedule turn submitted", {
			actionKind: snapshot.actionKind,
			messageId: sent.messageId,
			scheduleId: snapshot.scheduleId,
			sessionId: snapshot.sessionId,
		});
		return { messageId: sent.messageId, result: { submitted: true } };
	}

	async #notify(input: {
		readonly target: {
			readonly chat: typeof chatObjects.$inferSelect;
			readonly session: typeof conversations.$inferSelect;
		};
		readonly snapshot: ScheduleSnapshot;
		readonly messageId: string;
	}): Promise<ScheduleExecutionResult> {
		const database = this.#db();
		const { target, snapshot, messageId } = input;
		const [existing] = await database
			.select({ deliveryStatus: messages.deliveryStatus })
			.from(messages)
			.where(eq(messages.id, messageId))
			.limit(1);
		if (existing?.deliveryStatus === "sent") return { messageId, result: { reused: true } };
		const now = new Date(this.#now()).toISOString();
		const runs = this.#runs?.();
		const seq = existing === undefined ? ((await runs?.allocateSeq(target.session.id)) ?? 0) : 0;
		if (existing === undefined) {
			await database.insert(messages).values({
				chatObjectId: target.chat.id,
				contentText: snapshot.prompt,
				conversationId: target.session.id,
				direction: "system",
				deliveryStatus: "pending",
				id: messageId,
				ingestedAt: now,
				kind: "scheduler",
				occurredAt: now,
				partsJson: JSON.stringify([{ text: snapshot.prompt, type: "text" }]),
				seq,
				senderDisplayName: "Tsukaima scheduler",
				senderExternalId: "tsukaima-scheduler",
				updatedAt: now,
			});
		}
		if (target.chat.kind !== "private" && target.chat.kind !== "group") {
			await database
				.update(messages)
				.set({ deliveryStatus: "sent", updatedAt: now })
				.where(eq(messages.id, messageId));
			return { messageId, result: { local: true } };
		}
		const channelId = target.chat.channelId;
		const destination = target.chat.platformConversationId;
		const adapter = channelId === null ? undefined : this.#channels.get(channelId);
		if (
			channelId === null ||
			destination === null ||
			adapter === undefined ||
			adapter.diagnostics().connected !== true ||
			!this.#channels.hasCapability(channelId, "send", target.session.id)
		) {
			await database
				.update(messages)
				.set({ deliveryStatus: "failed", updatedAt: now })
				.where(eq(messages.id, messageId));
			throw new Error("CHANNEL_UNAVAILABLE");
		}
		try {
			const sent = await this.#channels.send(channelId, target.chat.kind, destination, [
				{ text: snapshot.prompt, type: "text" },
			]);
			await database
				.update(messages)
				.set({
					deliveryStatus: "sent",
					platformMessageId: sent.platformMessageId ?? null,
					updatedAt: new Date(this.#now()).toISOString(),
				})
				.where(eq(messages.id, messageId));
			return { messageId, result: { delivered: true } };
		} catch (error) {
			const uncertain = /timeout/i.test(errorMessage(error));
			await database
				.update(messages)
				.set({
					deliveryStatus: uncertain ? "uncertain" : "failed",
					updatedAt: new Date(this.#now()).toISOString(),
				})
				.where(eq(messages.id, messageId));
			if (uncertain) return { messageId, result: { uncertain: true }, status: "uncertain" };
			throw error;
		}
	}
}
