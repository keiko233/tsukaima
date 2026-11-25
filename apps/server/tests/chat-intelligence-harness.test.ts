import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LURK_MARKER, type PiDurableConversationHost } from "@tsukaima/core";
import type { MessageEnvelope } from "@tsukaima/contracts";
import {
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logging.ts";
import { DrizzleContextProvider } from "../src/services/context-provider.ts";
import { ConversationPacingTracker } from "../src/services/conversation-pacing.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { ConversationRouter } from "../src/services/conversation-router.ts";
import { CHAT_SELF_TUNE_TOOL_NAMES } from "../src/services/chat-self-tune-tools.ts";
import { computeOmittedSessionTools } from "../src/services/session-tool-policy.ts";
import { detectQuietFeedback, isLowSubstanceReaction } from "../src/services/social-profile.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";

const logger = createLogger({ level: "error" });

function groupEnvelope(
	id: string,
	text: string,
	overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope {
	return {
		channelId: "onebot-test",
		channelKind: "onebot-v11",
		conversationKey: { groupId: "group-chat-1", kind: "group", peerId: "user-1" },
		id,
		mentions: [],
		parts: [{ text, type: "text" }],
		sender: { displayName: "Alice", id: "user-1", platformId: "user-1" },
		source: { messageId: id, timestampMs: Date.now() },
		...overrides,
	};
}

async function openFixture(): Promise<{
	close: () => void;
	database: TsukaimaDatabase;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "tsukaima-chat-harness-"));
	const database = await openDomainDatabase(join(dir, "domain.sqlite"));
	migrateDomainDatabase(database);
	return {
		close: () => {
			try {
				database.$client.close();
			} catch {}
		},
		database,
		dir,
	};
}

function fakeHost(): {
	appended: Array<{ classification: string; text: string }>;
	host: PiDurableConversationHost;
} {
	const appended: Array<{ classification: string; text: string }> = [];
	const host = {
		append: async (input: { classification?: string; envelope: MessageEnvelope }) => {
			appended.push({
				classification: input.classification ?? "unknown",
				text: input.envelope.parts
					.filter((part) => part.type === "text")
					.map((part) => (part.type === "text" ? part.text : ""))
					.join(""),
			});
		},
		createConversation: async () => "dur-fake-1",
		scheduleActivityFlushAfter: () => undefined,
		updatePolicy: async () => undefined,
	} as unknown as PiDurableConversationHost;
	return { appended, host };
}

describe("quiet feedback and low-substance reaction detectors", () => {
	test("detects Chinese and English quiet-down feedback", () => {
		for (const phrase of [
			"你太吵了",
			"好吵啊先安静一下",
			"别老插话",
			"少说两句吧",
			"先潜水一会",
			"too noisy right now",
			"please quiet down",
			"stop interrupting",
		]) {
			expect(detectQuietFeedback(phrase).quietRequested).toBe(true);
		}
		expect(detectQuietFeedback("今天晚饭吃什么").quietRequested).toBe(false);
	});

	test("detects brief reactions without flagging substantive questions", () => {
		for (const reaction of ["哈哈", "哈哈哈哈", "嗯嗯", "好的", "ok", "草", "666", "收到!"]) {
			expect(isLowSubstanceReaction(reaction)).toBe(true);
		}
		expect(isLowSubstanceReaction("好的，那我们明天下午三点见？")).toBe(false);
		expect(isLowSubstanceReaction("帮我看看这个报错怎么修")).toBe(false);
	});
});

describe("ConversationRouter anti-awkward-interjection guards", () => {
	test("suppresses recent-activity escalation for low-substance reactions and quiet feedback", async () => {
		const { close, database, dir } = await openFixture();
		try {
			const { host } = fakeHost();
			const pacing = new ConversationPacingTracker();
			const policyService = new ConversationPolicyService({
				database: () => database,
				host: () => host,
				logger,
			});
			const quietEvents: string[] = [];
			let nowMs = 1_700_000_000_000;
			const router = new ConversationRouter({
				database: () => database,
				host: () => host,
				logger,
				now: () => nowMs,
				onQuietFeedback: ({ sessionId }) => {
					quietEvents.push(sessionId);
				},
				pacing,
				policy: policyService,
			});

			// Seed the session with a direct mention and record a bot reply so recentActivity is warm.
			const first = await router.ingest(
				groupEnvelope("m-1", "@bot hello", {
					mentions: [{ id: "bot-1" }],
					target: { id: "bot-1" },
				}),
			);
			expect(first.classification).toBe("direct");
			const [sessionRow] = await database.select().from(conversations).limit(1);
			if (sessionRow === undefined) throw new Error("Expected session row");
			pacing.recordReply(sessionRow.durableConversationId, nowMs);

			// A brief reaction ("哈哈") must NOT escalate to soft via recentActivity.
			nowMs += 5_000;
			const reaction = await router.ingest(groupEnvelope("m-2", "哈哈"));
			expect(reaction.classification).toBe("ambient");

			// A substantive undirected message escalates to soft normally.
			nowMs += 5_000;
			const substantive = await router.ingest(groupEnvelope("m-3", "大家周末打算去哪玩"));
			expect(substantive.classification).toBe("soft");

			// Quiet feedback arms temporary quiet mode and fires onQuietFeedback.
			nowMs += 70_000;
			const feedback = await router.ingest(groupEnvelope("m-4", "你太吵了，先安静一下"));
			expect(feedback.classification).toBe("ambient");
			expect(quietEvents).toEqual([first.sessionId]);

			// Subsequent substantive undirected chatter stays ambient while temporary quiet is active.
			nowMs += 5_000;
			const whileQuiet = await router.ingest(groupEnvelope("m-5", "那我们继续讨论下一个方案"));
			expect(whileQuiet.classification).toBe("ambient");

			// Explicit @mention still gets through as direct.
			nowMs += 5_000;
			const directAgain = await router.ingest(
				groupEnvelope("m-6", "@bot 帮我查一下时间", {
					mentions: [{ id: "bot-1" }],
					target: { id: "bot-1" },
				}),
			);
			expect(directAgain.classification).toBe("direct");
		} finally {
			close();
			await rm(dir, { force: true, recursive: true });
		}
	});

	test("suppresses undirected escalation when recent bot message ratio is high or quietUntilMs is active", async () => {
		const { close, database, dir } = await openFixture();
		try {
			const { host } = fakeHost();
			const pacing = new ConversationPacingTracker();
			const policyService = new ConversationPolicyService({
				database: () => database,
				host: () => host,
				logger,
			});
			let nowMs = 1_700_000_000_000;
			const router = new ConversationRouter({
				database: () => database,
				host: () => host,
				logger,
				now: () => nowMs,
				pacing,
				policy: policyService,
			});

			const seed = await router.ingest(
				groupEnvelope("s-1", "@bot hi", {
					mentions: [{ id: "bot-1" }],
					target: { id: "bot-1" },
				}),
			);
			const [sessionRow] = await database.select().from(conversations).limit(1);
			if (sessionRow === undefined) throw new Error("Expected session row");
			pacing.recordReply(sessionRow.durableConversationId, nowMs);

			// Insert 3 outbound bot replies so outbound share is 3/4 = 75% (> 40% ceiling).
			for (let i = 1; i <= 3; i += 1) {
				const at = new Date(nowMs + i * 1_000).toISOString();
				await database.insert(messages).values({
					chatObjectId: seed.chatObjectId,
					contentText: `bot reply ${i}`,
					conversationId: seed.sessionId,
					direction: "outbound",
					id: `out-${i}`,
					ingestedAt: at,
					kind: "text",
					occurredAt: at,
					partsJson: JSON.stringify([{ text: `bot reply ${i}`, type: "text" }]),
					senderDisplayName: "Tsukaima",
					senderExternalId: "tsukaima",
					updatedAt: at,
				});
			}

			nowMs += 10_000;
			const suppressedByRatio = await router.ingest(
				groupEnvelope("s-2", "大家觉得这个新版本怎么样"),
			);
			expect(suppressedByRatio.classification).toBe("ambient");

			// Clear ratio by disabling social ratio check, then test durable quietUntilMs.
			await policyService.update({
				conversationId: seed.sessionId,
				policy: {
					pacing: { quietUntilMs: nowMs + 600_000 },
					social: { enabled: false },
				},
				scope: "conversation",
			});
			nowMs += 70_000;
			const suppressedByQuietUntil = await router.ingest(
				groupEnvelope("s-3", "明天谁有空一起开黑"),
			);
			expect(suppressedByQuietUntil.classification).toBe("ambient");
		} finally {
			close();
			await rm(dir, { force: true, recursive: true });
		}
	});
});

describe("DrizzleContextProvider participation harness", () => {
	test("injects dynamic participation guidance for quiet mode, high bot share, and brief reactions", async () => {
		const { close, database, dir } = await openFixture();
		try {
			const nowIso = new Date(1_700_000_000_000).toISOString();
			await database.insert(chatObjects).values({
				createdAt: nowIso,
				id: "chat-1",
				kind: "group",
				title: "Test Group",
				updatedAt: nowIso,
			});
			await database.insert(conversations).values({
				chatObjectId: "chat-1",
				createdAt: nowIso,
				durableConversationId: "dur-1",
				id: "sess-1",
				isReceiving: 1,
				kind: "group",
				status: "active",
				updatedAt: nowIso,
			});
			const policyService = new ConversationPolicyService({
				database: () => database,
				host: () => undefined,
				logger,
			});
			await policyService.update({
				conversationId: "sess-1",
				policy: { pacing: { quietUntilMs: 1_700_000_000_000 + 20 * 60_000 } },
				scope: "conversation",
			});
			// Seed 3 outbound + 1 inbound messages with 2 trailing outbound messages.
			const seeded = [
				{ dir: "inbound" as const, id: "m1", offset: 1_000, text: "hello" },
				{ dir: "outbound" as const, id: "m2", offset: 2_000, text: "reply 1" },
				{ dir: "outbound" as const, id: "m3", offset: 3_000, text: "reply 2" },
				{ dir: "outbound" as const, id: "m4", offset: 4_000, text: "reply 3" },
			];
			for (const item of seeded) {
				const at = new Date(1_700_000_000_000 + item.offset).toISOString();
				await database.insert(messages).values({
					chatObjectId: "chat-1",
					contentText: item.text,
					conversationId: "sess-1",
					direction: item.dir,
					id: item.id,
					ingestedAt: at,
					kind: "text",
					occurredAt: at,
					partsJson: JSON.stringify([{ text: item.text, type: "text" }]),
					senderDisplayName: item.dir === "outbound" ? "Tsukaima" : "Alice",
					senderExternalId: item.dir === "outbound" ? "tsukaima" : "user-1",
					updatedAt: at,
				});
			}

			const provider = new DrizzleContextProvider({
				database: () => database,
				logger,
				policyService,
			});
			const sections = await provider.renderTurnContext({
				conversationId: "dur-1",
				inputs: [{ text: "哈哈" }],
				nowMs: 1_700_000_010_000,
				triggers: [{ classification: "soft" }],
			});
			const participation = sections.find((section) => section.key === "participation")?.text;
			expect(participation).toBeDefined();
			expect(participation).toContain("Temporary quiet mode is active");
			expect(participation).toContain("brief reaction or acknowledgment");
			expect(participation).toContain("You sent 3 of the last 4 messages");
			expect(participation).toContain("had no direct reply");
			expect(participation).toContain(LURK_MARKER);
		} finally {
			close();
			await rm(dir, { force: true, recursive: true });
		}
	});
});

describe("session tool policy and lifecycle quiet-feedback hook replacement", () => {
	test("exposes chat self-tune tools on chat surfaces and omits them on workspace/unknown surfaces", () => {
		const base = {
			agentAccess: false,
			capabilities: [],
			chatSurfaceOmitted: [],
			codingSurfaceOmitted: [],
			proactiveTools: [],
			workspaceDelegationEnabled: false,
		};
		for (const kind of ["group", "private", "webui"] as const) {
			const omitted = computeOmittedSessionTools({ ...base, kind });
			for (const name of CHAT_SELF_TUNE_TOOL_NAMES) {
				expect(omitted).not.toContain(name);
			}
		}
		for (const kind of ["workspace", "unknown", undefined] as const) {
			const omitted = computeOmittedSessionTools({ ...base, kind });
			for (const name of CHAT_SELF_TUNE_TOOL_NAMES) {
				expect(omitted).toContain(name);
			}
		}
		const failed = computeOmittedSessionTools({ ...base, kind: "group", readFailed: true });
		for (const name of CHAT_SELF_TUNE_TOOL_NAMES) {
			expect(failed).toContain(name);
		}
	});

	test("lifecycle quiet feedback replaces prior runtime prompt hook cleanly without unique-key collision", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tsukaima-lifecycle-quiet-"));
		const lifecycle = new TsukaimaLifecycle(
			loadConfig({
				TSUKAIMA_DATA_DIR: dir,
				TSUKAIMA_LOG_LEVEL: "error",
			}),
			{ logger },
		);
		await lifecycle.start();
		try {
			const first = await lifecycle.conversationRouter.ingest(
				groupEnvelope("q-1", "你太吵了，安静一下"),
			);
			const hooksAfterFirst = await lifecycle.promptHooks.list({
				includeFinished: false,
				sessionId: first.sessionId,
			});
			expect(hooksAfterFirst.filter((h) => h.createdBy === "harness-quiet-feedback")).toHaveLength(
				1,
			);

			// Second quiet feedback in the same session must replace the previous hook cleanly.
			await lifecycle.conversationRouter.ingest(groupEnvelope("q-2", "真的别插话了"));
			const hooksAfterSecond = await lifecycle.promptHooks.list({
				includeFinished: false,
				sessionId: first.sessionId,
			});
			expect(hooksAfterSecond.filter((h) => h.createdBy === "harness-quiet-feedback")).toHaveLength(
				1,
			);
			const rendered = await lifecycle.promptHooks.renderContext(first.sessionId);
			expect(rendered).toContain("[Room feedback]");
		} finally {
			await lifecycle.stop();
			await rm(dir, { force: true, recursive: true });
		}
	});
});
