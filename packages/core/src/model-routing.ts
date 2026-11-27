import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

/** Capability tag used to route a request to a concrete model policy. */
export type ModelCapability =
	| "basic-chat"
	| "tool-use"
	| "coding"
	| "chat.persona"
	| "chat.fast"
	| "summarize"
	| "memory.extract"
	| "vision"
	| "tool-heavy"
	| "structured-output"
	| (string & {});

/** Broad usage category for a routed model call. */
export type ModelUsageKind = "chat" | "decision" | "embedding" | "audio" | "image" | "video";

export interface ModelPolicy {
	readonly capability: ModelCapability;
	readonly maxOutputTokens?: number;
	readonly primary: ModelRef;
	readonly fallbacks?: readonly ModelRef[];
	readonly thinking?: "off" | "low" | "medium" | "high";
}

export interface ModelRef {
	readonly modelId: string;
	readonly providerId: string;
}

export interface ModelUsageRecord {
	readonly capability: ModelCapability;
	readonly inputTokens: number;
	readonly modelId: string;
	readonly outputTokens: number;
	readonly providerId: string;
	readonly kind?: ModelUsageKind;
	readonly count?: number;
	readonly costUsd?: number;
}

export class ModelUsageLedger {
	readonly #records: ModelUsageRecord[] = [];

	get records(): readonly ModelUsageRecord[] {
		return [...this.#records];
	}

	get totals(): { readonly inputTokens: number; readonly outputTokens: number } {
		return this.#records.reduce(
			(accumulator, record) => ({
				inputTokens: accumulator.inputTokens + record.inputTokens,
				outputTokens: accumulator.outputTokens + record.outputTokens,
			}),
			{ inputTokens: 0, outputTokens: 0 },
		);
	}

	record(message: AssistantMessage, capability: ModelCapability): ModelUsageRecord {
		const record: ModelUsageRecord = {
			capability,
			inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
			modelId: message.model,
			outputTokens: message.usage.output,
			providerId: message.provider,
		};
		this.#records.push(record);
		return record;
	}
}

export interface RouteModelRequest {
	readonly capability: ModelCapability;
	readonly policies?: readonly ModelPolicy[];
}

export interface RoutedModel {
	readonly maxOutputTokens?: number;
	readonly model: Model<Api>;
	readonly policy: ModelPolicy;
}

export class ModelPolicyRouter {
	readonly #models = new Map<string, Model<Api>>();

	constructor(models: readonly Model<Api>[]) {
		for (const model of models) {
			this.#models.set(`${model.provider}:${model.id}`, model);
		}
	}

	select(request: RouteModelRequest): RoutedModel {
		const candidates = request.policies?.filter(
			(policy) => policy.capability === request.capability,
		);
		const policy = candidates?.[0];
		if (!policy) throw new Error(`No model policy for capability: ${request.capability}`);
		const fallbacks = [policy.primary, ...(policy.fallbacks ?? [])];
		for (const modelRef of fallbacks) {
			const model = this.#models.get(`${modelRef.providerId}:${modelRef.modelId}`);
			if (model) {
				const policyLimit = policy.maxOutputTokens;
				const modelLimit = model.maxTokens;
				const maxOutputTokens =
					policyLimit === undefined
						? modelLimit
						: modelLimit === undefined
							? policyLimit
							: Math.min(modelLimit, policyLimit);
				return {
					...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
					model,
					policy,
				};
			}
		}
		throw new Error(`No available model for capability: ${request.capability}`);
	}
}
