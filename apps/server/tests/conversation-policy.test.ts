import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { CONTEXT_EXTENSION_NAME, createContextExtension } from "@tsukaima/core";
import {
	auditLog,
	chatObjects,
	conversations,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	personaBindings,
	personas,
	policies,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logging.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { DrizzleContextProvider } from "../src/services/context-provider.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "tsukaima::test" });

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function openFixture(): Promise<TsukaimaDatabase> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-policy-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

async function seedSession(database: TsukaimaDatabase): Promise<void> {
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		createdAt: now,
		id: "chat-1",
		kind: "group",
		platformConversationId: "group-1",
		title: "Group",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		chatObjectId: "chat-1",
		createdAt: now,
		durableConversationId: "41",
		id: "session-1",
		isReceiving: 1,
		kind: "group",
		title: "Main",
		updatedAt: now,
	});
}

function service(database: TsukaimaDatabase): ConversationPolicyService {
	return new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
}

const privateEnvelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

const groupEnvelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "onebot-test",
	channelKind: "onebot-v11",
	conversationKey: { groupId: "group-1", kind: "group", peerId: "user-1" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, timestampMs: Date.now() },
});

describe("conversation policy service", () => {
	test("validates revisions, inherits global fields, and keeps history", async () => {
		const database = await openFixture();
		try {
			await seedSession(database);
			const policyService = service(database);
			const initial = await policyService.view({ conversationId: "session-1" });
			expect(initial.source.scope).toBe("default");
			expect(initial.policy.version).toBe(1);

			await policyService.update({
				policy: {
					compaction: {
						keepRecentTokens: 9_000,
						reserveTokens: 4_096,
						triggerTokens: 100_000,
					},
					trigger: { groupAccess: "allowlist", keywords: ["wake"] },
				},
				scope: "global",
			});
			const conversationUpdate = await policyService.update({
				conversationId: "session-1",
				policy: { pacing: { burstSettleMs: 123, replyCooldownMs: 456 } },
				scope: "conversation",
			});
			expect(conversationUpdate.policy.trigger.groupAccess).toBe("allowlist");
			expect(conversationUpdate.policy.trigger.keywords).toEqual(["wake"]);
			expect(conversationUpdate.policy.pacing.burstSettleMs).toBe(123);
			expect(conversationUpdate.policy.pacing.replyCooldownMs).toBe(456);
			expect(conversationUpdate.policy.compaction.reserveTokens).toBe(4_096);
			expect(conversationUpdate.policy.compaction.keepRecentTokens).toBe(9_000);
			expect(conversationUpdate.policy.compaction.backgroundTokens).toBe(32_768);
			expect(conversationUpdate.policy.compaction.triggerTokens).toBe(100_000);

			const second = await policyService.update({
				conversationId: "session-1",
				policy: { trigger: { selfAliases: ["Tsukaima"] } },
				scope: "conversation",
			});
			expect(second.policy.version).toBe(2);
			expect(second.policy.pacing.burstSettleMs).toBe(123);
			expect(second.policy.trigger.selfAliases).toEqual(["Tsukaima"]);

			const history = await policyService.history({
				conversationId: "session-1",
				scope: "conversation",
			});
			expect(history).toHaveLength(2);
			expect(history.filter((revision) => revision.isActive)).toHaveLength(1);
			expect(history.find((revision) => revision.isActive)?.policy.version).toBe(2);
			const rows = await database.select().from(policies);
			expect(rows.filter((row) => row.scope === "conversation")).toHaveLength(2);
		} finally {
			database.$client.close();
		}
	});

	test("overrideAll replaces every conversation policy with the saved global snapshot", async () => {
		const database = await openFixture();
		try {
			await seedSession(database);
			const now = new Date().toISOString();
			await database.insert(conversations).values({
				chatObjectId: "chat-1",
				createdAt: now,
				durableConversationId: "42",
				id: "session-2",
				isReceiving: 0,
				kind: "group",
				title: "Second",
				updatedAt: now,
			});
			const policyService = service(database);
			await policyService.update({
				conversationId: "session-1",
				policy: {
					compaction: { reserveTokens: 2_048 },
					memoryExtractModel: "custom-extract-model",
					pacing: {
						allowedTools: ["search"],
						burstSettleMs: 123,
						quietHours: { enabled: true, endHour: 2, startHour: 1 },
					},
					sidechat: { model: "custom-sidechat-model" },
				},
				scope: "conversation",
			});
			await policyService.update({
				conversationId: "session-2",
				policy: { pacing: { burstSettleMs: 456 } },
				scope: "conversation",
			});

			const result = await policyService.overrideAll({
				policy: {
					compaction: { reserveTokens: 4_096, triggerTokens: 90_000 },
					pacing: { burstSettleMs: 999 },
				},
			});
			expect(result.updated).toBe(2);
			expect(result.view.source.scope).toBe("global");
			expect(result.view.policy.pacing.burstSettleMs).toBe(999);

			const first = await policyService.view({ conversationId: "session-1" });
			expect(first.source.scope).toBe("conversation");
			expect(first.policy.pacing.burstSettleMs).toBe(999);
			expect(first.policy.pacing.allowedTools).toBeUndefined();
			expect(first.policy.pacing.quietHours).toBeUndefined();
			expect(first.policy.sidechat.model).toBeUndefined();
			expect(first.policy.memoryExtractModel).toBeUndefined();
			expect(first.policy.compaction.reserveTokens).toBe(4_096);
			expect(first.policy.compaction.triggerTokens).toBe(90_000);

			const second = await policyService.view({ conversationId: "session-2" });
			expect(second.policy.pacing.burstSettleMs).toBe(999);
			expect(second.policy.compaction.reserveTokens).toBe(4_096);
			expect(second.policy.compaction.triggerTokens).toBe(90_000);

			const firstHistory = await policyService.history({
				conversationId: "session-1",
				scope: "conversation",
			});
			expect(firstHistory).toHaveLength(2);
			expect(firstHistory.filter((revision) => revision.isActive)).toHaveLength(1);
			expect(firstHistory.find((revision) => revision.isActive)?.policy.pacing.burstSettleMs).toBe(
				999,
			);
			const secondHistory = await policyService.history({
				conversationId: "session-2",
				scope: "conversation",
			});
			expect(secondHistory).toHaveLength(2);
		} finally {
			database.$client.close();
		}
	});

	test("resolves persona precedence, active versions, and shared aliases", async () => {
		const database = await openFixture();
		try {
			await seedSession(database);
			const now = new Date().toISOString();
			const persona = (
				id: string,
				name: string,
				version = 1,
				isActive = 1,
				aliases: string[] = [],
			) => ({
				aliasesJson: JSON.stringify(aliases),
				behaviorJson: "{}",
				createdAt: now,
				id,
				isActive,
				name,
				promptJson: JSON.stringify(`PROMPT-${id}-${version}`),
				summary: name,
				version,
			});
			await database
				.insert(personas)
				.values([
					persona("persona-global", "Global", 1, 1, ["GlobalAlias"]),
					persona("persona-kind", "Group kind", 1, 1, ["KindAlias"]),
					persona("persona-object", "Chat object", 1, 1, ["ObjectAlias"]),
					persona("persona-conversation", "Conversation", 1, 1, ["ConversationAlias"]),
					persona("persona-conversation", "Conversation", 2, 1, ["NewerAlias"]),
				]);
			await database.insert(personaBindings).values([
				{ id: "bind-global", isActive: 1, isGlobal: 1, personaId: "persona-global" },
				{
					chatKind: "group",
					id: "bind-kind",
					isActive: 1,
					isGlobal: 0,
					personaId: "persona-kind",
				},
				{
					chatKind: "group",
					chatObjectId: "chat-1",
					id: "bind-object",
					isActive: 1,
					isGlobal: 0,
					personaId: "persona-object",
				},
				{
					chatKind: "group",
					chatObjectId: "chat-1",
					conversationId: "session-1",
					id: "bind-conversation",
					isActive: 1,
					isGlobal: 0,
					personaId: "persona-conversation",
				},
			]);

			const policyService = service(database);
			const resolved = await policyService.personaForSession({
				chatKind: "group",
				chatObjectId: "chat-1",
				conversationId: "session-1",
			});
			expect(resolved?.id).toBe("persona-conversation");
			expect(resolved?.version).toBe(2);
			expect(resolved?.selfAliases).toEqual(["NewerAlias"]);

			await database
				.update(personaBindings)
				.set({ isActive: 0 })
				.where(eq(personaBindings.id, "bind-conversation"));
			const object = await policyService.personaForSession({
				chatKind: "group",
				chatObjectId: "chat-1",
				conversationId: "session-1",
			});
			expect(object?.id).toBe("persona-object");

			await database
				.update(personaBindings)
				.set({ isActive: 0 })
				.where(eq(personaBindings.id, "bind-object"));
			const kind = await policyService.personaForSession({
				chatKind: "group",
				chatObjectId: "chat-1",
				conversationId: "session-1",
			});
			expect(kind?.id).toBe("persona-kind");

			const aliases = await policyService.selfAliases(
				"session-1",
				await policyService.effectivePolicy("session-1"),
			);
			expect(aliases).toContain("KindAlias");
		} finally {
			database.$client.close();
		}
	});

	test("renders compact identity and policy before memory without internals", async () => {
		const database = await openFixture();
		try {
			await seedSession(database);
			const policyService = service(database);
			await database.insert(personas).values({
				aliasesJson: JSON.stringify(["Tsukaima"]),
				behaviorJson: "{}",
				id: "persona-1",
				isActive: 1,
				name: "Tsukaima",
				promptJson: JSON.stringify("You are Tsukaima."),
				summary: "Traveler",
				version: 1,
			});
			await database.insert(personaBindings).values({
				conversationId: "session-1",
				id: "bind-1",
				isActive: 1,
				isGlobal: 0,
				personaId: "persona-1",
			});
			const extension = createContextExtension(
				new DrizzleContextProvider({
					database: () => database,
					logger,
					policyService,
				}),
			);
			expect(extension.name).toBe(CONTEXT_EXTENSION_NAME);
			expect(extension.sections?.map((section) => section.key)).toEqual([
				"tsukaima-persona",
				"tsukaima-policy",
				"tsukaima-memory",
			]);
			const provider = new DrizzleContextProvider({
				database: () => database,
				logger,
				policyService,
			});
			const text = await provider.renderPolicy("41");
			if (text === undefined) throw new Error("Expected policy text");
			expect(text).toContain("Speak as: Tsukaima");
			expect(text).toContain("TSUKAIMA_LURK");
			expect(text).not.toContain("persona_bindings");
			expect(text).not.toContain("onebot");
			expect(text).not.toContain("SQL");
		} finally {
			database.$client.close();
		}
	});
});

async function createLifecycle() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-policy-e2e-"));
	directories.push(directory);
	const { lifecycle } = createApp({ TSUKAIMA_DATA_DIR: directory, TSUKAIMA_PORT: "7420" });
	await lifecycle.start();
	return lifecycle;
}

describe("conversation policy ingestion", () => {
	test("drops ignored traffic before messages and rate-limits audit rows", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.conversationPolicy.update({
				policy: { trigger: { groupAccess: "disabled" } },
				scope: "global",
			});
			await lifecycle.processEnvelope(groupEnvelope("ignored-1", "hello"));
			await lifecycle.processEnvelope(groupEnvelope("ignored-2", "again"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			expect(await database.select().from(conversations)).toHaveLength(1);
			const auditRows = await database.select().from(auditLog);
			expect(lifecycle.triggerStats().ignored).toBe(2);
			expect(lifecycle.processedMessageCount).toBe(0);
			const ignoredAudit = auditRows.filter((row) => row.action === "conversation.trigger-ignored");
			expect(ignoredAudit).toHaveLength(1);
			expect(ignoredAudit[0]?.result).toBe("denied");
		} finally {
			await lifecycle.stop();
		}
	});

	test("aggregates during cooldown and flushes after it expires", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.conversationPolicy.update({
				policy: {
					pacing: {
						burstMaxWaitMs: 60,
						burstSettleMs: 20,
						replyCooldownMs: 500,
					},
				},
				scope: "global",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const outboundCount = async () =>
				(await database.select().from(messages)).filter(
					(row) => row.direction === "outbound" && row.senderExternalId === "tsukaima",
				).length;
			await lifecycle.processEnvelope(privateEnvelope("cooldown-1", "first"));
			const startedAt = Date.now();
			while ((await outboundCount()) < 1 && Date.now() - startedAt < 3_000) {
				await Bun.sleep(20);
			}
			expect(await outboundCount()).toBe(1);

			await lifecycle.processEnvelope(privateEnvelope("cooldown-2", "second"));
			await Bun.sleep(120);
			expect(await outboundCount()).toBe(1);
			const inbound = (await database.select().from(messages)).filter(
				(row) => row.direction === "inbound",
			);
			expect(inbound).toHaveLength(2);

			const secondReplyStartedAt = Date.now();
			while ((await outboundCount()) < 2 && Date.now() - secondReplyStartedAt < 3_000) {
				await Bun.sleep(30);
			}
			expect(await outboundCount()).toBe(2);
		} finally {
			await lifecycle.stop();
		}
	});

	test("stores ambient context without submitting and keeps direct turns", async () => {
		const lifecycle = await createLifecycle();
		try {
			await lifecycle.conversationPolicy.update({
				policy: { trigger: { groupAccess: "open" } },
				scope: "global",
			});
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			await lifecycle.processEnvelope(groupEnvelope("ambient-1", "just chatting"));
			const rows = await database.select().from(messages);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.triggerClassification).toBe("ambient");

			const direct = groupEnvelope("direct-1", "Tsukaima hello");
			direct.raw = { self_id: "bot-1" };
			direct.mentions = [{ id: "bot-1" }];
			await lifecycle.processEnvelope(direct);
			const after = await database.select().from(messages);
			expect(after).toHaveLength(2);
			expect(after.find((row) => row.platformMessageId === "direct-1")?.triggerClassification).toBe(
				"direct",
			);
			expect(lifecycle.triggerStats().ambient).toBe(1);
			expect(lifecycle.triggerStats().direct).toBe(1);
		} finally {
			await lifecycle.stop();
		}
	});
});
