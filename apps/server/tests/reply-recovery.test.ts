import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createFakeModel, PiDurableConversationHost } from "@tsukaima/core";
import {
	auditLog,
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	replyDispatchExpectations,
	replyDispatchIntents,
	pluginFollowUpIntents,
} from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import type { MessageEnvelope } from "@tsukaima/contracts";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
} from "@tsukaima-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

function createSendTransport() {
	const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
	// A real platform returns a distinct message id per send; a fixed id would collide with the
	// outbound unique index and hide recovery behavior behind a delivery error.
	let nextMessageId = 7001;
	const factory: OneBotTransportFactory = (): OneBotTransport => {
		const listeners = new Map<string, (value?: unknown) => void>();
		queueMicrotask(() => listeners.get("open")?.());
		return {
			close: () => listeners.get("close")?.(),
			on: (name, listener) => {
				listeners.set(name, listener as (value?: unknown) => void);
			},
			send: (data) => {
				const parsed = JSON.parse(data) as {
					action: string;
					echo: string;
					params: Record<string, unknown>;
				};
				actions.push({ action: parsed.action, params: parsed.params });
				const messageId = nextMessageId;
				nextMessageId += 1;
				queueMicrotask(() => {
					listeners.get("message")?.(
						JSON.stringify({ data: { message_id: messageId }, echo: parsed.echo, retcode: 0 }),
					);
				});
			},
		};
	};
	return { actions, factory };
}

async function waitFor<T>(
	read: () => T | undefined | Promise<T | undefined>,
	timeoutMs = 8_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function seedDomainSession(
	dataDir: string,
	durableConversationId: string,
	options: { readonly title?: string } = {},
): Promise<{ chatId: string; sessionId: string }> {
	const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
	migrateDomainDatabase(database);
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "private",
		platformConversationId: "user-1",
		title: options.title ?? "Recovered chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "private",
		platformConversationId: "user-1",
		title: options.title ?? "Recovered session",
		updatedAt: now,
	});
	database.$client.close();
	return { chatId, sessionId };
}

interface CrashedTurn {
	readonly answerText: string;
	readonly durableConversationId: string;
	readonly entryId: string;
	readonly requestId: string;
}

/**
 * Commit one assistant answer to durable storage with no run observer attached, exactly like a
 * process that died after the durable answer landed but before any server code saw it.
 */
async function seedCrashedTurn(
	dataDir: string,
	text: string,
	options: {
		readonly history?: readonly string[];
		readonly requestId?: string;
		readonly seedBackground?: boolean;
	} = {},
): Promise<CrashedTurn> {
	const storage = await openDurableStorage(join(dataDir, "durable.sqlite"));
	const history = options.history ?? [];
	const crashedHost = new PiDurableConversationHost({
		model: createFakeModel({ responses: [...history, text] }),
		storage,
	});
	const durableConversationId = await crashedHost.createConversation();
	for (let index = 0; index < [...history, text].length; index += 1) {
		const requestId = options.requestId ?? `${durableConversationId}:activity#crash-${index}`;
		const isLast = index === history.length;
		if (isLast && options.seedBackground === true) {
			await crashedHost.submitBackgroundTurn({
				conversationId: durableConversationId,
				kind: "proactive",
				prompt: "Synthetic background turn",
				requestId,
			});
			continue;
		}
		await crashedHost.append({
			conversationId: durableConversationId,
			envelope: envelope(`crash-${index}`, "hello"),
			forceSubmit: true,
			requestId,
			submittedAtMs: Date.now() + index,
		});
		await waitFor(async () => {
			const resolved = await crashedHost.resolveSubmissionAnswer(durableConversationId, requestId);
			return resolved.status === "answered" ? true : undefined;
		});
	}
	await crashedHost.close();
	await storage.close(BACKGROUND_CONTEXT);
	const lastIndex = history.length;
	const finalRequestId =
		options.requestId ?? `${durableConversationId}:activity#crash-${lastIndex}`;
	const reopened = await openDurableStorage(join(dataDir, "durable.sqlite"));
	const answer = await new PiDurableConversationHost({ storage: reopened }).resolveSubmissionAnswer(
		durableConversationId,
		finalRequestId,
	);
	await reopened.close(BACKGROUND_CONTEXT);
	if (answer.status !== "answered") throw new Error("Seeded turn did not answer");
	return {
		answerText: text,
		durableConversationId,
		entryId: answer.entryId,
		requestId: finalRequestId,
	};
}

async function seedExpectation(
	dataDir: string,
	sessionId: string,
	requestId: string,
	options: {
		readonly kind?: "background" | "chat";
		readonly sourceFollowUpKind?: string;
		readonly sourcePluginId?: string;
		readonly sourceTaskId?: string;
		readonly state?: "pending" | "settled";
	} = {},
): Promise<void> {
	const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
	migrateDomainDatabase(database);
	const now = Date.now();
	await database.insert(replyDispatchExpectations).values({
		conversationId: sessionId,
		createdAtMs: now,
		durableEntryId: null,
		kind: options.kind ?? "chat",
		lastDetail: null,
		sourceFollowUpKind: options.sourceFollowUpKind ?? null,
		sourcePluginId: options.sourcePluginId ?? null,
		sourceTaskId: options.sourceTaskId ?? null,
		state: options.state ?? "pending",
		submissionRequestId: requestId,
		updatedAtMs: now,
	});
	database.$client.close();
}

function startLifecycle(
	dataDir: string,
	options: {
		readonly actions?: ReturnType<typeof createSendTransport>["actions"];
		readonly factory?: OneBotTransportFactory;
		readonly port: string;
	} = { port: "7424" },
) {
	const onebot = options.factory === undefined ? createSendTransport() : undefined;
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: dataDir,
			TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
			TSUKAIMA_PORT: options.port,
		},
		{
			pluginBindings: new Map([
				[ONEBOT_TRANSPORT_FACTORY_BINDING, options.factory ?? onebot!.factory],
			]),
			reply: { reconcileIntervalMs: 50 },
		},
	);
	return { actions: options.actions ?? onebot!.actions, lifecycle };
}

describe("durable reply expectations", () => {
	test("replays a committed answer that never reached the transcript, exactly once", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-recovery-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "recovered answer");
		const { chatId, sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId);

		const { actions, lifecycle } = startLifecycle(dataDir);
		await lifecycle.start();
		try {
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			const sends = actions.filter((action) => action.action.startsWith("send_"));
			expect(sends).toHaveLength(1);
			expect(JSON.stringify(sends[0]?.params)).toContain("recovered answer");

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const outbound = await database
				.select()
				.from(messages)
				.where(eq(messages.conversationId, sessionId));
			expect(outbound).toHaveLength(1);
			expect(outbound[0]).toMatchObject({ chatObjectId: chatId, deliveryStatus: "sent" });
			const audited = await database
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "message.answer-recovered"));
			expect(audited.length).toBeGreaterThanOrEqual(1);
			const [expectation] = await database
				.select()
				.from(replyDispatchExpectations)
				.where(eq(replyDispatchExpectations.conversationId, sessionId));
			expect(expectation?.state).toBe("settled");

			// Repeated sweeps must not send the answer twice.
			const replay = await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			expect(replay.recovered).toBe(0);
			await Bun.sleep(120);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("covers a crash before the first dispatch claim", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-preclaim-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "pre-claim answer");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		// Only the expectation exists: no ledger claim, no outbound row.
		await seedExpectation(dataDir, sessionId, crashed.requestId);

		const { actions, lifecycle } = startLifecycle(dataDir);
		await lifecycle.start();
		try {
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			expect(JSON.stringify(actions)).toContain("pre-claim answer");
			const database = lifecycle.domainDatabase;
			const outbound = await database
				?.select()
				.from(messages)
				.where(eq(messages.conversationId, sessionId));
			expect(outbound).toHaveLength(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("never replays history for a conversation without an expectation", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-history-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "historical answer", {
			history: ["old answer", "intermediate answer"],
		});
		await seedDomainSession(dataDir, crashed.durableConversationId);

		const { actions, lifecycle } = startLifecycle(dataDir);
		await lifecycle.start();
		try {
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(200);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
		} finally {
			await lifecycle.stop();
		}
	});

	test("reports a legacy claimed intent instead of replaying history for it", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-legacy-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "legacy answer");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		// A pre-upgrade ledger row: it names only the answer entry, not the submission, so there is
		// no safe way to prove which turn it belongs to.
		const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
		migrateDomainDatabase(database);
		await database.insert(replyDispatchIntents).values({
			claimedAtMs: Date.now() - 60_000,
			conversationId: sessionId,
			durableEntryId: "1",
			messageId: null,
			state: "claimed",
			updatedAtMs: Date.now(),
		});
		database.$client.close();

		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7435" });
		await lifecycle.start();
		try {
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(150);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const audited = await lifecycle.domainDatabase
				?.select()
				.from(auditLog)
				.where(eq(auditLog.action, "message.answer-recovery-unavailable"));
			expect(audited?.length).toBe(1);
		} finally {
			await lifecycle.stop();
		}
	});

	test("dispatches only the expected turn's terminal answer, not intermediate or suppressed ones", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-intermediate-"));
		directories.push(dataDir);
		// The conversation already has two assistant entries. Only the second one belongs to the
		// expectation, and the first one was already suppressed in a previous process.
		const crashed = await seedCrashedTurn(dataDir, "current answer", {
			history: ["already suppressed", "older answer"],
		});
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
		migrateDomainDatabase(database);
		const now = new Date().toISOString();
		await database.insert(messages).values({
			chatObjectId: (await database.select().from(conversations).limit(1))[0]?.chatObjectId ?? "",
			contentText: "already suppressed",
			conversationId: sessionId,
			deliveryStatus: "sent",
			direction: "outbound",
			durableEntryId: "1",
			id: randomUUID(),
			ingestedAt: now,
			kind: "private",
			occurredAt: now,
			partsJson: JSON.stringify([{ text: "already suppressed", type: "text" }]),
			senderDisplayName: "Tsukaima",
			senderExternalId: "tsukaima",
			updatedAt: now,
		});
		database.$client.close();
		await seedExpectation(dataDir, sessionId, crashed.requestId);

		const { actions, lifecycle } = startLifecycle(dataDir);
		await lifecycle.start();
		try {
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			await Bun.sleep(150);
			const sends = actions.filter((action) => action.action.startsWith("send_"));
			expect(sends).toHaveLength(1);
			expect(JSON.stringify(sends[0]?.params)).toContain("current answer");
			const sent = JSON.stringify(actions);
			expect(sent).not.toContain("already suppressed");
			expect(sent).not.toContain("older answer");
		} finally {
			await lifecycle.stop();
		}
	});

	test("does not starve recovery past many idle conversations", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-many-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "buried answer");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId, {
			title: "Buried",
		});
		await seedExpectation(dataDir, sessionId, crashed.requestId);
		// 120 other conversations are more recently updated than the one that owes a reply.
		const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
		migrateDomainDatabase(database);
		for (let index = 0; index < 120; index += 1) {
			const chatId = randomUUID();
			const now = new Date(Date.now() + index + 1).toISOString();
			await database.insert(chatObjects).values({
				channelId: "onebot",
				createdAt: now,
				id: chatId,
				kind: "private",
				platformConversationId: `user-${index + 2}`,
				title: `Idle ${index}`,
				updatedAt: now,
			});
			await database.insert(conversations).values({
				channelId: "onebot",
				chatObjectId: chatId,
				createdAt: now,
				durableConversationId: `900000${index}`,
				id: randomUUID(),
				isReceiving: 0,
				kind: "private",
				platformConversationId: `user-${index + 2}`,
				updatedAt: now,
			});
		}
		database.$client.close();

		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7425" });
		await lifecycle.start();
		try {
			// Recovery selects conversations by their own pending expectation, so 120 more recently
			// active conversations cannot push the owed reply out of any window.
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			expect(JSON.stringify(actions)).toContain("buried answer");
		} finally {
			await lifecycle.stop();
		}
	});

	test("repeated startup does not duplicate a recovered send", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-restart-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "once only");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId);

		const first = startLifecycle(dataDir, { port: "7426" });
		await first.lifecycle.start();
		try {
			await waitFor(() =>
				first.actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
		} finally {
			await first.lifecycle.stop();
		}
		expect(first.actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(1);

		const second = startLifecycle(dataDir, { port: "7427" });
		await second.lifecycle.start();
		try {
			await Bun.sleep(200);
			expect(second.actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
		} finally {
			await second.lifecycle.stop();
		}
	});

	test("leaves an answer undispatched while its channel is disconnected", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-offline-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "waiting answer");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId);
		const { lifecycle } = createApp({ TSUKAIMA_DATA_DIR: dataDir, TSUKAIMA_PORT: "7428" }, {});
		await lifecycle.start();
		try {
			const result = await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			expect(result.recovered).toBe(0);
			expect(result.skipped).toBeGreaterThanOrEqual(1);
			const outbound = await lifecycle.domainDatabase
				?.select()
				.from(messages)
				.where(eq(messages.conversationId, sessionId));
			expect(outbound).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("pending");
		} finally {
			await lifecycle.stop();
		}
	});

	test("does not resend an answer that already has an outbound row", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-claimed-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "claimed answer");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId);
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7429" });
		await lifecycle.start();
		try {
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const [row] = await database
				.select()
				.from(messages)
				.where(eq(messages.conversationId, sessionId));
			expect(row?.durableEntryId).not.toBeNull();
			// A crash after the outbound row was claimed but before the send completed.
			await database
				.update(messages)
				.set({ deliveryStatus: "pending" })
				.where(eq(messages.id, row?.id ?? ""));
			await database
				.update(replyDispatchExpectations)
				.set({ state: "pending" })
				.where(eq(replyDispatchExpectations.conversationId, sessionId));
			const before = actions.filter((action) => action.action.startsWith("send_")).length;
			const result = await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			expect(result.recovered).toBe(0);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(before);
		} finally {
			await lifecycle.stop();
		}
	});

	test("abandons a stale expectation whose submission never appeared, without sending", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-missing-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "never dispatched");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		// An expectation written before a durable commit that never landed. Only a row older than
		// the TTL may be abandoned; a fresh one could still be an admission in flight.
		await seedExpectation(dataDir, sessionId, `${crashed.durableConversationId}:activity#never`);
		const database = await openDomainDatabase(join(dataDir, "domain.sqlite"));
		migrateDomainDatabase(database);
		await database
			.update(replyDispatchExpectations)
			.set({ createdAtMs: Date.now() - 60 * 60_000 })
			.where(eq(replyDispatchExpectations.conversationId, sessionId));
		database.$client.close();

		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7430" });
		await lifecycle.start();
		try {
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(120);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("abandoned");
			// A retried admission at the same dedup key is owed a reply again; abandoning the first
			// attempt must not permanently silence the turn.
			await lifecycle.replyExpectations.expect({
				conversationId: sessionId,
				kind: "chat",
				submissionRequestId: `${crashed.durableConversationId}:activity#never`,
			});
			const [retried] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(retried?.state).toBe("pending");
		} finally {
			await lifecycle.stop();
		}
	});

	test("recovers a background turn but suppresses a proactive marker without resending text", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-background-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "TSUKAIMA_LURK");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId, { kind: "background" });
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7431" });
		await lifecycle.start();
		try {
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(150);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("suppressed");
		} finally {
			await lifecycle.stop();
		}
	});

	test("suppresses a background marker even when text follows it", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-marker-text-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "TSUKAIMA_SKIP I would have said this");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId, { kind: "background" });
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7432" });
		await lifecycle.start();
		try {
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(150);
			// The original process would have suppressed the whole turn, so recovery must not send
			// the remaining text as if it were an ordinary answer.
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("suppressed");
			expect(expectation?.lastDetail).toBe("marker_skip");
		} finally {
			await lifecycle.stop();
		}
	});

	test("sends a background turn that carries ordinary text", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-background-text-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "proactive hello");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId, { kind: "background" });
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7433" });
		await lifecycle.start();
		try {
			await waitFor(() =>
				actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			expect(JSON.stringify(actions)).toContain("proactive hello");
		} finally {
			await lifecycle.stop();
		}
	});

	test("recovers a schedule-later marker into a plugin-owned follow-up after a crash", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-defer-"));
		directories.push(dataDir);
		const requestId = "plugin:proactive-scheduler:task:task-retry";
		const crashed = await seedCrashedTurn(dataDir, "TSUKAIMA_SCHEDULE_LATER 15m", {
			requestId,
		});
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		await seedExpectation(dataDir, sessionId, crashed.requestId, {
			kind: "background",
			sourceFollowUpKind: "proactive",
			sourcePluginId: "proactive-scheduler",
			sourceTaskId: "task-source",
		});
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7436" });
		await lifecycle.start();
		try {
			await waitFor(async () => {
				const rows = await lifecycle.domainDatabase
					?.select()
					.from(pluginFollowUpIntents)
					.where(eq(pluginFollowUpIntents.conversationId, sessionId));
				return rows?.[0]?.status === "completed" ? true : undefined;
			});
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("suppressed");
			const [intent] =
				(await lifecycle.domainDatabase
					?.select()
					.from(pluginFollowUpIntents)
					.where(eq(pluginFollowUpIntents.conversationId, sessionId))) ?? [];
			expect(intent).toMatchObject({
				delayMs: 15 * 60_000,
				followUpKind: "proactive",
				pluginId: "proactive-scheduler",
				sourceTaskId: "task-source",
				status: "completed",
				submissionRequestId: crashed.requestId,
			});
			const tasks = (await lifecycle.pluginHost.invokeRpc("proactive-scheduler.tasks.list", {
				conversationId: sessionId,
			})) as { tasks: { dedupeKey: string | null; id: string; status: string }[] };
			expect(tasks.tasks).toHaveLength(1);
			expect(tasks.tasks[0]).toEqual(
				expect.objectContaining({
					dedupeKey: `follow-up:proactive-scheduler:${crashed.requestId}`,
					status: "scheduled",
				}),
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("does not settle a schedule-later recovery when the follow-up outbox is unavailable", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-defer-fail-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "TSUKAIMA_SCHEDULE_LATER");
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		const { actions, lifecycle } = startLifecycle(dataDir, { port: "7437" });
		await lifecycle.start();
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Domain database not ready");
		const now = Date.now();
		await database.insert(replyDispatchExpectations).values({
			conversationId: sessionId,
			createdAtMs: now,
			durableEntryId: null,
			kind: "background",
			lastDetail: null,
			sourceFollowUpKind: "proactive",
			sourcePluginId: "proactive-scheduler",
			sourceTaskId: null,
			state: "pending",
			submissionRequestId: crashed.requestId,
			updatedAtMs: now,
		});
		try {
			// Simulate the host losing the outbox after the answer committed but before the
			// follow-up intent was written. Recovery must leave the expectation pending.
			await database.$client.exec("DROP TABLE plugin_follow_up_intents");
			await lifecycle.replyDispatcher.recoverUndispatchedAnswers();
			await Bun.sleep(120);
			expect(actions.filter((action) => action.action.startsWith("send_"))).toHaveLength(0);
			const [expectation] =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, sessionId))) ?? [];
			expect(expectation?.state).toBe("pending");
		} finally {
			await lifecycle.stop();
		}
	});

	test("reuses the durable answer when a source task retries after a pending follow-up", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-defer-retry-"));
		directories.push(dataDir);
		const crashed = await seedCrashedTurn(dataDir, "TSUKAIMA_SCHEDULE_LATER 15m", {
			requestId: "plugin:proactive-scheduler:task:task-retry",
			seedBackground: true,
		});
		const { sessionId } = await seedDomainSession(dataDir, crashed.durableConversationId);
		const onebot = createSendTransport();
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: dataDir,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7438",
			},
			{
				model: createFakeModel({ responses: ["TSUKAIMA_SCHEDULE_LATER 15m"] }),
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.factory]]),
				reply: { reconcileIntervalMs: 50 },
			},
		);
		await lifecycle.start();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			// Simulate the crash window: the answer exists, but neither the expectation nor the
			// follow-up outbox was written. A retried scheduler task must reuse the answer instead
			// of producing a second model turn.
			const before = await lifecycle.conversationHost?.listEntries(
				crashed.durableConversationId,
				20,
			);
			const resolved = await lifecycle.conversationHost?.resolveSubmissionAnswer(
				crashed.durableConversationId,
				crashed.requestId,
			);
			const result = await lifecycle.pluginConversations
				.forPlugin("proactive-scheduler", ["conversation.read", "channel.send"])
				.submitBackgroundTurn({
					conversationId: sessionId,
					kind: "proactive",
					prompt: "Synthetic retry",
					taskId: "task-retry",
				});
			const after = await lifecycle.conversationHost?.listEntries(
				crashed.durableConversationId,
				20,
			);
			expect(resolved).toEqual(
				expect.objectContaining({ status: "answered", text: "TSUKAIMA_SCHEDULE_LATER 15m" }),
			);
			expect(result.text).toBe("");
			expect(result.marker).toBe("schedule-later");
			expect(after?.length).toBe(before?.length);
			expect(result.entryId).toBe(crashed.entryId);
			expect(result.submissionRequestId).toBe(crashed.requestId);
			const followUps = await database
				.select()
				.from(pluginFollowUpIntents)
				.where(eq(pluginFollowUpIntents.conversationId, sessionId));
			expect(followUps).toHaveLength(1);
			expect(followUps[0]).toMatchObject({
				pluginId: "proactive-scheduler",
				status: "completed",
				submissionRequestId: crashed.requestId,
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a normal inbound turn records and then settles its expectation", async () => {
		const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-answer-normal-"));
		directories.push(dataDir);
		const onebot = createSendTransport();
		const { lifecycle } = createApp(
			{
				TSUKAIMA_DATA_DIR: dataDir,
				TSUKAIMA_ONEBOT_WS_URL: "ws://napcat.test:3001",
				TSUKAIMA_PORT: "7434",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, onebot.factory]]),
				reply: { reconcileIntervalMs: 50 },
			},
		);
		await lifecycle.start();
		try {
			await waitFor(() =>
				lifecycle.channels.get("onebot")?.diagnostics().connected === true ? true : undefined,
			);
			await lifecycle.conversationPolicy.update({
				policy: { pacing: { burstMaxMessages: 1 } },
				scope: "global",
			});
			const result = await lifecycle.conversationRouter.ingest(envelope("normal-1", "hello"));
			expect(result.ignored).toBe(false);
			await waitFor(() =>
				onebot.actions.some((action) => action.action.startsWith("send_")) ? true : undefined,
			);
			const rows =
				(await lifecycle.domainDatabase
					?.select()
					.from(replyDispatchExpectations)
					.where(eq(replyDispatchExpectations.conversationId, result.sessionId))) ?? [];
			expect(rows).toHaveLength(1);
			expect(rows[0]?.state).toBe("settled");
			expect(rows[0]?.kind).toBe("chat");
		} finally {
			await lifecycle.stop();
		}
	});
});
