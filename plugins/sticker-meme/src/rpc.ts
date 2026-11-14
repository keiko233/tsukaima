import type { PluginContext } from "@tsukaima/sdk";
import { encodeBase64 } from "./archive.ts";
import {
	normalizeLabels,
	normalizeText,
	recordValue,
	stickerPackSourceSchema,
	stickerReviewStatusSchema,
} from "./domain.ts";
import type { LearningService } from "./learning.ts";
import {
	bundleFilesResponse,
	filesFromBundle,
	type StickerImportService,
} from "./import-service.ts";
import { StickerProgressTracker } from "./progress.ts";
import type { StickerRepository } from "./repository.ts";
import {
	isVisionCapablePluginModel,
	resolveSemanticClassifier,
	STICKER_SEMANTIC_CATEGORIES,
	type StickerSemanticClassifier,
} from "./semantic.ts";
import { TelegramStickerClient } from "./telegram.ts";
import { TelegramStickerImportService } from "./telegram-import.ts";

interface ServiceBag {
	readonly importService: StickerImportService;
	readonly learning: LearningService;
	readonly onSettled?: () => Promise<void>;
	readonly repository: StickerRepository;
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

function settingBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : fallback;
}

function settingNumber(record: Record<string, unknown>, key: string, fallback: number): number {
	const value = asNumber(record[key]);
	return value === undefined ? fallback : value;
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
		...(reviewStatus.success ? { reviewStatus: reviewStatus.data } : {}),
		...(revokedAt === undefined ? {} : { revokedAt }),
		...(score === undefined ? {} : { score }),
	};
}

/** Registers the admin/WebUI procedure surface. The host adds the plugin-id namespace. */
export function registerStickerRpc(context: PluginContext, services: ServiceBag): void {
	const { importService, learning, onSettled, repository } = services;
	const tracker = new StickerProgressTracker({
		context,
		...(onSettled === undefined ? {} : { onSettled }),
	});
	const importClassifier = async (
		record: Record<string, unknown> = {},
	): Promise<StickerSemanticClassifier> => await configuredClassifier(context, record);

	context.rpc.register("progress", async () => ({ active: tracker.current() }));

	context.rpc.register("packs.list", async () => {
		const packs = await repository.listPacks();
		const items = await repository.listItems();
		return {
			packs: packs.map((pack) => ({
				...pack,
				itemCount: items.filter((item) => item.packId === pack.id).length,
			})),
		};
	});

	context.rpc.register("packs.save", async (input) => {
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

	context.rpc.register("packs.toggle", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		if (packId.length === 0) throw new Error("packId is required");
		const pack = await repository.togglePack(packId, record.enabled === true);
		if (pack === undefined) throw new Error("Pack not found");
		return pack;
	});

	context.rpc.register("packs.delete", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		if (packId.length === 0) throw new Error("packId is required");
		if (record.confirm !== true || record.backup !== true) {
			throw new Error("Pack deletion requires explicit confirmation and a backup flag");
		}
		const backup = await importService.exportPacks(packId);
		await repository.deletePack(packId);
		await context.audit?.record({
			action: "sticker.pack.deleted",
			actorKind: "user",
			payload: { itemCount: backup.manifest.packs[0]?.items.length ?? 0, packId },
			result: "ok",
			targetId: packId,
			targetKind: "sticker-pack",
		});
		return {
			backup: {
				files: bundleFilesResponse(backup.files),
				manifest: backup.manifest,
			},
			deleted: true,
		};
	});

	context.rpc.register("packs.importDir", async (input) => {
		const record = recordValue(input);
		const directory = normalizeText(record.directory ?? record.path);
		if (directory.length === 0) throw new Error("directory is required");
		const dryRun = record.dryRun === true;
		const jobId = tracker.start({ dryRun, kind: "packs.importDir", stage: "fetching" });
		try {
			const report = await importService.importDirectory({
				classifier: await importClassifier(record),
				directory,
				dryRun,
				onProgress: (progress) => tracker.update(jobId, progress),
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

	context.rpc.register("packs.importBundle", async (input) => {
		const record = recordValue(input);
		const dryRun = record.dryRun === true;
		const zip = normalizeText(record.bundleBase64 ?? record.zipBase64);
		const jobId = tracker.start({ dryRun, kind: "packs.importBundle", stage: "fetching" });
		try {
			const report =
				zip.length > 0
					? await importService.importZip({
							bytes: new Uint8Array(Buffer.from(zip, "base64")),
							classifier: await importClassifier(record),
							dryRun,
							onProgress: (progress) => tracker.update(jobId, progress),
							source: "webui",
						})
					: await importService.importBundle({
							classifier: await importClassifier(record),
							dryRun,
							files: filesFromBundle(asFiles(record.files)),
							manifest: record.manifest ?? record,
							onProgress: (progress) => tracker.update(jobId, progress),
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

	context.rpc.register("packs.importDsh", async (input) => {
		const record = recordValue(input);
		const directory = normalizeText(record.directory ?? record.path);
		if (directory.length === 0) throw new Error("directory is required");
		const dryRun = record.dryRun === true;
		const jobId = tracker.start({ dryRun, kind: "packs.importDsh", stage: "fetching" });
		try {
			const report = await importService.importDshDirectory({
				classifier: await importClassifier(record),
				directory,
				dryRun,
				onProgress: (progress) => tracker.update(jobId, progress),
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

	context.rpc.register("telegram.import", async (input) => {
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
			token,
		});
		const service = new TelegramStickerImportService({ client, media, repository });
		const dryRun = record.dryRun === true;
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
				dryRun,
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
				videoFormat: enumValue(
					normalizeText(record.videoFormat) || normalizeText(settings.telegramVideoFormat, "gif"),
					["gif", "thumbnail", "webm"] as const,
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

	context.rpc.register("semantic.reclassify", async (input) => {
		const record = recordValue(input);
		const media = context.media;
		if (media === undefined) throw new Error("Host media bridge is unavailable");
		const packId = normalizeText(record.packId);
		const packs = new Map((await repository.listPacks()).map((pack) => [pack.id, pack]));
		const items = await repository.listItems(packId.length === 0 ? undefined : packId);
		const targetTitle = packId.length > 0 ? packs.get(packId)?.name : undefined;
		const jobId = tracker.start({
			kind: "semantic.reclassify",
			...(targetTitle === undefined ? {} : { packTitle: targetTitle }),
			stage: "classifying",
			total: items.length,
		});
		try {
			const classifier = await importClassifier(record);
			let updated = 0;
			let skipped = 0;
			for (const [index, item] of items.entries()) {
				tracker.update(jobId, {
					classified: updated,
					current: index,
					currentItem: item.name,
					skipped,
					stage: "classifying",
					total: items.length,
				});
				if (item.mediaId.length === 0) {
					skipped += 1;
					tracker.update(jobId, { classified: updated, current: index + 1, skipped });
					continue;
				}
				const isImage = item.mimeType.startsWith("image/");
				if (!isImage && item.mimeType !== "video/webm") {
					skipped += 1;
					tracker.update(jobId, { classified: updated, current: index + 1, skipped });
					continue;
				}
				let bytes: Uint8Array | undefined;
				if (isImage) {
					try {
						bytes = await media.readBytes(item.mediaId);
					} catch {
						skipped += 1;
						tracker.update(jobId, { classified: updated, current: index + 1, skipped });
						continue;
					}
				}
				const profile = await classifier.classify({
					...(bytes === undefined ? {} : { bytes }),
					...(item.semantic.emoji === undefined ? {} : { emoji: item.semantic.emoji }),
					mimeType: item.mimeType,
					title: packs.get(item.packId)?.name ?? item.name,
				});
				tracker.update(jobId, {
					classified: updated,
					current: index,
					currentItem: item.name,
					skipped,
					stage: "saving",
				});
				await repository.updateItem(item.id, {
					description: profile.description,
					emotions: [...item.emotions, ...profile.emotions],
					keywords: [...item.keywords, ...profile.keywords],
					semantic: profile,
				});
				updated += 1;
				tracker.update(jobId, {
					classified: updated,
					current: index + 1,
					currentItem: item.name,
					skipped,
					stage: "saving",
				});
			}
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
	});

	context.rpc.register("semantic.models", async () => {
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

	context.rpc.register("semantic.categories", async () => ({
		categories: STICKER_SEMANTIC_CATEGORIES.map((category) => ({
			id: category.id,
			kind: category.kind,
		})),
	}));

	context.rpc.register("packs.export", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId ?? record.id);
		const result = await importService.exportPacks(packId.length === 0 ? undefined : packId);
		return {
			files: bundleFilesResponse(result.files),
			manifest: result.manifest,
			warnings: result.warnings,
		};
	});

	context.rpc.register("items.list", async (input) => {
		const record = recordValue(input);
		const packId = normalizeText(record.packId);
		const items = await repository.listItems(packId.length === 0 ? undefined : packId);
		return { items };
	});

	context.rpc.register("items.update", async (input) => {
		const record = recordValue(input);
		const id = normalizeText(record.id ?? record.itemId);
		if (id.length === 0) throw new Error("id is required");
		const item = await repository.updateItem(id, asItemPatch(record));
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

	context.rpc.register("candidates.list", async (input) => {
		const record = recordValue(input);
		const status = stickerReviewStatusSchema.safeParse(record.status);
		const items = await repository.listItems();
		return {
			items: items.filter((item) =>
				status.success ? item.reviewStatus === status.data : item.reviewStatus === "pending",
			),
		};
	});

	context.rpc.register("candidates.review", async (input) => {
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

	context.rpc.register("stats", async () => {
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

	context.rpc.register("learn", async (input) => {
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

	context.rpc.register("preview", async (input) => {
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
}
