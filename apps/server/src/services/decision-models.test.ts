import { expect, test } from "bun:test";
import { defaultConversationPolicy } from "@tsukaima/contracts";
import { MODEL_CAPABILITIES, type PluginDecisionChoiceRequest } from "@tsukaima/sdk";
import { createLogger } from "../logging.ts";
import { ConversationGateService } from "./conversation-gate.ts";
import { createNativeDecisionProviders, NativeDecisionModels } from "./decision-models.ts";
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

test("native decision providers expose standard configured descriptors", async () => {
	const providers = createNativeDecisionProviders({
		GEMINI_API_KEY: "",
		TYPESAFE_API_KEY: "fixture-only",
	});
	const gemini = providers[0]!;
	const typesafe = providers[1]!;
	expect(providers.map((provider) => provider.id)).toEqual([
		"gemini-decision",
		"typesafe-decision",
	]);
	expect(await gemini.isConfigured?.()).toBe(false);
	expect(await typesafe.isConfigured?.()).toBe(true);
	expect(await gemini.listModels?.()).toEqual([]);
	expect(await typesafe.listModels?.()).toEqual([
		{
			capabilities: [MODEL_CAPABILITIES.decisionChoice, MODEL_CAPABILITIES.sidechat],
			id: "jev-latest",
			input: ["text"],
			name: "Jev",
			output: ["text"],
		},
	]);
	expect(() => gemini.createPort()).toThrow(
		"Native decision providers do not support chat completion ports",
	);
	expect(() => typesafe.createPort()).toThrow(
		"Native decision providers do not support chat completion ports",
	);
});

test("native Gemini decision provider delegates to the Decisions API", async () => {
	const gemini = createNativeDecisionProviders(
		{ GEMINI_API_KEY: "fixture-only" },
		async (url, init) => {
			expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/decisions");
			expect(new Headers(init.headers).get("x-goog-api-key")).toBe("fixture-only");
			expect(JSON.parse(String(init.body))).toMatchObject({
				model: "gemini-decision-1",
				questions: {
					routing: {
						criteria: { REPLY: expect.any(String), SKIP: expect.any(String) },
						type: "choice",
					},
				},
			});
			return answer("SKIP");
		},
	)[0]!;
	expect(
		await gemini.decideChoice!({
			context: "synthetic context",
			instructions: "choose",
			options: { REPLY: "reply", SKIP: "skip" },
			maxTokens: 512,
		}),
	).toEqual({
		choice: "SKIP",
		confidence: 0.95,
		modelId: "gemini-decision-1",
		providerId: "gemini-decision",
	});
});

test("native TypeSafe decision provider delegates to System One", async () => {
	const typesafe = createNativeDecisionProviders(
		{ TYPESAFE_API_KEY: "fixture-only" },
		async (url, init) => {
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-only");
			expect(JSON.parse(String(init.body))).toMatchObject({
				model: "jev-latest",
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
				state: "synthetic context",
			});
			return answer("steer");
		},
	)[1]!;
	expect(
		await typesafe.decideChoice!({
			context: "synthetic context",
			instructions: "choose",
			modelId: "jev-latest",
			options: { interrupt: "stop", steer: "adjust", wait: "finish" },
		}),
	).toEqual({
		choice: "steer",
		confidence: 0.95,
		modelId: "jev-latest",
		providerId: "typesafe-decision",
	});
});

test("conversation gate routes provider:model targets through decideChoice", async () => {
	const calls: PluginDecisionChoiceRequest[] = [];
	let completions = 0;
	const gate = new ConversationGateService({
		defaultModelId: async () => "decision-provider:picker-1",
		logger,
		models: {
			active: () => undefined,
			complete: async () => {
				completions += 1;
				return '{"decision":"REPLY","confidence":0.9}';
			},
			decideChoice: async (request) => {
				calls.push(request);
				return {
					choice: "SKIP",
					confidence: 0.87,
					modelId: request.modelId ?? "picker-1",
					providerId: request.providerId ?? "decision-provider",
				};
			},
			eligible: async () => [{ modelId: "picker-1", providerId: "decision-provider" }],
		},
	});
	expect(await gate.decideUndirectedGroupReply(gateInput)).toMatchObject({
		confidence: 0.87,
		decision: "SKIP",
		modelId: "picker-1",
		source: "gate",
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({
		maxTokens: 512,
		modelId: "picker-1",
		options: { REPLY: expect.any(String), SKIP: expect.any(String) },
		providerId: "decision-provider",
	});
	expect(completions).toBe(0);
});

test("sidechat routes provider:model targets through decideChoice", async () => {
	const calls: PluginDecisionChoiceRequest[] = [];
	let completions = 0;
	const sidechat = new SidechatService({
		defaultModelId: async () => "decision-provider-b:picker-1",
		logger,
		models: {
			active: () => ({ modelId: "picker-1", providerId: "decision-provider-a" }),
			complete: async () => {
				completions += 1;
				return '{"decision":"wait","confidence":0.9}';
			},
			decideChoice: async (request) => {
				calls.push(request);
				return {
					choice: "steer",
					confidence: 0.9,
					modelId: request.modelId ?? "picker-1",
					providerId: request.providerId ?? "decision-provider-b",
				};
			},
			eligible: async () => [
				{ modelId: "picker-1", providerId: "decision-provider-a" },
				{ modelId: "picker-1", providerId: "decision-provider-b" },
			],
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
			toolsActive: true,
			turns: 1,
		}),
	).toMatchObject({ confidence: 0.9, decision: "steer" });
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({
		modelId: "picker-1",
		options: {
			interrupt: expect.any(String),
			steer: expect.any(String),
			wait: expect.any(String),
		},
		providerId: "decision-provider-b",
	});
	expect(calls[0]?.maxTokens).toBe(512);
	expect(completions).toBe(0);
});

test("conversation gate stays unconfigured without an active or eligible model", async () => {
	let decideCalls = 0;
	const gate = new ConversationGateService({
		defaultModelId: async () => "decision-provider:picker-1",
		logger,
		models: {
			active: () => undefined,
			complete: async () => {
				throw new Error("unexpected chat completion");
			},
			decideChoice: async () => {
				decideCalls += 1;
				throw new Error("unexpected decision choice");
			},
			eligible: async () => [],
		},
	});
	expect(await gate.decideUndirectedGroupReply(gateInput)).toMatchObject({
		decision: "REPLY",
		reason: "unconfigured",
		source: "fallback",
	});
	expect(decideCalls).toBe(0);
});
