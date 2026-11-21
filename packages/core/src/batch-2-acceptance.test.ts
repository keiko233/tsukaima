import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import {
	conversationPolicySchema,
	defaultConversationPolicy,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import { openDurableStorage } from "@tsukaima/durable";
import {
	type ConversationAnswer,
	type ConversationNarration,
	type DurableConversationHostOptions,
	createFakeModel,
	createOpenAICompatibleModelPort,
	extractLurkMarker,
	LENGTH_CONTINUATION_PROMPT,
	PiDurableConversationHost,
} from "./index.ts";

const conversationEnvelope = (id: string, text: string, receivedAtMs = 1): MessageEnvelope => ({
	channelId: "test",
	channelKind: "webui",
	conversationKey: { kind: "webui" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, receivedAtMs, timestampMs: receivedAtMs },
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
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
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-batch-2-core-"));
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

const withPacing = (pacing: Partial<(typeof defaultConversationPolicy)["pacing"]>) =>
	conversationPolicySchema.parse({
		...defaultConversationPolicy,
		pacing: { ...defaultConversationPolicy.pacing, ...pacing },
	});

const withGeneration = (generation: Partial<(typeof defaultConversationPolicy)["generation"]>) =>
	conversationPolicySchema.parse({
		...defaultConversationPolicy,
		generation: { ...defaultConversationPolicy.generation, ...generation },
	});

const jsonResponse = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	});

const completion = (content: string | null, finishReason: "length" | "stop"): Response =>
	jsonResponse({
		choices: [{ finish_reason: finishReason, message: { content } }],
		id: `response-${finishReason}`,
		model: "scripted-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	});

const toolCompletion = (content: string, callId: string): Response =>
	jsonResponse({
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content,
					tool_calls: [
						{
							function: { arguments: "{}", name: "probe_tool" },
							id: callId,
							type: "function",
						},
					],
				},
			},
		],
		id: `response-${callId}`,
		model: "scripted-model",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	});

describe("Batch 2 acceptance: responsive pacing", () => {
	test("flushes a complete direct message at once while a rapid burst still merges", async () => {
		const answers: ConversationAnswer[] = [];
		const contexts: unknown[] = [];
		const model = createFakeModel({ responses: ["direct answer", "merged answer"] });
		const stream = model.models.streamSimple.bind(model.models);
		model.models.streamSimple = (target, context, options) => {
			contexts.push(context);
			return stream(target, context, options);
		};
		await withHost(
			async (host) => {
				const directConversation = await host.createConversation();
				await host.updatePolicy(
					directConversation,
					withPacing({ burstMaxWaitMs: 5_000, burstSettleMs: 5_000 }),
				);
				const startedAt = Date.now();
				await host.append({
					classification: "direct",
					conversationId: directConversation,
					envelope: conversationEnvelope("direct-question", "are you there?"),
					submittedAtMs: startedAt,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(Date.now() - startedAt).toBeLessThan(1_500);
				expect(contexts).toHaveLength(1);

				const burstConversation = await host.createConversation();
				await host.updatePolicy(
					burstConversation,
					withPacing({
						activeBurstWindowMs: 500,
						burstMaxWaitMs: 500,
						burstSettleMs: 250,
					}),
				);
				const burstAt = Date.now();
				await host.append({
					classification: "direct",
					conversationId: burstConversation,
					envelope: conversationEnvelope("burst-one", "part one", burstAt),
					submittedAtMs: burstAt,
				});
				await host.append({
					classification: "direct",
					conversationId: burstConversation,
					envelope: conversationEnvelope("burst-two", "part two?", burstAt + 20),
					submittedAtMs: burstAt + 20,
				});
				await waitFor(() => (answers.length > 1 ? answers[1] : undefined));
				// Both envelopes merged into one model request instead of starting two runs.
				expect(contexts).toHaveLength(2);
				const merged = JSON.stringify(contexts[1]);
				expect(merged).toContain("part one");
				expect(merged).toContain("part two?");
				await Bun.sleep(100);
				expect(contexts).toHaveLength(2);
			},
			{
				model,
				onAnswer: (answer) => {
					answers.push(answer);
				},
			},
		);
	});
});

describe("Batch 2 acceptance: mid-turn narration", () => {
	test("delivers a preamble before the tool finishes and keeps each round distinct", async () => {
		let releaseTool!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let toolStarted = false;
		const probe: Extension = {
			name: "batch-2-probe",
			tools: [
				{
					callers: ["model"],
					description: "Block until the test releases it",
					execute: async () => {
						toolStarted = true;
						await toolGate;
						return { output: [{ text: "probe result", type: "text" }] };
					},
					name: "probe_tool",
					parameters: { properties: {}, type: "object" },
				},
			],
		};
		const requests: unknown[] = [];
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://scripted-tool.invalid/v1",
				fetch: (async (_input: string, init?: RequestInit) => {
					const request = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: readonly { readonly role?: string }[];
					};
					requests.push(request);
					const toolResults = (request.messages ?? []).filter(
						(message) => message.role === "tool",
					).length;
					if (toolResults === 0) {
						return toolCompletion("First note.", "call-1");
					}
					if (toolResults === 1) {
						return toolCompletion("Second note.", "call-2");
					}
					return completion("Final answer.", "stop");
				}) as typeof fetch,
			},
			[{ maxOutputTokens: 4_096, modelId: "scripted-model", supportsTools: true }],
		);
		const narrations: ConversationNarration[] = [];
		const answers: ConversationAnswer[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.append({
					classification: "direct",
					conversationId,
					envelope: conversationEnvelope("narration-run", "use the probe twice"),
					forceSubmit: true,
					submittedAtMs: 1,
				});
				await waitFor(() => (toolStarted && narrations.length > 0 ? true : undefined));
				expect(answers).toHaveLength(0);
				expect(narrations).toHaveLength(1);
				expect(narrations[0]).toMatchObject({
					kind: "tool-preamble",
					text: "First note.",
					toolNames: ["probe_tool"],
				});
				releaseTool();
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(narrations).toHaveLength(2);
				expect(narrations[1]).toMatchObject({
					kind: "tool-preamble",
					text: "Second note.",
				});
				expect(narrations[0]?.narrationId).not.toBe(narrations[1]?.narrationId);
				expect(answers[0]?.text).toBe("Final answer.");
				expect(requests).toHaveLength(3);
			},
			{
				extensions: [probe],
				model,
				onAnswer: (answer) => {
					answers.push(answer);
				},
				onNarration: (narration) => {
					narrations.push(narration);
				},
			},
		);
	});
});

describe("Batch 2 acceptance: lurk and length truncation", () => {
	test("a standalone marker lurks while an embedded mention keeps the real text", () => {
		expect(extractLurkMarker("TSUKAIMA_LURK").lurk).toBe(true);
		expect(extractLurkMarker("ok\nTSUKAIMA_LURK")).toEqual({ lurk: false, text: "ok" });
		expect(extractLurkMarker("The token TSUKAIMA_LURK stays internal.").text).toBe(
			"The token stays internal.",
		);
	});

	test("bounded continuations advance past one and finish with a complete answer", async () => {
		const requests: Array<{ readonly messages?: readonly unknown[] }> = [];
		let call = 0;
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://scripted-length.invalid/v1",
				fetch: (async (_input: string, init?: RequestInit) => {
					const request = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: readonly unknown[];
					};
					requests.push(request);
					call += 1;
					return completion(`cut-${call}`, "length");
				}) as typeof fetch,
			},
			[{ maxOutputTokens: 4_096, modelId: "scripted-model" }],
		);
		const narrations: ConversationNarration[] = [];
		const answers: ConversationAnswer[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(conversationId, withGeneration({ maxLengthContinuations: 2 }));
				await host.append({
					classification: "direct",
					conversationId,
					envelope: conversationEnvelope("length-run", "write a long answer"),
					forceSubmit: true,
					submittedAtMs: 1,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(requests).toHaveLength(3);
				expect(narrations.map((entry) => entry.text)).toEqual(["cut-1", "cut-2"]);
				expect(narrations.every((entry) => entry.kind === "length-prefix")).toBe(true);
				expect(narrations[0]?.narrationId).not.toBe(narrations[1]?.narrationId);
				const answer = answers[0];
				expect(answer?.truncated).toBe(true);
				if (answer?.submissionRequestId !== undefined) {
					expect(
						await host.resolveSubmissionAnswer(conversationId, answer.submissionRequestId),
					).toMatchObject({ status: "answered", text: "cut-3", truncated: true });
				}
				// The continuation requests still carry the run's original input and the durable
				// continuation instruction, so the boundary did not reset halfway through.
				expect(JSON.stringify(requests[1])).toContain("write a long answer");
				expect(JSON.stringify(requests[1])).toContain(LENGTH_CONTINUATION_PROMPT);
			},
			{
				model,
				onAnswer: (answer) => {
					answers.push(answer);
				},
				onNarration: (narration) => {
					narrations.push(narration);
				},
			},
		);
	});

	test("a completed continuation is delivered as the final answer without truncation", async () => {
		let call = 0;
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://scripted-continue.invalid/v1",
				fetch: (async (_input: string, _init?: RequestInit) => {
					call += 1;
					return call === 1 ? completion("Cut prefix", "length") : completion(" and rest.", "stop");
				}) as typeof fetch,
			},
			[{ maxOutputTokens: 4_096, modelId: "scripted-model" }],
		);
		const narrations: ConversationNarration[] = [];
		const answers: ConversationAnswer[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.updatePolicy(conversationId, withGeneration({ maxLengthContinuations: 1 }));
				await host.append({
					classification: "direct",
					conversationId,
					envelope: conversationEnvelope("continue-run", "finish the sentence"),
					forceSubmit: true,
					submittedAtMs: 1,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
				expect(narrations).toHaveLength(1);
				expect(narrations[0]).toMatchObject({ kind: "length-prefix", text: "Cut prefix" });
				const answer = answers[0];
				expect(answer?.text).toBe("and rest.");
				expect(answer?.truncated).toBeUndefined();
				if (answer?.submissionRequestId !== undefined) {
					expect(
						await host.resolveSubmissionAnswer(conversationId, answer.submissionRequestId),
					).toMatchObject({ status: "answered", text: "and rest." });
				}
			},
			{
				model,
				onAnswer: (answer) => {
					answers.push(answer);
				},
				onNarration: (narration) => {
					narrations.push(narration);
				},
			},
		);
	});
});

describe("Batch 2 acceptance: sampling and request timeout", () => {
	test("retries a timed-out upstream and forwards sampling settings", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		let firstAborted = false;
		let calls = 0;
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://slow-upstream.invalid/v1",
				fetch: (async (_input: string, init?: RequestInit) => {
					calls += 1;
					bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
					if (calls === 1) {
						init?.signal?.addEventListener(
							"abort",
							() => {
								firstAborted = true;
							},
							{ once: true },
						);
						return await new Promise<Response>(() => {});
					}
					return completion("answer after retry", "stop");
				}) as typeof fetch,
			},
			[
				{
					maxOutputTokens: 4_096,
					modelId: "scripted-model",
					requestTimeoutMs: 50,
					stop: ["MODEL-STOP"],
					temperature: 0.2,
					topP: 0.3,
				},
			],
		);
		const answers: ConversationAnswer[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				const generation = {
					...defaultConversationPolicy.generation,
					stop: ["\n\n"],
					temperature: 0.7,
					topP: 0.9,
				};
				await host.updatePolicy(
					conversationId,
					conversationPolicySchema.parse({
						...defaultConversationPolicy,
						generation,
					}),
				);
				await host.append({
					classification: "direct",
					conversationId,
					envelope: conversationEnvelope("timeout-run", "answer after the timeout"),
					forceSubmit: true,
					submittedAtMs: 1,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined), 20_000);
				expect(firstAborted).toBe(true);
				expect(calls).toBe(2);
				expect(answers[0]?.text).toBe("answer after retry");
			},
			{
				model,
				onAnswer: (answer) => {
					answers.push(answer);
				},
			},
		);
		const forwarded = bodies.at(-1);
		expect(forwarded?.temperature).toBe(0.7);
		expect(forwarded?.top_p).toBe(0.9);
		expect(forwarded?.stop).toEqual(["\n\n"]);
	});
});
