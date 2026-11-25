import { describe, expect, mock, test, type Mock } from "bun:test";
import {
	normalizeContext,
	type Api,
	type AssistantMessage,
	type Context,
	type FetchFunction,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import {
	createOpenAICompatibleStreams,
	OpenAIRequestTimeoutError,
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

function sseData(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
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
			stream: true,
			stream_options: { include_usage: true },
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

	test("streams SSE deltas while the response is still arriving", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				controller = streamController;
			},
		});
		const fetch = mock(
			async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const output = collectStream(streams.stream);
		const iterator = output[Symbol.asyncIterator]();

		// `start` arrives after the response headers, before the first token: the WebUI can show
		// that the request is in flight instead of waiting for the complete body.
		expect((await iterator.next()).value).toMatchObject({ type: "start" });

		controller.enqueue(
			encoder.encode(sseData({ choices: [{ delta: { reasoning_content: "Think" } }] })),
		);
		expect((await iterator.next()).value).toMatchObject({ type: "thinking_start" });
		expect((await iterator.next()).value).toMatchObject({
			delta: "Think",
			type: "thinking_delta",
		});

		controller.enqueue(encoder.encode(sseData({ choices: [{ delta: { content: "Hello" } }] })));
		expect((await iterator.next()).value).toMatchObject({ type: "thinking_end" });
		expect((await iterator.next()).value).toMatchObject({ type: "text_start" });
		expect((await iterator.next()).value).toMatchObject({
			delta: "Hello",
			type: "text_delta",
		});

		controller.enqueue(
			encoder.encode(
				sseData({
					choices: [
						{
							delta: {
								tool_calls: [
									{
										function: { arguments: '{"path":', name: "read_file" },
										id: "call-1",
										index: 0,
										type: "function",
									},
								],
							},
						},
					],
				}),
			),
		);
		expect((await iterator.next()).value).toMatchObject({ type: "text_end" });
		expect((await iterator.next()).value).toMatchObject({ type: "toolcall_start" });
		expect((await iterator.next()).value).toMatchObject({
			delta: '{"path":',
			type: "toolcall_delta",
		});

		controller.enqueue(
			encoder.encode(
				sseData({
					choices: [
						{
							delta: {
								tool_calls: [{ function: { arguments: '"/tmp/file"}' }, index: 0 }],
							},
						},
					],
				}),
			),
		);
		expect((await iterator.next()).value).toMatchObject({
			delta: '"/tmp/file"}',
			type: "toolcall_delta",
		});

		controller.enqueue(
			encoder.encode(
				sseData({
					choices: [{ delta: {}, finish_reason: "tool_calls" }],
					id: "response-2",
					model: "remote-model",
					usage: { completion_tokens: 7, prompt_tokens: 11 },
				}),
			),
		);
		controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		controller.close();

		expect((await iterator.next()).value).toMatchObject({
			toolCall: {
				arguments: { path: "/tmp/file" },
				id: "call-1",
				name: "read_file",
			},
			type: "toolcall_end",
		});
		const done = await iterator.next();
		expect(done.value).toMatchObject({
			message: {
				content: [
					{ thinking: "Think", type: "thinking" },
					{ text: "Hello", type: "text" },
					{
						arguments: { path: "/tmp/file" },
						id: "call-1",
						name: "read_file",
						type: "toolCall",
					},
				],
				responseId: "response-2",
				responseModel: "remote-model",
				stopReason: "toolUse",
				usage: { input: 11, output: 7 },
			},
			reason: "toolUse",
			type: "done",
		});
		expect((await iterator.next()).done).toBe(true);
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
					prompt_tokens_details: { cached_tokens: 12 },
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
				usage: { cacheRead: 12, input: 7, output: 14, reasoning: 4, totalTokens: 33 },
			},
		});

		for await (const event of streams.stream(
			reasoningModel,
			normalizeContext({ messages: [{ content: "quick", role: "user", timestamp: 2 }] }),
			{ reasoning: "minimal" } as SimpleStreamOptions,
		)) {
			void event;
		}
		const clampedRequest = (fetch.mock.calls[1] as [string, RequestInit])[1];
		expect(JSON.parse(clampedRequest.body as string).reasoning_effort).toBe("low");
	});

	test("never upscales low-budget reasoning requests into high effort and clamps by rank", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[
				{
					defaultReasoningLevel: "medium",
					modelId: "high-only-model",
					reasoningLevels: ["high"],
					supportsReasoning: true,
				},
				{
					defaultReasoningLevel: "high",
					modelId: "unsorted-levels-model",
					reasoningLevels: ["high", "low"],
					supportsReasoning: true,
				},
				{
					defaultReasoningLevel: "low",
					modelId: "capped-medium-model",
					reasoningLevels: ["low", "medium"],
					supportsReasoning: true,
				},
			],
		);
		const context = normalizeContext({
			messages: [{ content: "quick", role: "user", timestamp: 1 }],
		});

		for await (const event of streams.stream(
			{ ...model, id: "high-only-model", reasoning: true },
			context,
			{ reasoning: "minimal" } as SimpleStreamOptions,
		)) {
			void event;
		}
		for await (const event of streams.stream(
			{ ...model, id: "unsorted-levels-model", reasoning: true },
			context,
			{ reasoning: "minimal" } as SimpleStreamOptions,
		)) {
			void event;
		}
		for await (const event of streams.stream(
			{ ...model, id: "capped-medium-model", reasoning: true },
			context,
			{ reasoning: "high" } as SimpleStreamOptions,
		)) {
			void event;
		}

		const highOnlyBody = JSON.parse(
			(fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		const unsortedBody = JSON.parse(
			(fetch.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		const cappedBody = JSON.parse((fetch.mock.calls[2] as [string, RequestInit])[1].body as string);
		expect(highOnlyBody.reasoning_effort).toBeUndefined();
		expect(unsortedBody.reasoning_effort).toBe("low");
		expect(cappedBody.reasoning_effort).toBe("medium");
	});

	test("preserves reasoning_content on current-turn tool-call rounds and omits it on earlier turns", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const context = normalizeContext({
			messages: [
				{ content: "first question", role: "user", timestamp: 1 },
				{
					api: "openai-compatible",
					content: [
						{ thinking: "old turn reasoning", type: "thinking" },
						{ text: "first answer", type: "text" },
					],
					model: model.id,
					provider: model.provider,
					role: "assistant",
					stopReason: "stop",
					timestamp: 2,
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
						input: 1,
						output: 1,
						totalTokens: 2,
					},
				},
				{ content: "second question", role: "user", timestamp: 3 },
				{
					api: "openai-compatible",
					content: [
						{ thinking: "current turn tool reasoning", type: "thinking" },
						{ arguments: { path: "/tmp/a" }, id: "call-1", name: "read_file", type: "toolCall" },
					],
					model: model.id,
					provider: model.provider,
					role: "assistant",
					stopReason: "toolUse",
					timestamp: 4,
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
						input: 1,
						output: 1,
						totalTokens: 2,
					},
				},
				{
					content: [{ text: "file contents", type: "text" }],
					isError: false,
					role: "toolResult",
					timestamp: 5,
					toolCallId: "call-1",
					toolName: "read_file",
				},
			],
		} satisfies Context);
		const events = [];
		for await (const event of streams.stream(model, context)) events.push(event);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		const sent = JSON.parse(request.body as string).messages as {
			role: string;
			reasoning_content?: string;
		}[];
		const assistants = sent.filter((entry) => entry.role === "assistant");
		expect(assistants).toHaveLength(2);
		expect(assistants[0]?.reasoning_content).toBeUndefined();
		expect(assistants[1]?.reasoning_content).toBe("current turn tool reasoning");
	});

	test("splits inline <think> tags across SSE chunks into thinking blocks while keeping fenced code intact", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			sseData({ choices: [{ delta: { content: "<thi" } }] }),
			sseData({ choices: [{ delta: { content: "nk:abc>internal " } }] }),
			sseData({ choices: [{ delta: { content: "plan</thi" } }] }),
			sseData({
				choices: [{ delta: { content: "nk:abc>Answer\n```xml\n<think>demo</think>\n```" } }],
			}),
			sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const fetch = mock(
			async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const events = [];
		for await (const event of collectStream(streams.stream)) events.push(event);
		expect(events.at(-1)).toMatchObject({
			message: {
				content: [
					{ thinking: "internal plan", type: "thinking" },
					{ text: "Answer\n```xml\n<think>demo</think>\n```", type: "text" },
				],
			},
			type: "done",
		});
	});

	test("extracts reasoning when reasoning_content is empty and reasoning or reasoning_details is populated", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			sseData({ choices: [{ delta: { reasoning: "step 1 ", reasoning_content: "" } }] }),
			sseData({
				choices: [{ delta: { reasoning_details: [{ text: "step 2" }] } }],
			}),
			sseData({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const fetch = mock(
			async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
		) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const events = [];
		for await (const event of collectStream(streams.stream)) events.push(event);
		expect(events.at(-1)).toMatchObject({
			message: {
				content: [
					{ thinking: "step 1 step 2", type: "thinking" },
					{ text: "done", type: "text" },
				],
			},
			type: "done",
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

	test("replays tool-result images to vision models after the contiguous tool run", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const visionModel: TestModel = { ...model, input: ["text", "image"] };
		const context = normalizeContext({
			messages: [
				{ content: "inspect the sticker", role: "user", timestamp: 1 },
				{
					api: "openai-compatible",
					content: [
						{
							arguments: { itemId: "sticker-1" },
							id: "call-view",
							name: "sticker-meme.view",
							type: "toolCall",
						},
						{
							arguments: { path: "/tmp/a" },
							id: "call-read",
							name: "read_file",
							type: "toolCall",
						},
					],
					model: model.id,
					provider: model.provider,
					role: "assistant",
					stopReason: "toolUse",
					timestamp: 2,
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
						input: 1,
						output: 1,
						totalTokens: 2,
					},
				},
				{
					content: [
						{ text: '{"itemId":"sticker-1"}', type: "text" },
						{ data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
					],
					isError: false,
					role: "toolResult",
					timestamp: 3,
					toolCallId: "call-view",
					toolName: "sticker-meme.view",
				},
				{
					content: [{ text: "file contents", type: "text" }],
					isError: false,
					role: "toolResult",
					timestamp: 4,
					toolCallId: "call-read",
					toolName: "read_file",
				},
			],
		} satisfies Context);
		for await (const event of streams.stream(visionModel, context)) void event;

		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		const sent = JSON.parse(request.body as string).messages;
		expect(sent).toEqual([
			{ content: "inspect the sticker", role: "user" },
			{
				content: null,
				role: "assistant",
				tool_calls: [
					{
						function: {
							arguments: '{"itemId":"sticker-1"}',
							name: "sticker-meme.view",
						},
						id: "call-view",
						type: "function",
					},
					{
						function: { arguments: '{"path":"/tmp/a"}', name: "read_file" },
						id: "call-read",
						type: "function",
					},
				],
			},
			{ content: '{"itemId":"sticker-1"}', role: "tool", tool_call_id: "call-view" },
			{ content: "file contents", role: "tool", tool_call_id: "call-read" },
			{
				content: [
					{ text: "Image returned by sticker-meme.view.", type: "text" },
					{
						image_url: { url: "data:image/png;base64,aW1hZ2U=" },
						type: "image_url",
					},
				],
				role: "user",
			},
		]);
	});

	test("keeps tool-result images out of text-only model requests", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams({
			apiKey: "test-key",
			baseUrl: "https://model.example/v1",
			fetch: fetch as unknown as FetchFunction,
		});
		const context = normalizeContext({
			messages: [
				{ content: "inspect the sticker", role: "user", timestamp: 1 },
				{
					api: "openai-compatible",
					content: [
						{
							arguments: { itemId: "sticker-1" },
							id: "call-view",
							name: "sticker-meme.view",
							type: "toolCall",
						},
					],
					model: model.id,
					provider: model.provider,
					role: "assistant",
					stopReason: "toolUse",
					timestamp: 2,
					usage: {
						cacheRead: 0,
						cacheWrite: 0,
						cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
						input: 1,
						output: 1,
						totalTokens: 2,
					},
				},
				{
					content: [
						{ text: '{"itemId":"sticker-1"}', type: "text" },
						{ data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
					],
					isError: false,
					role: "toolResult",
					timestamp: 3,
					toolCallId: "call-view",
					toolName: "sticker-meme.view",
				},
			],
		} satisfies Context);
		for await (const event of streams.stream(model, context)) void event;

		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(request.body as string);
		expect(body.messages.at(-1)).toEqual({
			content: '{"itemId":"sticker-1"}',
			role: "tool",
			tool_call_id: "call-view",
		});
		expect(body.messages.filter((message: { role: string }) => message.role === "user")).toEqual([
			{ content: "inspect the sticker", role: "user" },
		]);
		expect(JSON.stringify(body.messages)).not.toContain("image_url");
	});

	test("serializes temperature, top_p, and stop from request options and model defaults", async () => {
		const fetch = mock(async () => textResponse()) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[{ modelId: model.id, stop: ["MODEL-END"], temperature: 0.4, topP: 0.8 }],
		);
		for await (const event of streams.stream(
			model,
			normalizeContext({ messages: [{ content: "hi", role: "user", timestamp: 1 }] }),
			{ samplingParams: { stop: ["REQUEST-STOP"], top_p: 0.9 }, temperature: 0.6 },
		)) {
			void event;
		}
		const request = (fetch.mock.calls[0] as [string, RequestInit])[1];
		const body = JSON.parse(request.body as string);
		expect(body.temperature).toBe(0.6);
		expect(body.top_p).toBe(0.9);
		expect(body.stop).toEqual(["REQUEST-STOP"]);

		for await (const event of streams.stream(
			model,
			normalizeContext({ messages: [{ content: "again", role: "user", timestamp: 1 }] }),
		)) {
			void event;
		}
		const defaults = JSON.parse(
			((fetch.mock.calls[1] as [string, RequestInit])[1].body as string) ?? "{}",
		);
		expect(defaults.temperature).toBe(0.4);
		expect(defaults.top_p).toBe(0.8);
		expect(defaults.stop).toEqual(["MODEL-END"]);
	});

	test("aborts headers that never arrive and reports an OpenAIRequestTimeoutError", async () => {
		let abortReason: unknown;
		const fetch = mock(async (_input: string, init?: RequestInit) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					abortReason = init.signal?.reason;
				},
				{ once: true },
			);
			return await new Promise<Response>(() => {});
		}) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[{ modelId: model.id, requestTimeoutMs: 20 }],
		);
		const startedAt = Date.now();
		const events = await expectErrorStream(streams.stream);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(abortReason).toBeInstanceOf(OpenAIRequestTimeoutError);
		expect(abortReason).toMatchObject({ phase: "response", timeoutMs: 20 });
		expect(events.at(-1)).toMatchObject({
			error: {
				errorMessage: expect.stringContaining("timed out after 20ms"),
				stopReason: "error",
			},
			reason: "error",
		});
	});

	test("aborts a stalled SSE stream and reports a retryable timeout", async () => {
		let abortReason: unknown;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(sseData({ choices: [{ delta: { content: "partial answer" } }] })),
				);
			},
		});
		const fetch = mock(async (_input: string, init?: RequestInit) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					abortReason = init.signal?.reason;
				},
				{ once: true },
			);
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}) as unknown as FetchMock;
		const streams = createOpenAICompatibleStreams(
			{
				apiKey: "test-key",
				baseUrl: "https://model.example/v1",
				fetch: fetch as unknown as FetchFunction,
			},
			[{ modelId: model.id, requestTimeoutMs: 20 }],
		);
		const events = [];
		for await (const event of streams.stream(
			model,
			normalizeContext({ messages: [{ content: "hi", role: "user", timestamp: 1 }] }),
		)) {
			events.push(event);
		}
		expect(abortReason).toBeInstanceOf(OpenAIRequestTimeoutError);
		expect(abortReason).toMatchObject({ phase: "stream", timeoutMs: 20 });
		expect(
			events.some((event) => event.type === "text_delta" && event.delta === "partial answer"),
		).toBe(true);
		expect(events.at(-1)).toMatchObject({
			error: {
				errorMessage: expect.stringContaining("stalled for 20ms"),
				stopReason: "error",
			},
			reason: "error",
		});
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
