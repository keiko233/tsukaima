export const STICKER_DECISION_PROMPT_MAX_CHARS = 1_000;

export const DEFAULT_STICKER_DECISION_PROMPT =
	"Before finalizing a reply, pause to think whether sending a sticker via `sticker-meme.send` would make your reaction feel more natural and expressive—for example when teasing, joking, reacting with emotion or empathy, greeting, agreeing, or sending a standalone sticker reaction alongside or instead of short text. Do not wait to be asked, and do not limit yourself to the sample captions below; match any mood, keyword, or vibe with `sticker-meme.send` (or browse with `sticker-meme.search` / `sticker-meme.list_packs`). Skip stickers if staying silent (`TSUKAIMA_LURK`), and never write sticker markers in text.";

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
