import type { PluginContext, PluginLogger, ToolResult } from "@tsukaima/sdk";
import { elapsedMs, traceLog } from "./logging.ts";
import type { StickerSearchInput, StickerSelectionService } from "./selection.ts";

const text = (value: string): ToolResult => ({ content: [{ text: value, type: "text" }] });

const asString = (input: Record<string, unknown>, key: string): string | undefined => {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const asStringList = (input: Record<string, unknown>, key: string): string[] | undefined => {
	const value = input[key];
	if (typeof value === "string") {
		return value
			.split(/[,，]/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
};

const searchInput = (input: Record<string, unknown>): StickerSearchInput => {
	const emotion = asString(input, "emotion");
	const packId = asString(input, "packId");
	const personaId = asString(input, "personaId");
	const query = asString(input, "query");
	const tags = asStringList(input, "tags");
	const limit =
		typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
	return {
		...(emotion === undefined ? {} : { emotion }),
		...(limit === undefined ? {} : { limit }),
		...(packId === undefined ? {} : { packId }),
		...(personaId === undefined ? {} : { personaId }),
		...(query === undefined ? {} : { query }),
		...(tags === undefined ? {} : { tags }),
	};
};

/** Registers model-visible sticker selection tools with host-enforced policies. */
export function registerStickerTools(
	context: PluginContext,
	selection: StickerSelectionService,
	logger?: PluginLogger,
): void {
	const log = logger ?? context.logger;
	context.tools.register({
		description:
			"Search approved, enabled stickers by semantic text, emotion, persona, pack, or tags.",
		async execute(input) {
			const startedAt = Date.now();
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				tool: "sticker-meme.search",
			});
			const candidates = await selection.search(search);
			log.debug("sticker tool completed", {
				candidateCount: candidates.length,
				durationMs: elapsedMs(startedAt),
				tool: "sticker-meme.search",
			});
			return text(
				JSON.stringify({
					candidates,
					count: candidates.length,
				}),
			);
		},
		name: "sticker-meme.search",
		parameters: {
			properties: {
				emotion: { type: "string" },
				limit: { maximum: 25, minimum: 1, type: "integer" },
				packId: { type: "string" },
				personaId: { type: "string" },
				query: { type: "string" },
				tags: { items: { type: "string" }, type: "array" },
			},
			type: "object",
		},
		policy: { maxConcurrent: 4, maxPayloadBytes: 4_096, timeoutMs: 10_000 },
		requiredPermissions: ["media.read"],
	});
	context.tools.register({
		description:
			"Choose one approved sticker and issue a single-use, short-lived, conversation-bound send token. Use the returned directive verbatim in the final reply.",
		async execute(input, invocation) {
			const startedAt = Date.now();
			const conversationId = invocation.conversationId;
			if (conversationId === undefined || conversationId.trim().length === 0) {
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					reason: "missing_conversation",
					tool: "sticker-meme.choose",
				});
				return text("A conversation is required to choose a sticker.");
			}
			const itemId = asString(input, "itemId");
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				itemId: itemId ?? null,
				tool: "sticker-meme.choose",
			});
			const result = await selection.choose({
				...search,
				conversationId,
				...(itemId === undefined ? {} : { itemId }),
			});
			log.debug("sticker tool completed", {
				chosenId: result.itemId,
				durationMs: elapsedMs(startedAt),
				tokenIssued: true,
				tool: "sticker-meme.choose",
			});
			return text(JSON.stringify(result));
		},
		name: "sticker-meme.choose",
		parameters: {
			properties: {
				emotion: { type: "string" },
				itemId: { type: "string" },
				packId: { type: "string" },
				personaId: { type: "string" },
				query: { type: "string" },
				tags: { items: { type: "string" }, type: "array" },
			},
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			timeoutMs: 15_000,
		},
		requiredPermissions: ["media.read", "conversation.read"],
	});
}
