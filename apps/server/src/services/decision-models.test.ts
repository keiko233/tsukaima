import { expect, test } from "bun:test";
import { defaultConversationPolicy } from "@tsukaima/contracts";
import { createLogger } from "../logging.ts";
import { ConversationGateService } from "./conversation-gate.ts";
import { NativeDecisionModels } from "./decision-models.ts";
import { SidechatService } from "./sidechat.ts";

const logger = createLogger({ level: "error" });
const gateInput = {
	conversationId: "synthetic-group",
	messageText: "A synthetic status update",
	policy: { ...defaultConversationPolicy.gate, enabled: true },
	senderName: "Example",
};

const answer = (choice: string) =>
	Response.json({ answers: { routing: { choice, confidence: 0.95, type: "choice" } } });

test("Gemini uses the native Decisions API for the group reply gate", async () => {
	let calls = 0;
	const models = new NativeDecisionModels({ GEMINI_API_KEY: "fixture-only" }, async (url, init) => {
		calls += 1;
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
		expect(new Headers(init.headers).get("x-goog-api-key")).toBe("fixture-only");
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			model: "gemini-decision-1",
			questions: {
				routing: {
					criteria: { REPLY: expect.any(String), SKIP: expect.any(String) },
					type: "choice",
				},
			},
		});
		expect(body.input.includes(gateInput.messageText)).toBe(true);
		expect(body.input.includes("Return only JSON")).toBe(false);
		return answer("SKIP");
	});
	const gate = new ConversationGateService({
		decisionModels: models,
		defaultModelId: async () => "gemini-decision-1",
		logger,
	});
	expect(await gate.decideUndirectedGroupReply(gateInput)).toMatchObject({
		confidence: 0.95,
		decision: "SKIP",
		modelId: "gemini-decision-1",
		source: "gate",
	});
	expect(calls).toBe(1);
});

test("Jev uses System One for Sidechat and applies its existing arbitration guard", async () => {
	let calls = 0;
	const models = new NativeDecisionModels(
		{ TYPESAFE_API_KEY: "fixture-only" },
		async (url, init) => {
			calls += 1;
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-only");
			expect(JSON.parse(String(init.body))).toMatchObject({
				model: "jev-1.14.0",
				questions: {
					routing: {
						criteria: {
							interrupt: expect.any(String),
							steer: expect.any(String),
							wait: expect.any(String),
						},
						type: "choice",
					},
				},
				state: expect.stringContaining("Use the other option"),
			});
			return answer("steer");
		},
	);
	const sidechat = new SidechatService({
		decisionModels: models,
		defaultModelId: async () => "jev-1.14.0",
		logger,
		models: {
			active: () => undefined,
			complete: async () => {
				throw new Error("unexpected chat completion");
			},
			eligible: async () => [],
		},
	});
	expect(
		await sidechat.decide({
			conversationId: "synthetic-group",
			pendingText: "Use the other option",
			policy: {
				...defaultConversationPolicy,
				sidechat: { ...defaultConversationPolicy.sidechat, enabled: true },
			},
			runAgeMs: 3_000,
			runningRequest: "Compare two synthetic options",
			toolsActive: false,
			turns: 0,
		}),
	).toMatchObject({ decision: "wait", reason: "no active tool round" });
	expect(calls).toBe(1);
});

test("a malformed native result preserves the group gate fail-open behavior", async () => {
	const gate = new ConversationGateService({
		decisionModels: new NativeDecisionModels({ GEMINI_API_KEY: "fixture-only" }, async () =>
			answer("UNKNOWN"),
		),
		defaultModelId: async () => "gemini-decision-1",
		logger,
	});
	expect(await gate.decideUndirectedGroupReply(gateInput)).toMatchObject({
		decision: "REPLY",
		source: "fallback",
	});
});

test("chat-completion gate and sidechat request minimal reasoning and sufficient token budget", async () => {
	const gateCalls: { maxTokens: number; reasoning?: string }[] = [];
	const gate = new ConversationGateService({
		defaultModelId: async () => "reasoning-model",
		logger,
		models: {
			active: () => ({ modelId: "reasoning-model", providerId: "openai-compatible" }),
			complete: async (_target, _prompt, options) => {
				gateCalls.push({
					maxTokens: options.maxTokens,
					...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
				});
				return '{"decision":"REPLY","confidence":0.9,"reason":"direct question"}';
			},
			eligible: async () => [{ modelId: "reasoning-model", providerId: "openai-compatible" }],
		},
	});
	expect(await gate.decideUndirectedGroupReply(gateInput)).toMatchObject({
		decision: "REPLY",
		modelId: "reasoning-model",
		source: "gate",
	});
	expect(gateCalls).toEqual([{ maxTokens: 512, reasoning: "minimal" }]);

	const sidechatCalls: { maxTokens: number; reasoning?: string }[] = [];
	const sidechat = new SidechatService({
		defaultModelId: async () => "reasoning-model",
		logger,
		models: {
			active: () => ({ modelId: "reasoning-model", providerId: "openai-compatible" }),
			complete: async (_target, _prompt, options) => {
				sidechatCalls.push({
					maxTokens: options.maxTokens,
					...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
				});
				return '{"decision":"wait","confidence":0.9,"reason":"let current run finish"}';
			},
			eligible: async () => [{ modelId: "reasoning-model", providerId: "openai-compatible" }],
		},
	});
	expect(
		await sidechat.decide({
			conversationId: "synthetic-group",
			pendingText: "Follow up",
			policy: {
				...defaultConversationPolicy,
				sidechat: { ...defaultConversationPolicy.sidechat, enabled: true },
			},
			runAgeMs: 2_000,
			runningRequest: "Answer a synthetic question",
			toolsActive: false,
			turns: 0,
		}),
	).toMatchObject({ decision: "wait" });
	expect(sidechatCalls).toEqual([{ maxTokens: 512, reasoning: "minimal" }]);
});
