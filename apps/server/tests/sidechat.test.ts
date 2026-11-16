import { describe, expect, test } from "bun:test";
import type { BusyArbitrationInput } from "@tsukaima/core";
import { conversationPolicySchema, defaultConversationPolicy } from "@tsukaima/contracts";
import { Logger } from "../src/logging.ts";
import {
	buildSidechatPrompt,
	SidechatService,
	type SidechatModelTarget,
} from "../src/services/sidechat.ts";

const logger = Logger.create({ level: "error", sink: () => undefined });

const policy = (patch: { minConfidence?: number } = {}) =>
	conversationPolicySchema.parse({
		...defaultConversationPolicy,
		sidechat: {
			enabled: true,
			maxHoldMs: 5_000,
			maxInterruptsPerMinute: 3,
			minConfidence: patch.minConfidence ?? 0.6,
			minRunAgeMs: 0,
			timeoutMs: 1_000,
		},
	});

const withSidechatModel = (model: string) => ({
	...policy(),
	sidechat: { ...policy().sidechat, model },
});

const input = (overrides: Partial<BusyArbitrationInput> = {}): BusyArbitrationInput => ({
	conversationId: "42",
	pendingText: "ExampleUser: what changed?",
	policy: policy(),
	runningRequest: "ExampleUser: no\nExampleUser: say this",
	runAgeMs: 5_000,
	toolsActive: false,
	turns: 0,
	...overrides,
});

const activeModel: SidechatModelTarget = { modelId: "active-model", providerId: "primary" };

interface RuntimeOptions {
	readonly active?: SidechatModelTarget | undefined;
	readonly defaultModelId?: string;
	readonly eligible?: readonly SidechatModelTarget[];
	readonly used?: SidechatModelTarget[];
}

const runtime = (response: string, options: RuntimeOptions = {}) => ({
	active: () => ("active" in options ? options.active : activeModel),
	complete: async (target: SidechatModelTarget) => {
		options.used?.push(target);
		return response;
	},
	eligible: async () => options.eligible ?? [],
});

const service = (response: string, options: RuntimeOptions = {}) =>
	new SidechatService({
		defaultModelId: async () => options.defaultModelId,
		logger,
		models: runtime(response, options),
	});

describe("sidechat service", () => {
	test("parses a fenced JSON decision", async () => {
		const result = await service(
			'```json\n{"decision":"interrupt","confidence":0.9,"reason":"unfinished request"}\n```',
		).decide(input());
		expect(result?.decision).toBe("interrupt");
		expect(result?.confidence).toBe(0.9);
	});

	test("downgrades steer when no tool round is active", async () => {
		const result = await service('{"decision":"steer","confidence":0.95}').decide(input());
		expect(result?.decision).toBe("wait");
	});

	test("keeps steer during an active tool round", async () => {
		const result = await service('{"decision":"steer","confidence":0.95}').decide(
			input({ toolsActive: true, turns: 2 }),
		);
		expect(result?.decision).toBe("steer");
	});

	test("returns wait below the confidence threshold", async () => {
		const result = await service('{"decision":"interrupt","confidence":0.2}').decide(
			input({ policy: policy({ minConfidence: 0.6 }) }),
		);
		expect(result?.decision).toBe("wait");
	});

	test("returns undefined for an unusable answer", async () => {
		const result = await service("I think you should interrupt.").decide(input());
		expect(result).toBeUndefined();
	});

	test("uses the plugin-declared model from conversation policy", async () => {
		const used: SidechatModelTarget[] = [];
		const result = await service('{"decision":"interrupt","confidence":0.9}', {
			eligible: [{ modelId: "fast-classifier", providerId: "openai-compatible" }],
			used,
		}).decide(input({ policy: withSidechatModel("fast-classifier") }));
		expect(result?.decision).toBe("interrupt");
		expect(used).toEqual([{ modelId: "fast-classifier", providerId: "openai-compatible" }]);
	});

	test("prefers the active provider for a shared model id", async () => {
		const used: SidechatModelTarget[] = [];
		await service('{"decision":"wait","confidence":0.9}', {
			eligible: [
				{ modelId: "shared", providerId: "secondary" },
				{ modelId: "shared", providerId: "primary" },
			],
			used,
		}).decide(input({ policy: withSidechatModel("shared") }));
		expect(used).toEqual([{ modelId: "shared", providerId: "primary" }]);
	});

	test("falls back to the active model when the plugin no longer declares the model", async () => {
		const used: SidechatModelTarget[] = [];
		await service('{"decision":"wait","confidence":0.9}', { used }).decide(
			input({ policy: withSidechatModel("retired-model") }),
		);
		expect(used).toEqual([activeModel]);
	});

	test("uses the runtime default before the active model", async () => {
		const used: SidechatModelTarget[] = [];
		await service('{"decision":"wait","confidence":0.9}', {
			defaultModelId: "settings-model",
			eligible: [{ modelId: "settings-model", providerId: "openai-compatible" }],
			used,
		}).decide(input());
		expect(used).toEqual([{ modelId: "settings-model", providerId: "openai-compatible" }]);
	});

	test("uses a plugin-declared model when no active model exists", async () => {
		const used: SidechatModelTarget[] = [];
		await service('{"decision":"wait","confidence":0.9}', {
			active: undefined,
			eligible: [{ modelId: "fallback-model", providerId: "openai-compatible" }],
			used,
		}).decide(input());
		expect(used).toEqual([{ modelId: "fallback-model", providerId: "openai-compatible" }]);
	});

	test("builds a bounded prompt with the request and pending batch", () => {
		const prompt = buildSidechatPrompt(
			input({
				pendingText: "ExampleUser: what changed?",
				runningRequest: "ExampleUser: say this",
			}),
		);
		expect(prompt).toContain("ExampleUser: say this");
		expect(prompt).toContain("ExampleUser: what changed?");
		expect(prompt).toContain('"decision":"interrupt|steer|wait"');
	});
});
