import type { PluginContext, PluginLogger, PluginRpcHandler } from "@tsukaima/sdk";
import pLimit from "p-limit";
import { encodeBase64 } from "./archive.ts";
import {
	clampConcurrency,
	normalizeLabels,
	normalizeText,
	recordValue,
	stickerPackSourceSchema,
	stickerReviewStatusSchema,
} from "./domain.ts";
import type { LearningService } from "./learning.ts";
import { elapsedMs, logErrorMessage, traceLog } from "./logging.ts";
import {
	bundleFilesResponse,
	filesFromBundle,
	type StickerImportService,
} from "./import-service.ts";
import { StickerProgressTracker } from "./progress.ts";
import { resolveStickerDecisionPrompt } from "./prompt.ts";
import type { StickerRepository } from "./repository.ts";
import type { StickerSelectionService } from "./selection.ts";
import {
	isVisionCapablePluginModel,
	resolveSemanticClassifier,
	STICKER_SEMANTIC_CATEGORIES,
	type StickerSemanticClassifier,
} from "./semantic.ts";
import { TelegramStickerClient } from "./telegram.ts";
import { TelegramStickerImportService } from "./telegram-import.ts";
import type { StickerUrlImportService } from "./url-import.ts";

interface ServiceBag {
	readonly importService: StickerImportService;
	readonly learning: LearningService;
	readonly logger?: PluginLogger | undefined;
	readonly onSettled?: () => Promise<void>;
	readonly repository: StickerRepository;
	readonly selection?: StickerSelectionService;
	readonly urlImport?: StickerUrlImportService;
}

function resultCounts(result: unknown): Record<string, number> {
	if (typeof result !== "object" || result === null) return {};
	const record = result as Record<string, unknown>;
	const counts: Record<string, number> = {};
	for (const key of ["candidates", "categories", "files", "items", "models", "packs", "warnings"]) {
		const value = record[key];
		if (Array.isArray(value)) counts[`${key}Count`] = value.length;
	}
	for (const key of ["classified", "deduped", "missingMedia", "packs", "skipped", "updated"]) {
		const value = record[key];
		if (typeof value === "number") counts[key] = value;
	}
	return counts;
}

const asBoolean = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;

const asStringList = (value: unknown): readonly string[] | undefined => {
	if (typeof value === "string") return normalizeLabels(value).values;
	if (!Array.isArray(value)) return undefined;
	return normalizeLabels(value.filter((entry): entry is string => typeof entry === "string"))
		.values;
};

const asRecordArray = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.flatMap((entry) => {
				const record = recordValue(entry);
				return Object.keys(record).length === 0 ? [] : [record];
			})
		: [];

function asFiles(value: unknown): { dataBase64: string; path: string }[] {
	return asRecordArray(value).flatMap((entry) => {
		const path = normalizeText(entry.path);
		const dataBase64 = normalizeText(entry.dataBase64 ?? entry.base64);
		return path.length === 0 || dataBase64.length === 0 ? [] : [{ dataBase64, path }];
	});
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reclassify should replace stale heuristic labels, not append to them. A row only counts as
 * updated when the persisted description or labels actually change; a fallback profile that
 * matches the stored row is a no-op.
 */
function hasProfileChanges(
	item: {
		readonly description: string;
		readonly emotions: readonly string[];
		readonly keywords: readonly string[];
	},
	profile: {
		readonly description: string;
		readonly emotions: readonly string[];
		readonly keywords: readonly string[];
	},
): boolean {
	return (
		item.description !== profile.description ||
		!sameLabels(item.emotions, profile.emotions) ||
		!sameLabels(item.keywords, profile.keywords)
	);
}

function settingBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingNumber(record: Record<string, unknown>, key: string, fallback: number): number {
	const value = asNumber(record[key]);
	return value === undefined ? fallback : value;
}

function concurrencySetting(
	record: Record<string, unknown>,
	settings: Record<string, unknown>,
	key: "importConcurrency" | "semanticConcurrency",
): number {
	return clampConcurrency(asNumber(record[key]) ?? asNumber(settings[key]));
}

function enumValue<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
	return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function optionalOverride(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		if (Object.hasOwn(record, key)) {
			return normalizeText(record[key]);
		}
	}
	return undefined;
}

async function configuredClassifier(
	context: PluginContext,
	record: Record<string, unknown> = {},
): Promise<StickerSemanticClassifier> {
	const settings = recordValue((await context.settings?.get()) ?? {});
	const mode = normalizeText(record.semanticMode ?? record.mode) || undefined;
	const providerId = optionalOverride(record, ["semanticProviderId", "providerId"]);
	const modelId = optionalOverride(record, ["semanticModel", "modelId"]);
	return await resolveSemanticClassifier(settings, {
		logger: context.logger,
		...(mode === undefined ? {} : { mode }),
		...(modelId === undefined ? {} : { modelId }),
		models: context.models,
		...(providerId === undefined ? {} : { providerId }),
	});
}

function asItemPatch(input: Record<string, unknown>) {
	const reviewStatus = stickerReviewStatusSchema.safeParse(input.reviewStatus);
	const packId =
		typeof input.packId === "string" && input.packId.trim().length > 0
			? input.packId.trim()
			: undefined;
	const description = typeof input.description === "string" ? input.description : undefined;
	const enabled = asBoolean(input.enabled);
	const emotions = asStringList(input.emotions);
	const keywords = asStringList(input.keywords);
	const name = typeof input.name === "string" ? input.name : undefined;
	const revokedAt =
		typeof input.revokedAt === "string" || input.revokedAt === null
			? (input.revokedAt as string | null)
			: undefined;
	const score =
		typeof input.score === "number" && Number.isFinite(input.score) ? input.score : undefined;
	return {
		...(description === undefined ? {} : { description }),
		...(enabled === undefined ? {} : { enabled }),
		...(emotions === undefined ? {} : { emotions }),
		...(keywords === undefined ? {} : { keywords }),
		...(name === undefined ? {} : { name }),
		...(packId === undefined ? {} : { packId }),
		...(reviewStatus.success ? { reviewStatus: reviewStatus.data } : {}),
		...(revokedAt === undefined ? {} : { revokedAt }),
		...(score === undefined ? {} : { score }),
	};
}

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerStickerRpc(context: PluginContext, services: ServiceBag): void {
	const { importService, learning, onSettled, repository, selection, urlImport } = services;
	const logger = services.logger ?? context.logger;
	const rpc = {
		list(): readonly { readonly method: string }[] {
			return context.rpc.list();
		},
		register(method: string, handler: PluginRpcHandler): () => void {
			return context.rpc.register(method, async (input) => {
				const startedAt = Date.now();
				traceLog(logger, "sticker rpc invoked", { procedure: method });
				try {
					const result = await handler(input);
					logger.debug("sticker rpc completed", {
						durationMs: elapsedMs(startedAt),
						procedure: method,
						...resultCounts(result),
					});
					return result;
				} catch (error) {
					logger.warn("sticker rpc failed", {
						durationMs: elapsedMs(startedAt),
						error: logErrorMessage(error),
						procedure: method,
					});
					throw error;
				}
			});
		},
	};
	const tracker = new StickerProgressTracker({
		context,
		...(onSettled === undefined ? {} : { onSettled }),
	});
	const importClassifier = async (
		record: Record<string, unknown> = {},
	): Promise<StickerSemanticClassifier> => await configuredClassifier(context, record);

	rpc.register("progress", async () => ({ active: tracker.current(), jobs: tracker.jobs() }));

	rpc.register("packs.list", async () => {
		const packs = await repository.listPacks();
		const items = await repository.listItems();
		return {
			packs: packs.map((pack) => ({
				...pack,
				itemCount: items.filter((item) => item.packId === pack.id).length,
			})),
		};
	});

	rpc.register("packs.save", async (input) => {
		const record = recordValue(input);
		const name = normalizeText(record.name);
		if (name.length === 0) throw new Error("Pack name is required");
		const source = stickerPackSourceSchema.safeParse(record.source);
		const id = normalizeText(record.id);
		const enabled = asBoolean(record.enabled);
		const personaIds = asStringList(record.personaIds);
		const tags = asStringList(record.tags);
		return await repository.savePack({
			...(id.length === 0 ? {} : { id }),
			...(enabled === undefined ? {} : { enabled }),
			...(record.metadata === undefined ? {} : { metadata: recordValue(record.metadata) }),
			name,
			...(personaIds === undefined ? {} : { personaIds }),
			...(source.success ? { source: source.data } : {}),
			...(tags === undefined ? {} : { tags }),
		});
	});

	rpc.register("packs.toggle", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		if (packId.length === 0) throw new Error("packId is required");
		const pack = await repository.togglePack(packId, record.enabled === true);
		if (pack === undefined) throw new Error("Pack not found");
		return pack;
	});

	rpc.register("packs.delete", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		if (packId.length === 0) throw new Error("packId is required");
		if (record.confirm !== true) {
			throw new Error("Pack deletion requires explicit confirmation");
		}
		const pack = await repository.getPack(packId);
		if (pack === undefined) throw new Error("Pack not found");
		const itemCount = (await repository.listItems(packId)).length;
		await repository.deletePack(packId);
		await context.audit?.record({
			action: "sticker.pack.deleted",
			actorKind: "user",
			payload: { itemCount, packId },
			result: "ok",
			targetId: packId,
			targetKind: "sticker-pack",
		});
		return { deleted: true };
	});

	rpc.register("packs.importDir", async (input) => {
		const record = recordValue(input);
		const directory = normalizeText(record.directory ?? record.path);
		if (directory.length === 0) throw new Error("directory is required");
		const settings = recordValue((await context.settings?.get()) ?? {});
		const dryRun = record.dryRun === true;
		const jobId = tracker.start({ dryRun, kind: "packs.importDir", stage: "fetching" });
		try {
			const report = await importService.importDirectory({
				classifier: await importClassifier(record),
				directory,
				dryRun,
				importConcurrency: concurrencySetting(record, settings, "importConcurrency"),
				onProgress: (progress) => tracker.update(jobId, progress),
				semanticConcurrency: concurrencySetting(record, settings, "semanticConcurrency"),
				source: "webui",
			});
			await tracker.complete(jobId, {
				current: report.items,
				skipped: report.missingMedia,
				total: report.items,
			});
			return report;
		} catch (error) {
			await tracker.fail(jobId, error);
			throw error;
		}
	});

	rpc.register("packs.importBundle", async (input) => {
		const record = recordValue(input);
		const settings = recordValue((await context.settings?.get()) ?? {});
		const dryRun = record.dryRun === true;
		const importConcurrency = concurrencySetting(record, settings, "importConcurrency");
		const semanticConcurrency = concurrencySetting(record, settings, "semanticConcurrency");
		const zip = normalizeText(record.bundleBase64 ?? record.zipBase64);
		const jobId = tracker.start({ dryRun, kind: "packs.importBundle", stage: "fetching" });
		try {
			const report =
				zip.length > 0
					? await importService.importZip({
							bytes: new Uint8Array(Buffer.from(zip, "base64")),
							classifier: await importClassifier(record),
							dryRun,
							importConcurrency,
							onProgress: (progress) => tracker.update(jobId, progress),
							semanticConcurrency,
							source: "webui",
						})
					: await importService.importBundle({
							classifier: await importClassifier(record),
							dryRun,
							files: filesFromBundle(asFiles(record.files)),
							importConcurrency,
							manifest: record.manifest ?? record,
							onProgress: (progress) => tracker.update(jobId, progress),
							semanticConcurrency,
							source: "webui",
						});
			await tracker.complete(jobId, {
				current: report.items,
				skipped: report.missingMedia,
				total: report.items,
			});
			return report;
		} catch (error) {
			await tracker.fail(jobId, error);
			throw error;
		}
	});

	rpc.register("packs.importDsh", async (input) => {
		const record = recordValue(input);
		const directory = normalizeText(record.directory ?? record.path);
		if (directory.length === 0) throw new Error("directory is required");
		const settings = recordValue((await context.settings?.get()) ?? {});
		const dryRun = record.dryRun === true;
		const jobId = tracker.start({ dryRun, kind: "packs.importDsh", stage: "fetching" });
		try {
			const report = await importService.importDshDirectory({
				classifier: await importClassifier(record),
				directory,
				dryRun,
				importConcurrency: concurrencySetting(record, settings, "importConcurrency"),
				onProgress: (progress) => tracker.update(jobId, progress),
				semanticConcurrency: concurrencySetting(record, settings, "semanticConcurrency"),
			});
			await tracker.complete(jobId, {
				current: report.items,
				skipped: report.missingMedia,
				total: report.items,
			});
			return report;
		} catch (error) {
			await tracker.fail(jobId, error);
			throw error;
		}
	});

	/**
	 * Classifies stored items with a bounded worker pool. Runs as its own tracked job so it can
	 * execute concurrently with imports instead of blocking them.
	 */
	const reclassifySemantics = async (
		jobId: string,
		record: Record<string, unknown>,
	): Promise<{ classifier: string; skipped: number; updated: number }> => {
		try {
			const media = context.media;
			if (media === undefined) throw new Error("Host media bridge is unavailable");
			const mediaApi = media;
			const packId = normalizeText(record.packId);
			const settings = recordValue((await context.settings?.get()) ?? {});
			const semanticConcurrency = concurrencySetting(record, settings, "semanticConcurrency");
			const packs = new Map((await repository.listPacks()).map((pack) => [pack.id, pack]));
			const items = await repository.listItems(packId.length === 0 ? undefined : packId);
			const targetTitle = packId.length > 0 ? packs.get(packId)?.name : undefined;
			tracker.update(jobId, {
				...(targetTitle === undefined ? {} : { packTitle: targetTitle }),
				current: 0,
				stage: "classifying",
				total: items.length,
			});
			const classifier = await importClassifier(record);
			const limit = pLimit(semanticConcurrency);
			let updated = 0;
			let skipped = 0;
			let processed = 0;
			await limit.map(items, async (item) => {
				tracker.update(jobId, {
					classified: updated,
					current: processed,
					currentItem: item.name,
					skipped,
					stage: "classifying",
				});
				let bytes: Uint8Array | undefined;
				let classify = false;
				if (item.mediaId.length > 0) {
					const isImage = item.mimeType.startsWith("image/");
					if (isImage) {
						classify = true;
						try {
							bytes = await mediaApi.readBytes(item.mediaId);
						} catch {
							classify = false;
						}
					}
				}
				if (!classify) {
					skipped += 1;
				} else {
					const profile = await classifier.classify({
						...(bytes === undefined ? {} : { bytes }),
						...(item.semantic.emoji === undefined ? {} : { emoji: item.semantic.emoji }),
						mimeType: item.mimeType,
						title: packs.get(item.packId)?.name ?? item.name,
					});
					const changed = hasProfileChanges(item, profile);
					if (changed) {
						tracker.update(jobId, {
							classified: updated,
							current: processed,
							currentItem: item.name,
							skipped,
							stage: "saving",
						});
						await repository.updateItem(item.id, {
							description: profile.description,
							emotions: [...profile.emotions],
							keywords: [...profile.keywords],
							semantic: profile,
						});
						updated += 1;
					} else {
						skipped += 1;
					}
				}
				processed += 1;
				tracker.update(jobId, {
					classified: updated,
					current: processed,
					currentItem: item.name,
					skipped,
					stage: "saving",
				});
			});
			await context.audit?.record({
				action: "sticker.semantic.reclassified",
				actorKind: "user",
				payload: {
					classifier: classifier.name,
					packId: packId.length === 0 ? null : packId,
					updated,
				},
				result: "ok",
				...(packId.length === 0 ? {} : { targetId: packId }),
				targetKind: "sticker-pack",
			});
			await tracker.complete(jobId, {
				classified: updated,
				current: items.length,
				skipped,
				total: items.length,
			});
			return { classifier: classifier.name, skipped, updated };
		} catch (error) {
			await tracker.fail(jobId, error);
			throw error;
		}
	};

	rpc.register("telegram.import", async (input) => {
		const record = recordValue(input);
		const reference = normalizeText(record.url ?? record.reference ?? record.setName);
		if (reference.length === 0) throw new Error("Telegram sticker set URL or name is required");
		const media = context.media;
		if (media === undefined) throw new Error("Host media bridge is unavailable");
		const settings = recordValue((await context.settings?.get()) ?? {});
		const token = normalizeText(record.token) || normalizeText(settings.telegramBotToken);
		if (token.length === 0) {
			throw new Error(
				"Telegram bot token is not configured. Set telegramBotToken or TSUKAIMA_TELEGRAM_BOT_TOKEN.",
			);
		}
		const apiBaseUrl =
			normalizeText(record.apiBaseUrl) || normalizeText(settings.telegramApiBaseUrl);
		const client = new TelegramStickerClient({
			...(apiBaseUrl.length === 0 ? {} : { apiBaseUrl }),
			logger,
			token,
		});
		const service = new TelegramStickerImportService({ client, logger, media, repository });
		const dryRun = record.dryRun === true;
		const deferSemantic = record.deferSemantic === true || record.backgroundSemantic === true;
		const jobId = tracker.start({ dryRun, kind: "telegram.import", stage: "fetching" });
		try {
			const report = await service.importReference(reference, {
				animatedFormat: enumValue(
					normalizeText(record.animatedFormat) ||
						normalizeText(settings.telegramAnimatedFormat, "gif"),
					["gif", "thumbnail"] as const,
					"gif",
				),
				animatedFps: settingNumber(
					record,
					"animatedFps",
					settingNumber(settings, "telegramAnimatedFps", 15),
				),
				animatedMaxFrames: settingNumber(
					record,
					"animatedMaxFrames",
					settingNumber(settings, "telegramAnimatedMaxFrames", 50),
				),
				classifier: await importClassifier(record),
				deferSemantic,
				dryRun,
				importConcurrency: concurrencySetting(record, settings, "importConcurrency"),
				includeAnimated: settingBoolean(
					record,
					"includeAnimated",
					settingBoolean(settings, "telegramIncludeAnimated", true),
				),
				includeVideo: settingBoolean(
					record,
					"includeVideo",
					settingBoolean(settings, "telegramIncludeVideo", true),
				),
				maxStickers: Math.floor(
					settingNumber(record, "maxStickers", settingNumber(settings, "telegramMaxStickers", 200)),
				),
				onProgress: (progress) => tracker.update(jobId, progress),
				semanticConcurrency: concurrencySetting(record, settings, "semanticConcurrency"),
				videoFormat: enumValue(
					normalizeText(record.videoFormat) || normalizeText(settings.telegramVideoFormat, "gif"),
					["gif", "thumbnail"] as const,
					"gif",
				),
			});
			await context.audit?.record({
				action: "sticker.telegram.imported",
				actorKind: "user",
				payload: {
					deduped: report.deduped,
					dryRun: report.dryRun,
					items: report.items,
					setName: report.setName,
					skipped: report.skipped,
				},
				result: "ok",
				targetId: report.setName,
				targetKind: "telegram-sticker-set",
			});
			if (!dryRun && report.semanticDeferred === true && report.packIds[0] !== undefined) {
				const semanticJobId = tracker.start({
					kind: "semantic.reclassify",
					packTitle: report.title,
					stage: "classifying",
				});
				void reclassifySemantics(semanticJobId, { ...record, packId: report.packIds[0] }).catch(
					(error) => {
						logger.warn("sticker deferred semantic classification failed", {
							error: logErrorMessage(error),
							packId: report.packIds[0],
						});
					},
				);
			}
			await tracker.complete(jobId, {
				classified: report.classified,
				current: report.items,
				packTitle: report.title,
				skipped: report.skipped,
				total: report.items,
			});
			return report;
		} catch (error) {
			await tracker.fail(jobId, error);
			throw error;
		}
	});

	rpc.register("semantic.reclassify", async (input) => {
		const record = recordValue(input);
		const jobId = tracker.start({ kind: "semantic.reclassify", stage: "classifying" });
		return await reclassifySemantics(jobId, record);
	});

	rpc.register("semantic.models", async () => {
		const all = await context.models.listModels();
		const sorted = [...all].toSorted((left, right) => {
			const leftVision = isVisionCapablePluginModel(left);
			const rightVision = isVisionCapablePluginModel(right);
			if (leftVision !== rightVision) return leftVision ? -1 : 1;
			return `${left.providerId}/${left.id}`.localeCompare(`${right.providerId}/${right.id}`);
		});
		const settings = recordValue((await context.settings?.get()) ?? {});
		return {
			configuredCustom:
				normalizeText(settings.semanticApiKey).length > 0 &&
				normalizeText(settings.semanticModel).length > 0,
			models: sorted.map((model) => ({
				capabilities: model.capabilities,
				id: model.id,
				input: model.input ?? ["text"],
				name: model.name ?? model.id,
				...(model.pluginId === undefined ? {} : { pluginId: model.pluginId }),
				providerId: model.providerId,
				supportsImage: isVisionCapablePluginModel(model),
			})),
		};
	});

	rpc.register("semantic.categories", async () => ({
		categories: STICKER_SEMANTIC_CATEGORIES.map((category) => ({
			id: category.id,
			kind: category.kind,
		})),
	}));

	rpc.register("packs.export", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		const result = await importService.exportPacks(packId.length === 0 ? undefined : packId);
		return {
			files: bundleFilesResponse(result.files),
			manifest: result.manifest,
			warnings: result.warnings,
		};
	});

	rpc.register("items.list", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId);
		const items = await repository.listItems(packId.length === 0 ? undefined : packId);
		return { items };
	});

	rpc.register("hints", async (input) => {
		const record = recordValue(input);
		const limit = asNumber(record.limit) ?? 3;
		const hints = await repository.listCaptionHints(limit);
		let packs: Array<{ name: string; itemCount: number }> = [];
		if (selection !== undefined) {
			const available = await selection.listAvailablePacks();
			packs = available
				.filter((pack) => pack.itemCount > 0)
				.slice(0, 10)
				.map((pack) => ({ itemCount: pack.itemCount, name: pack.name }));
		} else {
			const packList = await repository.listPacks();
			const items = await repository.listItems();
			packs = packList
				.filter((pack) => pack.enabled)
				.map((pack) => ({
					itemCount: items.filter(
						(item) =>
							item.packId === pack.id &&
							item.enabled &&
							item.revokedAt === null &&
							item.reviewStatus === "approved" &&
							item.mediaId.length > 0,
					).length,
					name: pack.name,
				}))
				.filter((pack) => pack.itemCount > 0)
				.slice(0, 10);
		}
		const settings = recordValue((await context.settings?.get()) ?? {});
		const prompt =
			packs.length > 0 || hints.length > 0 ? resolveStickerDecisionPrompt(settings) : undefined;
		return {
			captions: hints.map((hint) => hint.caption),
			packs,
			...(prompt === undefined ? {} : { prompt }),
		};
	});

	rpc.register("items.update", async (input) => {
		const record = recordValue(input);
		const id = normalizeText(record.id ?? record.itemId);
		if (id.length === 0) throw new Error("id is required");
		const patch = asItemPatch(record);
		if (patch.packId !== undefined && (await repository.getPack(patch.packId)) === undefined) {
			throw new Error("Pack not found");
		}
		const item = await repository.updateItem(id, patch);
		if (item === undefined) throw new Error("Item not found");
		await context.audit?.record({
			action: "sticker.item.updated",
			actorKind: "user",
			payload: { itemId: item.id },
			result: "ok",
			targetId: item.id,
			targetKind: "sticker-item",
		});
		return item;
	});

	rpc.register("items.delete", async (input) => {
		const record = recordValue(input);
		const id = normalizeText(record.id ?? record.itemId);
		if (id.length === 0) throw new Error("id is required");
		const item = await repository.getItem(id);
		if (item === undefined) throw new Error("Item not found");
		await repository.deleteItem(id);
		await context.audit?.record({
			action: "sticker.item.deleted",
			actorKind: "user",
			payload: { itemId: id, packId: item.packId },
			result: "ok",
			targetId: id,
			targetKind: "sticker-item",
		});
		return { deleted: true };
	});

	rpc.register("candidates.list", async (input) => {
		const record = recordValue(input);
		const status = stickerReviewStatusSchema.safeParse(record.status);
		const items = await repository.listItems();
		return {
			items: items.filter((item) =>
				status.success ? item.reviewStatus === status.data : item.reviewStatus === "pending",
			),
		};
	});

	rpc.register("candidates.review", async (input) => {
		const record = recordValue(input);
		const id = normalizeText(record.id ?? record.itemId);
		const action = normalizeText(record.action);
		if (id.length === 0) throw new Error("id is required");
		if (action === "delete") {
			await repository.deleteItem(id);
			await context.audit?.record({
				action: "sticker.candidate.deleted",
				actorKind: "user",
				payload: { itemId: id },
				result: "ok",
				targetId: id,
				targetKind: "sticker-item",
			});
			return { deleted: true };
		}
		if (action !== "approve" && action !== "reject") {
			throw new Error("action must be approve, reject, or delete");
		}
		const item = await repository.updateItem(id, {
			reviewStatus: action === "approve" ? "approved" : "rejected",
		});
		if (item === undefined) throw new Error("Candidate not found");
		await context.audit?.record({
			action: action === "approve" ? "sticker.candidate.approved" : "sticker.candidate.rejected",
			actorKind: "user",
			payload: { itemId: item.id, packId: item.packId },
			result: "ok",
			targetId: item.id,
			targetKind: "sticker-item",
		});
		return item;
	});

	rpc.register("stats", async () => {
		const stats = await repository.stats();
		const packs = await repository.listPacks();
		const items = await repository.listItems();
		return {
			...stats,
			packs: stats.packs,
			usageByPack: packs.map((pack) => ({
				itemCount: items.filter((item) => item.packId === pack.id).length,
				packId: pack.id,
				sends: items
					.filter((item) => item.packId === pack.id)
					.reduce((total, item) => total + item.useCount, 0),
			})),
		};
	});

	rpc.register("learn", async (input) => {
		const record = recordValue(input);
		const bytesBase64 = normalizeText(record.bytesBase64 ?? record.base64);
		const description = typeof record.description === "string" ? record.description : undefined;
		const emotions = asStringList(record.emotions);
		const keywords = asStringList(record.keywords);
		const mediaId = normalizeText(record.mediaId);
		const mimeType = normalizeText(record.mimeType);
		const name = normalizeText(record.name);
		const packId = normalizeText(record.packId);
		const sourceConversationId = normalizeText(record.sourceConversationId);
		const result = await learning.learn({
			...(bytesBase64.length === 0 ? {} : { bytesBase64 }),
			...(description === undefined ? {} : { description }),
			...(emotions === undefined ? {} : { emotions }),
			...(keywords === undefined ? {} : { keywords }),
			...(mediaId.length === 0 ? {} : { mediaId }),
			...(mimeType.length === 0 ? {} : { mimeType }),
			...(name.length === 0 ? {} : { name }),
			...(packId.length === 0 ? {} : { packId }),
			source: record.source === "generated" ? "generated" : "admin",
			...(sourceConversationId.length === 0 ? {} : { sourceConversationId }),
		});
		return result;
	});

	rpc.register("preview", async (input) => {
		const record = recordValue(input);
		let mediaId = normalizeText(record.mediaId);
		let mimeType = normalizeText(record.mimeType, "image/png");
		if (mediaId.length === 0) {
			const itemId = normalizeText(record.itemId ?? record.id);
			if (itemId.length === 0) throw new Error("itemId or mediaId is required");
			const item = await repository.getItem(itemId);
			if (item === undefined) throw new Error("Item not found");
			mediaId = item.mediaId;
			mimeType = item.mimeType;
		}
		const bytes = await context.media?.readBytes(mediaId);
		if (bytes === undefined) throw new Error("Media is unavailable");
		return { dataBase64: encodeBase64(bytes), mediaId, mimeType };
	});

	rpc.register("items.importUrl", async (input) => {
		if (urlImport === undefined) {
			throw new Error("URL import service is unavailable");
		}
		const record = recordValue(input);
		const url = normalizeText(record.url);
		if (url.length === 0) throw new Error("url is required");
		const name = normalizeText(record.name);
		const packId = normalizeText(record.packId);
		const description = typeof record.description === "string" ? record.description : undefined;
		const emotions = asStringList(record.emotions);
		const keywords = asStringList(record.keywords);
		const fps = asNumber(record.fps);
		const maxFrames = asNumber(record.maxFrames);
		const width = asNumber(record.width);
		const skipClassifier = record.classify === false;
		const classifier = skipClassifier ? undefined : await importClassifier(record);
		const result = await urlImport.importUrl({
			...(record.approve === undefined ? {} : { approve: record.approve === true }),
			...(classifier === undefined ? {} : { classifier }),
			...(fps === undefined && maxFrames === undefined && width === undefined
				? {}
				: {
						conversion: {
							...(fps === undefined ? {} : { fps }),
							...(maxFrames === undefined ? {} : { maxFrames }),
							...(width === undefined ? {} : { width }),
						},
					}),
			...(description === undefined ? {} : { description }),
			...(emotions === undefined ? {} : { emotions }),
			...(keywords === undefined ? {} : { keywords }),
			...(name.length === 0 ? {} : { name }),
			...(packId.length === 0 ? {} : { packId }),
			url,
		});
		await onSettled?.();
		return result;
	});

	rpc.register("qq.recentMedia", async (input) => {
		const conversations = context.conversations;
		if (conversations === undefined) {
			return { items: [] };
		}
		const record = recordValue(input);
		const filterConversationId = normalizeText(record.conversationId);
		const limit = Math.max(1, Math.min(80, Math.floor(asNumber(record.limit) ?? 40)));
		const allConversations = await conversations.list();
		const targetConversations = allConversations
			.filter((conv) => {
				if (filterConversationId.length > 0) return conv.id === filterConversationId;
				const cid = conv.channelId ?? "";
				return cid === "onebot-napcat" || cid.includes("qq");
			})
			.slice(0, 15);
		const existingItems = await repository.listItems();
		const existingByHash = new Map(existingItems.map((item) => [item.hash, item.id]));
		const seenMediaIds = new Set<string>();
		const collected: Array<{
			readonly alreadyInLibrary: boolean;
			readonly channelId: string;
			readonly conversationId: string;
			readonly conversationTitle: string;
			readonly createdAt: string;
			readonly existingItemId?: string;
			readonly mediaId: string;
			readonly messageId: string;
			readonly mimeType: string;
			readonly partType: "image" | "sticker";
			readonly previewText?: string;
			readonly sha256?: string;
		}> = [];
		const messageLists = await Promise.all(
			targetConversations.map(async (conv) => ({
				conv,
				messages: await conversations.recentMessages(conv.id, 30),
			})),
		);
		for (const { conv, messages } of messageLists) {
			for (const message of messages) {
				for (const part of message.parts ?? []) {
					if (part.type !== "sticker" && part.type !== "image") continue;
					if (part.mediaId === undefined || part.mediaId.length === 0) continue;
					if (seenMediaIds.has(part.mediaId)) continue;
					seenMediaIds.add(part.mediaId);
					const existingItemId =
						part.sha256 !== undefined ? existingByHash.get(part.sha256) : undefined;
					collected.push({
						alreadyInLibrary: existingItemId !== undefined,
						channelId: conv.channelId ?? "unknown",
						conversationId: conv.id,
						conversationTitle: conv.title,
						createdAt: message.occurredAt,
						...(existingItemId === undefined ? {} : { existingItemId }),
						mediaId: part.mediaId,
						messageId: message.platformMessageId ?? message.id,
						mimeType: part.mimeType ?? "image/png",
						partType: part.type,
						...(part.previewText === undefined ? {} : { previewText: part.previewText }),
						...(part.sha256 === undefined ? {} : { sha256: part.sha256 }),
					});
				}
			}
		}
		collected.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
		return { items: collected.slice(0, limit) };
	});

	rpc.register("qq.steal", async (input) => {
		const record = recordValue(input);
		const mediaId = normalizeText(record.mediaId);
		const sha256 = normalizeText(record.sha256);
		if (mediaId.length === 0 && sha256.length === 0) {
			throw new Error("mediaId or sha256 is required");
		}
		const name = normalizeText(record.name);
		const packId = normalizeText(record.packId);
		const mimeType = normalizeText(record.mimeType);
		const sourceConversationId = normalizeText(
			record.sourceConversationId ?? record.conversationId,
		);
		const description = typeof record.description === "string" ? record.description : undefined;
		const emotions = asStringList(record.emotions);
		const keywords = asStringList(record.keywords);
		const skipClassifier = record.classify === false;
		const classifier = skipClassifier ? undefined : await importClassifier(record);
		const result = await learning.stealMedia({
			...(record.approve === undefined ? {} : { approve: record.approve === true }),
			...(classifier === undefined ? {} : { classifier }),
			...(description === undefined ? {} : { description }),
			...(emotions === undefined ? {} : { emotions }),
			...(keywords === undefined ? {} : { keywords }),
			...(mediaId.length === 0 ? {} : { mediaId }),
			...(mimeType.length === 0 ? {} : { mimeType }),
			...(name.length === 0 ? {} : { name }),
			...(packId.length === 0 ? {} : { packId }),
			...(sha256.length === 0 ? {} : { sha256 }),
			...(sourceConversationId.length === 0 ? {} : { sourceConversationId }),
		});
		await onSettled?.();
		return result;
	});
}
