import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, PromptInput } from "@earendil-works/pi-durable";
import { openDurableStorage } from "@elaina/durable";
import {
	CONTEXT_EXTENSION_NAME,
	MEMORY_SECTION_KEY,
	PERSONA_SECTION_KEY,
	createContextExtension,
	type ContextPromptProvider,
} from "./context.ts";
import { PiDurableConversationHost } from "./conversation-host.ts";

const renderInput = { conversationId: 7 as ConversationId } as unknown as PromptInput;

const stubProvider = (overrides: Partial<ContextPromptProvider> = {}): ContextPromptProvider => ({
	renderMemories: async () => undefined,
	renderPersona: async () => undefined,
	...overrides,
});

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

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("context extension", () => {
	test("renders persona and memory sections in order", async () => {
		const extension = createContextExtension(
			stubProvider({
				renderMemories: async () => "Known memories:\n- [global/fact] likes tea",
				renderPersona: async () => "You are Elaina, a curious traveler.",
			}),
		);
		expect(extension.name).toBe(CONTEXT_EXTENSION_NAME);
		expect(extension.sections?.map((section) => section.key)).toEqual([
			PERSONA_SECTION_KEY,
			MEMORY_SECTION_KEY,
		]);
		const personaText = await extension.sections?.[0]?.render(renderInput, BACKGROUND_CONTEXT);
		const memoryText = await extension.sections?.[1]?.render(renderInput, BACKGROUND_CONTEXT);
		expect(personaText).toContain("Elaina");
		expect(memoryText).toContain("likes tea");
	});

	test("omits sections when the provider throws or returns nothing", async () => {
		const extension = createContextExtension(
			stubProvider({
				renderMemories: async () => "   ",
				renderPersona: async () => {
					throw new Error("persona lookup exploded");
				},
			}),
		);
		expect(await extension.sections?.[0]?.render(renderInput, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await extension.sections?.[1]?.render(renderInput, BACKGROUND_CONTEXT)).toBeUndefined();
	});
});

describe("PiDurableConversationHost context provider", () => {
	test("renders persona and memory for the conversation that produced the run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-context-"));
		try {
			const calls: string[] = [];
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				contextProvider: stubProvider({
					renderMemories: async (conversationId) => {
						calls.push(`memory:${conversationId}`);
						return "MEMORY-TEXT";
					},
					renderPersona: async (conversationId) => {
						calls.push(`persona:${conversationId}`);
						return "PERSONA-TEXT";
					},
				}),
				policy: { maxMessages: 20, windowMs: 20 },
				storage,
			});
			expect(host.registry.snapshot().extension(CONTEXT_EXTENSION_NAME)).toBeDefined();
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("message-1", "hello"),
				submittedAtMs: Date.now(),
			});
			await waitFor(() => (calls.includes(`persona:${conversationId}`) ? true : undefined));
			await waitFor(() => (calls.includes(`memory:${conversationId}`) ? true : undefined));
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("backfills the extension for conversations created before it existed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-core-context-"));
		try {
			const path = join(directory, "durable.sqlite");
			const legacyStorage = await openDurableStorage(path);
			const legacyHost = new PiDurableConversationHost({
				policy: { maxMessages: 20, windowMs: 20 },
				storage: legacyStorage,
			});
			const conversationId = await legacyHost.createConversation();
			await legacyHost.close(); // Closing the harness closes the storage it was opened with.

			const storage = await openDurableStorage(path);
			const calls: string[] = [];
			const host = new PiDurableConversationHost({
				contextProvider: stubProvider({
					renderMemories: async () => undefined,
					renderPersona: async (id) => {
						calls.push(id);
						return "PERSONA-TEXT";
					},
				}),
				policy: { maxMessages: 20, windowMs: 20 },
				storage,
			});
			await host.append({
				conversationId,
				envelope: envelope("message-2", "still there?"),
				submittedAtMs: Date.now(),
			});
			await waitFor(() => (calls.includes(conversationId) ? true : undefined));
			await host.close();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
