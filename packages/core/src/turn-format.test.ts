import { describe, expect, test } from "bun:test";
import { envelopeSpeaker, formatEnvelopeLine, formatQuote } from "./turn-format.ts";

describe("turn-format: speaker and quote formatting", () => {
	test("envelopeSpeaker formats name(id) in group chats when id differs from name", () => {
		expect(
			envelopeSpeaker({
				conversationKey: { kind: "group" },
				sender: { displayName: "Alice", id: "user-1", platformId: "10001" },
			}),
		).toBe("Alice(10001)");

		expect(
			envelopeSpeaker({
				conversationKey: { kind: "group" },
				sender: { displayName: "10001", id: "user-1", platformId: "10001" },
			}),
		).toBe("10001");

		expect(
			envelopeSpeaker({
				conversationKey: { kind: "group" },
				sender: { id: "user-1" },
			}),
		).toBe("user-1");

		expect(
			envelopeSpeaker({
				conversationKey: { kind: "group" },
				sender: { displayName: "Alice", id: "user-1" },
			}),
		).toBe("Alice(user-1)");
	});

	test("envelopeSpeaker formats name in non-group chats", () => {
		expect(
			envelopeSpeaker({
				conversationKey: { kind: "private" },
				sender: { displayName: "Alice", id: "user-1", platformId: "10001" },
			}),
		).toBe("Alice");
	});

	test("formatQuote includes unique id when both displayName and platformId are present", () => {
		expect(
			formatQuote({
				excerpt: "hello world",
				senderDisplayName: "Bob",
				senderPlatformId: "10002",
			}),
		).toBe('[reply to Bob(10002): "hello world"]');

		expect(
			formatQuote({
				excerpt: "hello world",
				senderDisplayName: "Bob",
				senderId: "user-bob",
			}),
		).toBe('[reply to Bob(user-bob): "hello world"]');
	});

	test("formatQuote formats correctly when id or name is missing or fromSelf", () => {
		expect(
			formatQuote({
				excerpt: "hello world",
				fromSelf: true,
				senderDisplayName: "Bob",
				senderPlatformId: "10002",
			}),
		).toBe('[reply to you: "hello world"]');

		expect(
			formatQuote({
				excerpt: "hello world",
				senderDisplayName: "Bob",
			}),
		).toBe('[reply to Bob: "hello world"]');

		expect(
			formatQuote({
				excerpt: "hello world",
				senderPlatformId: "10002",
			}),
		).toBe('[reply to 10002: "hello world"]');

		expect(
			formatQuote({
				excerpt: "hello world",
				senderDisplayName: "10002",
				senderPlatformId: "10002",
			}),
		).toBe('[reply to 10002: "hello world"]');
	});

	test("formatEnvelopeLine formats envelope header with quote and mention labels", () => {
		const line = formatEnvelopeLine(
			{
				conversationKey: { kind: "group" },
				mentions: [{ id: "10003", label: "Charlie" }],
				sender: { displayName: "Alice", id: "user-1", platformId: "10001" },
				source: { timestampMs: 1700000000000 },
				target: {
					quote: { excerpt: "hi", senderDisplayName: "Bob", senderPlatformId: "10002" },
				},
			},
			"hello @10003",
			{ timeZone: "UTC" },
		);
		expect(line).toContain("Alice(10001)");
		expect(line).toContain('[reply to Bob(10002): "hi"]');
		expect(line).toContain("hello @Charlie");
	});
});
