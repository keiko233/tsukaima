import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableStorage } from "@tsukaima/durable";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { PiDurableConversationHost, type AdmittedTurn } from "./conversation-host.ts";
import { createFakeModel, createSlowStreamingModel } from "./model.ts";

const envelope = (id: string, text: string, senderId = "10001"): MessageEnvelope => ({
	channelId: "test",
	channelKind: "webui",
	conversationKey: { kind: "webui" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Synthetic speaker", id: senderId, platformId: senderId },
	source: { messageId: id, receivedAtMs: Date.now(), timestampMs: Date.now() },
});

async function waitFor(read: () => boolean, timeoutMs = 6_000): Promise<void> {
	const startedAt = Date.now();
	while (!read()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("condition timed out");
		await Bun.sleep(20);
	}
}

describe("admitted submission settlement", () => {
	test("a mixed-sender batch is admitted without a triggering sender", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-mixed-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["ok"] }),
				onTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			// Plain, unterminated text keeps the first envelope in a collecting burst so the
			// forced second append admits both senders as one batch.
			await host.append({
				conversationId,
				envelope: envelope("batch-1", "synthetic first part", "10001"),
				submittedAtMs: now,
			});
			await host.append({
				conversationId,
				envelope: envelope("batch-2", "synthetic second part", "10002"),
				forceSubmit: true,
				submittedAtMs: now + 1,
			});
			expect(admitted).toHaveLength(1);
			expect(admitted[0]?.senderExternalId).toBeUndefined();
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("a same-sender batch keeps its triggering sender", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-same-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["ok"] }),
				onTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: envelope("batch-1", "synthetic first part", "10001"),
				submittedAtMs: now,
			});
			await host.append({
				conversationId,
				envelope: envelope("batch-2", "synthetic second part", "10001"),
				forceSubmit: true,
				submittedAtMs: now + 1,
			});
			expect(admitted).toHaveLength(1);
			expect(admitted[0]?.senderExternalId).toBe("10001");
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("an empty final answer still settles the admitted submission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-empty-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const answers: string[] = [];
			const settled: Array<{ conversationId: string; submissionRequestId: string }> = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: [""] }),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				onSubmissionSettled: (event) => {
					settled.push(event);
				},
				onTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("empty-answer", "synthetic empty final"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await waitFor(() => settled.length === 1);
			expect(answers).toHaveLength(0);
			expect(settled[0]).toEqual({
				conversationId,
				submissionRequestId: admitted[0]!.submissionRequestId,
			});
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("an interrupted run still settles the admitted submission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-abort-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const settled: Array<{ conversationId: string; submissionRequestId: string }> = [];
			const host = new PiDurableConversationHost({
				model: createSlowStreamingModel(["slow ", "synthetic ", "answer ", "chunks"], {
					delayMs: 40,
				}),
				onSubmissionSettled: (event) => {
					settled.push(event);
				},
				onTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("interrupted", "synthetic interrupted turn"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			await waitFor(() => admitted.length === 1);
			await host.abortConversation(conversationId);
			await waitFor(() => settled.length === 1);
			expect(settled[0]).toEqual({
				conversationId,
				submissionRequestId: admitted[0]!.submissionRequestId,
			});
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("a refused admission rolls its submission back", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-refused-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const settled: Array<{ conversationId: string; submissionRequestId: string }> = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["never delivered"] }),
				onSubmissionSettled: (event) => {
					settled.push(event);
				},
				onTurnAdmitted: (turn) => {
					// The binding is already announced when the durable submit is refused.
					admitted.push(turn);
					throw new Error("synthetic refused submit");
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await expect(
				host.append({
					conversationId,
					envelope: envelope("refused", "synthetic refused turn"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				}),
			).rejects.toThrow("synthetic refused submit");
			expect(admitted.length).toBeGreaterThan(0);
			const submissionRequestId = admitted.at(-1)!.submissionRequestId;
			expect(settled).toContainEqual({ conversationId, submissionRequestId });
			expect(await host.resolveSubmissionAnswer(conversationId, submissionRequestId!)).toEqual({
				status: "missing",
			});
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("a steer admitted into a working run is marked mid-run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-steer-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const host = new PiDurableConversationHost({
				model: createSlowStreamingModel(["slow ", "synthetic ", "answer ", "chunks"], {
					delayMs: 60,
				}),
				onTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: envelope("steer-owner", "synthetic running turn", "10001"),
				forceSubmit: true,
				submittedAtMs: now,
			});
			await waitFor(() => admitted.length === 1);
			await host.append({
				conversationId,
				envelope: envelope("steer-joiner", "synthetic steer", "10002"),
				forceSubmit: true,
				submittedAtMs: now + 1,
				whenBusy: "steer",
			});
			expect(admitted).toHaveLength(2);
			expect(admitted[1]).toMatchObject({
				midRun: true,
				senderExternalId: "10002",
				whenBusy: "steer",
			});
			await host.abortConversation(conversationId);
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("a background turn settles its fail-closed binding", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-background-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const admitted: AdmittedTurn[] = [];
			const settled: Array<{ conversationId: string; submissionRequestId: string }> = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["background answer"] }),
				onBackgroundTurnAdmitted: (turn) => {
					admitted.push(turn);
				},
				onSubmissionSettled: (event) => {
					settled.push(event);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const result = await host.submitBackgroundTurn({
				conversationId,
				kind: "scheduled",
				prompt: "synthetic scheduled prompt",
			});
			expect(admitted).toHaveLength(1);
			expect(admitted[0]?.senderExternalId).toBeUndefined();
			expect(settled).toEqual([
				{ conversationId, submissionRequestId: result.submissionRequestId },
			]);
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("releases sender binding before a slow onAnswer finishes so a follow-up sees its own sender", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-settlement-followup-"));
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		try {
			const senders = new Map<string, string | null>();
			let releaseFirstAnswer!: () => void;
			const firstAnswerGate = new Promise<void>((resolve) => {
				releaseFirstAnswer = resolve;
			});
			let firstAnswerEntered = false;
			let headSenderWhileFirstAnswerHeld: string | null | undefined;
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["first answer", "second answer"] }),
				onTurnAdmitted: (turn) => {
					senders.set(turn.submissionRequestId, turn.senderExternalId ?? null);
				},
				onSubmissionSettled: (event) => {
					senders.delete(event.submissionRequestId);
				},
				onAnswer: async (answer) => {
					if (answer.text === "first answer") {
						firstAnswerEntered = true;
						await firstAnswerGate;
					}
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: envelope("admin-1", "synthetic admin turn", "10001"),
				forceSubmit: true,
				submittedAtMs: now,
			});
			await waitFor(() => firstAnswerEntered);
			// Queue a non-admin follow-up while the first answer's onAnswer is still blocked.
			await host.append({
				conversationId,
				envelope: envelope("user-2", "synthetic user follow-up", "20002"),
				forceSubmit: true,
				submittedAtMs: now + 1,
				whenBusy: "follow-up",
			});
			for (const sender of senders.values()) {
				headSenderWhileFirstAnswerHeld = sender;
				break;
			}
			expect(headSenderWhileFirstAnswerHeld).toBe("20002");
			releaseFirstAnswer();
			await waitFor(() => senders.size === 0);
			await host.close();
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
			await rm(directory, { force: true, recursive: true });
		}
	});
});
