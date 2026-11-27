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

export interface CompositeModelPreference {
	readonly providerId?: string;
	readonly modelId?: string;
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

/**
 * Merge every provider from `ports` into one {@link Models} registry and pick a default model.
 *
 * Providers with a duplicate id are skipped after the first occurrence. The preferred provider
 * and model win when both are registered; a missing model falls back to the preferred provider's
 * first model, then to the first non-'fake' port, then to `ports[0]`, then to a fake model when
 * no ports are supplied.
 */
export function createCompositeModelPort(
	ports: readonly ModelPort[],
	preferred: CompositeModelPreference = {},
): ModelPort {
	const models = createModels();
	const seen = new Set<string>();
	for (const port of ports) {
		for (const provider of port.models.getProviders()) {
			if (seen.has(provider.id)) continue;
			seen.add(provider.id);
			models.setProvider(provider);
		}
	}

	const selectPreferred = (): { modelId: string; providerId: string } | undefined => {
		const providerId = preferred.providerId;
		if (providerId === undefined || models.getProvider(providerId) === undefined) {
			return undefined;
		}
		if (preferred.modelId !== undefined) {
			const model = models.getModel(providerId, preferred.modelId);
			if (model !== undefined) return { modelId: model.id, providerId };
		}
		const first = models.getModels(providerId)[0];
		return first === undefined ? undefined : { modelId: first.id, providerId };
	};

	const preferredSelection = selectPreferred();
	if (preferredSelection) return { ...preferredSelection, models };

	const nonFake = ports.find((port) => port.providerId !== "fake");
	if (nonFake) return { modelId: nonFake.modelId, models, providerId: nonFake.providerId };

	const firstPort = ports[0];
	if (firstPort) return { modelId: firstPort.modelId, models, providerId: firstPort.providerId };

	return createFakeModel();
}

/**
 * A provider that streams `chunks` one at a time with a real delay.
 *
 * The deterministic fake model resolves in a microtask, which is far faster than the durable
 * `progress.partialIntervalMs` commit cadence. Any test that asserts on streamed partial text
 * needs a model that stays in flight long enough for those commits to land.
 */
export function createSlowStreamingModel(
	chunks: readonly string[],
	options: {
		delayMs?: number;
		modelId?: string;
		/** Chunks for one provider call, for tests that need different answers per run. */
		chunksForCall?: (callIndex: number) => readonly string[];
		/** Observe the context the host sends, so a test can assert on image blocks. */
		onContext?: (context: unknown) => void;
		/** Observe the provider request options and selected model for each call. */
		onStreamOptions?: (
			options: { reasoning?: string; signal?: AbortSignal } | undefined,
			model: { id: string },
		) => void;
		/** Declare image input, so a test can exercise the vision path. Defaults to text-only. */
		supportsImage?: boolean;
		/** Extra models on the same provider, for tests that select a conversation model. */
		additionalModels?: readonly { id: string; supportsImage?: boolean }[];
	} = {},
): ModelPort {
	const delayMs = options.delayMs ?? 40;
	const providerId = "slow-test";
	const modelId = options.modelId ?? "slow-test-model";
	let callIndex = 0;

	const stream = (
		model: { api: string; id: string; provider: string },
		context?: unknown,
		streamOptions?: { reasoning?: string; signal?: AbortSignal },
	) => {
		const callChunks = options.chunksForCall?.(callIndex) ?? chunks;
		callIndex += 1;
		options.onContext?.(context);
		options.onStreamOptions?.(streamOptions, model);
		const output = createAssistantMessageEventStream();
		void (async () => {
			output.push({
				partial: { ...testAssistantMessage(model, ""), content: [], stopReason: "pending" },
				type: "start",
			});
			output.push({
				contentIndex: 0,
				partial: { ...testAssistantMessage(model, ""), content: [] },
				type: "text_start",
			});
			let accumulated = "";
			for (const chunk of callChunks) {
				await Bun.sleep(delayMs);
				if (streamOptions?.signal?.aborted) {
					const aborted = {
						...testAssistantMessage(model, accumulated),
						stopReason: "aborted" as const,
					};
					output.push({ error: aborted, reason: "aborted", type: "error" });
					output.end(aborted);
					return;
				}
				accumulated += chunk;
				output.push({
					contentIndex: 0,
					delta: chunk,
					partial: testAssistantMessage(model, accumulated),
					type: "text_delta",
				});
			}
			output.push({
				content: accumulated,
				contentIndex: 0,
				partial: testAssistantMessage(model, accumulated),
				type: "text_end",
			});
			output.push({
				message: testAssistantMessage(model, accumulated),
				reason: "stop",
				type: "done",
			});
			output.end(testAssistantMessage(model, accumulated));
		})();
		return output;
	};

	const modelEntry = (id: string, supportsImage: boolean | undefined) => {
		const input: ("text" | "image")[] = supportsImage === true ? ["text", "image"] : ["text"];
		return {
			api: "slow-test",
			baseUrl: "slow-test://local",
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id,
			input,
			maxTokens: 8_000,
			name: "Slow streaming test model",
			provider: providerId,
			reasoning: false,
		};
	};
	const provider = createProvider({
		api: { stream, streamSimple: stream } as never,
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: {} }) } },
		id: providerId,
		models: [
			modelEntry(modelId, options.supportsImage),
			...(options.additionalModels ?? []).map((model) => modelEntry(model.id, model.supportsImage)),
		],
	});
	const models = createModels();
	models.setProvider(provider);
	return { modelId, models, providerId };
}

/** A provider-shaped assistant message for the slow test model. */
function testAssistantMessage(
	model: { api: string; id: string; provider: string },
	text: string,
): AssistantMessage {
	return {
		api: model.api as never,
		content: [{ text, type: "text" as const }],
		model: model.id,
		provider: model.provider,
		role: "assistant" as const,
		stopReason: "stop" as const,
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
