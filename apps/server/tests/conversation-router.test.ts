import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { durableDocumentKinds, type MessageEnvelope } from "@tsukaima/contracts";
import { formatCompactionSummary } from "@tsukaima/core";
import { auditLog, conversations, identities, media, messages, users } from "@tsukaima/db";
import type { ChannelAdapter, ChannelDiagnostics } from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";
import type { ChannelRegistry } from "../src/services/channel-registry.ts";
import { localDateKey, sessionDateKey } from "../src/services/conversation-router.ts";
import { listMessages } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: 1_000 },
});

async function createLifecycle() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-router-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7420",
	});
	await lifecycle.start();
	return lifecycle;
}

test("keeps the reason for an ambient group message in the transcript", async () => {
	const lifecycle = await createLifecycle();
	try {
		const result = await lifecycle.conversationRouter.ingest({
			...envelope("ambient-1", "A synthetic group update"),
			conversationKey: { groupId: "group-1", kind: "group" },
		});
		expect(result.classification).toBe("ambient");
		expect(await listMessages(lifecycle, result.sessionId)).toEqual([
			expect.objectContaining({
				direction: "inbound",
				replyDecision: { cooldownMs: 0, reason: "group context only" },
				triggerClassification: "ambient",
			}),
		]);
	} finally {
		await lifecycle.stop();
	}
});

/**
 * Register a minimal adapter and return the function that pushes an envelope through the
 * registry's real detached `onEnvelope` callback.
 */
function registerFakeChannel(
	registry: ChannelRegistry,
	channelId: string,
	fetchMedia?: ChannelAdapter["fetchMedia"],
): (envelope: MessageEnvelope) => void {
	const handlers: Array<(envelope: MessageEnvelope) => void> = [];
	const adapter: ChannelAdapter = {
		capabilities: () => [],
		diagnostics: (): ChannelDiagnostics => ({ configured: true, connected: true, state: "open" }),
		...(fetchMedia === undefined ? {} : { fetchMedia }),
		id: channelId,
		kind: "fake",
		onEnvelope: (handler) => handlers.push(handler),
		send: async () => ({}),
		start: async () => {},
		stop: async () => {},
	};
	registry.register(adapter);
	return (next: MessageEnvelope) => {
		for (const handler of handlers) handler(next);
	};
}

const eqMessagePlatformId = (platformMessageId: string) =>
	eq(messages.platformMessageId, platformMessageId);

describe("ConversationRouter ingestion boundary", () => {
	test("rejects an invalid envelope without persisting anything", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			const emptyParts: MessageEnvelope = { ...envelope("bad-1", "ignored"), parts: [] };
			await expect(lifecycle.processEnvelope(emptyParts)).rejects.toThrow(
				"Invalid message envelope",
			);

			const emptyName: MessageEnvelope = {
				...envelope("bad-2", "ignored"),
				sender: { displayName: "", id: "user-1", platformId: "user-1" },
			};
			await expect(lifecycle.processEnvelope(emptyName)).rejects.toThrow(
				"Invalid message envelope",
			);

			expect(lifecycle.lastProcessingError).toBeInstanceOf(Error);
			expect(await database.select({ id: messages.id }).from(messages)).toHaveLength(0);
			expect(await database.select({ id: users.id }).from(users)).toHaveLength(0);
			expect(await database.select({ id: identities.id }).from(identities)).toHaveLength(0);
		} finally {
			await lifecycle.stop();
		}
	});

	// Regression: the channel registry invokes these handlers from a detached promise. Swallowing
	// the rejection meant a contract violation or database error dropped the message with no log
	// at all, which is why an empty sender name looked like "the bot ignores me".
	test("logs a rejected envelope instead of swallowing the failure", async () => {
		const lifecycle = await createLifecycle();
		try {
			const emit = registerFakeChannel(lifecycle.channels, "onebot");
			// Push an invalid envelope through the real detached registry path.
			emit({ ...envelope("logged-1", "x"), parts: [] });
			await Bun.sleep(50);

			const failures = lifecycle.logs
				.list({ level: "warn" })
				.filter((entry) => entry.message.includes("inbound channel event"));
			expect(failures).toHaveLength(1);
			expect(failures[0]?.fields).toMatchObject({
				channelId: "onebot",
				conversationKey: "private:peer:user-1",
				eventId: "logged-1",
				stage: "envelope",
			});
			expect(lifecycle.lastProcessingError).toBeInstanceOf(Error);
		} finally {
			await lifecycle.stop();
		}
	});

	test("rate limits repeated inbound failures per conversation", async () => {
		const lifecycle = await createLifecycle();
		try {
			const emit = registerFakeChannel(lifecycle.channels, "onebot");
			for (let index = 0; index < 5; index += 1) {
				emit({ ...envelope(`flood-${index}`, "x"), parts: [] });
				await Bun.sleep(10);
			}
			const failures = lifecycle.logs
				.list({ level: "warn" })
				.filter((entry) => entry.message.includes("inbound channel event"));
			// Every failure is recorded; only the first of the burst is not marked suppressed.
			expect(failures).toHaveLength(5);
			expect(failures.filter((entry) => entry.fields.suppressed !== true)).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("resolves a single canonical user under concurrent ingestion", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			await Promise.all([
				lifecycle.processEnvelope(envelope("concurrent-1", "first")),
				lifecycle.processEnvelope(envelope("concurrent-2", "second")),
			]);

			expect(await database.select({ id: users.id }).from(users)).toHaveLength(1);
			expect(await database.select({ id: identities.id }).from(identities)).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("keeps the identity display name in sync when a sender renames", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			const renamed = (id: string, displayName: string): MessageEnvelope => ({
				...envelope(id, "name change"),
				sender: { displayName, id: "user-1", platformId: "user-1" },
			});

			await lifecycle.processEnvelope(renamed("rename-1", "Old Display Name"));
			const [before] = await database
				.select({ displayName: identities.displayName })
				.from(identities);
			expect(before?.displayName).toBe("Old Display Name");

			await lifecycle.processEnvelope(renamed("rename-2", "New Display Name"));
			const [identity] = await database
				.select({ displayName: identities.displayName })
				.from(identities);
			const [user] = await database.select({ displayName: users.displayName }).from(users);
			expect(identity?.displayName).toBe("New Display Name");
			expect(user?.displayName).toBe("New Display Name");
		} finally {
			await lifecycle.stop();
		}
	});

	test("stores inbound media through the channel hook and marks an unfetchable part", async () => {
		const lifecycle = await createLifecycle();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		registerFakeChannel(lifecycle.channels, "onebot-test", async (part) =>
			part.type === "image" && part.channelRef === "image-hook" ? png : undefined,
		);
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			await lifecycle.processEnvelope({
				...envelope("media-1", "look"),
				parts: [
					{ text: "look", type: "text" },
					{ channelRef: "image-hook", type: "image" },
				],
			});
			const [stored] = await database.select().from(media);
			expect(stored).toMatchObject({ mimeType: "image/png", sizeBytes: png.byteLength });
			const first = await database
				.select({ partsJson: messages.partsJson })
				.from(messages)
				.where(eqMessagePlatformId("media-1"));
			const image = JSON.parse(first[0]?.partsJson ?? "[]").find(
				(part: { type: string }) => part.type === "image",
			);
			expect(image.mediaId).toBe(stored?.id);

			await lifecycle.processEnvelope({
				...envelope("media-2", "broken"),
				parts: [{ sourceUrl: "http://127.0.0.1:9/a.png", type: "image" }],
			});
			const second = await database
				.select({ partsJson: messages.partsJson })
				.from(messages)
				.where(eqMessagePlatformId("media-2"));
			const failed = JSON.parse(second[0]?.partsJson ?? "[]")[0];
			expect(failed).toMatchObject({
				mediaUnavailableReason: "blocked_address",
				sourceUrl: "http://127.0.0.1:9/a.png",
				type: "image",
			});
			expect(failed.mediaId).toBeUndefined();
		} finally {
			await lifecycle.stop();
		}
	});

	test("persists a valid envelope as a single inbound message", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			await lifecycle.processEnvelope(envelope("valid-1", "hello"));

			const rows = await database
				.select({ contentText: messages.contentText, direction: messages.direction })
				.from(messages);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.direction).toBe("inbound");
			expect(rows[0]?.contentText).toBe("hello");
			expect(lifecycle.processedMessageCount).toBe(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("preserves a channel-hydrated quote when the replied message is not stored", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const quote = {
				excerpt: "an earlier note",
				senderDisplayName: "Quoted Person",
				senderPlatformId: "10002",
			};
			await lifecycle.processEnvelope({
				...envelope("reply-missing", "what did that mean?"),
				target: { quote, replyToEnvelopeId: "not-in-retention" },
			});
			const [conversation] = await database
				.select({ durableConversationId: conversations.durableConversationId })
				.from(conversations)
				.limit(1);
			const entries = await lifecycle.conversationHost?.listEntries(
				conversation?.durableConversationId ?? "",
			);
			const window = entries?.find((entry) => entry.kind === durableDocumentKinds.activityWindow);
			const data = window?.data as
				| { envelopes?: readonly { target?: { quote?: unknown } }[] }
				| undefined;
			expect(data?.envelopes?.[0]?.target?.quote).toEqual(quote);
		} finally {
			await lifecycle.stop();
		}
	});

	test("splits the running segment when a direct IM message arrives while busy", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const first = await lifecycle.conversationRouter.ingest(
				envelope("busy-1", "first synthetic"),
			);
			const run = await lifecycle.conversationRuns.startRun({
				conversationId: first.sessionId,
				triggerMessageId: null,
			});
			await lifecycle.liveRuns.record(first.sessionId, {
				attempt: 1,
				conversationId: first.sessionId,
				draftTools: [],
				failure: undefined,
				generationStartedAtMs: undefined,
				model: undefined,
				partialText: "synthetic partial",
				partialThinking: "synthetic work before the steer",
				retry: undefined,
				settled: false,
				startedAtMs: Date.now(),
				tools: [],
				turns: 1,
			});

			await lifecycle.conversationRouter.ingest(envelope("busy-2", "steer while busy"));

			const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
				first.sessionId,
			);
			expect(segments).toHaveLength(2);
			const [closed, continuation] = segments;
			expect(closed).toMatchObject({
				runId: run.anchor.runId,
				segmentIndex: 0,
				status: "steered",
			});
			expect(closed?.rounds).toMatchObject([
				{ thinking: "synthetic work before the steer", toolCalls: [] },
			]);
			expect(continuation).toMatchObject({
				runId: run.anchor.runId,
				segmentIndex: 1,
				status: "running",
				triggerKind: "steer",
			});
			const [steerRow] = await database
				.select({ id: messages.id, seq: messages.seq })
				.from(messages)
				.where(eqMessagePlatformId("busy-2"))
				.limit(1);
			expect(steerRow?.id).toBe(continuation?.triggerMessageId ?? undefined);
			expect(steerRow?.seq).toBeGreaterThan(closed?.seq ?? 0);
			expect(continuation?.seq).toBeGreaterThan(steerRow?.seq ?? 0);
			expect(await lifecycle.liveRuns.segmentAnchor(first.sessionId)).toMatchObject({
				runId: run.anchor.runId,
				segmentId: continuation?.id,
				segmentIndex: 1,
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a settled turn cannot be re-settled through the active-run fallback", async () => {
		const lifecycle = await createLifecycle();
		try {
			const first = await lifecycle.conversationRouter.ingest(
				envelope("settle-1", "first synthetic turn"),
			);
			await lifecycle.conversationRuns.settleRun({
				conversationId: first.sessionId,
				status: "completed",
			});
			const settled = await lifecycle.conversationRuns.settleRun({
				conversationId: first.sessionId,
				status: "suppressed",
			});
			expect(settled).toBeUndefined();
		} finally {
			await lifecycle.stop();
		}
	});

	// Regression: a OneBot host runs its own clock. NapCat was observed ~36s ahead of the server,
	// so an inbound row stamped from the platform clock sorted *after* the assistant reply it
	// triggered, and the WebUI transcript read out of order. Ordering must use the local clock.
	test("orders an inbound message before the reply even when the platform clock runs ahead", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			const platformAheadMs = Date.now() + 36_000;
			await lifecycle.processEnvelope({
				...envelope("skewed-1", "clock skew"),
				source: {
					messageId: "skewed-1",
					receivedAtMs: Date.now(),
					timestampMs: platformAheadMs,
				},
			});

			const rows = await database
				.select({ occurredAt: messages.occurredAt, direction: messages.direction })
				.from(messages)
				.orderBy(messages.occurredAt);
			expect(rows).toHaveLength(1);
			// The platform timestamp must not leak into the ordering column.
			expect(Date.parse(rows[0]!.occurredAt)).toBeLessThan(platformAheadMs - 30_000);
		} finally {
			await lifecycle.stop();
		}
	});

	test("parses both ISO-8601 and SQLite UTC timestamps into local date keys", () => {
		expect(localDateKey(Date.parse("2026-11-20T16:30:00.000Z"), "Asia/Shanghai")).toBe(
			"2026-11-21",
		);
		expect(sessionDateKey("2026-11-20 16:30:00", "Asia/Shanghai")).toBe("2026-11-21");
		expect(sessionDateKey("2026-11-20 15:30:00", "Asia/Shanghai")).toBe("2026-11-20");
		expect(sessionDateKey("2026-11-20T15:30:00.000Z", "UTC")).toBe("2026-11-20");
	});

	test("splits external sessions by date, seeds baseline context, inherits policy, and serializes concurrent rollovers", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");

			// Day 1 message creates a date-titled receiving session.
			const first = await lifecycle.conversationRouter.ingest(
				envelope("day1-msg", "Remember project alpha"),
			);
			const [day1Session] = await database
				.select()
				.from(conversations)
				.where(eq(conversations.id, first.sessionId))
				.limit(1);
			expect(day1Session).toBeDefined();
			expect(day1Session!.title).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(day1Session!.isReceiving).toBe(1);

			// Attach a conversation-scoped policy override on day 1 so we can verify rollover inherits it.
			const currentPolicy = await lifecycle.conversationPolicy.effectivePolicy(first.sessionId);
			await lifecycle.conversationPolicy.update({
				conversationId: first.sessionId,
				policy: {
					...currentPolicy,
					trigger: { ...currentPolicy.trigger, keywords: ["alpha-wake"] },
				},
				scope: "conversation",
			});

			// Wait briefly for the day 1 turn to settle into durable history before rolling over.
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const stats = await lifecycle.conversationHost?.inspectConversationContext(
					day1Session!.durableConversationId,
				);
				if ((stats?.messageCount ?? 0) >= 1) break;
				await Bun.sleep(20);
			}

			// Same-day message stays in the same receiving session.
			const sameDay = await lifecycle.conversationRouter.ingest(
				envelope("day1-msg-2", "still today"),
			);
			expect(sameDay.sessionId).toBe(first.sessionId);

			// Simulate yesterday's session using SQLite's legacy CURRENT_TIMESTAMP format.
			const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
			const sqliteYesterday = yesterday.toISOString().replace("T", " ").slice(0, 19);
			await database
				.update(conversations)
				.set({ createdAt: sqliteYesterday, title: "Legacy Session" })
				.where(eq(conversations.id, first.sessionId));

			// Two concurrent messages after midnight must rotate once and land in the same new session.
			const [rolledA, rolledB] = await Promise.all([
				lifecycle.conversationRouter.ingest(envelope("day2-msg-a", "good morning A")),
				lifecycle.conversationRouter.ingest(envelope("day2-msg-b", "good morning B")),
			]);
			expect(rolledA.sessionId).not.toBe(first.sessionId);
			expect(rolledB.sessionId).toBe(rolledA.sessionId);

			const allSessions = await database
				.select()
				.from(conversations)
				.where(eq(conversations.chatObjectId, first.chatObjectId));
			expect(allSessions).toHaveLength(2);
			const oldRow = allSessions.find((row) => row.id === first.sessionId);
			const newRow = allSessions.find((row) => row.id === rolledA.sessionId);
			expect(oldRow?.isReceiving).toBe(0);
			expect(newRow?.isReceiving).toBe(1);
			expect(newRow?.title).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

			// New session inherited the conversation-scoped policy from the previous session.
			const inheritedPolicy = await lifecycle.conversationPolicy.effectivePolicy(rolledA.sessionId);
			expect(inheritedPolicy.trigger.keywords).toEqual(["alpha-wake"]);

			// New session was seeded with baseline context from the previous session.
			const newStats = await lifecycle.conversationHost?.inspectConversationContext(
				newRow!.durableConversationId,
			);
			expect(newStats?.messageCount).toBeGreaterThanOrEqual(1);

			// Rollover was recorded in the audit log.
			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "session.rollover"));
			expect(audits).toHaveLength(1);
			expect(audits[0]?.targetId).toBe(rolledA.sessionId);
		} finally {
			await lifecycle.stop();
		}
	});

	test("drops stale carried-forward baseline on daily rollover after persona change", async () => {
		const lifecycle = await createLifecycle();
		try {
			const database = lifecycle.domainDatabase;
			const host = lifecycle.conversationHost;
			if (database === undefined || host === undefined) {
				throw new Error("domain database or host not ready");
			}
			const first = await lifecycle.conversationRouter.ingest(envelope("persona-d1-1", "hi day 1"));
			const idleDay2Durable = await host.createConversation();
			await host.resetConversation(
				idleDay2Durable,
				formatCompactionSummary("Old persona habit that must not carry forever"),
			);
			const yesterdayIso = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
			await database
				.update(conversations)
				.set({ isReceiving: 0 })
				.where(eq(conversations.chatObjectId, first.chatObjectId));
			await database.insert(conversations).values({
				channelId: "onebot-test",
				chatObjectId: first.chatObjectId,
				createdAt: yesterdayIso,
				durableConversationId: idleDay2Durable,
				id: "session-idle-prev",
				isReceiving: 1,
				kind: "private",
				platformConversationId: "user-1",
				title: "Idle previous day",
				updatedAt: yesterdayIso,
			});

			const updatedPersona = await lifecycle.conversationPolicy.upsertPersona({
				id: "persona-fresh-rollover",
				name: "Nozomi",
				prompt: "Fresh persona",
				summary: "Fresh",
			});
			await lifecycle.conversationPolicy.bindPersona({
				chatObjectId: first.chatObjectId,
				personaId: updatedPersona.id,
				scope: "chat-object",
			});

			const day3 = await lifecycle.conversationRouter.ingest(envelope("persona-d3-1", "hi day 3"));
			expect(day3.sessionId).not.toBe("session-idle-prev");

			const audits = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "session.rollover"));
			const rolloverAudit = audits.find((entry) => entry.targetId === day3.sessionId);
			expect(rolloverAudit).toBeDefined();
			expect(JSON.parse(rolloverAudit?.payloadJson ?? "{}")).toMatchObject({
				baselineMethod: "none",
				baselineSeeded: false,
				previousSessionId: "session-idle-prev",
			});
		} finally {
			await lifecycle.stop();
		}
	});
});
