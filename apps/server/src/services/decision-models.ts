import { NATIVE_DECISION_MODELS } from "@tsukaima/contracts";
import { z } from "zod";

interface ChoiceRequest {
	readonly context: string;
	readonly instructions: string;
	readonly options: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
}

const choiceResponse = z.object({
	answers: z.object({
		routing: z.object({
			choice: z.string(),
			confidence: z.number().min(0).max(1),
			type: z.literal("choice"),
		}),
	}),
});

export class NativeDecisionModels {
	constructor(
		private readonly env: Readonly<Record<string, string | undefined>>,
		private readonly request: (url: string, init: RequestInit) => Promise<Response> = fetch,
	) {}

	supports(modelId: string | undefined): modelId is string {
		return modelId !== undefined && this.#find(modelId) !== undefined;
	}

	#find(modelId: string) {
		return NATIVE_DECISION_MODELS.find(
			(model) =>
				model.id === modelId ||
				(model.id === "jev-latest" && /^jev-(?:preview|\d+(?:\.\d+){1,2})$/u.test(modelId)),
		);
	}

	async choose<Decision extends string>(
		modelId: string,
		input: ChoiceRequest & { readonly options: Readonly<Record<Decision, string>> },
	): Promise<{ confidence: number; decision: Decision }> {
		const model = this.#find(modelId);
		if (model === undefined) throw new Error("Unknown decision model");
		const apiKey = this.env[model.apiKeyEnv]?.trim();
		if (!apiKey) throw new Error(`Decision model credentials missing (${model.apiKeyEnv})`);

		const questions = {
			routing: { criteria: input.options, instructions: input.instructions, type: "choice" },
		};
		const gemini = model.id === "gemini-decision-1";
		const response = await this.request(
			gemini
				? "https://generativelanguage.googleapis.com/v1beta/decisions"
				: "https://api.typesafe.ai/v1/systemone",
			{
				body: JSON.stringify({
					[gemini ? "input" : "state"]: input.context,
					model: modelId,
					questions,
				}),
				headers: {
					"content-type": "application/json",
					...(gemini ? { "x-goog-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
				},
				method: "POST",
				redirect: "error",
				signal: input.signal,
			},
		);
		if (!response.ok) throw new Error(`Decision API returned HTTP ${response.status}`);
		const parsed = choiceResponse.safeParse(await response.json());
		if (!parsed.success) throw new Error("Decision API returned an invalid choice");
		const { choice, confidence } = parsed.data.answers.routing;
		if (!Object.hasOwn(input.options, choice))
			throw new Error("Decision API returned an unknown choice");
		return { confidence, decision: choice as Decision };
	}
}
