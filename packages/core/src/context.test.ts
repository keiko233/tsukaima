import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, PromptInput } from "@earendil-works/pi-durable";
import { durableDocumentKinds } from "@tsukaima/contracts";
import { openDurableStorage } from "@tsukaima/durable";
import {
	CONTEXT_EXTENSION_NAME,
	PERSONA_SECTION_KEY,
	chatCompactionTranscript,
	collectRunInputs,
	collectRunTriggers,
	createContextExtension,
	previousCompactionSummary,
	type ContextPromptProvider,
} from "./context.ts";
import { PiDurableConversationHost } from "./conversation-host.ts";

const renderInput = { conversationId: 7 as ConversationId } as unknown as PromptInput;

const stubProvider = (overrides: Partial<ContextPromptProvider> = {}): ContextPromptProvider => ({
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
	test("keeps only static sections in pi.system and hooks the turn context", async () => {
		const extension = createContextExtension(
			stubProvider({
				renderPersona: async () => "You are Tsukaima, a curious traveler.",
				renderTurnContext: async () => [{ key: "memories", text: "likes tea" }],
			}),
		);
		expect(extension.name).toBe(CONTEXT_EXTENSION_NAME);
		expect(extension.sections?.map((section) => section.key)).toEqual([PERSONA_SECTION_KEY]);
		expect(extension.hooks?.length).toBe(1);
		const personaText = await extension.sections?.[0]?.render(renderInput, BACKGROUND_CONTEXT);
		expect(personaText).toContain("Tsukaima");
	});

	test("omits sections when the provider throws or returns nothing", async () => {
		const extension = createContextExtension(
			stubProvider({
				renderPersona: async () => {
					throw new Error("persona lookup exploded");
				},
				renderPolicy: async () => "   ",
			}),
		);
		expect(await extension.sections?.[0]?.render(renderInput, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await extension.sections?.[1]?.render(renderInput, BACKGROUND_CONTEXT)).toBeUndefined();
	});
});

describe("PiDurableConversationHost context provider", () => {
	test("renders persona and turn context for the conversation that produced the run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-context-"));
		try {
			const calls: string[] = [];
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				contextProvider: stubProvider({
					renderTurnContext: async (request) => {
						calls.push(`memory:${request.conversationId}`);
						return [{ key: "memories", text: "MEMORY-TEXT" }];
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
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-context-"));
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

const conversation = 1 as ConversationId;

const activity = (id: number, envelopes: readonly Record<string, unknown>[]): EntryRecord =>
	({
		conversationId: conversation,
		data: { envelopes },
		id: id as EntryId,
		kind: durableDocumentKinds.activityWindow,
		model: [{ content: "input", role: "user", timestamp: id }],
	}) as unknown as EntryRecord;

const assistant = (id: number, stopReason: "stop" | "toolUse"): EntryRecord =>
	({
		conversationId: conversation,
		id: id as EntryId,
		kind: "pi.assistant",
		model: [
			{
				content: [{ text: stopReason, type: "text" }],
				role: "assistant",
				stopReason,
			},
		],
	}) as unknown as EntryRecord;

const turnEnvelope = (
	id: string,
	classification: "direct" | "soft" | "ambient",
	extra: Record<string, unknown> = {},
) => ({
	id,
	source: { messageId: id, timestampMs: 1 },
	turnContext: { classification, ...extra },
});

describe("collectRunTriggers", () => {
	test("collects steers and follow-ups oldest first and skips tool rounds", () => {
		const entries = [
			assistant(10, "toolUse"),
			activity(9, [turnEnvelope("steer-2", "direct")]),
			assistant(8, "toolUse"),
			activity(7, [turnEnvelope("follow-up", "soft", { cue: "quiet cue" })]),
			activity(6, [turnEnvelope("initial", "direct")]),
			assistant(5, "stop"),
			activity(4, [turnEnvelope("previous-run", "ambient")]),
		];
		expect(collectRunTriggers(entries)).toEqual([
			{ classification: "direct" },
			{ classification: "soft", cue: "quiet cue" },
			{ classification: "direct" },
		]);
		expect(collectRunInputs(entries)).toEqual([
			{ envelopeId: "initial", platformMessageId: "initial" },
			{ envelopeId: "follow-up", platformMessageId: "follow-up" },
			{ envelopeId: "steer-2", platformMessageId: "steer-2" },
		]);
	});

	test("uses the live run boundary after a terminate round", () => {
		const entries = [
			assistant(9, "toolUse"),
			activity(8, [turnEnvelope("current-tool-round", "direct")]),
			activity(7, [turnEnvelope("current-input", "soft")]),
			assistant(6, "toolUse"),
			activity(5, [turnEnvelope("previous-terminate-input", "ambient")]),
			assistant(4, "toolUse"),
			activity(3, [turnEnvelope("older-run-input", "direct")]),
		];
		// A terminate round ends without a final answer, so the live run's first entry is the
		// boundary; without it the scan would walk into the terminated run's own inputs.
		expect(collectRunTriggers(entries, { minEntryId: 7 })).toEqual([
			{ classification: "soft" },
			{ classification: "direct" },
		]);
	});

	test("recovers legacy triggerContext envelopes without exposing the old preamble", () => {
		const entries = [
			assistant(7, "toolUse"),
			activity(6, [
				{
					id: "legacy-direct",
					triggerContext: "Conversation trigger:\n- direct\n- Media/notice summary: none",
				},
				{
					id: "legacy-soft",
					triggerContext:
						"Conversation trigger:\n- soft\n- Bot name used without direct address: yes\n- Another bot is speaking: no\n- Media/notice summary: sticker only\n- If speaking would be noise, reply with exactly TSUKAIMA_LURK and nothing else.",
				},
				{ id: "legacy-none", triggerContext: "not a trigger" },
			]),
			assistant(5, "stop"),
		];
		const triggers = collectRunTriggers(entries);
		expect(triggers[0]).toEqual({ classification: "direct" });
		expect(triggers[1]?.classification).toBe("soft");
		expect(triggers[1]?.cue).toContain("mentioned you by name");
		expect(triggers[1]?.cue).toContain("sticker only");
		expect(triggers[1]?.cue).not.toContain("Conversation trigger:");
		expect(triggers).toHaveLength(2);
	});

	test("ignores write-only windows and stops at compaction or reset", () => {
		expect(
			collectRunTriggers([
				assistant(6, "stop"),
				{
					conversationId: conversation,
					data: { envelopes: [turnEnvelope("write-window", "direct")] },
					id: 5 as EntryId,
					kind: durableDocumentKinds.activityWindow,
				} as unknown as EntryRecord,
				assistant(4, "toolUse"),
				activity(3, [turnEnvelope("compacted-away", "direct")]),
				{ conversationId: conversation, id: 2 as EntryId, kind: "pi.compaction" },
			]),
		).toEqual([]);
		expect(
			collectRunTriggers([
				assistant(6, "stop"),
				activity(5, [turnEnvelope("before-reset", "direct")]),
				{ conversationId: conversation, id: 4 as EntryId, kind: "pi.reset" },
			]),
		).toEqual([]);
	});
});

describe("chatCompactionTranscript", () => {
	test("clips tool output, omits inline image bytes, and separates a previous summary", () => {
		const head = `The conversation history before this point was compacted into the following summary:\n\n<summary>\nPREVIOUS-SUMMARY\n</summary>`;
		const messages = [
			{ content: [{ text: head, type: "text" }], role: "user", timestamp: 1 },
			{
				content: [
					{
						text: `look ${"data:image/png;base64,"}${"A".repeat(600)}`,
						type: "text",
					},
				],
				role: "user",
				timestamp: 2,
			},
			{
				content: [
					{ text: "I will check.", type: "text" },
					{
						arguments: {},
						id: "call-1",
						name: "search",
						type: "toolCall",
					},
				],
				role: "assistant",
				stopReason: "toolUse",
				timestamp: 3,
			},
			{
				content: [
					{ text: "R".repeat(5_000), type: "text" },
					{ data: "A".repeat(400), mimeType: "image/png", type: "image" },
				],
				isError: false,
				role: "toolResult",
				timestamp: 4,
				toolCallId: "call-1",
				toolName: "search",
			},
		] as unknown as Message[];
		expect(previousCompactionSummary(messages)).toBe("PREVIOUS-SUMMARY");
		const transcript = chatCompactionTranscript(messages);
		expect(transcript).not.toContain("PREVIOUS-SUMMARY");
		expect(transcript).not.toContain("data:image");
		expect(transcript).not.toContain("A".repeat(200));
		expect(transcript).toContain("(you used: search)");
		expect(transcript).toContain("(result of search):");
		expect(Math.max(...transcript.split("\n").map((line) => line.length))).toBeLessThan(2_100);
	});
});
