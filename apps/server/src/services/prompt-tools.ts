import {
	personaPromptUpdateSchema,
	promptKeySchema,
	promptUpdateSchema,
} from "@tsukaima/contracts";
import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import { z } from "zod";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { PromptService } from "./prompts.ts";

export const PROMPT_TOOL_NAMES = ["prompt_list", "prompt_update", "persona_prompt_update"] as const;

export interface PromptToolsOptions {
	/**
	 * Fail-closed runtime gate for surfaces whose prompt access is not implied by the session
	 * kind alone (for example an authenticated IM administrator). When omitted the legacy
	 * `webui`/coding-`workspace` rule applies.
	 */
	readonly authorize?: (
		durableConversationId: string,
		toolName: string,
	) => Promise<{ readonly allowed: boolean; readonly reason?: string }>;
}

export function createPromptTools(
	prompts: PromptService,
	policy: ConversationPolicyService,
	options: PromptToolsOptions = {},
): DurableExtension {
	function tool<Schema extends z.ZodType>(
		name: (typeof PROMPT_TOOL_NAMES)[number],
		description: string,
		schema: Schema,
		run: (input: z.output<Schema>) => Promise<unknown> | unknown,
	): DurableToolRegistration {
		return {
			name,
			description,
			deferred: true,
			surface: "both",
			parameters: z.toJSONSchema(schema),
			execute: async (raw, api) => {
				try {
					const conversationId = String(api.conversationId);
					const session = prompts.session(conversationId);
					let allowed: boolean;
					if (options.authorize === undefined) {
						allowed =
							session?.kind === "webui" ||
							(session?.kind === "workspace" &&
								(await policy.capabilities(session.id)).includes("coding"));
					} else {
						const decision = await options.authorize(conversationId, name);
						allowed = decision.allowed === true;
					}
					if (!allowed || !prompts.agentAccess())
						throw new Error("Prompt tool access is disabled for this session");
					const result = await run(schema.parse(raw));
					return { output: [{ type: "text", text: JSON.stringify(result) }] };
				} catch (error) {
					return {
						isError: true,
						output: [
							{
								type: "text",
								text:
									error instanceof z.ZodError
										? "Invalid prompt tool arguments"
										: error instanceof Error
											? error.message
											: "Prompt operation failed",
							},
						],
					};
				}
			},
		};
	}
	return {
		name: "tsukaima-prompt-tools",
		tools: [
			tool(
				"prompt_list",
				"Read configured prompts, their built-in defaults, and active personas. Use before editing. Pass key or personaId to read only the requested entry.",
				z.strictObject({
					key: promptKeySchema.optional(),
					personaId: z.string().min(1).optional(),
				}),
				async ({ key, personaId }) => ({
					prompts:
						personaId !== undefined && key === undefined
							? []
							: prompts.list().filter((prompt) => key === undefined || prompt.key === key),
					personas:
						key !== undefined && personaId === undefined
							? []
							: (await policy.listPersonas()).filter(
									(persona) =>
										persona.isActive && (personaId === undefined || persona.id === personaId),
								),
				}),
			),
			tool(
				"prompt_update",
				"Update a shared prompt only when explicitly requested by the operator. Pass the current override as expectedOverride and null as override to restore the default.",
				promptUpdateSchema,
				(input) => prompts.update(input, "agent"),
			),
			tool(
				"persona_prompt_update",
				"Update an active persona's prompt only when explicitly requested by the operator. Pass its current version. Every session bound to the persona will use the new version.",
				personaPromptUpdateSchema,
				async (input) => {
					const persona = policy.updatePersonaPrompt(input, "agent");
					await prompts.auditPersona(persona, "agent");
					return persona;
				},
			),
		],
	};
}
