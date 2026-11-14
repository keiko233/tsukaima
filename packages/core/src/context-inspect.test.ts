import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import { PiDurableConversationHost } from "./conversation-host.ts";

const envelope = (id: string, text: string) => ({
	channelId: "test",
	channelKind: "webui" as const,
	conversationKey: { kind: "webui" as const },
	id,
	mentions: [],
	parts: [{ text, type: "text" as const }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { timestampMs: 1 },
});

describe("inspectConversationContext", () => {
	test("returns undefined for invalid or unknown conversation ids", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-inspect-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({ storage });
			expect(await host.inspectConversationContext("not-a-number")).toBeUndefined();
			expect(await host.inspectConversationContext("999999")).toBeUndefined();
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("accounts for prompt sections, offered/deferred tools, omission filters, and free space", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-inspect-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const extension: Extension = {
				name: "test-tools",
				tools: [
					{
						callers: ["model"],
						description: "Search notes",
						execute: async () => ({ output: [{ text: "ok", type: "text" }] }),
						name: "search_notes",
						parameters: {
							properties: { query: { type: "string" } },
							required: ["query"],
							type: "object",
						},
					},
					{
						callers: ["model"],
						deferred: true,
						description: "Heavy deferred tool",
						execute: async () => ({ output: [{ text: "ok", type: "text" }] }),
						name: "heavy_tool",
						parameters: {
							properties: { path: { type: "string" } },
							required: ["path"],
							type: "object",
						},
					},
					{
						callers: ["model"],
						description: "Restricted coding tool",
						execute: async () => ({ output: [{ text: "ok", type: "text" }] }),
						name: "coding_exec",
						parameters: {
							properties: { cmd: { type: "string" } },
							required: ["cmd"],
							type: "object",
						},
					},
				],
			};

			const host = new PiDurableConversationHost({
				contextProvider: {
					renderMemories: async () => "- [conversation/fact] User likes tea",
					renderPersona: async () => "You are Tsukaima, a traveling witch.",
					renderPolicy: async () => "Conversation contract:\n- Access: private open",
				},
				extensions: [extension],
				storage,
			});

			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("m1", "Hello Tsukaima, remember anything about tea?"),
				forceSubmit: true,
				submittedAtMs: 1,
			});

			const stats = await host.inspectConversationContext(conversationId, {
				omittedTools: ["coding_exec"],
			});
			expect(stats).toBeDefined();
			if (stats === undefined) throw new Error("Expected context stats");

			expect(stats.contextWindow).toBeGreaterThan(0);
			expect(stats.messageCount).toBeGreaterThanOrEqual(1);
			expect(stats.categories.personaTokens).toBeGreaterThan(0);
			expect(stats.categories.policyTokens).toBeGreaterThan(0);
			expect(stats.categories.memoriesTokens).toBeGreaterThan(0);
			expect(stats.categories.toolsTokens).toBeGreaterThan(0);
			expect(stats.deferredToolsTokens).toBeGreaterThan(0);

			expect(stats.tools.map((tool) => tool.name)).toEqual(["search_notes", "heavy_tool"]);
			expect(stats.tools.find((tool) => tool.name === "heavy_tool")?.deferred).toBe(true);
			expect(stats.tools.find((tool) => tool.name === "search_notes")?.deferred).toBe(false);

			const categorySum =
				stats.categories.messagesTokens +
				stats.categories.toolsTokens +
				stats.categories.personaTokens +
				stats.categories.policyTokens +
				stats.categories.memoriesTokens +
				stats.categories.otherSystemTokens;
			expect(stats.usedTokens).toBe(categorySum);
			expect(stats.usedTokens + stats.autocompact.bufferTokens + stats.freeSpaceTokens).toBe(
				stats.contextWindow,
			);

			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
