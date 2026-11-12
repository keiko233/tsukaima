import {
	createModels,
	createProvider,
	type Models,
	type ProviderStreams,
} from "@earendil-works/pi-ai";

export interface ModelPort {
	readonly providerId: string;
	readonly modelId: string;
	readonly models: Models;
}

export interface FakeModelOptions {
	readonly responses?: readonly string[];
}

export function createFakeModel(options: FakeModelOptions = {}): ModelPort {
	const providerId = "fake";
	const modelId = "fake-deterministic";
	let index = 0;

	const streams: ProviderStreams = {
		async *stream(_model, _context) {
			const response = options.responses?.[index] ?? "ok";
			index += 1;
			yield { type: "text", text: response };
		},
		streamSimple(model, context, _streamOptions) {
			const asyncStream = streams.stream(model, context, options);
			return {
				async *[Symbol.asyncIterator]() {
					yield* asyncStream;
				},
			};
		},
	};

	const provider = createProvider({
		auth: { apiKey: { name: "Fake key", resolve: async () => ({ auth: {} }) } },
		id: providerId,
		models: [
			{
				api: "fake",
				contextWindow: 128_000,
				cost: { input: 0, output: 0 },
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
