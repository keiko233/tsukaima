export const STICKER_DECISION_PROMPT_MAX_CHARS = 1_000;

export const DEFAULT_STICKER_DECISION_PROMPT =
	"Stickers are optional highlights—use `sticker-meme.send` sparingly when a sticker genuinely heightens a punchline, teasing, strong emotion, or an obvious standalone reaction. Keep plain greetings, short answers, and routine replies text-only, and never wait to be asked when a moment truly calls for one. Match any mood or vibe with `sticker-meme.send` (or browse with `sticker-meme.search` / `sticker-meme.list_packs`), skip stickers when staying silent (`TSUKAIMA_LURK`), and never write sticker markers in text.";

export function resolveStickerDecisionPrompt(settingsInput: unknown): string | undefined {
	const settings =
		typeof settingsInput === "object" && settingsInput !== null && !Array.isArray(settingsInput)
			? (settingsInput as Record<string, unknown>)
			: {};
	if (settings.promptEnabled === false) return undefined;
	const custom = settings.promptText;
	if (typeof custom === "string") {
		const trimmed = custom.trim();
		if (trimmed.length > 0) {
			return trimmed.slice(0, STICKER_DECISION_PROMPT_MAX_CHARS);
		}
	}
	return DEFAULT_STICKER_DECISION_PROMPT;
}
