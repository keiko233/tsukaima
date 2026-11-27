import { describe, expect, test } from "bun:test";
import {
	createModels,
	createProvider,
	type Api,
	type AssistantMessage,
	type Model,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { createCompositeModelPort, createFakeModel, type ModelPort } from "./model.ts";
import {
	ModelPolicyRouter,
	ModelUsageLedger,
	type ModelCapability,
	type ModelPolicy,
} from "./model-routing.ts";

const stubStream: ProviderStreams["stream"] = () => {
	throw new Error("stream is not exercised in routing tests");
};

function modelEntry(providerId: string, id: string, maxTokens = 4_096): Model<Api> {
	return {
		api: "fake",
		baseUrl: "test://local",
		contextWindow: 128_000,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id,
		input: ["text"],
		maxTokens,
		name: id,
		provider: providerId,
		reasoning: false,
	};
}

function makePort(providerId: string, modelIds: readonly string[]): ModelPort {
	const provider = createProvider({
		api: { stream: stubStream, streamSimple: stubStream },
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
		id: providerId,
		models: modelIds.map((id) => modelEntry(providerId, id)),
	});
	const models = createModels();
	models.setProvider(provider);
	return { modelId: modelIds[0] ?? "", models, providerId };
}

describe("createCompositeModelPort", () => {
	test("merges providers from every port and defaults to the first port", () => {
		const alpha = makePort("alpha", ["alpha-1", "alpha-2"]);
		const beta = makePort("beta", ["beta-1"]);

		const composite = createCompositeModelPort([alpha, beta]);

		expect(composite.models.getProviders().map((provider) => provider.id)).toEqual([
			"alpha",
			"beta",
		]);
		expect(composite.models.getModels("beta").map((model) => model.id)).toEqual(["beta-1"]);
		expect(composite.providerId).toBe("alpha");
		expect(composite.modelId).toBe("alpha-1");
	});

	test("selects the preferred provider and model when registered", () => {
		const alpha = makePort("alpha", ["alpha-1", "alpha-2"]);
		const beta = makePort("beta", ["beta-1"]);

		const composite = createCompositeModelPort([alpha, beta], {
			modelId: "beta-1",
			providerId: "beta",
		});

		expect(composite.providerId).toBe("beta");
		expect(composite.modelId).toBe("beta-1");
	});

	test("falls back to the preferred provider's first model when the model is missing", () => {
		const alpha = makePort("alpha", ["alpha-1", "alpha-2"]);

		const withoutModelId = createCompositeModelPort([alpha], { providerId: "alpha" });
		expect(withoutModelId.providerId).toBe("alpha");
		expect(withoutModelId.modelId).toBe("alpha-1");

		const missingModel = createCompositeModelPort([alpha], {
			modelId: "missing",
			providerId: "alpha",
		});
		expect(missingModel.providerId).toBe("alpha");
		expect(missingModel.modelId).toBe("alpha-1");
	});

	test("falls back to the first non-fake port", () => {
		const fake = createFakeModel();
		const beta = makePort("beta", ["beta-1"]);

		const composite = createCompositeModelPort([fake, beta]);

		expect(composite.providerId).toBe("beta");
		expect(composite.modelId).toBe("beta-1");
		expect(composite.models.getProviders().map((provider) => provider.id)).toContain("fake");
	});

	test("skips duplicate provider ids without crashing", () => {
		const first = makePort("dupe", ["dupe-a"]);
		const second = makePort("dupe", ["dupe-b"]);

		const composite = createCompositeModelPort([first, second]);

		expect(composite.models.getProviders().map((provider) => provider.id)).toEqual(["dupe"]);
		expect(composite.models.getModels("dupe").map((model) => model.id)).toEqual(["dupe-a"]);
		expect(composite.modelId).toBe("dupe-a");
	});

	test("falls back to a fake model when no ports are supplied", () => {
		const composite = createCompositeModelPort([]);

		expect(composite.providerId).toBe("fake");
		expect(composite.modelId).toBe("fake-deterministic");
		expect(composite.models.getProviders()).toHaveLength(1);
	});
});

describe("ModelPolicyRouter", () => {
	const models: readonly Model<Api>[] = [
		modelEntry("test-provider", "chat-small", 2_048),
		modelEntry("test-provider", "tool-medium", 4_096),
		modelEntry("test-provider", "code-large", 16_384),
	];
	const router = new ModelPolicyRouter(models);
	const basicChatPolicy: ModelPolicy = {
		capability: "basic-chat" satisfies ModelCapability,
		maxOutputTokens: 1_024,
		primary: { modelId: "chat-small", providerId: "test-provider" },
	};
	const policies: readonly ModelPolicy[] = [
		basicChatPolicy,
		{
			capability: "tool-use" satisfies ModelCapability,
			fallbacks: [{ modelId: "code-large", providerId: "test-provider" }],
			primary: { modelId: "missing", providerId: "test-provider" },
		},
	];

	test("selects a model and clamps the output limit to the policy", () => {
		const routed = router.select({ capability: "basic-chat", policies });

		expect(routed.model.id).toBe("chat-small");
		expect(routed.maxOutputTokens).toBe(1_024);
		expect(routed.policy).toBe(basicChatPolicy);
	});

	test("uses fallbacks and reports missing capabilities", () => {
		const routed = router.select({ capability: "tool-use", policies });
		expect(routed.model.id).toBe("code-large");

		expect(() => router.select({ capability: "vision", policies })).toThrow(
			"No model policy for capability: vision",
		);
	});
});

describe("ModelUsageLedger", () => {
	const message: AssistantMessage = {
		api: "fake",
		content: [{ text: "ok", type: "text" }],
		model: "test-model",
		provider: "test-provider",
		role: "assistant",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			cacheRead: 5,
			cacheWrite: 1,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 19,
			output: 11,
			totalTokens: 36,
		},
	};

	test("records routed usage and aggregates totals", () => {
		const ledger = new ModelUsageLedger();

		const record = ledger.record(message, "basic-chat");
		ledger.record(message, "tool-use");

		expect(record).toEqual({
			capability: "basic-chat",
			inputTokens: 25,
			modelId: "test-model",
			outputTokens: 11,
			providerId: "test-provider",
		});
		expect(ledger.records).toHaveLength(2);
		expect(ledger.totals).toEqual({ inputTokens: 50, outputTokens: 22 });
	});
});
