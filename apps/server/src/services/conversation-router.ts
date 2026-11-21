import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import {
	buildTurnCue,
	classifyConversationTrigger,
	type ConversationGatePort,
	type PiDurableConversationHost,
	type ResolvedReplyTarget,
	type TurnTrigger,
} from "@tsukaima/core";
import type {
	ConversationPolicy,
	InboundReplyDecision,
	MessagePart,
	MessageQuote,
} from "@tsukaima/contracts";
import {
	channelNoticeSchema,
	conversationPolicySchema,
	defaultConversationPolicy,
	MESSAGE_QUOTE_EXCERPT_MAX_CHARS,
	messageEnvelopeSchema,
	messagePartsText,
	type ChannelNotice,
	type MessageEnvelope,
	type TriggerDecision,
} from "@tsukaima/contracts";
import {
	chatObjects,
	conversations,
	conversationMembers,
	identities,
	messages,
	type TsukaimaDatabase,
	users,
	userAliases,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import type { ConversationPacingTracker } from "./conversation-pacing.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import { loadMentionLabels } from "./mention-labels.ts";
import { isValidTimeZone, localParts } from "./schedule-time.ts";

export interface ConversationIngestResult {
	readonly chatObjectId: string;
	readonly classification: TriggerDecision;
	readonly duplicated: boolean;
	readonly envelope?: MessageEnvelope;
	readonly ignored: boolean;
	readonly sessionId: string;
}

export interface ConversationRouterOptions {
	/** Apply conversation-scoped model tool visibility before a turn is submitted. */
	readonly applyModelToolPolicy?: (
		durableConversationId: string,
		policy: ConversationPolicy,
	) => Promise<void> | void;
	readonly audit?: (entry: AuditEntry) => Promise<void>;
	/** Optional fail-open pre-model gate used to filter undirected group `soft` escalations. */
	readonly conversationGate?: () => ConversationGatePort | undefined;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	/** Rate limit for ignored-trigger audit rows, per channel/conversation key. */
	readonly ignoredAuditIntervalMs?: number;
	readonly logger: Logger;
	/**
	 * Store an inbound media part's bytes and return the part rewritten to reference them.
	 * Without this an inbound image keeps only its remote URL, so nothing renders and the model
	 * sees a placeholder.
	 */
	readonly ingestMedia?: (part: MessagePart, channelId: string) => Promise<MessagePart>;
	/** Clock override used for daily session boundaries (defaults to `Date.now`). */
	readonly now?: () => number;
	readonly onInboundTrigger?: (durableConversationId: string) => void;
	readonly pacing?: ConversationPacingTracker;
	readonly policy?: ConversationPolicyService;
	/**
	 * Durable prompt-hook text inserted before the next turn. A hook failure is logged and
	 * skipped: injection must never block message ingestion.
	 */
	readonly promptContext?: (
		sessionId: string,
		durableConversationId: string,
	) => Promise<string | undefined>;
	/** IANA time zone for daily session boundaries (defaults to the host's local time zone). */
	readonly timeZone?: string;
}

export const messageText = messagePartsText;

function resolveRouterTimeZone(configured: string | undefined): string {
	if (configured !== undefined && isValidTimeZone(configured)) return configured;
	const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
	return detected !== undefined && isValidTimeZone(detected) ? detected : "UTC";
}

/** Local calendar date (`YYYY-MM-DD`) used to split external chat sessions by day. */
export function localDateKey(atMs: number, timeZone: string): string {
	const safeZone = isValidTimeZone(timeZone) ? timeZone : "UTC";
	const parts = localParts(atMs, safeZone);
	return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * Resolve the local date key of a stored `conversations.created_at` timestamp. Handles both
 * ISO-8601 strings and SQLite's `CURRENT_TIMESTAMP` (`YYYY-MM-DD HH:MM:SS`, which is UTC).
 */
export function sessionDateKey(storedTimestamp: string, timeZone: string): string | undefined {
	const trimmed = storedTimestamp.trim();
	if (trimmed.length === 0) return undefined;
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(trimmed)
		? `${trimmed.replace(" ", "T")}Z`
		: trimmed;
	const parsed = Date.parse(normalized);
	if (!Number.isFinite(parsed)) return undefined;
	return localDateKey(parsed, timeZone);
}

/**
 * Ordering key for the domain timeline. Every row that reaches the timeline must use the same
 * clock domain, so this is always local receipt time.
 *
 * Platform timestamps are NOT a safe ordering key: a remote OneBot host runs its own clock and
 * nothing guarantees it agrees with this process. NapCat hosts are commonly a few tens of
 * seconds off, and an inbound message stamped in the future sorts *after* the assistant reply it
 * caused, which reads as a scrambled transcript. Outbound rows are written from `Date.now()`,
 * so mixing platform time into the same column splits the timeline across two clock domains.
 *
 * The platform timestamp stays available as evidence on `raw_ref_json`.
 */
const timelineAt = (now: string): string => now;

const noticeSummary = (notice: ChannelNotice): string => {
	const actor = notice.actorDisplayName ?? notice.actorId ?? "unknown";
	const target = notice.targetUserId ?? notice.targetMessageId;
	const self = notice.isSelfTarget === true ? " (bot)" : "";
	return target === undefined
		? `[${notice.noticeType}] ${actor}${self}`
		: `[${notice.noticeType}] ${actor} -> ${target}${self}`;
};

const safeChannelId = (envelope: unknown): string => {
	if (typeof envelope === "object" && envelope !== null && "channelId" in envelope) {
		const value = (envelope as { channelId?: unknown }).channelId;
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "unknown";
};

/**
 * Channel-agnostic ingestion: identity resolution, chat-object/session resolution, durable
 * append, and domain message persistence. Any channel adapter can drive it with a
 * `MessageEnvelope`.
 */
export class ConversationRouter {
	readonly #applyModelToolPolicy: ConversationRouterOptions["applyModelToolPolicy"];
	readonly #audit: ConversationRouterOptions["audit"];
	readonly #conversationGate: ConversationRouterOptions["conversationGate"];
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #ignoredAuditIntervalMs: number;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #onInboundTrigger: ConversationRouterOptions["onInboundTrigger"];
	readonly #pacing: ConversationPacingTracker | undefined;
	readonly #policy: ConversationPolicyService | undefined;
	readonly #promptContext: ConversationRouterOptions["promptContext"];
	readonly #timeZone: string;
	readonly #ingesting = new Set<string>();
	readonly #ignoredAuditAt = new Map<string, number>();
	readonly #sessionLocks = new Map<string, Promise<void>>();
	readonly #ingestMedia:
		| ((part: MessagePart, channelId: string) => Promise<MessagePart>)
		| undefined;
	readonly #stats = {
		ambient: 0,
		direct: 0,
		ignored: 0,
		soft: 0,
	};

	constructor(options: ConversationRouterOptions) {
		this.#applyModelToolPolicy = options.applyModelToolPolicy;
		this.#audit = options.audit;
		this.#conversationGate = options.conversationGate;
		this.#database = options.database;
		this.#host = options.host;
		this.#ignoredAuditIntervalMs = options.ignoredAuditIntervalMs ?? 60_000;
		this.#ingestMedia = options.ingestMedia;
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#onInboundTrigger = options.onInboundTrigger;
		this.#pacing = options.pacing;
		this.#policy = options.policy;
		this.#promptContext = options.promptContext;
		this.#timeZone = resolveRouterTimeZone(options.timeZone);
	}

	triggerStats(): {
		readonly ambient: number;
		readonly direct: number;
		readonly ignored: number;
		readonly soft: number;
	} {
		return { ...this.#stats };
	}

	async ingest(envelope: MessageEnvelope): Promise<ConversationIngestResult> {
		const parsed = messageEnvelopeSchema.safeParse(envelope);
		if (!parsed.success) {
			const channelId = safeChannelId(envelope);
			const reason = parsed.error.issues
				.slice(0, 4)
				.map((issue) => {
					const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
					return `${path}: ${issue.message}`;
				})
				.join("; ");
			this.#logger.warn("rejected invalid message envelope", { channelId, reason });
			throw new Error(`Invalid message envelope: ${reason}`);
		}
		const message = parsed.data;
		const ingestionKey = `${message.channelId}:${message.source.messageId ?? message.id}`;
		if (this.#ingesting.has(ingestionKey)) {
			throw new Error("Message is already being ingested");
		}
		this.#ingesting.add(ingestionKey);
		const startedAt = performance.now();
		const messageLog = this.#logger.span("process_message", {
			channelId: message.channelId,
			messageId: message.source.messageId ?? message.id,
		});
		messageLog.debug("channel message accepted", {
			conversationKind: message.conversationKey.kind,
			partCount: message.parts.length,
		});
		messageLog.trace("inbound message content preview", {
			preview: previewText(messageText(message.parts)),
			senderId: message.sender.platformId,
		});
		try {
			const host = this.#host();
			if (host === undefined) throw new Error("Conversation host is not ready");
			const database = this.#requireDatabase();
			const target = await this.resolveSession(message, message.sender.displayName);
			const platformMessageId = message.source.messageId ?? message.id;
			const existing = await database
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.chatObjectId, target.chatObjectId),
						eq(messages.platformMessageId, platformMessageId),
					),
				)
				.limit(1);
			if (existing.length > 0) {
				messageLog.debug("duplicate channel message ignored", {
					chatObjectId: target.chatObjectId,
					sessionId: target.sessionId,
				});
				return {
					chatObjectId: target.chatObjectId,
					classification: "direct",
					duplicated: true,
					ignored: false,
					sessionId: target.sessionId,
				};
			}

			const policy =
				(await this.#policy?.effectivePolicy(target.sessionId)) ??
				conversationPolicySchema.parse(defaultConversationPolicy);
			const selfAliases =
				(await this.#policy?.selfAliases(target.sessionId, policy)) ?? policy.trigger.selfAliases;
			const reply = await this.#resolveReplyContext(
				database,
				target.chatObjectId,
				message.target?.replyToEnvelopeId,
			);
			// A quote the channel resolved with `get_msg` still proves a reply to the bot when the
			// original message is outside the local retention window.
			const replyTarget =
				reply?.target ??
				(message.target?.quote?.fromSelf === true
					? { direction: "outbound" as const, senderKind: "assistant" as const }
					: undefined);
			const recentlyActive =
				this.#pacing?.isRecentlyActive(
					target.durableConversationId,
					Math.max(300_000, policy.pacing.burstMaxWaitMs),
				) ?? false;
			const escalation = policy.trigger.recentActivityEscalation;
			// `throttled` lets at most one undirected message per interval start a full-model `soft`
			// turn, so recent activity alone cannot burn a model call on every group message.
			const recentActivity =
				recentlyActive &&
				(escalation === "always" ||
					(escalation === "throttled" &&
						(this.#pacing?.softEscalationAvailable(
							target.durableConversationId,
							policy.trigger.recentActivityMinIntervalMs,
						) ??
							true)));
			const trigger = classifyConversationTrigger({
				chatKind: message.conversationKey.kind,
				envelope: message,
				policy,
				recentActivity,
				selfAliases,
				...(replyTarget === undefined ? {} : { replyTarget }),
			});
			// A gate may veto a soft trigger. Idle group chatter requires an explicit REPLY from
			// the configured model, so an unavailable model cannot wake an idle group.
			let effectiveTrigger = trigger;
			let replyGate: InboundReplyDecision["gate"];
			const gate = this.#conversationGate?.();
			const text = messageText(message.parts);
			const couldAddressBot =
				!trigger.peerBotSpeaking &&
				message.mentions.length === 0 &&
				message.target?.replyToEnvelopeId === undefined &&
				/(?:[你您妳]|\b(?:you|your|yours)\b)/iu.test(text);
			const allowAmbientReply = policy.gate.ambientGroupReply && !recentlyActive;
			const classifyAmbient =
				(allowAmbientReply || couldAddressBot) &&
				trigger.classification === "ambient" &&
				trigger.reason === "group context only";
			if (
				message.conversationKey.kind === "group" &&
				(trigger.classification === "soft" || classifyAmbient) &&
				!trigger.aliasMentioned &&
				policy.gate.enabled &&
				policy.gate.undirectedGroupReply &&
				gate !== undefined
			) {
				const recentRows = await database
					.select({
						contentText: messages.contentText,
						direction: messages.direction,
						senderDisplayName: messages.senderDisplayName,
					})
					.from(messages)
					.where(
						and(eq(messages.conversationId, target.sessionId), ne(messages.direction, "system")),
					)
					.orderBy(desc(messages.occurredAt), desc(messages.id))
					.limit(6);
				const recentContext = recentRows
					.toReversed()
					.filter((row) => (row.contentText ?? "").trim().length > 0)
					.map((row) => {
						const who = row.direction === "outbound" ? "(you)" : (row.senderDisplayName ?? "user");
						return `${who}: ${(row.contentText ?? "").trim()}`;
					});
				const gateDecision = await gate.decideUndirectedGroupReply({
					conversationId: target.sessionId,
					messageText: text,
					policy: policy.gate,
					recentContext,
					...(classifyAmbient && !allowAmbientReply ? { requireDirectAddress: true } : {}),
					senderName: message.sender.displayName,
				});
				replyGate = gateDecision;
				if (
					gateDecision.decision === "REPLY" &&
					gateDecision.source === "gate" &&
					classifyAmbient
				) {
					effectiveTrigger = {
						...trigger,
						classification: "soft",
						reason: "group reply gate invited a response",
					};
				} else if (gateDecision.decision === "SKIP") {
					effectiveTrigger = {
						...trigger,
						classification: "ambient",
						reason: `gate_skip:${gateDecision.reason ?? "undirected"}`,
					};
					messageLog.debug("undirected group message gated SKIP -> ambient", {
						reason: gateDecision.reason,
						sessionId: target.sessionId,
						source: gateDecision.source,
					});
				}
			}
			if (
				effectiveTrigger.classification === "soft" &&
				!effectiveTrigger.aliasMentioned &&
				recentActivity
			) {
				this.#pacing?.recordSoftEscalation(target.durableConversationId);
			}
			this.#stats[effectiveTrigger.classification] += 1;
			messageLog.debug("conversation trigger classified", {
				classification: effectiveTrigger.classification,
				recentActivity,
				reason: effectiveTrigger.reason,
				sessionId: target.sessionId,
			});

			if (effectiveTrigger.classification === "ignored") {
				await this.#recordIgnored(
					message,
					target.sessionId,
					target.chatObjectId,
					effectiveTrigger.reason,
				);
				messageLog.warn("conversation trigger ignored", {
					chatObjectId: target.chatObjectId,
					reason: effectiveTrigger.reason,
					sessionId: target.sessionId,
				});
				return {
					chatObjectId: target.chatObjectId,
					classification: "ignored",
					duplicated: false,
					ignored: true,
					sessionId: target.sessionId,
				};
			}

			const sender = await this.resolveIdentity(message);
			// Fetch media bytes before durable append and persistence so both the model turn input
			// (which resolves local blobs via `mediaId`/`sha256`) and the persisted transcript see
			// the local media reference. Best-effort: a failed fetch keeps the original part.
			// Mention labels and the quoted reply are resolved here, once, so durable formatting in
			// `@tsukaima/core` never needs channel or database lookups.
			const hydratedMessage = await this.#enrichReferences(
				database,
				await this.#hydrateInboundMedia(message),
				target.sessionId,
				reply?.quote,
			);
			let cooldownMs = 0;
			if (effectiveTrigger.classification !== "ambient") {
				// Only a direct address interrupts in-flight output. A `soft` message is chatter the
				// bot merely follows and must not cut a multi-bubble reply short.
				if (effectiveTrigger.classification === "direct") {
					this.#onInboundTrigger?.(target.durableConversationId);
				}
				await this.#policy?.ensureHostPolicy(target.sessionId, target.durableConversationId);
				try {
					await this.#applyModelToolPolicy?.(target.durableConversationId, policy);
				} catch (error) {
					messageLog.warn("conversation model tool policy failed", {
						error: error instanceof Error ? error.message : String(error),
						sessionId: target.sessionId,
					});
				}
				cooldownMs = this.#pacing?.remainingCooldownMs(target.durableConversationId, policy) ?? 0;
				messageLog.debug("appending turn to durable conversation", {
					classification: effectiveTrigger.classification,
					collectOnly: cooldownMs > 0,
					cooldownMs,
					durableConversationId: target.durableConversationId,
				});
				const injected = await this.#injectedPrompt(target.sessionId, target.durableConversationId);
				await host.append({
					classification: effectiveTrigger.classification,
					collectOnly: cooldownMs > 0,
					conversationId: target.durableConversationId,
					envelope: hydratedMessage,
					submittedAtMs: Date.now(),
					turnContext: turnContextFor(effectiveTrigger, hydratedMessage, injected),
				});
				if (cooldownMs > 0) {
					host.scheduleActivityFlushAfter(target.durableConversationId, cooldownMs);
				}
			}
			await this.#persistInbound(database, {
				classification: effectiveTrigger.classification,
				envelope: hydratedMessage,
				replyDecision: {
					cooldownMs,
					gate: replyGate,
					reason:
						trigger.reason === "group context only" && recentlyActive && !recentActivity
							? escalation === "off"
								? "recent activity escalation disabled"
								: "recent activity escalation throttled"
							: classifyAmbient && effectiveTrigger.classification === "soft"
								? effectiveTrigger.reason
								: trigger.reason,
				},
				sender,
				target,
			});
			messageLog.info("channel message processed", {
				chatObjectId: target.chatObjectId,
				classification: effectiveTrigger.classification,
				durationMs: Math.round(performance.now() - startedAt),
				sessionId: target.sessionId,
			});
			return {
				chatObjectId: target.chatObjectId,
				classification: effectiveTrigger.classification,
				duplicated: false,
				envelope: hydratedMessage,
				ignored: false,
				sessionId: target.sessionId,
			};
		} finally {
			this.#ingesting.delete(ingestionKey);
		}
	}

	async #injectedPrompt(
		sessionId: string,
		durableConversationId: string,
	): Promise<string | undefined> {
		try {
			return await this.#promptContext?.(sessionId, durableConversationId);
		} catch (error) {
			this.#logger.warn("prompt hook injection failed", {
				durableConversationId,
				error: error instanceof Error ? error.message : String(error),
				sessionId,
			});
			return undefined;
		}
	}

	async #hydrateInboundMedia(envelope: MessageEnvelope): Promise<MessageEnvelope> {
		if (this.#ingestMedia === undefined) return envelope;
		const ingestMedia = this.#ingestMedia;
		const parts = await Promise.all(
			envelope.parts.map(async (part) => {
				try {
					return await ingestMedia(part, envelope.channelId);
				} catch (error) {
					this.#logger.warn("inbound media could not be stored", {
						error: error instanceof Error ? error.message : String(error),
						type: part.type,
					});
					return part;
				}
			}),
		);
		return { ...envelope, parts };
	}

	async #recordIgnored(
		envelope: MessageEnvelope,
		sessionId: string,
		chatObjectId: string,
		reason: string,
	): Promise<void> {
		const key = `${envelope.channelId}:${chatObjectId}`;
		const now = Date.now();
		if (now - (this.#ignoredAuditAt.get(key) ?? 0) < this.#ignoredAuditIntervalMs) return;
		this.#ignoredAuditAt.set(key, now);
		this.#logger.warn("ignored inbound activity", {
			channelId: envelope.channelId,
			chatObjectId,
			reason,
			// Counter is cumulative; the audit/log row is rate-limited per conversation.
			ignoredTotal: this.#stats.ignored,
		});
		try {
			await this.#audit?.({
				action: "conversation.trigger-ignored",
				actorId: envelope.sender.platformId,
				actorKind: "user",
				payload: {
					channelId: envelope.channelId,
					conversationKind: envelope.conversationKey.kind,
					reason,
				},
				result: "denied",
				targetId: sessionId,
				targetKind: "session",
			});
		} catch {
			// Audit failure must not make unauthorized traffic retryable.
		}
	}

	/**
	 * The stored message an inbound reply quotes: trigger classification needs its direction,
	 * and the durable turn needs its author and an excerpt.
	 */
	async #resolveReplyContext(
		database: TsukaimaDatabase,
		chatObjectId: string,
		replyToEnvelopeId: string | undefined,
	): Promise<{ quote: MessageQuote; target: ResolvedReplyTarget } | undefined> {
		if (replyToEnvelopeId === undefined) return undefined;
		const [row] = await database
			.select({
				contentText: messages.contentText,
				direction: messages.direction,
				senderDisplayName: messages.senderDisplayName,
				senderExternalId: messages.senderExternalId,
			})
			.from(messages)
			.where(
				and(
					eq(messages.chatObjectId, chatObjectId),
					eq(messages.platformMessageId, replyToEnvelopeId),
				),
			)
			.limit(1);
		if (row === undefined) return undefined;
		const fromSelf = row.direction === "outbound" || row.senderExternalId === "tsukaima";
		const excerpt = (row.contentText ?? "").replace(/\s+/gu, " ").trim();
		const quote: MessageQuote = {
			...(excerpt.length === 0
				? {}
				: { excerpt: excerpt.slice(0, MESSAGE_QUOTE_EXCERPT_MAX_CHARS) }),
			...(fromSelf ? { fromSelf: true } : {}),
			...(row.senderDisplayName === null || row.senderDisplayName.trim().length === 0
				? {}
				: { senderDisplayName: row.senderDisplayName }),
			...(row.senderExternalId === null || row.senderExternalId.length === 0
				? {}
				: { senderPlatformId: row.senderExternalId }),
		};
		return {
			quote,
			target: {
				direction: row.direction,
				senderExternalId: row.senderExternalId,
				senderKind: fromSelf ? "assistant" : "human",
			},
		};
	}

	/**
	 * Fill mention labels from known identities and merge the stored quote under whatever the
	 * channel already supplied. Best-effort: a lookup failure keeps the envelope as received,
	 * including a quote the channel hydrated through `get_msg` for an unstored message.
	 */
	async #enrichReferences(
		database: TsukaimaDatabase,
		envelope: MessageEnvelope,
		sessionId: string,
		storedQuote: MessageQuote | undefined,
	): Promise<MessageEnvelope> {
		let mentions = envelope.mentions;
		const unlabeled = mentions
			.filter((mention) => mention.id !== undefined && mention.label === undefined)
			.map((mention) => mention.id as string);
		if (unlabeled.length > 0) {
			try {
				const labels = (
					await loadMentionLabels(
						database,
						[{ conversationId: sessionId, platformAccountId: envelope.channelId }],
						unlabeled,
					)
				).get(sessionId);
				if (labels !== undefined && labels.size > 0) {
					mentions = mentions.map((mention) => {
						const label = mention.id === undefined ? undefined : labels.get(mention.id);
						return label === undefined || mention.label !== undefined
							? mention
							: { ...mention, label };
					});
				}
			} catch (error) {
				this.#logger.debug("mention labels unavailable", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const channelQuote = envelope.target?.quote;
		const quote =
			storedQuote === undefined
				? channelQuote
				: channelQuote === undefined
					? storedQuote
					: { ...storedQuote, ...channelQuote };
		if (mentions === envelope.mentions && quote === channelQuote) return envelope;
		return {
			...envelope,
			mentions,
			...(envelope.target === undefined && quote === undefined
				? {}
				: { target: { ...envelope.target, ...(quote === undefined ? {} : { quote }) } }),
		};
	}

	async #persistInbound(
		database: TsukaimaDatabase,
		input: {
			classification: "ambient" | "direct" | "soft";
			envelope: MessageEnvelope;
			replyDecision: InboundReplyDecision;
			sender: { displayName: string; userId: string };
			target: { chatObjectId: string; sessionId: string };
		},
	): Promise<void> {
		const message = input.envelope;
		const parts = message.parts;
		const now = new Date().toISOString();
		// Local clock only: outbound rows are stamped from `Date.now()` and both share this
		// ordering key, so a remote platform timestamp here would reorder the transcript.
		const occurredAt = timelineAt(now);
		await database
			.insert(messages)
			.values({
				chatObjectId: input.target.chatObjectId,
				contentText: messageText(parts),
				conversationId: input.target.sessionId,
				direction: "inbound",
				id: randomUUID(),
				ingestedAt: now,
				kind: message.channelKind,
				occurredAt,
				partsJson: JSON.stringify(parts),
				platformMessageId: message.source.messageId ?? message.id,
				rawRefJson: JSON.stringify({ ...message, replyDecision: input.replyDecision }),
				...(message.target?.replyToEnvelopeId === undefined
					? {}
					: { replyToMessageId: message.target.replyToEnvelopeId }),
				senderDisplayName: input.sender.displayName,
				senderExternalId: message.sender.platformId,
				senderUserId: input.sender.userId,
				triggerClassification: input.classification,
				updatedAt: now,
			})
			.onConflictDoNothing();
		await Promise.all([
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, input.target.chatObjectId)),
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, input.target.sessionId)),
		]);
		if (message.conversationKey.kind === "group") {
			await database
				.insert(conversationMembers)
				.values({
					conversationId: input.target.sessionId,
					lastSeenAt: occurredAt,
					role: message.sender.groupRole === "admin" ? "admin" : "member",
					userId: input.sender.userId,
					...(message.sender.groupRole === undefined
						? {}
						: { platformRole: message.sender.groupRole }),
				})
				.onConflictDoUpdate({
					set: { lastSeenAt: occurredAt },
					target: [conversationMembers.conversationId, conversationMembers.userId],
				});
		}
	}

	/**
	 * Persist a platform notice as a system/notice row on the resolved session. Ingestion never
	 * calls the conversation host; {@link ConversationRouter.wakeFromNotice} decides separately
	 * whether a self-targeted poke starts a turn. `DrizzleContextProvider` exposes observed
	 * self-pokes to the next turn when `notices.pokeObserve` is enabled.
	 */
	async ingestNotice(notice: ChannelNotice): Promise<IngestedNotice> {
		const parsed = channelNoticeSchema.safeParse(notice);
		if (!parsed.success) throw new Error("Invalid channel notice");
		const value = parsed.data;
		if (value.noticeType === "typing" && value.details?.persist !== true) {
			this.#logger.trace("channel typing notice skipped", {
				channelId: value.channelId,
				noticeId: value.id,
			});
			return { duplicated: false, persisted: false };
		}
		const database = this.#requireDatabase();
		const actorId = value.actorId;
		const displayName = value.actorDisplayName ?? actorId ?? "system";
		const envelope: MessageEnvelope = {
			channelId: value.channelId,
			channelKind: value.channelKind,
			conversationKey: value.conversationKey,
			id: value.id,
			mentions: [],
			parts: [
				{
					nativeType: `notice:${value.noticeType}`,
					type: "channel-native",
					summary: noticeSummary(value),
					...(value.isSelfTarget === undefined
						? {}
						: { safeFields: { isSelfTarget: value.isSelfTarget } }),
				},
			],
			sender: {
				displayName,
				id: actorId ?? "system",
				isBot: false,
				platformId: actorId ?? "system",
			},
			source: {
				messageId: value.id,
				receivedAtMs: Date.now(),
				timestampMs: value.occurredAtMs,
			},
		};
		const sender = actorId === undefined ? undefined : await this.resolveIdentity(envelope);
		const target = await this.resolveSession(envelope, sender?.displayName ?? displayName);
		const existing = await database
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.chatObjectId, target.chatObjectId),
					eq(messages.platformMessageId, value.id),
				),
			)
			.limit(1);
		if (existing.length > 0) {
			this.#logger.trace("duplicate channel notice ignored", {
				channelId: value.channelId,
				noticeId: value.id,
				noticeType: value.noticeType,
				sessionId: target.sessionId,
			});
			return {
				duplicated: true,
				durableConversationId: target.durableConversationId,
				envelope,
				persisted: true,
				sessionId: target.sessionId,
			};
		}
		const now = new Date().toISOString();
		const occurredAt = timelineAt(now);
		await database
			.insert(messages)
			.values({
				chatObjectId: target.chatObjectId,
				contentText: noticeSummary(value),
				conversationId: target.sessionId,
				direction: "system",
				id: randomUUID(),
				ingestedAt: now,
				kind: "notice",
				occurredAt,
				partsJson: JSON.stringify(envelope.parts),
				platformMessageId: value.id,
				rawRefJson: JSON.stringify(value),
				senderDisplayName: sender?.displayName ?? displayName,
				senderExternalId: actorId ?? "system",
				...(sender === undefined ? {} : { senderUserId: sender.userId }),
				updatedAt: now,
			})
			.onConflictDoNothing();
		await Promise.all([
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, target.chatObjectId)),
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, target.sessionId)),
		]);
		this.#logger.debug("channel notice persisted", {
			channelId: value.channelId,
			isSelfTarget: value.isSelfTarget ?? false,
			noticeId: value.id,
			noticeType: value.noticeType,
			sessionId: target.sessionId,
		});
		return {
			duplicated: false,
			durableConversationId: target.durableConversationId,
			envelope,
			persisted: true,
			sessionId: target.sessionId,
		};
	}

	/**
	 * Start a turn for a self-targeted poke when the conversation policy enables it.
	 *
	 * The wake passes the same access rules as a message (access mode, allowlist, peer bots,
	 * quiet hours) and a per-conversation cooldown, so a poke can never be used to spam turns.
	 */
	async wakeFromNotice(
		notice: ChannelNotice,
		ingested: IngestedNotice,
	): Promise<{ readonly woken: boolean; readonly reason: string }> {
		if (notice.noticeType !== "poke" || notice.isSelfTarget !== true) {
			return { reason: "not-self-poke", woken: false };
		}
		if (ingested.duplicated) return { reason: "duplicate", woken: false };
		const { durableConversationId, envelope, sessionId } = ingested;
		if (durableConversationId === undefined || envelope === undefined || sessionId === undefined) {
			return { reason: "no-session", woken: false };
		}
		const host = this.#host();
		if (host === undefined) return { reason: "host-not-ready", woken: false };
		const policy =
			(await this.#policy?.effectivePolicy(sessionId)) ??
			conversationPolicySchema.parse(defaultConversationPolicy);
		if (!policy.enabled || !policy.notices.pokeWake) return { reason: "disabled", woken: false };
		const kind = envelope.conversationKey.kind;
		const access = classifyConversationTrigger({
			chatKind: kind,
			envelope,
			policy,
		});
		if (access.classification === "ignored") return { reason: access.reason, woken: false };
		// A poke is a notice, not a free bypass of the reply cooldown or the per-minute ceiling.
		// Check before consuming the poke cooldown so a rejected wake does not delay the next one.
		const pacingCooldownMs = this.#pacing?.remainingCooldownMs(durableConversationId, policy) ?? 0;
		if (pacingCooldownMs > 0) return { reason: "cooldown", woken: false };
		if (
			this.#pacing !== undefined &&
			!this.#pacing.takeNoticeWake(durableConversationId, policy.notices.pokeWakeCooldownMs)
		) {
			return { reason: "cooldown", woken: false };
		}
		await this.#policy?.ensureHostPolicy(sessionId, durableConversationId);
		try {
			await this.#applyModelToolPolicy?.(durableConversationId, policy);
		} catch (error) {
			this.#logger.warn("conversation model tool policy failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionId,
			});
		}
		await host.append({
			classification: "direct",
			conversationId: durableConversationId,
			envelope,
			forceSubmit: true,
			submittedAtMs: Date.now(),
			turnContext: { classification: "direct", cue: "Someone poked you." },
		});
		return { reason: "poke", woken: true };
	}

	async resolveIdentity(
		envelope: MessageEnvelope,
	): Promise<{ displayName: string; userId: string }> {
		return this.rememberIdentity({
			displayName: envelope.sender.displayName,
			externalId: envelope.sender.platformId,
			kind: envelope.sender.isBot === true ? "bot" : "human",
			platform: envelope.channelKind,
			platformAccountId: envelope.channelId,
		});
	}

	/**
	 * Upsert a known platform identity without requiring a full message envelope. Used by the
	 * channel-side mention-name hook to persist a name it resolved before the next read.
	 */
	async rememberIdentity(input: {
		readonly displayName: string;
		readonly externalId: string;
		readonly kind: "human" | "bot";
		readonly platform: string;
		readonly platformAccountId: string;
	}): Promise<{ displayName: string; userId: string }> {
		const database = this.#requireDatabase();
		const { displayName, externalId, kind, platform, platformAccountId } = input;
		const now = new Date().toISOString();

		// A single synchronous transaction over the serialized Bun SQLite connection: no
		// concurrent ingestion can observe or create a duplicate identity for this key, so we
		// never return (or leak) an orphan user that a losing insert would have produced.
		return database.transaction((tx) => {
			const findIdentity = () =>
				tx
					.select({
						displayName: users.displayName,
						identityDisplayName: identities.displayName,
						identityId: identities.id,
						userId: users.id,
					})
					.from(identities)
					.innerJoin(users, eq(users.id, identities.canonicalUserId))
					.where(
						and(
							eq(identities.platform, platform),
							eq(identities.platformAccountId, platformAccountId),
							eq(identities.externalId, externalId),
							eq(identities.kind, "user"),
						),
					)
					.limit(1)
					.get();
			const existing = findIdentity();
			if (existing !== undefined) {
				if (existing.displayName !== displayName) {
					tx.update(users)
						.set({ displayName, updatedAt: now })
						.where(eq(users.id, existing.userId))
						.run();
				}
				// Keep the identity copy in the same transaction. It bypassed this refresh before,
				// so the WebUI could show a permanently stale name even though `users` was current.
				if (existing.identityDisplayName !== displayName) {
					tx.update(identities)
						.set({ displayName, updatedAt: now })
						.where(eq(identities.id, existing.identityId))
						.run();
				}
				return { displayName, userId: existing.userId };
			}
			const userId = randomUUID();
			tx.insert(users)
				.values({
					createdAt: now,
					displayName,
					id: userId,
					kind,
					updatedAt: now,
				})
				.run();
			const inserted = tx
				.insert(identities)
				.values({
					canonicalUserId: userId,
					createdAt: now,
					displayName,
					externalId,
					id: randomUUID(),
					kind: "user",
					platform,
					platformAccountId,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: identities.id })
				.get();
			if (inserted !== undefined) {
				tx.insert(userAliases)
					.values({
						alias: displayName,
						createdAt: now,
						id: randomUUID(),
						source: platform,
						userId,
					})
					.onConflictDoNothing()
					.run();
				return { displayName, userId };
			}
			// Another connection already inserted this identity: discard our orphan user and adopt
			// the canonical one. No messages can reference the orphan yet, so the delete is safe.
			tx.delete(users).where(eq(users.id, userId)).run();
			const winner = findIdentity();
			if (winner === undefined) {
				throw new Error("Failed to resolve identity after insert conflict");
			}
			return { displayName: winner.displayName ?? displayName, userId: winner.userId };
		});
	}

	/**
	 * Find the receiving session for an external conversation, creating the chat object and a
	 * session when the bot is about to act in a conversation it has never seen inbound. Inbound
	 * envelopes and outbound sends share this path so both land in one transcript.
	 */
	async resolveSession(
		target: {
			readonly channelId: string;
			readonly conversationKey: MessageEnvelope["conversationKey"];
		},
		senderDisplayName: string,
	): Promise<{
		chatObjectId: string;
		durableConversationId: string;
		sessionId: string;
	}> {
		const host = this.#host();
		if (host === undefined) throw new Error("Conversation host is not ready");
		const database = this.#requireDatabase();
		const kind = target.conversationKey.kind;
		if (kind !== "private" && kind !== "group") {
			throw new Error(`External processing does not support ${kind} conversations`);
		}
		const platformConversationId =
			kind === "group" ? target.conversationKey.groupId : target.conversationKey.peerId;
		if (platformConversationId === undefined) {
			throw new Error("External conversation is missing its platform conversation id");
		}
		const findChatObject = async () => {
			const [row] = await database
				.select()
				.from(chatObjects)
				.where(
					and(
						eq(chatObjects.channelId, target.channelId),
						eq(chatObjects.kind, kind),
						eq(chatObjects.platformConversationId, platformConversationId),
					),
				)
				.limit(1);
			return row;
		};
		let chat = await findChatObject();
		if (chat === undefined) {
			const now = new Date().toISOString();
			await database
				.insert(chatObjects)
				.values({
					channelId: target.channelId,
					createdAt: now,
					id: randomUUID(),
					kind,
					platformConversationId,
					title: kind === "group" ? `Group ${platformConversationId}` : senderDisplayName,
					updatedAt: now,
				})
				.onConflictDoNothing();
			chat = await findChatObject();
		}
		if (chat === undefined) throw new Error("Failed to resolve chat object");
		return this.#withChatSessionLock(chat.id, async () => {
			const nowMs = this.#now();
			const nowIso = new Date(nowMs).toISOString();
			const todayKey = localDateKey(nowMs, this.#timeZone);
			const [receiving] = await database
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.chatObjectId, chat.id),
						eq(conversations.isReceiving, 1),
						eq(conversations.status, "active"),
					),
				)
				.limit(1);
			if (receiving !== undefined) {
				const receivingDay = sessionDateKey(receiving.createdAt, this.#timeZone);
				if (receivingDay === todayKey) {
					return {
						chatObjectId: chat.id,
						durableConversationId: receiving.durableConversationId,
						sessionId: receiving.id,
					};
				}
				return this.#openDailySession({
					channelId: target.channelId,
					chatObjectId: chat.id,
					database,
					host,
					kind,
					nowIso,
					platformConversationId,
					previous: {
						durableConversationId: receiving.durableConversationId,
						id: receiving.id,
					},
					todayKey,
				});
			}
			const [latest] = await database
				.select()
				.from(conversations)
				.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.status, "active")))
				.orderBy(desc(conversations.updatedAt))
				.limit(1);
			if (latest !== undefined) {
				const latestDay = sessionDateKey(latest.createdAt, this.#timeZone);
				if (latestDay === todayKey) {
					await database
						.update(conversations)
						.set({ isReceiving: 1 })
						.where(eq(conversations.id, latest.id));
					return {
						chatObjectId: chat.id,
						durableConversationId: latest.durableConversationId,
						sessionId: latest.id,
					};
				}
				return this.#openDailySession({
					channelId: target.channelId,
					chatObjectId: chat.id,
					database,
					host,
					kind,
					nowIso,
					platformConversationId,
					previous: {
						durableConversationId: latest.durableConversationId,
						id: latest.id,
					},
					todayKey,
				});
			}
			return this.#openDailySession({
				channelId: target.channelId,
				chatObjectId: chat.id,
				database,
				host,
				kind,
				nowIso,
				platformConversationId,
				todayKey,
			});
		});
	}

	async #openDailySession(input: {
		readonly channelId: string;
		readonly chatObjectId: string;
		readonly database: TsukaimaDatabase;
		readonly host: PiDurableConversationHost;
		readonly kind: "private" | "group";
		readonly nowIso: string;
		readonly platformConversationId: string;
		readonly previous?: { readonly durableConversationId: string; readonly id: string };
		readonly todayKey: string;
	}): Promise<{
		chatObjectId: string;
		durableConversationId: string;
		sessionId: string;
	}> {
		const durableConversationId = await input.host.createConversation();
		let baseline: {
			readonly method: "llm" | "carry-forward" | "fallback" | "none";
			readonly seeded: boolean;
			readonly summaryChars: number;
		} = { method: "none", seeded: false, summaryChars: 0 };
		if (input.previous !== undefined) {
			try {
				baseline = await input.host.seedConversationBaseline(
					durableConversationId,
					input.previous.durableConversationId,
				);
			} catch (error) {
				this.#logger.warn("failed to seed daily session baseline", {
					chatObjectId: input.chatObjectId,
					error: error instanceof Error ? error.message : String(error),
					previousSessionId: input.previous.id,
				});
			}
		}
		const sessionId = randomUUID();
		input.database.transaction((tx) => {
			tx.update(conversations)
				.set({ isReceiving: 0 })
				.where(
					and(eq(conversations.chatObjectId, input.chatObjectId), eq(conversations.isReceiving, 1)),
				)
				.run();
			tx.insert(conversations)
				.values({
					channelId: input.channelId,
					chatObjectId: input.chatObjectId,
					createdAt: input.nowIso,
					durableConversationId,
					id: sessionId,
					isReceiving: 1,
					kind: input.kind,
					platformConversationId: input.platformConversationId,
					title: input.todayKey,
					updatedAt: input.nowIso,
				})
				.run();
			tx.update(chatObjects)
				.set({ updatedAt: input.nowIso })
				.where(eq(chatObjects.id, input.chatObjectId))
				.run();
		});
		if (input.previous !== undefined && this.#policy !== undefined) {
			await this.#policy.inheritConversationPolicy(input.previous.id, sessionId);
		}
		if (input.previous !== undefined) {
			this.#logger.info("rotated daily conversation session", {
				baselineMethod: baseline.method,
				baselineSeeded: baseline.seeded,
				chatObjectId: input.chatObjectId,
				dateKey: input.todayKey,
				previousSessionId: input.previous.id,
				sessionId,
			});
			await this.#audit?.({
				action: "session.rollover",
				actorKind: "system",
				payload: {
					baselineMethod: baseline.method,
					baselineSeeded: baseline.seeded,
					chatObjectId: input.chatObjectId,
					dateKey: input.todayKey,
					previousSessionId: input.previous.id,
				},
				result: "ok",
				targetId: sessionId,
				targetKind: "session",
			});
		}
		return { chatObjectId: input.chatObjectId, durableConversationId, sessionId };
	}

	async #withChatSessionLock<T>(chatObjectId: string, run: () => Promise<T>): Promise<T> {
		const prior = this.#sessionLocks.get(chatObjectId) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => gate);
		this.#sessionLocks.set(chatObjectId, tail);
		await prior;
		try {
			return await run();
		} finally {
			release?.();
			if (this.#sessionLocks.get(chatObjectId) === tail) {
				this.#sessionLocks.delete(chatObjectId);
			}
		}
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}

/** Ephemeral turn info for the host: soft cue plus prompt hooks consumed at admission. */
export interface IngestedNotice {
	readonly duplicated: boolean;
	readonly persisted: boolean;
	readonly sessionId?: string;
	readonly durableConversationId?: string;
	/** The notice as a single channel-native envelope, for an optional wake turn. */
	readonly envelope?: MessageEnvelope;
}

function turnContextFor(
	trigger: ReturnType<typeof classifyConversationTrigger>,
	envelope: MessageEnvelope,
	promptHooks: string | undefined,
): TurnTrigger {
	const decision = trigger.classification;
	const classification: TurnTrigger["classification"] =
		decision === "ignored" ? undefined : decision;
	const cue = buildTurnCue({
		classification: trigger.classification,
		result: trigger,
		...(envelope.sender.isBot === undefined ? {} : { senderIsBot: envelope.sender.isBot }),
	});
	return {
		...(classification === undefined ? {} : { classification }),
		...(cue === undefined ? {} : { cue }),
		...(promptHooks === undefined || promptHooks.trim().length === 0 ? {} : { promptHooks }),
	};
}
