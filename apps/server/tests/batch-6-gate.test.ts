import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import {
	type ConversationGatePort,
	createFakeModel,
	FailOpenConversationGate,
} from "@tsukaima/core";
import { chatObjects, conversations, messages } from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { listMessages } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const groupEnvelope = (id: string, text: string, senderId = "user-2"): MessageEnvelope => ({
	channelId: "onebot",
	channelKind: "onebot-v11",
	conversationKey: { groupId: "group-1", kind: "group", peerId: senderId },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: `Member ${senderId}`, id: senderId, platformId: senderId },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

async function createLifecycle(gate: ConversationGatePort, onModelMessage: () => void) {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-batch-6-gate-"));
	directories.push(directory);
	const { lifecycle } = createApp(
		{
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		},
		{ conversationGate: gate, model: createFakeModel({ onMessage: onModelMessage }) },
	);
	await lifecycle.start();
	return lifecycle;
}

async function createGroupSession(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>,
): Promise<{ durableConversationId: string; sessionId: string }> {
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind: "group",
		platformConversationId: "group-1",
		title: "Synthetic Group",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind: "group",
		platformConversationId: "group-1",
		title: "Synthetic Group",
		updatedAt: now,
	});
	return { durableConversationId, sessionId };
}

async function enableGate(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>,
	sessionId: string,
) {
	await lifecycle.conversationPolicy.update({
		conversationId: sessionId,
		policy: {
			gate: { enabled: true },
			pacing: { activeBurstWindowMs: 500, burstMaxWaitMs: 500, burstSettleMs: 50 },
			trigger: { groupAccess: "open", recentActivityEscalation: "throttled" },
		},
		scope: "conversation",
	});
}

async function outboundCount(
	lifecycle: Awaited<ReturnType<typeof createLifecycle>>,
	sessionId: string,
): Promise<number> {
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("database missing");
	const rows = await database
		.select({ id: messages.id })
		.from(messages)
		.where(and(eq(messages.direction, "outbound"), eq(messages.conversationId, sessionId)));
	return rows.length;
}

describe("Batch 6 pre-model gate acceptance", () => {
	test("an opted-in idle group can start a soft turn only after a positive decision", async () => {
		let decisions = 0;
		const lifecycle = await createLifecycle(
			{
				decideBurstCompletion: async () => ({ decision: "SEND", source: "fallback" }),
				decideProactiveBubble: async () => ({ decision: "SHOULD", source: "fallback" }),
				decideUndirectedGroupReply: async () => {
					decisions += 1;
					return decisions === 1
						? { decision: "REPLY", source: "fallback" }
						: { decision: "REPLY", source: "gate" };
				},
			},
			() => {},
		);
		try {
			const group = await createGroupSession(lifecycle);
			await enableGate(lifecycle, group.sessionId);
			await lifecycle.conversationPolicy.update({
				conversationId: group.sessionId,
				policy: { gate: { ambientGroupReply: true } },
				scope: "conversation",
			});
			const fallback = await lifecycle.conversationRouter.ingest(
				groupEnvelope("idle-fallback", "Any ideas?"),
			);
			const reply = await lifecycle.conversationRouter.ingest(
				groupEnvelope("idle-reply", "What else could help?"),
			);
			expect(fallback.classification).toBe("ambient");
			expect(reply.classification).toBe("soft");
			expect(decisions).toBe(2);
		} finally {
			await lifecycle.stop();
		}
	});

	test("an undirected group SKIP never invokes the main chat model", async () => {
		let modelCalls = 0;
		const decisions: string[] = [];
		const lifecycle = await createLifecycle(
			{
				decideBurstCompletion: async () => ({ decision: "SEND", source: "fallback" }),
				decideProactiveBubble: async () => ({ decision: "SHOULD", source: "fallback" }),
				decideUndirectedGroupReply: async () => {
					decisions.push("group");
					return { decision: "SKIP", reason: "chatter", source: "gate" };
				},
			},
			() => {
				modelCalls += 1;
			},
		);
		try {
			const group = await createGroupSession(lifecycle);
			await enableGate(lifecycle, group.sessionId);
			lifecycle.conversationPacing.recordReply(group.durableConversationId);
			await lifecycle.processEnvelope(groupEnvelope("group-skip-1", "just chatting here"));
			await Bun.sleep(150);
			expect(decisions).toEqual(["group"]);
			expect(modelCalls).toBe(0);
			expect(await outboundCount(lifecycle, group.sessionId)).toBe(0);
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const [inbound] = await database
				.select({ triggerClassification: messages.triggerClassification })
				.from(messages)
				.where(eq(messages.platformMessageId, "group-skip-1"));
			expect(inbound?.triggerClassification).toBe("ambient");
			const [message] = await listMessages(lifecycle, group.sessionId);
			expect(message?.replyDecision).toEqual({
				cooldownMs: 0,
				gate: { decision: "SKIP", reason: "chatter", source: "gate" },
				reason: "recent conversation activity",
			});
		} finally {
			await lifecycle.stop();
		}
	});

	test("a throwing gate fails open and lets the main model answer", async () => {
		let modelCalls = 0;
		const gate = new FailOpenConversationGate({
			defaultTimeoutMs: 200,
			driver: {
				decideBurstCompletion: async () => ({ decision: "SEND" }),
				decideProactiveBubble: async () => ({ decision: "SHOULD" }),
				decideUndirectedGroupReply: async () => {
					throw new Error("synthetic classifier failure");
				},
			},
		});
		const lifecycle = await createLifecycle(gate, () => {
			modelCalls += 1;
		});
		try {
			const group = await createGroupSession(lifecycle);
			await enableGate(lifecycle, group.sessionId);
			lifecycle.conversationPacing.recordReply(group.durableConversationId);
			await lifecycle.processEnvelope(groupEnvelope("group-fail-open", "anyone around?"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const deadline = Date.now() + 5_000;
			let outbound = 0;
			while (Date.now() < deadline) {
				outbound = await outboundCount(lifecycle, group.sessionId);
				if (outbound > 0) break;
				await Bun.sleep(20);
			}
			expect(modelCalls).toBeGreaterThanOrEqual(1);
			expect(outbound).toBeGreaterThan(0);
		} finally {
			await lifecycle.stop();
		}
	});
});
