import {
	createAssistantMessageEventStream,
	createModels,
	createProvider,
	type AssistantMessage,
	type Model,
	type Api,
	type Models,
	type ProviderStreams,
} from "@earendil-works/pi-ai";

export interface ModelPort {
	readonly providerId: string;
	readonly modelId: string;
	readonly models: Models;
}

export interface FakeModelOptions {
	readonly onMessage?: (message: AssistantMessage) => void;
	readonly responses?: readonly string[];
}

function responseMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		api: model.api,
		content: [{ text, type: "text" }],
		model: model.id,
		provider: model.provider,
		role: "assistant",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			cacheRead: 0,
			cacheWrite: 0,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
			input: 0,
			output: 0,
			totalTokens: 0,
		},
	};
}

export function createFakeModel(options: FakeModelOptions = {}): ModelPort {
	const providerId = "fake";
	const modelId = "fake-deterministic";
	let index = 0;

	const stream: ProviderStreams["stream"] = (model) => {
		const output = createAssistantMessageEventStream();
		const text = options.responses?.[index] ?? "ok";
		index += 1;
		const message = responseMessage(model, text);
		options.onMessage?.(message);
		queueMicrotask(() => {
			output.push({
				type: "start",
				partial: { ...message, content: [], stopReason: "pending" },
			});
			output.push({
				type: "text_start",
				contentIndex: 0,
				partial: { ...message, content: [] },
			});
			output.push({
				type: "text_delta",
				contentIndex: 0,
				delta: text,
				partial: message,
			});
			output.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: message,
			});
			output.push({ type: "done", message, reason: "stop" });
			output.end(message);
		});
		return output;
	};

	const streams: ProviderStreams = {
		stream,
		streamSimple: stream,
	};

	const provider = createProvider({
		auth: { apiKey: { name: "Fake key", resolve: async () => ({ auth: {} }) } },
		id: providerId,
		models: [
			{
				api: "fake",
				baseUrl: "fake://local",
				contextWindow: 128_000,
				cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
				id: modelId,
				input: ["text"],
				maxTokens: 8_000,
				name: "Deterministic fake model",
				provider: providerId,
				reasoning: false,
			},
		],
		api: streams,
	});

	const models = createModels();
	models.setProvider(provider);

	return { models, modelId, providerId };
}
