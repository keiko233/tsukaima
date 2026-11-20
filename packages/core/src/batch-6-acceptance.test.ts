import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conversationPolicySchema,
	defaultConversationPolicy,
	type ConversationPolicy,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import { openDurableStorage } from "@tsukaima/durable";
import {
	type BusyArbitrationInput,
	type BusyArbitrationResult,
	type ConversationGatePort,
	type DurableConversationHostOptions,
	FailOpenConversationGate,
	type FastLaneInterjectInput,
	type FastLaneReply,
	PiDurableConversationHost,
	createFakeModel,
	createSlowStreamingModel,
} from "./index.ts";

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

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function withHost(
	run: (host: PiDurableConversationHost) => Promise<void>,
	options: Omit<DurableConversationHostOptions, "storage"> = {},
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-batch-6-core-"));
	try {
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const host = new PiDurableConversationHost({
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
			timeZone: "UTC",
			...options,
		});
		try {
			await run(host);
		} finally {
			await host.close();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

const policyWith = (
	overrides: {
		readonly gate?: Partial<ConversationPolicy["gate"]>;
		readonly humanization?: Partial<ConversationPolicy["humanization"]>;
		readonly pacing?: Partial<ConversationPolicy["pacing"]>;
		readonly sidechat?: Partial<ConversationPolicy["sidechat"]>;
	} = {},
): ConversationPolicy =>
	conversationPolicySchema.parse({
		...defaultConversationPolicy,
		...(overrides.gate === undefined
			? {}
			: { gate: { ...defaultConversationPolicy.gate, ...overrides.gate } }),
		...(overrides.humanization === undefined
			? {}
			: { humanization: { ...defaultConversationPolicy.humanization, ...overrides.humanization } }),
		...(overrides.pacing === undefined
			? {}
			: { pacing: { ...defaultConversationPolicy.pacing, ...overrides.pacing } }),
		...(overrides.sidechat === undefined
			? {}
			: { sidechat: { ...defaultConversationPolicy.sidechat, ...overrides.sidechat } }),
	});

function slowModelWithStart(
	chunks: readonly string[],
	chunksForCall?: (call: number) => readonly string[],
	delayMs = 90,
) {
	const started = Promise.withResolvers<void>();
	let seen = 0;
	const model = createSlowStreamingModel(chunks, {
		...(chunksForCall === undefined ? {} : { chunksForCall }),
		delayMs,
		onContext: () => {
			seen += 1;
			if (seen === 1) started.resolve();
		},
	});
	return { model, started: started.promise };
}

function stubGate(
	decisions: {
		readonly burst?: (
			input: Parameters<ConversationGatePort["decideBurstCompletion"]>[0],
		) => "SEND" | "WAIT";
		readonly proactive?: "SHOULD" | "SKIP";
	},
	events: string[] = [],
): ConversationGatePort {
	return {
		decideBurstCompletion: async (input) => {
			events.push("burst");
			return { decision: decisions.burst?.(input) ?? "SEND", source: "gate" };
		},
		decideProactiveBubble: async () => ({
			decision: decisions.proactive ?? "SHOULD",
			source: "gate",
		}),
		decideUndirectedGroupReply: async () => ({ decision: "REPLY", source: "gate" }),
	};
}

describe("Batch 6 acceptance: burst-completion gate", () => {
	test("WAIT holds a soft burst until the burstMaxWaitMs ceiling, then submits", async () => {
		const events: string[] = [];
		const answers: string[] = [];
		const gate = stubGate(
			{
				burst: (input) => (input.elapsedMs < 180 ? "WAIT" : "SEND"),
			},
			events,
		);
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(
					conversationId,
					policyWith({
						gate: { enabled: true },
						pacing: { burstMaxWaitMs: 200, burstSettleMs: 40 },
					}),
				);
				const startedAt = Date.now();
				await host.append({
					classification: "soft",
					conversationId,
					envelope: envelope("soft-burst", "still thinking out loud"),
					submittedAtMs: startedAt,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				const elapsed = Date.now() - startedAt;
				expect(gate).toBeDefined();
				expect(events.length).toBeGreaterThanOrEqual(2);
				expect(elapsed).toBeGreaterThanOrEqual(150);
				expect(elapsed).toBeLessThan(800);
			},
			{
				conversationGate: gate,
				model: createFakeModel({ responses: ["gated answer"] }),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
	});

	test("SEND submits after the normal settle window without waiting for burstMaxWaitMs", async () => {
		const events: string[] = [];
		const answers: string[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(
					conversationId,
					policyWith({
						gate: { enabled: true },
						pacing: { burstMaxWaitMs: 2_000, burstSettleMs: 60 },
					}),
				);
				const startedAt = Date.now();
				await host.append({
					classification: "soft",
					conversationId,
					envelope: envelope("soft-send", "finished thought"),
					submittedAtMs: startedAt,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(Date.now() - startedAt).toBeLessThan(800);
			},
			{
				conversationGate: stubGate({ burst: () => "SEND" }, events),
				model: createFakeModel({ responses: ["send answer"] }),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
		expect(events).toHaveLength(1);
	});
});

describe("Batch 6 acceptance: fail-open gate", () => {
	test("a timed-out driver fails open and trips the breaker after three failures", async () => {
		let nowMs = 1_000;
		let calls = 0;
		let healthy = false;
		const breakerCalls: string[] = [];
		const gate = new FailOpenConversationGate({
			defaultTimeoutMs: 100,
			now: () => nowMs,
			onFallback: (event) => breakerCalls.push(`${event.kind}:${event.reason}`),
			driver: {
				decideBurstCompletion: async () => ({ decision: "SEND" }),
				decideProactiveBubble: async () => ({ decision: "SHOULD" }),
				decideUndirectedGroupReply: async (_input, signal) => {
					calls += 1;
					if (healthy) return { decision: "SKIP", reason: "chatter" };
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("timeout")));
					});
					return undefined;
				},
			},
		});
		const policy = conversationPolicySchema.parse({
			...defaultConversationPolicy,
			gate: { ...defaultConversationPolicy.gate, enabled: true, timeoutMs: 100 },
		}).gate;
		for (let index = 0; index < 3; index += 1) {
			const decision = await gate.decideUndirectedGroupReply({
				conversationId: "conv-1",
				messageText: "synthetic chatter",
				policy,
				senderName: "Synthetic",
			});
			expect(decision).toMatchObject({ decision: "REPLY", reason: "timeout", source: "fallback" });
		}
		expect(calls).toBe(3);
		expect(gate.health().state).toBe("open");
		expect(breakerCalls.at(-1)).toBe("group:timeout");

		nowMs += 60_000;
		healthy = true;
		const recovered = await gate.decideUndirectedGroupReply({
			conversationId: "conv-1",
			messageText: "synthetic chatter",
			policy,
			senderName: "Synthetic",
		});
		expect(recovered).toMatchObject({ decision: "SKIP", source: "gate" });
		expect(gate.health().state).toBe("closed");
	});
});

describe("Batch 6 acceptance: fast-lane busy interjection", () => {
	const busyPolicy = policyWith({
		pacing: { burstMaxWaitMs: 200, burstSettleMs: 30 },
		sidechat: { enabled: true, interjectEnabled: true, maxHoldMs: 5_000 },
	});

	test("an urgent direct question receives an anchored fast reply without touching the main run", async () => {
		const interjections: FastLaneInterjectInput[] = [];
		const fastReplies: FastLaneReply[] = [];
		const answers: string[] = [];
		const contexts: unknown[] = [];
		let mainRequestId: string | undefined;
		const slow = slowModelWithStart(
			[],
			(call) => (call === 0 ? ["main ", "answer"] : ["second ", "answer"]),
			100,
		);
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(conversationId, busyPolicy);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("main-turn", "write the report"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await slow.started;
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("urgent", "在吗？急事问一下"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await waitFor(() => (fastReplies.length > 0 ? fastReplies[0] : undefined));
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(interjections).toHaveLength(1);
				expect(interjections[0]?.messageText).toContain("急事");
				expect(interjections[0]?.runningRequest).toBeTruthy();
				expect(fastReplies[0]?.text).toContain("马上");
				expect(answers).toEqual(["main answer"]);
				if (mainRequestId !== undefined) {
					expect(await host.resolveSubmissionAnswer(conversationId, mainRequestId)).toMatchObject({
						status: "answered",
						text: "main answer",
					});
				}
			},
			{
				busyArbiter: (): BusyArbitrationResult => ({ confidence: 1, decision: "wait" }),
				fastLaneInterjector: async (input) => {
					interjections.push(input);
					return { handled: true, text: "马上，我先把手上的收尾。" };
				},
				model: slow.model,
				onAnswer: (answer) => {
					answers.push(answer.text);
					mainRequestId = answer.submissionRequestId;
				},
				onFastLaneReply: (reply) => {
					fastReplies.push(reply);
				},
				onLiveRun: (run) => contexts.push(run),
			},
		);
		expect(contexts.length).toBeGreaterThan(0);
	});

	test("identity probes and trailing follow-ups stay on the main conversation", async () => {
		const interjections: FastLaneInterjectInput[] = [];
		const fastReplies: FastLaneReply[] = [];
		const answers: string[] = [];
		const slow = slowModelWithStart(
			[],
			(call) => (call === 0 ? ["main ", "answer"] : ["second ", "answer"]),
			100,
		);
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(conversationId, busyPolicy);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("identity-main", "write the report"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await slow.started;
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("identity-probe", "你是谁？"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await waitFor(() => (answers.length >= 2 ? answers[1] : undefined));
				expect(interjections).toHaveLength(0);
				expect(fastReplies).toHaveLength(0);
				expect(answers).toEqual(["main answer", "second answer"]);
			},
			{
				busyArbiter: (): BusyArbitrationResult => ({ confidence: 1, decision: "wait" }),
				fastLaneInterjector: async (input) => {
					interjections.push(input);
					return { handled: true, text: "fast" };
				},
				model: slow.model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				onFastLaneReply: (reply) => {
					fastReplies.push(reply);
				},
			},
		);
	});

	test("a trailing follow-up stays on the main conversation", async () => {
		const interjections: FastLaneInterjectInput[] = [];
		const fastReplies: FastLaneReply[] = [];
		const answers: string[] = [];
		const slow = slowModelWithStart(
			[],
			(call) => (call === 0 ? ["main ", "answer"] : ["second ", "answer"]),
			100,
		);
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(conversationId, busyPolicy);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("followup-main", "write the report"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await slow.started;
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("trailing-followup", "对了还有一件事？"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await waitFor(() => (answers.length >= 2 ? answers[1] : undefined));
				expect(interjections).toHaveLength(0);
				expect(fastReplies).toHaveLength(0);
				expect(answers).toEqual(["main answer", "second answer"]);
			},
			{
				busyArbiter: (): BusyArbitrationResult => ({ confidence: 1, decision: "wait" }),
				fastLaneInterjector: async (input) => {
					interjections.push(input);
					return { handled: true, text: "fast" };
				},
				model: slow.model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				onFastLaneReply: (reply) => {
					fastReplies.push(reply);
				},
			},
		);
	});

	test("rate limits and multi-envelope windows fall back to the main conversation", async () => {
		const interjections: FastLaneInterjectInput[] = [];
		const fastReplies: FastLaneReply[] = [];
		const answers: string[] = [];
		const arbitration: BusyArbitrationInput[] = [];
		const slow = slowModelWithStart(
			[],
			(call) => (call === 0 ? ["main ", "answer", " ", "part", "."] : ["second ", "answer"]),
			140,
		);
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(
					conversationId,
					policyWith({
						pacing: { burstMaxWaitMs: 200, burstSettleMs: 40 },
						sidechat: {
							enabled: true,
							interjectEnabled: true,
							maxHoldMs: 5_000,
							maxInterruptsPerMinute: 1,
						},
					}),
				);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("limit-main", "write the report"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await slow.started;
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("urgent-one", "在吗？急事问一下"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await waitFor(() => (fastReplies.length > 0 ? fastReplies[0] : undefined));
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("urgent-two", "还在吗？快点"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await Bun.sleep(80);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("second-question", "现在怎么样？"),
					submittedAtMs: Date.now(),
					turnContext: { classification: "direct" },
				});
				await waitFor(() => (answers.length >= 2 ? answers[1] : undefined));
				expect(interjections).toHaveLength(1);
				expect(fastReplies).toHaveLength(1);
				expect(answers[1]).toBe("second answer");
			},
			{
				busyArbiter: (input) => {
					arbitration.push(input);
					return { confidence: 1, decision: "wait" };
				},
				fastLaneInterjector: async (input) => {
					interjections.push(input);
					return { handled: true, text: "fast reply" };
				},
				model: slow.model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				onFastLaneReply: (reply) => {
					fastReplies.push(reply);
				},
			},
		);
		expect(arbitration.length).toBeGreaterThan(0);
	});
});

describe("Batch 6 acceptance: bounded repetition rewrite", () => {
	test("rewrites exactly once when severe repetition is detected and the guard is enabled", async () => {
		const answers: string[] = [];
		let calls = 0;
		const model = createFakeModel({
			onMessage: () => {
				calls += 1;
			},
			responses: ["废话废话废话 repeated answer", "clean answer"],
		});
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(
					conversationId,
					policyWith({ humanization: { repetitionRewriteEnabled: true } }),
				);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("rewrite", "please answer"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(calls).toBe(2);
				expect(answers[0]).toBe("clean answer");
			},
			{
				// Even a check that keeps saying "rewrite" must stay bounded to a single retry.
				checkRepetitionRewrite: async () => ({ matched: ["废话"], rewrite: true }),
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
	});

	test("does not rewrite when the guard is disabled even with repeated text", async () => {
		const answers: string[] = [];
		let calls = 0;
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(
					conversationId,
					policyWith({ humanization: { repetitionRewriteEnabled: false } }),
				);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: envelope("no-rewrite", "please answer"),
					forceSubmit: true,
					submittedAtMs: Date.now(),
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(calls).toBe(1);
				expect(answers[0]).toBe("废话废话废话 repeated answer");
			},
			{
				checkRepetitionRewrite: async () => ({ matched: ["废话"], rewrite: true }),
				model: createFakeModel({
					onMessage: () => {
						calls += 1;
					},
					responses: ["废话废话废话 repeated answer"],
				}),
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
	});
});
