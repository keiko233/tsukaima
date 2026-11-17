import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { conversationPolicySchema, defaultConversationPolicy } from "@tsukaima/contracts";
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
			expect(await host.inspectConversationContext("10003")).toBeUndefined();
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("applies conversation compaction policy to the active agent", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-inspect-compaction-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({ storage });
			const conversationId = await host.createConversation();
			await host.updatePolicy(
				conversationId,
				conversationPolicySchema.parse({
					...defaultConversationPolicy,
					compaction: {
						backgroundTokens: 12_000,
						enabled: true,
						keepRecentTokens: 9_000,
						reserveTokens: 4_096,
						triggerTokens: 0,
					},
				}),
			);

			const stats = await host.inspectConversationContext(conversationId);
			expect(stats?.autocompact).toEqual({
				backgroundTokens: 12_000,
				bufferTokens: 4_096,
				enabled: true,
				keepRecentTokens: 9_000,
			});

			await host.updatePolicy(
				conversationId,
				conversationPolicySchema.parse({
					...defaultConversationPolicy,
					compaction: {
						backgroundTokens: 12_000,
						enabled: true,
						keepRecentTokens: 9_000,
						reserveTokens: 4_096,
						triggerTokens: 100_000,
					},
				}),
			);
			const triggered = await host.inspectConversationContext(conversationId);
			// The fake model has a 128k window, so a 100k trigger leaves a 28k reserve.
			expect(triggered?.autocompact.bufferTokens).toBe(28_000);

			await host.updatePolicy(
				conversationId,
				conversationPolicySchema.parse({
					...defaultConversationPolicy,
					compaction: {
						backgroundTokens: 12_000,
						enabled: true,
						keepRecentTokens: 9_000,
						reserveTokens: 4_096,
						triggerTokens: 200_000,
					},
				}),
			);
			const clamped = await host.inspectConversationContext(conversationId);
			// A trigger above the window still leaves a usable summary budget.
			expect(clamped?.autocompact.bufferTokens).toBe(2_048);

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

			expect(stats.tools.map((tool) => tool.name)).toEqual([
				"tool_search",
				"search_notes",
				"heavy_tool",
			]);
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

	test("loads deferred tools through tool_search and keeps removed tools undiscoverable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-tool-search-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const extension: Extension = {
				name: "test-deferred",
				tools: [
					{
						callers: ["model"],
						deferred: true,
						description: "Search notes by keyword",
						execute: async () => ({ output: [{ text: "ok", type: "text" }] }),
						name: "search_notes",
						parameters: { properties: { query: { type: "string" } }, type: "object" },
					},
					{
						callers: ["model"],
						deferred: true,
						description: "Edit a repository file",
						execute: async () => ({ output: [{ text: "ok", type: "text" }] }),
						name: "edit_file",
						parameters: { properties: { path: { type: "string" } }, type: "object" },
					},
				],
			};
			const host = new PiDurableConversationHost({ extensions: [extension], storage });
			const conversationId = await host.createConversation();
			const initial = await host.inspectConversationContext(conversationId);
			expect(initial?.tools.map((tool) => tool.name)).toEqual([
				"tool_search",
				"search_notes",
				"edit_file",
			]);
			expect(initial?.tools.filter((tool) => tool.deferred).map((tool) => tool.name)).toEqual([
				"search_notes",
				"edit_file",
			]);

			await host.updateToolAccess(conversationId, { remove: ["edit_file"] });
			const filtered = await host.inspectConversationContext(conversationId);
			expect(filtered?.tools.map((tool) => tool.name)).toEqual(["tool_search", "search_notes"]);
			expect(filtered?.deferredToolsTokens).toBeGreaterThan(0);

			await host.setModelToolAllowlist(conversationId, []);
			const disabled = await host.inspectConversationContext(conversationId);
			expect(disabled?.tools).toEqual([]);
			await host.updateToolAccess(conversationId, { remove: ["edit_file"] });
			const restored = await host.inspectConversationContext(conversationId);
			expect(restored?.tools.map((tool) => tool.name)).toEqual(["tool_search", "search_notes"]);

			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("compacts long context, resets context head with handoff, and aborts pending activity", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-commands-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				responses: [
					"reply-1",
					"reply-2",
					"reply-3",
					"reply-4",
					"Compacted summary of earlier turns.",
				],
				storage,
			});

			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("short-1", "hi there"),
				forceSubmit: true,
				submittedAtMs: 1,
			});

			// Small history fits inside keepRecentTokens, so compaction is a no-op.
			const noopCompact = await host.compactConversation(conversationId);
			expect(noopCompact.compacted).toBe(false);
			expect(noopCompact.entryId).toBeNull();
			expect(noopCompact.submissionId).toBeNull();

			// Append large turns so total context exceeds keepRecentTokens.
			const largeChunk = "alpha beta gamma delta ".repeat(1_500);
			for (let idx = 1; idx <= 3; idx += 1) {
				await host.append({
					conversationId,
					envelope: envelope(`big-${idx}`, `${idx}: ${largeChunk}`),
					forceSubmit: true,
					submittedAtMs: idx + 1,
				});
			}

			// Wait for the turns to finish running before compacting.
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const stats = await host.inspectConversationContext(conversationId);
				if ((stats?.messageCount ?? 0) >= 8) break;
				await Bun.sleep(20);
			}

			const compacted = await host.compactConversation(conversationId, "Keep key facts");
			expect(compacted.compacted).toBe(true);
			expect(compacted.submissionId).not.toBeNull();

			const postCompact = await host.inspectConversationContext(conversationId);
			expect(postCompact?.compacted).toBe(true);

			// Reset context with handoff: UI entries stay, active context starts from handoff.
			await host.resetConversation(conversationId, "Resume cleanly from here");
			const postReset = await host.inspectConversationContext(conversationId);
			expect(postReset?.compacted).toBe(false);
			expect(postReset?.messageCount).toBe(1);

			// Pending burst collection is cleared by abortConversation.
			await host.append({
				collectOnly: true,
				conversationId,
				envelope: envelope("queued-1", "pending burst"),
				submittedAtMs: 100,
			});
			await host.abortConversation(conversationId);

			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
