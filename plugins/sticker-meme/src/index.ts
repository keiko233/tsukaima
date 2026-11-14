import type { TsukaimaPlugin, PluginContext } from "@tsukaima/sdk";
import { recordValue } from "./domain.ts";
import { StickerImportService } from "./import-service.ts";
import { LearningService } from "./learning.ts";
import { stickerMemeManifest, STICKER_MEME_PLUGIN_ID } from "./manifest.ts";
import { createStickerReplyTransform } from "./output.ts";
import { StickerRepository } from "./repository.ts";
import { registerStickerRpc } from "./rpc.ts";
import { StickerSelectionService } from "./selection.ts";
import { registerStickerTools } from "./tools.ts";

export {
	STICKER_MEME_DIRECTIVE_PATTERN,
	STICKER_MEME_PLUGIN_ID,
	STICKER_MEME_RPC_PREFIX,
	stickerMemeManifest,
} from "./manifest.ts";
export {
	createAnimatedConverter,
	defaultAnimatedConverter,
	tgsToGif,
	webmToGif,
	type AnimatedConversionOptions,
	type AnimatedConverter,
} from "./animated.ts";
export { DEFAULT_LEARNING_SETTINGS, LearningService, type LearningSettings } from "./learning.ts";
export {
	bundleFilesResponse,
	filesFromBundle,
	parsePackManifest,
	StickerImportService,
	type StickerExportResult,
	type StickerImportProgress,
	type StickerImportReport,
} from "./import-service.ts";
export {
	StickerProgressTracker,
	type StickerJobKind,
	type StickerJobProgress,
	type StickerJobStage,
	type StickerJobStatus,
	type StickerProgressUpdate,
} from "./progress.ts";
export {
	createStickerReplyTransform,
	splitStickerDirectives,
	type StickerReplyTransformPayload,
	type StickerReplyTransformResult,
	type StickerTextPiece,
} from "./output.ts";
export { StickerRepository, type StickerItemInput, type StickerItemPatch } from "./repository.ts";
export {
	rankStickerItem,
	StickerSelectionService,
	type StickerCandidate,
	type StickerChooseResult,
	type StickerSearchInput,
} from "./selection.ts";
export { registerStickerRpc } from "./rpc.ts";
export {
	classifyStickerSemantics,
	createSemanticClassifier,
	extractEmojis,
	HeuristicSemanticClassifier,
	mergeSemanticProfiles,
	STICKER_SEMANTIC_CATEGORIES,
	VisionSemanticClassifier,
	type SemanticCategory,
	type SemanticKind,
	type SemanticLogger,
	type StickerSemanticClassifier,
	type StickerSemanticInput,
	type VisionSemanticOptions,
} from "./semantic.ts";
export { registerStickerTools } from "./tools.ts";
export { TelegramStickerClient, parseTelegramStickerSetReference } from "./telegram.ts";
export {
	TelegramStickerImportService,
	telegramPackId,
	type TelegramAnimatedFormat,
	type TelegramImportProgress,
	type TelegramStickerImportOptions,
	type TelegramStickerImportReport,
	type TelegramVideoFormat,
} from "./telegram-import.ts";
export * from "./domain.ts";

interface StickerRuntime {
	readonly disposers: (() => void)[];
	unsubscribe?: (() => void) | undefined;
}

const runtimes = new WeakMap<PluginContext, StickerRuntime>();

function readTtl(value: unknown): number {
	const seconds = recordValue(value).sendTokenTtlSeconds;
	return typeof seconds === "number" && Number.isFinite(seconds)
		? Math.max(5, Math.floor(seconds)) * 1_000
		: 120_000;
}

async function updateStatus(context: PluginContext, repository: StickerRepository): Promise<void> {
	const stats = await repository.stats();
	context.ui.setStatus({
		code: stats.pending > 0 ? "candidates_pending" : "ready",
		level: stats.pending > 0 ? "warning" : "ok",
		metrics: {
			items: stats.items,
			packs: stats.packs,
			pending: stats.pending,
			sends: stats.sends,
		},
		summary:
			stats.pending > 0
				? `${stats.pending} sticker candidate(s) need review`
				: `${stats.approved} approved sticker(s)`,
	});
}

export const stickerMemePlugin: TsukaimaPlugin = {
	manifest: stickerMemeManifest,
	async setup(context) {
		const database = context.database;
		const media = context.media;
		if (database === undefined || media === undefined) {
			context.logger.error("sticker-meme requires host-mode database and media access");
			context.ui.setStatus({
				code: "host_requirements_missing",
				level: "error",
				summary: "Host database or media bridge is unavailable",
			});
			return;
		}
		const repository = new StickerRepository(database);
		const importService = new StickerImportService({ media, repository });
		const selection = new StickerSelectionService({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			logger: context.logger,
			media,
			repository,
			tokenTtlMs: readTtl((await context.settings?.get()) ?? {}),
		});
		const learning = new LearningService({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			config: context.config,
			logger: context.logger,
			media,
			repository,
			...(context.settings === undefined ? {} : { settings: context.settings }),
		});
		const transform = createStickerReplyTransform({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			logger: context.logger,
			media,
			repository,
		});
		const runtime: StickerRuntime = { disposers: [] };
		runtimes.set(context, runtime);
		registerStickerTools(context, selection);
		registerStickerRpc(context, {
			importService,
			learning,
			onSettled: () => updateStatus(context, repository),
			repository,
		});
		runtime.disposers.push(
			context.events.on("message.received", async (payload) => {
				try {
					await learning.learnFromEnvelope(payload);
					await updateStatus(context, repository);
				} catch (error) {
					context.logger.warn("learnable sticker capture failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}),
			context.events.on("reply.transform", async (payload) => {
				const result = await transform(payload);
				await updateStatus(context, repository);
				return result;
			}),
		);
		runtime.unsubscribe = context.settings?.onChange(async (next) => {
			const ttl = readTtl(next);
			if (ttl > 0) context.logger.debug("sticker token TTL setting changed", { ttlMs: ttl });
			await updateStatus(context, repository);
		});
		await updateStatus(context, repository);
		context.logger.info("sticker-meme ready");
	},
	teardown(context) {
		const runtime = runtimes.get(context);
		runtime?.unsubscribe?.();
		for (const dispose of runtime?.disposers ?? []) {
			try {
				dispose();
			} catch {}
		}
		runtimes.delete(context);
		context.ui.setStatus(null);
	},
};

export default stickerMemePlugin;
export { STICKER_MEME_PLUGIN_ID as PLUGIN_ID };
