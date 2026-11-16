import {
	defineExtension,
	section,
	type Extension,
	type PromptSection,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

/**
 * Domain-agnostic seam for the persona and memory prompt sections. The server implements it
 * over Drizzle; `@tsukaima/core` never imports `@tsukaima/db`. Implementations must degrade to
 * `undefined` on any failure so prompt rendering can never break a model run.
 */
export interface ContextPromptProvider {
	/** Persona text for one durable conversation, or `undefined` when none is bound. */
	renderPersona(conversationId: string): Promise<string | undefined>;
	/** Retrieved memory text for one durable conversation, or `undefined` when there is none. */
	renderMemories(conversationId: string): Promise<string | undefined>;
	/** Compact identity/conversation contract text rendered between persona and memory. */
	renderPolicy?(conversationId: string): Promise<string | undefined>;
}

/**
 * Installed extension that carries the Tsukaima context sections. Registry section keys match
 * `/^[a-z][a-z0-9_-]*$/`, so the dotted `tsukaima.persona` form is not available.
 */
export const CONTEXT_EXTENSION_NAME = "tsukaima-context";
/** Section key for the conversation's persona (rendered before policy and memories). */
export const PERSONA_SECTION_KEY = "tsukaima-persona";
/** Section key for the compact conversation policy/trigger contract. */
export const POLICY_SECTION_KEY = "tsukaima-policy";
/** Section key for the conversation's retrieved memories. */
export const MEMORY_SECTION_KEY = "tsukaima-memory";

export interface ContextExtensionOptions {
	/** Section key overrides, mainly for tests and wrapping experiments. */
	readonly keys?: {
		readonly memory?: string;
		readonly persona?: string;
		readonly policy?: string;
	};
}

/**
 * Turns a {@link ContextPromptProvider} into a pi-durable extension with one section per
 * render call. Sections render before every request, so persona and memory changes are
 * reflected on the next turn without touching stored conversation state. Provider or render
 * failures omit the section (the harness keeps the previously shown text, if any).
 */
export function createContextExtension<Tool extends ToolRegistration = ToolRegistration>(
	provider: ContextPromptProvider,
	options: ContextExtensionOptions = {},
): Extension<Tool> {
	const buildSection = (
		key: string,
		render: ContextPromptProvider["renderPersona"],
	): PromptSection<Tool> =>
		section<Tool>(key, async (input, context) => {
			try {
				const text = await render(String(input.conversationId));
				return text === undefined || text.trim().length === 0 ? undefined : text;
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				return undefined;
			}
		});
	const sections = [
		buildSection(options.keys?.persona ?? PERSONA_SECTION_KEY, (conversationId) =>
			provider.renderPersona(conversationId),
		),
		...(provider.renderPolicy === undefined
			? []
			: [
					buildSection(
						options.keys?.policy ?? POLICY_SECTION_KEY,
						(conversationId) =>
							provider.renderPolicy?.(conversationId) ?? Promise.resolve(undefined),
					),
				]),
		buildSection(options.keys?.memory ?? MEMORY_SECTION_KEY, (conversationId) =>
			provider.renderMemories(conversationId),
		),
	];
	return defineExtension<Tool>({
		name: CONTEXT_EXTENSION_NAME,
		sections,
	});
}
