import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { defaultConversationPolicy, type MessagePart } from "@tsukaima/contracts";
import { openDurableStorage } from "@tsukaima/durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiDurableConversationHost } from "./conversation-host.ts";
import { createFakeModel, createSlowStreamingModel } from "./model.ts";

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

describe("PiDurableConversationHost", () => {
	test("aggregates messages in a window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({ storage });
			const conversationId = await host.createConversation();
			const first = await host.append({
				conversationId,
				envelope: envelope("message-1", "hello"),
				submittedAtMs: 1_000,
			});
			const second = await host.append({
				conversationId,
				envelope: envelope("message-2", "world"),
				submittedAtMs: 2_000,
			});
			expect(first.activityId).toBe("2:activity");
			expect(second.activityId).toBe("2:activity");
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("uses the deterministic fake model", async () => {
		const messages: unknown[] = [];
		const model = createFakeModel({
			onMessage: (message) => messages.push(message),
			responses: ["deterministic reply"],
		});
		expect(model.providerId).toBe("fake");
		expect(model.models.getModels("fake").length).toBeGreaterThan(0);
		const selected = model.models.getModel("fake", "fake-deterministic");
		if (selected === undefined) throw new Error("Fake model was not registered");
		const response = await model.models.completeSimple(
			selected,
			normalizeContext({
				messages: [{ content: "hello", role: "user", timestamp: 1 }],
			}),
		);
		expect(response.content).toEqual([{ text: "deterministic reply", type: "text" }]);
		expect(messages).toHaveLength(1);
	});

	test("flushes a collecting activity after the inactivity window", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				policy: { maxMessages: 20, windowMs: 30 },
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope("message-flush", "hello after idle"),
					source: { messageId: "message-flush", timestampMs: now },
				},
				submittedAtMs: now,
			});
			await Bun.sleep(150);
			const entries = await host.listEntries(conversationId);
			expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("submits each activity window as a distinct durable input", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const answers: string[] = [];
			const host = new PiDurableConversationHost({
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				responses: ["first answer", "second answer"],
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: { ...envelope("turn-1", "first"), source: { timestampMs: now } },
				forceSubmit: true,
				submittedAtMs: now,
			});
			await Bun.sleep(100);
			await host.append({
				conversationId,
				envelope: { ...envelope("turn-2", "second"), source: { timestampMs: now + 1 } },
				forceSubmit: true,
				submittedAtMs: now + 1,
			});
			await Bun.sleep(200);
			expect(answers).toEqual(["first answer", "second answer"]);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	// Regression: burst pacing compares envelope times against the local `submittedAtMs`. When a
	// remote platform clock ran ahead, `submittedAtMs - latestMessageAtMs` stayed negative, so
	// neither the idle settle nor the `burstMaxWaitMs` cap could ever be reached: the activity
	// window never submitted and the conversation silently stopped replying.
	test("submits a burst at the max-wait cap when the platform clock runs ahead", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				// A settle window far longer than the test so only the max-wait cap can submit.
				policy: {
					burstMaxWaitMs: 120,
					maxMessages: 100,
					windowMs: 60_000,
				},
				storage,
			});
			const conversationId = await host.createConversation();
			for (let index = 0; index < 25; index += 1) {
				const now = Date.now();
				await host.append({
					conversationId,
					envelope: {
						...envelope(`skewed-burst-${index}`, `burst ${index}`),
						source: {
							messageId: `skewed-burst-${index}`,
							receivedAtMs: now,
							// Platform clock 36s ahead of this process.
							timestampMs: now + 36_000,
						},
					},
					submittedAtMs: now,
				});
				await Bun.sleep(20);
			}
			const entries = await host.listEntries(conversationId);
			expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	// The WebUI shows an agent-style activity view while a run is in flight, which needs the
	// streamed partial from the durable `pi.live` document. Before `onLiveRun` existed a slow
	// model was indistinguishable from a hung bot: nothing appeared until the answer settled.
	test("streams partial answer text while a run is in flight", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const snapshots: string[] = [];
			const host = new PiDurableConversationHost({
				model: createSlowStreamingModel(["The ", "answer ", "streams ", "out."], { delayMs: 140 }),
				onLiveRun: (state) => {
					if (state.partialText !== undefined) snapshots.push(state.partialText);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope("live-1", "hi"),
					source: { messageId: "live-1", receivedAtMs: now, timestampMs: now },
				},
				forceSubmit: true,
				submittedAtMs: now,
			});
			// Four 140ms chunks: wait well past the stream plus the throttled commit that follows.
			await Bun.sleep(1_200);

			expect(snapshots.length).toBeGreaterThan(1);
			// Text must grow monotonically, never jump straight to the final answer.
			for (let index = 1; index < snapshots.length; index += 1) {
				expect(snapshots[index]!.startsWith(snapshots[index - 1]!)).toBe(true);
			}
			// The poll samples committed partials, so the last observation trails the final text
			// by up to one poll interval: it must still be a prefix of the answer, never a jump
			// straight to the end.
			expect(snapshots.at(-1)!.length).toBeLessThan("The answer streams out.".length);
			expect("The answer streams out.".startsWith(snapshots.at(-1)!)).toBe(true);
			// `close()` detaches the live watch and the harness before storage closes.
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("clears the live run once the answer settles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const states: (string | undefined)[] = [];
			const host = new PiDurableConversationHost({
				model: createSlowStreamingModel(["done"], { delayMs: 140 }),
				onLiveRun: (state) => states.push(state.partialText),
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope("live-2", "hi"),
					source: { messageId: "live-2", receivedAtMs: now, timestampMs: now },
				},
				forceSubmit: true,
				submittedAtMs: now,
			});
			// One 40ms chunk: wait past the stream, the throttled commit, and the settle report.
			await Bun.sleep(1_200);

			// The final observation is the settled state: no partial text, so the UI clears it.
			expect(states.length).toBeGreaterThan(0);
			expect(states.at(-1)).toBeUndefined();
			const entries = await host.listEntries(conversationId);
			expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	// A second input while the first run is still streaming replaces the live watcher. The old
	// watcher must stop, or both keep polling and publish alternating start times for one run.
	test("replaces the live watcher when another input arrives during a run", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const starts: number[] = [];
			const host = new PiDurableConversationHost({
				model: createSlowStreamingModel(["one ", "two ", "three ", "four ", "five"], {
					delayMs: 200,
				}),
				onLiveRun: (state) => {
					if (state.partialText !== undefined) starts.push(state.startedAtMs);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			await host.append({
				conversationId,
				envelope: {
					...envelope("live-3", "first"),
					source: { messageId: "live-3", receivedAtMs: now, timestampMs: now },
				},
				forceSubmit: true,
				submittedAtMs: now,
			});
			await Bun.sleep(250);
			await host.append({
				conversationId,
				envelope: {
					...envelope("live-4", "second"),
					source: { messageId: "live-4", receivedAtMs: now + 1, timestampMs: now + 1 },
				},
				forceSubmit: true,
				submittedAtMs: now + 1,
			});
			await Bun.sleep(1_600);

			expect(starts.length).toBeGreaterThan(2);
			for (let index = 1; index < starts.length; index += 1) {
				expect(starts[index]!).toBeGreaterThanOrEqual(starts[index - 1]!);
			}
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("resolves the terminal answer of an admitted submission by request id", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-answers-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["first", "second"] }),
				storage,
			});
			const conversationId = await host.createConversation();
			expect(await host.resolveSubmissionAnswer(conversationId, "1:activity#nope")).toEqual({
				status: "missing",
			});
			const requestIds: string[] = [];
			for (const [index, id] of ["answer-1", "answer-2"].entries()) {
				const now = Date.now() + index;
				await host.append({
					conversationId,
					envelope: {
						...envelope(id, "hi"),
						source: { messageId: id, receivedAtMs: now, timestampMs: now },
					},
					forceSubmit: true,
					submittedAtMs: now,
				});
				requestIds.push(`${conversationId}:activity#${id}`);
			}
			for (let step = 0; step < 120; step += 1) {
				const [first, second] = await Promise.all(
					requestIds.map((requestId) => host.resolveSubmissionAnswer(conversationId, requestId)),
				);
				if (first?.status === "answered" && second?.status === "answered") {
					expect(first.text).toBe("first");
					expect(second.text).toBe("second");
					break;
				}
				await Bun.sleep(25);
			}
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("persists the turn expectation before the submission is admitted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-expectation-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const admitted: { readonly requestId: string; readonly visible: boolean }[] = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["expected"] }),
				onTurnAdmitted: async (turn) => {
					// Inside the admission callback the durable submission must not exist yet, which
					// is exactly the crash window the expectation covers.
					const resolved = await host.resolveSubmissionAnswer(
						turn.conversationId,
						turn.submissionRequestId,
					);
					admitted.push({
						requestId: turn.submissionRequestId,
						visible: resolved.status !== "missing",
					});
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("expectation-1", "hello"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			expect(admitted).toHaveLength(1);
			expect(admitted[0]?.requestId).toBe(`${conversationId}:activity#expectation-1`);
			expect(admitted[0]?.visible).toBe(false);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("aborts the turn when the reply expectation cannot be persisted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-expectation-fail-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["should not run"] }),
				onTurnAdmitted: () => {
					throw new Error("expectation store unavailable");
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await expect(
				host.append({
					conversationId,
					envelope: envelope("expectation-fail-1", "hello"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				}),
			).rejects.toThrow("expectation store unavailable");
			// Nothing was admitted, so no answer can exist without a durable expectation.
			expect(
				await host.resolveSubmissionAnswer(
					conversationId,
					`${conversationId}:activity#expectation-fail-1`,
				),
			).toEqual({ status: "missing" });
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("passes resolved image blocks to vision models and withholds them from text-only models", async () => {
		const visionContent = await runImageTurnWithVision(true);
		expect(visionContent).toEqual([
			{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Tester: look at this$/), type: "text" },
			{ data: "AQID", mimeType: "image/png", type: "image" },
		]);

		const textOnlyContent = await runImageTurnWithVision(false);
		expect(textOnlyContent).toMatch(/^\[\d{2}:\d{2}\] Tester: look at this \[image\]$/);
	});

	test("gates images on the conversation agent model instead of the host model", async () => {
		const content = await runImageTurnWithVision(false, {
			additionalModels: [{ id: "vision-model", supportsImage: true }],
			agentModelId: "vision-model",
			hostModelId: "text-model",
		});
		expect(content).toEqual([
			{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Tester: look at this$/), type: "text" },
			{ data: "AQID", mimeType: "image/png", type: "image" },
		]);
	});

	test("passes sticker parts to the model as image blocks", async () => {
		const content = await runImageTurnWithVision(true, {
			messages: [
				{
					id: "sticker-turn",
					parts: [
						{ text: "react to this", type: "text" },
						{ channelRef: "face:1", type: "sticker" },
					],
				},
			],
		});
		expect(content).toEqual([
			{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Tester: react to this$/), type: "text" },
			{ data: "AQID", mimeType: "image/webp", type: "image" },
		]);
	});

	test("keeps each envelope's text next to its own image in a burst", async () => {
		const content = await runImageTurnWithVision(true, {
			messages: [
				{
					id: "burst-1",
					parts: [
						{ text: "first caption", type: "text" },
						{ mediaId: "media-1", mimeType: "image/png", type: "image" },
					],
					senderName: "Alpha",
				},
				{
					id: "burst-2",
					parts: [
						{ text: "second caption", type: "text" },
						{ mediaId: "media-2", mimeType: "image/png", type: "image" },
					],
					senderName: "Beta",
				},
			],
		});
		expect(content).toEqual([
			{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Alpha: first caption$/), type: "text" },
			{ data: "AQID", mimeType: "image/png", type: "image" },
			{ text: expect.stringMatching(/^\[\d{2}:\d{2}\] Beta: second caption$/), type: "text" },
			{ data: "AQID", mimeType: "image/png", type: "image" },
		]);
	});

	test("keeps an image the host cannot resolve as an explicit placeholder", async () => {
		const content = await runImageTurnWithVision(true, {
			resolveImage: async () => undefined,
		});
		expect(content).toEqual([
			{
				text: expect.stringMatching(/^\[\d{2}:\d{2}\] Tester: look at this \[image unavailable\]$/),
				type: "text",
			},
		]);
	});

	test("updates existing conversations when setModel switches provider or after reopening storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-model-sync-"));
		const dbPath = join(directory, "durable.sqlite");
		try {
			const answers: string[] = [];
			const storage = await openDurableStorage(dbPath);
			const host = new PiDurableConversationHost({
				model: createFakeModel(),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: {
					...envelope("turn-1", "before config"),
					source: { messageId: "turn-1", receivedAtMs: 1_000, timestampMs: 1_000 },
				},
				forceSubmit: true,
				submittedAtMs: 1_000,
			});
			for (let step = 0; step < 40 && answers.length < 1; step += 1) {
				await Bun.sleep(25);
			}
			expect(answers).toEqual(["ok"]);

			host.setModel(createSlowStreamingModel(["live-switched"], { delayMs: 5 }));
			await host.append({
				conversationId,
				envelope: {
					...envelope("turn-2", "after config"),
					source: { messageId: "turn-2", receivedAtMs: 2_000, timestampMs: 2_000 },
				},
				forceSubmit: true,
				submittedAtMs: 2_000,
			});
			for (let step = 0; step < 40 && answers.length < 2; step += 1) {
				await Bun.sleep(25);
			}
			expect(answers).toEqual(["ok", "live-switched"]);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);

			const restartedStorage = await openDurableStorage(dbPath);
			const restartedAnswers: string[] = [];
			const restartedHost = new PiDurableConversationHost({
				model: createSlowStreamingModel(["after-restart"], {
					delayMs: 5,
					modelId: "restarted-model",
				}),
				onAnswer: (answer) => {
					restartedAnswers.push(answer.text);
				},
				storage: restartedStorage,
			});
			await restartedHost.append({
				conversationId,
				envelope: {
					...envelope("turn-3", "after restart"),
					source: { messageId: "turn-3", receivedAtMs: 3_000, timestampMs: 3_000 },
				},
				forceSubmit: true,
				submittedAtMs: 3_000,
			});
			for (let step = 0; step < 40 && restartedAnswers.length < 1; step += 1) {
				await Bun.sleep(25);
			}
			expect(restartedAnswers).toEqual(["after-restart"]);
			await restartedHost.close();
			await restartedStorage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("applies per-conversation model and reasoning from policy sync", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-agent-settings-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const calls: { modelId: string; reasoning?: string }[] = [];
			const answers: string[] = [];
			const model = createSlowStreamingModel(["selected-model"], {
				additionalModels: [{ id: "advanced-model" }],
				delayMs: 5,
				onStreamOptions: (options, selected) => {
					calls.push({
						modelId: selected.id,
						...(options?.reasoning === undefined ? {} : { reasoning: options.reasoning }),
					});
				},
			});
			const host = new PiDurableConversationHost({
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.updatePolicy(conversationId, defaultConversationPolicy, {
				model: { modelId: "advanced-model", providerId: "slow-test" },
				thinkingLevel: "high",
			});
			await host.append({
				conversationId,
				envelope: envelope("override-turn", "use the advanced model"),
				forceSubmit: true,
				submittedAtMs: 1_000,
			});
			for (let step = 0; step < 40 && answers.length < 1; step += 1) {
				await Bun.sleep(25);
			}
			expect(calls).toEqual([{ modelId: "advanced-model", reasoning: "high" }]);

			await host.updatePolicy(conversationId, defaultConversationPolicy, {
				model: null,
				thinkingLevel: null,
			});
			await host.append({
				conversationId,
				envelope: envelope("default-turn", "go back to the default"),
				forceSubmit: true,
				submittedAtMs: 2_000,
			});
			for (let step = 0; step < 40 && answers.length < 2; step += 1) {
				await Bun.sleep(25);
			}
			expect(calls[1]).toEqual({ modelId: "slow-test-model" });
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	// Regression: a window usually holds one message in a group chat, and the model used to
	// receive it with the sender prefix stripped. Every turn then looked like a single anonymous
	// speaker, so the bot answered one member about what another member had said.
	test("labels every message with its sender, including single-message turns", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-sender-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const observed: { messages?: readonly { content?: unknown; role?: string }[] }[] = [];
			const answers: string[] = [];
			const model = createSlowStreamingModel([], {
				chunksForCall: (call) => [call === 0 ? "first" : "second"],
				delayMs: 5,
				onContext: (context) => observed.push((context as (typeof observed)[number]) ?? {}),
			});
			const host = new PiDurableConversationHost({
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			const now = Date.now();
			const turns = [
				{ id: "sender-turn-1", name: "Alpha", text: "look at this" },
				{ id: "sender-turn-2", name: "Beta", text: "what did it say" },
			];
			for (const [index, turn] of turns.entries()) {
				const base = envelope(turn.id, turn.text);
				await host.append({
					conversationId,
					envelope: {
						...base,
						conversationKey: { groupId: "group-1", kind: "group", peerId: `user-${index}` },
						sender: {
							displayName: turn.name,
							id: `user-${index}`,
							platformId: `user-${index}`,
						},
						source: { messageId: turn.id, receivedAtMs: now + index, timestampMs: now + index },
					},
					forceSubmit: true,
					submittedAtMs: now + index,
				});
				for (let step = 0; step < 40 && answers.length < index + 1; step += 1) {
					await Bun.sleep(25);
				}
			}
			expect(answers).toEqual(["first", "second"]);
			const userMessages = (observed.at(-1)?.messages ?? [])
				.filter((message) => message.role === "user")
				.map((message) => message.content);
			expect(userMessages).toEqual([
				expect.stringMatching(/^\[\d{2}:\d{2}\] Alpha\(user-0\): look at this$/),
				expect.stringMatching(/^\[\d{2}:\d{2}\] Beta\(user-1\): what did it say$/),
			]);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});

interface MultimodalTurnMessage {
	readonly id: string;
	readonly parts: readonly MessagePart[];
	readonly senderName?: string;
}

interface MultimodalTurnOptions {
	readonly additionalModels?: readonly { id: string; supportsImage?: boolean }[];
	readonly agentModelId?: string;
	readonly hostModelId?: string;
	readonly messages?: readonly MultimodalTurnMessage[];
	readonly resolveImage?: (
		part: MessagePart,
	) => Promise<{ data: string; mimeType: string } | undefined>;
}

async function runImageTurnWithVision(supportsImage: boolean, options: MultimodalTurnOptions = {}) {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-image-"));
	try {
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		let observedContext:
			| {
					messages?: readonly {
						role?: string;
						content?: unknown;
					}[];
			  }
			| undefined;
		const answers: string[] = [];
		const model = createSlowStreamingModel(["seen"], {
			delayMs: 5,
			modelId: options.hostModelId ?? "slow-test-model",
			...(options.additionalModels === undefined
				? {}
				: { additionalModels: options.additionalModels }),
			onContext: (context) => {
				observedContext = context as typeof observedContext;
			},
			supportsImage,
		});
		const resolveImage =
			options.resolveImage ??
			(async (part: MessagePart) => {
				if (part.type === "image") {
					return { data: "AQID", mimeType: part.mimeType ?? "image/png" };
				}
				if (part.type === "sticker") return { data: "AQID", mimeType: "image/webp" };
				return undefined;
			});
		const host = new PiDurableConversationHost({
			model,
			onAnswer: (answer) => {
				answers.push(answer.text);
			},
			resolveImage,
			storage,
		});
		let conversationId: string;
		if (options.agentModelId === undefined) {
			conversationId = await host.createConversation();
		} else {
			// Seed the durable conversation with a different agent model through the host's harness.
			const harness = await (host as unknown as { openHarness(): Promise<Harness> }).openHarness();
			const conversation = await harness.createConversation(
				{
					agent: {
						model: { modelId: options.agentModelId, provider: model.providerId },
					},
					ownership: { kind: "ownerless" },
				},
				BACKGROUND_CONTEXT,
			);
			conversationId = String(conversation.id);
		}
		const messages: readonly MultimodalTurnMessage[] = options.messages ?? [
			{
				id: "img-turn",
				parts: [
					{ text: "look at this", type: "text" },
					{ mediaId: "media-1", mimeType: "image/png", type: "image" },
				],
			},
		];
		const now = Date.now();
		for (const [index, message] of messages.entries()) {
			const base = envelope(message.id, "");
			await host.append({
				conversationId,
				envelope: {
					...base,
					parts: [...message.parts],
					...(message.senderName === undefined
						? {}
						: { sender: { ...base.sender, displayName: message.senderName } }),
					source: {
						messageId: message.id,
						receivedAtMs: now + index,
						timestampMs: now + index,
					},
				},
				forceSubmit: index === messages.length - 1,
				submittedAtMs: now + index,
			});
		}
		for (let step = 0; step < 40 && answers.length === 0; step += 1) {
			await Bun.sleep(25);
		}
		expect(answers).toEqual(["seen"]);
		await host.close();
		await storage.close(BACKGROUND_CONTEXT);
		return observedContext?.messages?.find((message) => message.role === "user")?.content;
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

describe("PiDurableConversationHost turn sender binding", () => {
	test("passes the triggering envelope sender to admission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-core-sender-"));
		try {
			const storage = await openDurableStorage(join(directory, "durable.sqlite"));
			const admitted: Array<string | undefined> = [];
			const host = new PiDurableConversationHost({
				model: createFakeModel({ responses: ["bound"] }),
				onTurnAdmitted: (turn) => {
					admitted.push(turn.senderExternalId);
				},
				storage,
			});
			const conversationId = await host.createConversation();
			await host.append({
				conversationId,
				envelope: envelope("sender-1", "hello"),
				forceSubmit: true,
				submittedAtMs: Date.now(),
			});
			expect(admitted).toEqual(["user-1"]);
			await host.close();
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
