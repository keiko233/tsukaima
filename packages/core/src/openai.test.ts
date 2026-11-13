import { describe, expect, mock, test, type Mock } from "bun:test";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Context,
	type FetchFunction,
	type Model,
	type Tool,
} from "@earendil-works/pi-ai";
import {
	createOpenAICompatibleStreams,
	type ModelCapability,
	ModelPolicyRouter,
	ModelUsageLedger,
	type ModelPolicy,
	type OpenAICompatibleModelConfig,
	type RoutedModel,
} from "./openai.ts";

const tool: Tool = {
	description: "Read a file",
	name: "read_file",
	parameters: {
		properties: { path: { type: "string" } },
		required: ["path"],
		type: "object",
	},
};

type TestModel = Model<Api> & { readonly id: string; readonly maxTokens: number };

const model: TestModel = {
	api: "openai-compatible",
	baseUrl: "https://model.example/v1",
	contextWindow: 128_000,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
	id: "test-model",
	input: ["text"],
	maxTokens: 4_096,
	name: "Test model",
	provider: "test-provider",
	reasoning: false,
};

type FetchMock = Mock<FetchFunction>;

function textResponse(overrides: Record<string, unknown> = {}): Response {
	return Response.json({
		choices: [{ finish_reason: "stop", message: { content: "Hello, Tsukaima." } }],
		id: "response-1",
		model: "remote-model",
		usage: { completion_tokens: 11, prompt_tokens: 19 },
		...overrides,
	});
}

function collectStream(stream: ReturnType<typeof createOpenAICompatibleStreams>["stream"]) {
	return stream(
		model,
		normalizeContext({ messages: [{ content: "hi", role: "user", timestamp: 1 }] }),
	);
}

async function expectErrorStream(
	stream: ReturnType<typeof createOpenAICompatibleStreams>["stream"],
) {
	const events = [];
	for await (const event of collectStream(stream)) events.push(event);
	return events;
}

describe("OpenAI-compatible provider", () => {
	test("parses a basic chat response and streams it", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1/",
			fetch: fetch as unknown as FetchFunction,
		});
		const events = [];
		for await (const event of collectStream(streams.stream)) events.push(event);

		const [url, request] = fetch.mock.calls[0] as [string, RequestInit];
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(url).toBe("https://model.example/v1/chat/completions");
		expect(request.method).toBe("POST");
		expect((request.headers as Record<string, string>).authorization).toBe("Bearer test-key");
		expect(JSON.parse(request.body as string)).toEqual({
			max_completion_tokens: 4_096,
			messages: [{ content: "hi", role: "user" }],
			model: "test-model",
		});
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(events.at(-1)).toMatchObject({
			message: {
				content: [{ text: "Hello, Tsukaima.", type: "text" }],
				model: "test-model",
				provider: "test-provider",
				responseId: "response-1",
				responseModel: "remote-model",
				rawStopReason: "stop",
				stopReason: "stop",
			},
			reason: "stop",
		});
	});

	test("parses tool calls and requests declared tools", async () => {
		const fetch = mock(async () =>
			textResponse({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							content: null,
							tool_calls: [
								{
									function: { arguments: '{"path":"/tmp/tsukaima.txt"}', name: "read_file" },
									id: "call-1",
									type: "function",
								},
							],
						},
					},
				],
			}),
		) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const context = normalizeContext({
			messages: [{ content: "read it", role: "user", timestamp: 1 }],
			tools: [tool],
		} satisfies Context);
		const events = [];
		for await (const event of streams.stream(model, context)) events.push(event);

		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(request.body as string).tools).toEqual([
			{
				function: {
					description: tool.description,
					name: tool.name,
					parameters: tool.parameters,
				},
				type: "function",
			},
		]);
		expect(events.at(-1)).toMatchObject({
			message: {
				content: [
					{
						arguments: { path: "/tmp/tsukaima.txt" },
						id: "call-1",
						name: "read_file",
						type: "toolCall",
					},
				],
				stopReason: "toolUse",
			},
			reason: "toolUse",
		});
	});

	test("preserves HTTP and transport errors as assistant error messages", async () => {
		const fetch = mock()
			.mockImplementationOnce(async () =>
				Response.json({ error: { message: "quota exceeded" } }, { status: 429 }),
			)
			.mockImplementationOnce(async () => {
				throw new TypeError("network down");
			}) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const httpEvents = await expectErrorStream(streams.stream);
		const transportEvents = await expectErrorStream(streams.stream);

		expect(httpEvents).toHaveLength(1);
		expect(httpEvents[0]).toMatchObject({
			error: {
				errorMessage: "OpenAI-compatible request failed (429): quota exceeded",
				stopReason: "error",
			},
			reason: "error",
		});
		expect(transportEvents).toHaveLength(1);
		expect(transportEvents[0]).toMatchObject({
			error: { errorMessage: "OpenAI-compatible request failed: network down" },
			reason: "error",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	test("sends reasoning effort and preserves reasoning content", async () => {
		const fetch = mock(async () =>
			textResponse({
				choices: [
					{
						finish_reason: "stop",
						message: {
							content: "Final answer",
							reasoning_content: "Considered the options.",
						},
					},
				],
				usage: {
					completion_tokens: 14,
					completion_tokens_details: { reasoning_tokens: 4 },
					prompt_tokens: 19,
				},
			}),
		) as unknown as FetchMock;
		const reasoningModel: TestModel = {
			...model,
			reasoning: true,
		};
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[
				{
					defaultReasoningLevel: "high",
					modelId: reasoningModel.id,
					reasoningLevels: ["low", "medium", "high"],
					supportsReasoning: true,
				},
			],
		);
		const events = [];
		for await (const event of streams.stream(
			reasoningModel,
			normalizeContext({ messages: [{ content: "think", role: "user", timestamp: 1 }] }),
		)) {
			events.push(event);
		}

		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		expect(JSON.parse(request.body as string).reasoning_effort).toBe("high");
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(events.at(-1)).toMatchObject({
			message: {
				content: [
					{ thinking: "Considered the options.", type: "thinking" },
					{ text: "Final answer", type: "text" },
				],
				usage: { reasoning: 4 },
			},
		});
	});

	test("supports image input and omits tools when the model declares no tool use", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[{ inputModalities: ["text", "image"], modelId: model.id, supportsTools: false }],
		);
		const context = normalizeContext({
			messages: [
				{
					content: [
						{ text: "What is this?", type: "text" },
						{ data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
					],
					role: "user",
					timestamp: 1,
				},
			],
			tools: [tool],
		} satisfies Context);
		for await (const event of streams.stream(model, context)) {
			void event;
		}

		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(request.body as string);
		expect(body.tools).toBeUndefined();
		expect(body.messages).toEqual([
			{
				content: [
					{ text: "What is this?", type: "text" },
					{
						image_url: { url: "data:image/png;base64,aW1hZ2U=" },
						type: "image_url",
					},
				],
				role: "user",
			},
		]);
	});

	test("accounts for input, output, cache-read, and routed usage", () => {
		const ledger = new ModelUsageLedger();
		const message: AssistantMessage = {
			api: "openai-compatible",
			content: [],
			model: "test-model",
			provider: "test-provider",
			role: "assistant",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				cacheRead: 5,
				cacheWrite: 1,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
				input: 19,
				output: 11,
				totalTokens: 36,
			},
		};
		const record = ledger.record(message, "basic-chat");

		expect(record).toEqual({
			capability: "basic-chat",
			inputTokens: 25,
			modelId: "test-model",
			outputTokens: 11,
			providerId: "test-provider",
		});
		expect(ledger.totals).toEqual({ inputTokens: 25, outputTokens: 11 });
		expect(ledger.records).toHaveLength(1);
	});
});

describe("Model policy router", () => {
	const modelConfigs: readonly OpenAICompatibleModelConfig[] = [
		{ modelId: "chat-small", maxOutputTokens: 2_048 },
		{ modelId: "tool-medium", maxOutputTokens: 4_096 },
		{ modelId: "code-large", maxOutputTokens: 16_384 },
	];
	const policies: readonly ModelPolicy[] = [
		{
			capability: "basic-chat" satisfies ModelCapability,
			maxOutputTokens: 1_024,
			primary: { modelId: "chat-small", providerId: "test-provider" },
		},
		{
			capability: "tool-use" satisfies ModelCapability,
			fallbacks: [{ modelId: "code-large", providerId: "test-provider" }],
			primary: { modelId: "tool-medium", providerId: "test-provider" },
		},
		{
			capability: "coding" satisfies ModelCapability,
			primary: { modelId: "code-large", providerId: "test-provider" },
		},
	];
	const router = new ModelPolicyRouter(
		modelConfigs.map((config) => ({
			...model,
			id: config.modelId,
			maxTokens: config.maxOutputTokens ?? model.maxTokens,
		})),
	);

	function selected(capability: ModelCapability): RoutedModel {
		return router.select({ capability, policies });
	}

	test("selects policies by basic-chat, tool-use, and coding capability", () => {
		expect(selected("basic-chat")).toMatchObject({ maxOutputTokens: 1_024, policy: policies[0] });
		expect(selected("basic-chat").model.id).toBe("chat-small");
		expect(selected("tool-use")).toMatchObject({ maxOutputTokens: 4_096, policy: policies[1] });
		expect(selected("tool-use").model.id).toBe("tool-medium");
		expect(selected("coding").model.id).toBe("code-large");
	});

	test("uses fallbacks and reports unavailable capabilities", () => {
		const withoutPrimary = router.select({
			capability: "tool-use",
			policies: [
				{
					capability: "tool-use",
					fallbacks: [{ modelId: "code-large", providerId: "test-provider" }],
					primary: { modelId: "missing", providerId: "test-provider" },
				},
			],
		});
		expect(withoutPrimary.model.id).toBe("code-large");
		expect(() => router.select({ capability: "vision" })).toThrow(
			"No model policy for capability: vision",
		);
	});
});
