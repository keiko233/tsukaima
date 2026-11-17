import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conversations,
	identities,
	messages,
	migrateDomainDatabase,
	openDomainDatabase,
	users,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import {
	collectMentionIds,
	loadMentionLabels,
	mentionLabelsForConversation,
	replaceMentionIds,
} from "../src/services/mention-labels.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function openTestDatabase(): Promise<TsukaimaDatabase> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-mention-labels-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

const cardEnvelope = (card: string): string => JSON.stringify({ raw: { sender: { card } } });

describe("mention labels", () => {
	test("collects every distinct mention id", () => {
		const ids = collectMentionIds("@10001 ping @10001 and @10002");
		expect([...ids]).toEqual(["10001", "10002"]);
		expect(collectMentionIds("no mentions here").size).toBe(0);
	});

	test("replaces known ids and leaves everything else untouched", () => {
		const labels = new Map([["10001", "ExampleUser"]]);
		expect(replaceMentionIds("@10001 ping", labels)).toBe("@ExampleUser ping");
		expect(replaceMentionIds("[@10001] hi", labels)).toBe("[@ExampleUser] hi");
		expect(replaceMentionIds("@10001示例", labels)).toBe("@ExampleUser示例");
		expect(replaceMentionIds("@10003 ping", labels)).toBe("@10003 ping");
	});

	test("does not treat address fragments or longer numbers as mentions", () => {
		const labels = new Map([
			["12345", "must not appear"],
			["1234567890123", "must not appear"],
		]);
		expect(replaceMentionIds("mail me at user@10001.example", labels)).toBe(
			"mail me at user@10001.example",
		);
		expect(replaceMentionIds("@1234567890123", labels)).toBe("@1234567890123");
		expect(replaceMentionIds("@123", labels)).toBe("@123");
	});

	test("prefers the current group card, then the user name, then the identity name", async () => {
		const database = await openTestDatabase();
		try {
			const now = "2026-01-01T00:00:00.000Z";
			await database.insert(users).values([
				{
					displayName: "Account Wide Name",
					id: "user-20001",
					kind: "human",
					updatedAt: now,
				},
				{
					displayName: null,
					id: "user-20002",
					kind: "human",
					updatedAt: now,
				},
			]);
			await database.insert(identities).values([
				{
					canonicalUserId: "user-20001",
					displayName: "Stale Identity Name",
					externalId: "20001",
					id: "identity-20001",
					kind: "user",
					platform: "onebot-v11",
					platformAccountId: "acct-1",
					updatedAt: now,
				},
				{
					canonicalUserId: "user-20002",
					displayName: "Identity Only Name",
					externalId: "20002",
					id: "identity-20002",
					kind: "user",
					platform: "onebot-v11",
					platformAccountId: "acct-1",
					updatedAt: now,
				},
			]);
			await database.insert(conversations).values(
				["conversation-a", "conversation-b", "conversation-c"].map((id) => ({
					chatObjectId: null,
					durableConversationId: `durable-${id}`,
					id,
					kind: "group" as const,
					platformConversationId: id,
					title: id,
					updatedAt: now,
				})),
			);
			await database.insert(messages).values([
				{
					contentText: "older",
					conversationId: "conversation-a",
					direction: "inbound",
					id: "message-a-older",
					kind: "onebot-v11",
					occurredAt: "2026-01-01T00:00:00.000Z",
					rawRefJson: cardEnvelope("Old Group A Card"),
					senderDisplayName: "Old Group A Card",
					senderExternalId: "20001",
				},
				{
					contentText: "newer",
					conversationId: "conversation-a",
					direction: "inbound",
					id: "message-a-newer",
					kind: "onebot-v11",
					occurredAt: "2026-01-02T00:00:00.000Z",
					rawRefJson: cardEnvelope("Group A Card"),
					senderDisplayName: "Group A Card",
					senderExternalId: "20001",
				},
				{
					contentText: "other group",
					conversationId: "conversation-b",
					direction: "inbound",
					id: "message-b",
					kind: "onebot-v11",
					occurredAt: "2026-01-03T00:00:00.000Z",
					senderDisplayName: "Group B Card",
					senderExternalId: "20001",
				},
				{
					contentText: "nickname only",
					conversationId: "conversation-c",
					direction: "inbound",
					id: "message-c",
					kind: "onebot-v11",
					occurredAt: "2026-01-04T00:00:00.000Z",
					rawRefJson: cardEnvelope(""),
					senderDisplayName: "Nickname Only",
					senderExternalId: "20001",
				},
			]);

			const labels = await loadMentionLabels(
				database,
				[
					{ conversationId: "conversation-a", platformAccountId: "acct-1" },
					{ conversationId: "conversation-b", platformAccountId: "acct-1" },
					{ conversationId: "conversation-c", platformAccountId: "acct-1" },
				],
				["20001", "20002", "29999"],
			);

			const groupA = mentionLabelsForConversation(labels, "conversation-a");
			expect(groupA.get("20001")).toBe("Group A Card");
			expect(replaceMentionIds("@20001 ping", groupA)).toBe("@Group A Card ping");

			// Cards are per group: group B's own name wins over conversation A's card.
			expect(mentionLabelsForConversation(labels, "conversation-b").get("20001")).toBe(
				"Group B Card",
			);

			// No group card in this conversation, so the account-wide name and identity fallback
			// apply even though the latest message carried a group-specific nickname.
			const groupC = mentionLabelsForConversation(labels, "conversation-c");
			expect(groupC.get("20001")).toBe("Account Wide Name");
			expect(groupC.get("20002")).toBe("Identity Only Name");

			// An id nobody has ever named stays a number instead of borrowing another id's name.
			expect(groupA.has("29999")).toBe(false);
			expect(replaceMentionIds("@29999 ping", groupA)).toBe("@29999 ping");
		} finally {
			database.$client.close();
		}
	});
});
