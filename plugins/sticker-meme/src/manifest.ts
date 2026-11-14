import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const STICKER_MEME_PLUGIN_ID = "sticker-meme";
export const STICKER_MEME_RPC_PREFIX = `${STICKER_MEME_PLUGIN_ID}.`;
export const STICKER_MEME_DIRECTIVE_PATTERN =
	/\[\[sticker:([A-Za-z0-9_-]+)\]\]|<sticker\s+token=["']([A-Za-z0-9_-]+)["']\s*\/?>/gu;

export const stickerMemeManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: {
		semanticApiKey: "TSUKAIMA_SEMANTIC_API_KEY",
		semanticBaseUrl: "TSUKAIMA_SEMANTIC_BASE_URL",
		semanticModel: "TSUKAIMA_SEMANTIC_MODEL",
		semanticProviderId: "TSUKAIMA_SEMANTIC_PROVIDER_ID",
		telegramApiBaseUrl: "TSUKAIMA_TELEGRAM_API_BASE_URL",
		telegramBotToken: "TSUKAIMA_TELEGRAM_BOT_TOKEN",
	},
	configSchema: {
		properties: {
			importConcurrency: {
				description:
					"Parallel workers for media import (download, convert, dedupe, store). Higher values import faster.",
				title: "Import concurrency",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
			learning: {
				properties: {
					allowGenerated: { type: "boolean" },
					dailyCap: { type: "integer" },
					duplicateThreshold: { type: "integer" },
					enabled: { type: "boolean" },
					retentionDays: { type: "integer" },
				},
				type: "object",
			},
			semanticApiKey: {
				description: "Secret API key for the optional OpenAI-compatible vision classifier.",
				title: "Semantic model API key",
				type: "string",
			},
			semanticBaseUrl: {
				description:
					"Base URL for the vision model endpoint, for example https://api.openai.com/v1.",
				title: "Semantic model base URL",
				type: "string",
			},
			semanticConcurrency: {
				description:
					"Parallel workers for semantic classification. Runs concurrently with media import.",
				title: "Semantic concurrency",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
			semanticMaxLabels: {
				description: "Maximum semantic labels stored per sticker.",
				title: "Semantic labels per sticker",
				maximum: 16,
				minimum: 1,
				type: "integer",
			},
			semanticMode: {
				description:
					"heuristic uses emoji/title only; auto uses a configured vision or selected model when available; vision requires a configured model.",
				enum: ["heuristic", "auto", "vision"],
				title: "Semantic classifier mode",
				type: "string",
			},
			semanticModel: {
				description:
					"Model id for semantic classification, from a host provider or custom endpoint.",
				title: "Semantic model",
				type: "string",
			},
			semanticProviderId: {
				description:
					"Host model provider id, for example openai-compatible. Leave empty to auto-select or use custom endpoint credentials.",
				title: "Semantic model provider",
				type: "string",
			},
			semanticTimeoutSeconds: {
				description: "Vision model request timeout in seconds.",
				title: "Semantic model timeout",
				maximum: 300,
				minimum: 5,
				type: "integer",
			},
			sendTokenTtlSeconds: { type: "integer" },
			telegramAnimatedFormat: {
				description:
					"gif renders animated Telegram TGS stickers to GIF; thumbnail keeps a still image.",
				enum: ["gif", "thumbnail"],
				title: "Animated sticker format",
				type: "string",
			},
			telegramAnimatedFps: {
				description: "GIF frame rate for animated/video Telegram stickers.",
				title: "Animated GIF FPS",
				maximum: 30,
				minimum: 1,
				type: "integer",
			},
			telegramAnimatedMaxFrames: {
				description:
					"Maximum GIF frames per sticker. Lower values import faster and produce smaller files.",
				title: "Animated GIF max frames",
				maximum: 120,
				minimum: 1,
				type: "integer",
			},
			telegramApiBaseUrl: {
				description: "Optional Telegram Bot API root. Leave empty for https://api.telegram.org.",
				title: "Telegram API base URL",
				type: "string",
			},
			telegramBotToken: {
				description:
					"Bot token from @BotFather. Stored as a secret and used only for sticker imports.",
				title: "Telegram bot token",
				type: "string",
			},
			telegramIncludeAnimated: {
				description: "Import TGS animated stickers.",
				title: "Include animated stickers",
				type: "boolean",
			},
			telegramIncludeVideo: {
				description: "Import Telegram video stickers.",
				title: "Include video stickers",
				type: "boolean",
			},
			telegramMaxStickers: {
				description: "Maximum stickers imported from one Telegram set.",
				title: "Telegram import limit",
				maximum: 200,
				minimum: 1,
				type: "integer",
			},
			telegramVideoFormat: {
				description:
					"gif uses ffmpeg when available and falls back to webm; webm keeps the original video; thumbnail uses a still image.",
				enum: ["gif", "thumbnail", "webm"],
				title: "Video sticker format",
				type: "string",
			},
		},
		type: "object",
	},
	hooks: [{ name: "message.received" }, { name: "reply.transform" }],
	kind: "builtin",
	migrations: { directory: "migrations" },
	name: STICKER_MEME_PLUGIN_ID,
	secretKeys: ["semanticApiKey", "telegramBotToken"],
	permissions: [
		"ui.panel",
		"media.read",
		"media.write",
		"storage.global",
		"channel.send",
		"conversation.read",
		"tools",
		"audit.write",
		"reply.transform",
	],
	version: "0.1.0",
});
