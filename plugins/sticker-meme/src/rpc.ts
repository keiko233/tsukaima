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
import type { StickerRepository } from "./repository.ts";

interface ServiceBag {
	readonly importService: StickerImportService;
	readonly learning: LearningService;
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
	const { importService, learning, repository } = services;

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
		return await importService.importDirectory({
			directory,
			dryRun: record.dryRun === true,
			source: "webui",
		});
	});

	context.rpc.register("packs.importBundle", async (input) => {
		const record = recordValue(input);
		const dryRun = record.dryRun === true;
		const zip = normalizeText(record.bundleBase64 ?? record.zipBase64);
		if (zip.length > 0) {
			return await importService.importZip({
				bytes: new Uint8Array(Buffer.from(zip, "base64")),
				dryRun,
				source: "webui",
			});
		}
		return await importService.importBundle({
			dryRun,
			files: filesFromBundle(asFiles(record.files)),
			manifest: record.manifest ?? record,
			source: "webui",
		});
	});

	context.rpc.register("packs.importDsh", async (input) => {
		const record = recordValue(input);
		const directory = normalizeText(record.directory ?? record.path);
		if (directory.length === 0) throw new Error("directory is required");
		return await importService.importDshDirectory({ directory, dryRun: record.dryRun === true });
	});

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
