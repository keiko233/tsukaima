import type { PluginLogger, PluginMediaApi } from "@elaina/sdk";
import { createAnimatedConverter, type AnimatedConverter } from "./animated.ts";
import {
	EMPTY_SEMANTIC_PROFILE,
	inferMimeType,
	normalizeLabel,
	normalizeLabels,
	normalizeText,
	sha256Bytes,
	stableId,
	type StickerReviewStatus,
	type StickerSemanticProfile,
} from "./domain.ts";
import type { StickerImportReport } from "./import-service.ts";
import { elapsedMs, logErrorMessage, traceLog } from "./logging.ts";
import type { StickerRepository } from "./repository.ts";
import { classifyStickerSemantics, type StickerSemanticClassifier } from "./semantic.ts";
import {
	parseTelegramStickerSetReference,
	type TelegramSticker,
	type TelegramStickerSet,
	type TelegramStickerSource,
} from "./telegram.ts";

export type TelegramAnimatedFormat = "gif" | "thumbnail";
export type TelegramVideoFormat = "gif" | "thumbnail" | "webm";

export interface TelegramStickerImportReport extends StickerImportReport {
	readonly classified: number;
	readonly classifier: string;
	readonly setName: string;
	readonly skipped: number;
	readonly sourceUrl: string;
	readonly title: string;
}

export interface TelegramImportProgress {
	readonly classified: number;
	readonly current: number;
	readonly currentItem?: string;
	readonly packTitle?: string;
	readonly skipped: number;
	readonly stage: "fetching" | "downloading" | "converting" | "classifying" | "saving";
	readonly total: number | null;
}

export interface TelegramStickerImportOptions {
	readonly animatedFormat?: TelegramAnimatedFormat;
	readonly animatedFps?: number;
	readonly animatedMaxFrames?: number;
	readonly classifier?: StickerSemanticClassifier;
	readonly dryRun?: boolean;
	readonly includeAnimated?: boolean;
	readonly includeVideo?: boolean;
	readonly maxStickers?: number;
	readonly onProgress?: (progress: TelegramImportProgress) => void;
	readonly reviewStatus?: StickerReviewStatus;
	readonly videoFormat?: TelegramVideoFormat;
}

export interface TelegramStickerImportServiceOptions {
	readonly client: TelegramStickerSource;
	readonly converter?: AnimatedConverter;
	readonly logger?: PluginLogger | undefined;
	readonly media: PluginMediaApi;
	readonly repository: StickerRepository;
}

type SelectedKind = "static" | "tgs" | "thumbnail" | "webm";

interface SelectedSticker {
	readonly fallbackFileId?: string;
	readonly fileId?: string;
	readonly index: number;
	readonly kind: SelectedKind;
	readonly sticker: TelegramSticker;
}

interface DownloadedMedia {
	readonly bytes: Uint8Array;
	readonly filePath: string;
}

interface PreparedMedia extends DownloadedMedia {
	readonly keyword?: "animated-gif" | "animated-thumbnail" | "video-webm";
	readonly mimeType: string;
	readonly still: boolean;
}

function telegramItemName(setName: string, index: number): string {
	const prefix = normalizeLabel(setName).replace(/_+/gu, "-").slice(0, 24) || "telegram";
	return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

function stickerMimeType(filePath: string): string {
	const mime = inferMimeType(filePath);
	return mime.startsWith("image/") ? mime : "image/webp";
}

function withTelegramContext(
	profile: StickerSemanticProfile,
	prepared: PreparedMedia,
): StickerSemanticProfile {
	const keywords = normalizeLabels([
		...profile.keywords,
		"telegram",
		...(prepared.keyword === undefined ? [] : [prepared.keyword]),
	]).values;
	const suffix =
		prepared.keyword === "animated-thumbnail"
			? " Still thumbnail of an animated Telegram sticker."
			: prepared.keyword === "animated-gif"
				? " Animated GIF."
				: prepared.keyword === "video-webm"
					? " Video sticker (webm)."
					: "";
	return {
		...profile,
		description: `${profile.description}${suffix}`.trim().slice(0, 240),
		keywords,
	};
}

/** Imports one Telegram set into a stable pack id, so re-imports update instead of duplicating. */
export class TelegramStickerImportService {
	readonly #client: TelegramStickerSource;
	readonly #converter: AnimatedConverter;
	readonly #logger: PluginLogger | undefined;
	readonly #media: PluginMediaApi;
	readonly #repository: StickerRepository;

	constructor(options: TelegramStickerImportServiceOptions) {
		this.#client = options.client;
		this.#logger = options.logger;
		this.#converter = options.converter ?? createAnimatedConverter({ logger: options.logger });
		this.#media = options.media;
		this.#repository = options.repository;
	}

	async importReference(
		reference: string,
		options: TelegramStickerImportOptions = {},
	): Promise<TelegramStickerImportReport> {
		const parsed = parseTelegramStickerSetReference(reference, this.#logger);
		return await this.importSet(parsed.setName, parsed.sourceUrl, options);
	}

	async importSet(
		setName: string,
		sourceUrl: string,
		options: TelegramStickerImportOptions = {},
	): Promise<TelegramStickerImportReport> {
		const startedAt = Date.now();
		this.#logger?.info("telegram sticker import started", {
			dryRun: options.dryRun === true,
			setName,
		});
		options.onProgress?.({
			classified: 0,
			current: 0,
			skipped: 0,
			stage: "fetching",
			total: null,
		});
		const set = await this.#client.getStickerSet(setName);
		const packId = stableId("pack", `telegram:${set.name}`);
		const warnings: string[] = [];
		const selection = selectStickers(set, options, warnings);
		const skipped = set.stickers.length - selection.length;
		this.#logger?.debug("telegram sticker set fetched", {
			animated: set.isAnimated,
			durationMs: elapsedMs(startedAt),
			selectedCount: selection.length,
			setName: set.name,
			skipped,
			stickerCount: set.stickers.length,
			video: set.isVideo,
		});
		const classifier = options.classifier;
		options.onProgress?.({
			classified: 0,
			current: 0,
			packTitle: set.title,
			skipped,
			stage: options.dryRun === true ? "classifying" : "downloading",
			total: selection.length,
		});
		if (options.dryRun === true) {
			const report = await this.#dryRun(
				set,
				selection,
				packId,
				classifier,
				warnings,
				sourceUrl,
				options,
			);
			this.#logger?.info("telegram sticker import completed", {
				durationMs: elapsedMs(startedAt),
				dryRun: true,
				items: report.items,
				setName,
				skipped: report.skipped,
				warnings: report.warnings.length,
			});
			return report;
		}
		await this.#savePack(set, packId, sourceUrl);
		const report = await this.#importStickers(
			set,
			selection,
			packId,
			classifier,
			warnings,
			sourceUrl,
			options,
		);
		this.#logger?.info("telegram sticker import completed", {
			classified: report.classified,
			deduped: report.deduped,
			durationMs: elapsedMs(startedAt),
			dryRun: false,
			items: report.items,
			missingMedia: report.missingMedia,
			setName,
			skipped: report.skipped,
			warnings: report.warnings.length,
		});
		return report;
	}

	async #savePack(set: TelegramStickerSet, packId: string, sourceUrl: string): Promise<void> {
		await this.#repository.savePack({
			id: packId,
			metadata: {
				provider: "telegram",
				telegram: {
					isAnimated: set.isAnimated,
					isVideo: set.isVideo,
					name: set.name,
					sourceUrl,
					stickerType: set.stickerType,
					title: set.title,
				},
			},
			name: set.title,
			source: "imported",
			tags: ["telegram", set.stickerType],
		});
	}

	async #dryRun(
		set: TelegramStickerSet,
		selection: readonly SelectedSticker[],
		packId: string,
		classifier: StickerSemanticClassifier | undefined,
		warnings: string[],
		sourceUrl: string,
		options: TelegramStickerImportOptions,
	): Promise<TelegramStickerImportReport> {
		const skipped = set.stickers.length - selection.length;
		let classified = 0;
		for (const [offset, entry] of selection.entries()) {
			const name = telegramItemName(set.name, entry.index);
			const itemLabel = entry.sticker.emoji ? `${name} ${entry.sticker.emoji}` : name;
			options.onProgress?.({
				classified,
				current: offset,
				currentItem: itemLabel,
				packTitle: set.title,
				skipped,
				stage: "classifying",
				total: selection.length,
			});
			const profile = await this.#classify(
				undefined,
				entry.sticker.emoji,
				set.title,
				entry.index,
				"image/webp",
				classifier,
				warnings,
			);
			if (profile.source !== "none") classified += 1;
			options.onProgress?.({
				classified,
				current: offset + 1,
				currentItem: itemLabel,
				packTitle: set.title,
				skipped,
				stage: "classifying",
				total: selection.length,
			});
		}
		appendFormatWarnings(selection, warnings, options);
		appendSkippedWarning(set, selection, warnings);
		return {
			classified,
			classifier: classifier?.name ?? "none",
			deduped: 0,
			dryRun: true,
			items: selection.length,
			missingMedia: 0,
			packIds: [packId],
			packs: 1,
			setName: set.name,
			skipped,
			sourceUrl,
			title: set.title,
			warnings,
		};
	}

	async #importStickers(
		set: TelegramStickerSet,
		selection: readonly SelectedSticker[],
		packId: string,
		classifier: StickerSemanticClassifier | undefined,
		warnings: string[],
		sourceUrl: string,
		options: TelegramStickerImportOptions,
	): Promise<TelegramStickerImportReport> {
		const skipped = set.stickers.length - selection.length;
		let deduped = 0;
		let missingMedia = 0;
		let classified = 0;
		for (const [offset, entry] of selection.entries()) {
			const name = telegramItemName(set.name, entry.index);
			const itemLabel = entry.sticker.emoji ? `${name} ${entry.sticker.emoji}` : name;
			const itemId = stableId("item", `telegram:${set.name}:${entry.sticker.fileUniqueId}`);
			traceLog(this.#logger, "telegram sticker import item started", {
				fileId: entry.fileId ?? null,
				index: entry.index,
				itemId,
				itemName: name,
				kind: entry.kind,
				packId,
			});
			const emit = (stage: TelegramImportProgress["stage"], current = offset) => {
				options.onProgress?.({
					classified,
					current,
					currentItem: itemLabel,
					packTitle: set.title,
					skipped,
					stage,
					total: selection.length,
				});
			};
			const missing = async (reason: string): Promise<void> => {
				missingMedia += 1;
				warnings.push(`sticker ${name} ${reason}`);
				await this.#repository.upsertItem({
					description: "",
					emotions: [],
					enabled: false,
					hash: sha256Bytes(new TextEncoder().encode(entry.sticker.fileUniqueId)),
					id: itemId,
					keywords: ["telegram"],
					mimeType: "image/webp",
					name,
					packId,
					reviewStatus: options.reviewStatus ?? "approved",
					semantic: EMPTY_SEMANTIC_PROFILE,
				});
				emit("saving", offset + 1);
			};

			emit("downloading");
			let downloaded: DownloadedMedia | undefined;
			let primaryDownload = true;
			if (entry.fileId !== undefined) {
				try {
					downloaded = await this.#client.downloadFile(entry.fileId);
				} catch (error) {
					primaryDownload = false;
					warnings.push(
						`sticker ${name} download failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					this.#logger?.warn("telegram sticker download failed", {
						error: logErrorMessage(error),
						itemId,
						itemName: name,
					});
				}
			}
			if (downloaded === undefined && entry.fallbackFileId !== undefined) {
				primaryDownload = false;
				try {
					downloaded = await this.#client.downloadFile(entry.fallbackFileId);
					warnings.push(`sticker ${name} fell back to its Telegram thumbnail`);
				} catch (error) {
					warnings.push(
						`sticker ${name} thumbnail download failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					this.#logger?.warn("telegram sticker thumbnail download failed", {
						error: logErrorMessage(error),
						itemId,
						itemName: name,
					});
				}
			}
			if (downloaded === undefined) {
				traceLog(this.#logger, "telegram sticker import item skipped", {
					itemId,
					itemName: name,
					reason: "no_media",
				});
				await missing("has no downloadable media");
				continue;
			}

			if (primaryDownload && (entry.kind === "tgs" || entry.kind === "webm")) {
				emit("converting");
			}
			let prepared = primaryDownload
				? await this.#prepare(entry, downloaded, options, warnings, name)
				: thumbnailMedia(downloaded);
			if (
				prepared === undefined &&
				entry.fallbackFileId !== undefined &&
				entry.fileId !== entry.fallbackFileId
			) {
				try {
					const thumbnail = await this.#client.downloadFile(entry.fallbackFileId);
					prepared = thumbnailMedia(thumbnail);
					warnings.push(
						`sticker ${name} could not be converted and was imported as a still thumbnail`,
					);
					this.#logger?.warn("telegram sticker conversion fell back to thumbnail", {
						itemId,
						itemName: name,
						kind: entry.kind,
					});
				} catch (error) {
					warnings.push(
						`sticker ${name} thumbnail fallback failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					this.#logger?.warn("telegram sticker thumbnail fallback failed", {
						error: logErrorMessage(error),
						itemId,
						itemName: name,
					});
				}
			}
			if (prepared === undefined) {
				traceLog(this.#logger, "telegram sticker import item skipped", {
					itemId,
					itemName: name,
					reason: "conversion_failed",
				});
				await missing("could not be converted or thumbnailed");
				continue;
			}

			const hash = sha256Bytes(prepared.bytes);
			const existing = await this.#media.findBySha(hash);
			if (existing !== undefined) deduped += 1;
			const stored =
				existing ??
				(await this.#media.store({
					bytes: prepared.bytes,
					height: entry.sticker.height,
					kind: "sticker",
					mimeType: prepared.mimeType,
					source: "webui",
					width: entry.sticker.width,
				}));
			emit("classifying");
			const profile = await this.#classify(
				prepared.bytes,
				entry.sticker.emoji,
				set.title,
				entry.index,
				prepared.mimeType,
				classifier,
				warnings,
			);
			const withContext = withTelegramContext(profile, prepared);
			if (withContext.source !== "none") classified += 1;
			emit("saving");
			await this.#repository.upsertItem({
				description: withContext.description,
				emotions: withContext.emotions,
				enabled: true,
				hash,
				height: entry.sticker.height,
				id: itemId,
				keywords: withContext.keywords,
				mediaId: stored.id,
				mimeType: prepared.mimeType,
				name,
				packId,
				reviewStatus: options.reviewStatus ?? "approved",
				semantic: withContext,
				width: entry.sticker.width,
			});
			traceLog(this.#logger, "telegram sticker import item saved", {
				bytes: prepared.bytes.byteLength,
				deduped: existing !== undefined,
				itemId,
				itemName: name,
				mimeType: prepared.mimeType,
				packId,
				semanticSource: withContext.source,
			});
			emit("saving", offset + 1);
		}
		const stillCount = selection.filter((entry) => entry.kind === "thumbnail").length;
		if (stillCount > 0) {
			warnings.push(`${stillCount} animated or video sticker(s) use still thumbnails`);
		}
		appendSkippedWarning(set, selection, warnings);
		return {
			classified,
			classifier: classifier?.name ?? "none",
			deduped,
			dryRun: false,
			items: selection.length,
			missingMedia,
			packIds: [packId],
			packs: 1,
			setName: set.name,
			skipped,
			sourceUrl,
			title: set.title,
			warnings,
		};
	}

	async #prepare(
		entry: SelectedSticker,
		downloaded: DownloadedMedia,
		options: TelegramStickerImportOptions,
		warnings: string[],
		name: string,
	): Promise<PreparedMedia | undefined> {
		if (entry.kind === "static") {
			return {
				...downloaded,
				mimeType: stickerMimeType(downloaded.filePath),
				still: false,
			};
		}
		if (entry.kind === "thumbnail") return thumbnailMedia(downloaded);
		const conversion = {
			...(options.animatedFps === undefined ? {} : { fps: options.animatedFps }),
			...(options.animatedMaxFrames === undefined ? {} : { maxFrames: options.animatedMaxFrames }),
			width: 512,
		};
		if (entry.kind === "tgs") {
			try {
				const bytes = await this.#converter.convertTgs(downloaded.bytes, conversion);
				return {
					bytes,
					filePath: "sticker.gif",
					keyword: "animated-gif",
					mimeType: "image/gif",
					still: false,
				};
			} catch (error) {
				warnings.push(
					`sticker ${name} TGS conversion failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.#logger?.warn("telegram TGS conversion failed", {
					error: logErrorMessage(error),
					itemName: name,
				});
				return undefined;
			}
		}
		const videoFormat = options.videoFormat ?? "gif";
		if (videoFormat === "webm") {
			return {
				...downloaded,
				keyword: "video-webm",
				mimeType: "video/webm",
				still: false,
			};
		}
		try {
			const bytes = await this.#converter.convertWebm(downloaded.bytes, conversion);
			if (bytes !== undefined && bytes.byteLength > 0) {
				return {
					bytes,
					filePath: "sticker.gif",
					keyword: "animated-gif",
					mimeType: "image/gif",
					still: false,
				};
			}
		} catch (error) {
			warnings.push(
				`sticker ${name} webm conversion failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.#logger?.warn("telegram webm conversion failed", {
				error: logErrorMessage(error),
				itemName: name,
			});
		}
		warnings.push(`sticker ${name} was kept as webm because GIF conversion was unavailable`);
		return {
			...downloaded,
			keyword: "video-webm",
			mimeType: "video/webm",
			still: false,
		};
	}

	async #classify(
		bytes: Uint8Array | undefined,
		emoji: string | undefined,
		title: string,
		index: number,
		mimeType: string,
		classifier: StickerSemanticClassifier | undefined,
		warnings: string[],
	): Promise<StickerSemanticProfile> {
		if (classifier === undefined) {
			return classifyStickerSemantics({ ...(emoji === undefined ? {} : { emoji }), title });
		}
		try {
			return await classifier.classify({
				...(bytes === undefined ? {} : { bytes }),
				...(emoji === undefined ? {} : { emoji }),
				index,
				mimeType,
				title,
			});
		} catch (error) {
			warnings.push(
				`semantic classification failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return classifyStickerSemantics({ ...(emoji === undefined ? {} : { emoji }), title });
		}
	}
}

function thumbnailMedia(downloaded: DownloadedMedia): PreparedMedia {
	return {
		...downloaded,
		keyword: "animated-thumbnail",
		mimeType: stickerMimeType(downloaded.filePath),
		still: true,
	};
}

function selectStickers(
	set: TelegramStickerSet,
	options: TelegramStickerImportOptions,
	warnings: string[],
): SelectedSticker[] {
	const includeAnimated = options.includeAnimated !== false;
	const includeVideo = options.includeVideo !== false;
	const animatedFormat = options.animatedFormat ?? "gif";
	const videoFormat = options.videoFormat ?? "gif";
	const maxStickers = Math.max(1, Math.min(200, options.maxStickers ?? 200));
	const selected: SelectedSticker[] = [];
	for (const [index, sticker] of set.stickers.entries()) {
		if (selected.length >= maxStickers) {
			warnings.push(`sticker import capped at ${maxStickers} item(s)`);
			break;
		}
		if (sticker.type === "mask" || sticker.type === "custom_emoji") continue;
		if (sticker.isAnimated && !includeAnimated) continue;
		if (sticker.isVideo && !includeVideo) continue;
		const thumbnailOnly =
			(sticker.isAnimated && animatedFormat === "thumbnail") ||
			(sticker.isVideo && videoFormat === "thumbnail");
		const kind: SelectedKind = thumbnailOnly
			? "thumbnail"
			: sticker.isAnimated
				? "tgs"
				: sticker.isVideo
					? "webm"
					: "static";
		const primaryFileId = thumbnailOnly ? sticker.thumbnailFileId : sticker.fileId;
		const fallbackFileId =
			thumbnailOnly || sticker.thumbnailFileId === undefined ? undefined : sticker.thumbnailFileId;
		const fileId = primaryFileId ?? fallbackFileId;
		selected.push({
			...(fallbackFileId === undefined ? {} : { fallbackFileId }),
			...(fileId === undefined ? {} : { fileId }),
			index,
			kind,
			sticker,
		});
	}
	return selected;
}

function appendFormatWarnings(
	selection: readonly SelectedSticker[],
	warnings: string[],
	options: TelegramStickerImportOptions,
): void {
	const animated = selection.filter((entry) => entry.kind === "tgs").length;
	const video = selection.filter((entry) => entry.kind === "webm").length;
	const still = selection.filter((entry) => entry.kind === "thumbnail").length;
	if (animated > 0) warnings.push(`${animated} animated sticker(s) will be converted to GIF`);
	if (video > 0) {
		const format = options.videoFormat ?? "gif";
		warnings.push(
			format === "webm"
				? `${video} video sticker(s) will be kept as webm`
				: format === "thumbnail"
					? `${video} video sticker(s) will use still thumbnails`
					: `${video} video sticker(s) will be converted to GIF (webm fallback)`,
		);
	}
	if (still > 0) warnings.push(`${still} sticker(s) are configured to use still thumbnails`);
}

function appendSkippedWarning(
	set: TelegramStickerSet,
	selection: readonly SelectedSticker[],
	warnings: string[],
): void {
	const skipped = set.stickers.length - selection.length;
	if (skipped > 0) warnings.push(`${skipped} unsupported Telegram sticker(s) were skipped`);
}

export function telegramPackId(setName: string): string {
	return stableId("pack", `telegram:${normalizeText(setName)}`);
}
