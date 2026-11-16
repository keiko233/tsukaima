import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import {
	conversationPolicySchema,
	defaultConversationPolicy,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import type { BusyArbitrationInput, BusyArbitrationResult } from "./busy-arbiter.ts";
import { PiDurableConversationHost } from "./conversation-host.ts";
import { createSlowStreamingModel } from "./model.ts";

const envelope = (id: string, text: string): MessageEnvelope => ({
	channelId: "test",
	channelKind: "webui",
	conversationKey: { kind: "webui" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

const busyPolicy = (patch: {
	burstLongMessageThreshold?: number;
	maxHoldMs?: number;
	maxInterruptsPerMinute?: number;
	sidechatEnabled?: boolean;
}) =>
	conversationPolicySchema.parse({
		...defaultConversationPolicy,
		pacing: {
			...defaultConversationPolicy.pacing,
			burstLongMessageThreshold: patch.burstLongMessageThreshold ?? 400,
			burstMaxWaitMs: 1_000,
			burstSettleMs: 30,
		},
		sidechat: {
			enabled: patch.sidechatEnabled ?? true,
			maxHoldMs: patch.maxHoldMs ?? 5_000,
			maxInterruptsPerMinute: patch.maxInterruptsPerMinute ?? 3,
			minConfidence: 0,
			minRunAgeMs: 0,
			timeoutMs: 1_000,
		},
	});

async function waitFor(check: () => boolean, timeoutMs = 6_000): Promise<void> {
	const startedAt = Date.now();
	while (!check()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
		await Bun.sleep(20);
	}
}

function contextText(context: unknown): string {
	if (typeof context !== "object" || context === null || !("messages" in context)) return "";
	const messages = (context as { messages?: readonly { content?: unknown; role?: string }[] })
		.messages;
	if (!Array.isArray(messages)) return "";
	return messages
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map((part: unknown) =>
								typeof part === "object" &&
								part !== null &&
								"text" in part &&
								typeof part.text === "string"
									? part.text
									: "",
							)
							.join("")
					: "",
		)
		.join("\n");
}

describe("busy sidechat arbitration", () => {
	test("holds a long pending message while the run works, then submits one merged follow-up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-busy-wait-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const contexts: unknown[] = [];
			const starts: (() => void)[] = [];
			const calls: BusyArbitrationInput[] = [];
			const answers: string[] = [];
			const host = new PiDurableConversationHost({
				busyArbiter: (input): BusyArbitrationResult => {
					calls.push(input);
					return { confidence: 1, decision: "wait" };
				},
				model: createSlowStreamingModel(["answer ", "chunk ", "one ", "two ", "three"], {
					delayMs: 80,
					onContext: (context) => {
						contexts.push(context);
						starts.shift()?.();
					},
				}),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.updatePolicy(conversationId, busyPolicy({ burstLongMessageThreshold: 3 }));
			const firstStarted = new Promise<void>((resolve) => starts.push(resolve));
			await host.append({
				conversationId,
				envelope: envelope("first", "first"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await firstStarted;
			// This is long enough to trip `burstLongMessageThreshold`; the old path submitted it
			// immediately, even while the run was working.
			await host.append({
				conversationId,
				envelope: envelope("second", "second message"),
				submittedAtMs: Date.now(),
			});
			await host.append({
				conversationId,
				envelope: envelope("third", "third message"),
				submittedAtMs: Date.now(),
			});
			await waitFor(() => calls.length > 0);
			expect(calls[0]?.pendingText).toContain("second message");
			expect(calls[0]?.pendingText).toContain("third message");
			await waitFor(() => answers.length >= 2);
			const mergedContext = contextText(contexts.at(-1));
			expect(mergedContext).toContain("second message");
			expect(mergedContext).toContain("third message");
			// The first answer and exactly one merged follow-up answer.
			expect(answers).toHaveLength(2);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("interrupts the working run and re-answers the merged conversation once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-busy-interrupt-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const contexts: unknown[] = [];
			const starts: (() => void)[] = [];
			const answers: string[] = [];
			const host = new PiDurableConversationHost({
				busyArbiter: () => ({ confidence: 1, decision: "interrupt" }),
				model: createSlowStreamingModel([], {
					chunksForCall: (call) =>
						call === 0
							? ["stale ", "partial ", "answer ", "should ", "not ", "arrive"]
							: ["fresh ", "answer"],
					delayMs: 80,
					onContext: (context) => {
						contexts.push(context);
						starts.shift()?.();
					},
				}),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.updatePolicy(conversationId, busyPolicy({}));
			const firstStarted = new Promise<void>((resolve) => starts.push(resolve));
			await host.append({
				conversationId,
				envelope: envelope("first", "first"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await firstStarted;
			const secondStarted = new Promise<void>((resolve) => starts.push(resolve));
			await host.append({
				conversationId,
				envelope: envelope("second", "second"),
				submittedAtMs: Date.now(),
			});
			await waitFor(() => answers.length >= 1);
			expect(answers).toHaveLength(1);
			expect(answers[0]).toContain("fresh answer");
			expect(answers[0]).not.toContain("stale partial");
			const retriedContext = contextText(contexts.at(-1));
			expect(retriedContext).toContain("first");
			expect(retriedContext).toContain("second");
			// The aborted partial is an `aborted` assistant entry and must not enter model context.
			expect(retriedContext).not.toContain("stale partial");
			await secondStarted;
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("falls back to waiting when the sidechat throws", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-busy-fallback-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const starts: (() => void)[] = [];
			const answers: string[] = [];
			const host = new PiDurableConversationHost({
				busyArbiter: () => {
					throw new Error("sidechat unavailable");
				},
				model: createSlowStreamingModel(["one ", "two ", "three ", "four"], {
					delayMs: 80,
					onContext: () => {
						starts.shift()?.();
					},
				}),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.updatePolicy(conversationId, busyPolicy({}));
			const firstStarted = new Promise<void>((resolve) => starts.push(resolve));
			await host.append({
				conversationId,
				envelope: envelope("first", "first"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await firstStarted;
			await host.append({
				conversationId,
				envelope: envelope("second", "second"),
				submittedAtMs: Date.now(),
			});
			await waitFor(() => answers.length >= 2);
			expect(answers).toHaveLength(2);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
