import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginLogger, PluginMediaApi, PluginMediaSource } from "@tsukaima/sdk";
import {
	decodeBase64,
	encodeBase64,
	readDirectoryFiles,
	readZipEntries,
	type ImportFile,
} from "./archive.ts";
import {
	EMPTY_SEMANTIC_PROFILE,
	fileExtension,
	inferMimeType,
	normalizeLabels,
	normalizeText,
	parseJson,
	parseSemanticProfile,
	recordValue,
	safeRelativePath,
	sha256Bytes,
	stableId,
	textList,
	type StickerPackSource,
	type StickerReviewStatus,
	type StickerSemanticProfile,
} from "./domain.ts";
import { elapsedMs, logErrorMessage, traceLog } from "./logging.ts";
import { StickerRepository } from "./repository.ts";
import type { StickerSemanticClassifier } from "./semantic.ts";

export interface StickerImportReport {
	readonly deduped: number;
	readonly dryRun: boolean;
	readonly items: number;
	readonly missingMedia: number;
	readonly packIds: readonly string[];
	readonly packs: number;
	readonly warnings: readonly string[];
}

export interface StickerExportResult {
	readonly files: readonly ImportFile[];
	readonly manifest: {
		readonly format: "tsukaima-sticker-pack";
		readonly packs: readonly {
			readonly id: string;
			readonly items: readonly {
				readonly description: string;
				readonly emotions: readonly string[];
				readonly enabled: boolean;
				readonly file: string;
				readonly height?: number;
				readonly id: string;
				readonly keywords: readonly string[];
				readonly mimeType: string;
				readonly name: string;
				readonly score: number;
				readonly semantic?: StickerSemanticProfile;
				readonly width?: number;
			}[];
			readonly metadata?: Record<string, unknown>;
			readonly name: string;
			readonly personaIds: readonly string[];
			readonly source: StickerPackSource;
			readonly tags: readonly string[];
		}[];
		readonly version: 1;
	};
	readonly warnings: readonly string[];
}

interface ManifestItem {
	readonly id?: string;
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly emotions: readonly string[];
	readonly mimeType: string;
	readonly file?: string;
	readonly hash?: string;
	readonly width?: number;
	readonly height?: number;
	readonly enabled: boolean;
	readonly reviewStatus?: StickerReviewStatus;
	readonly score: number;
	readonly semantic?: StickerSemanticProfile;
}

interface ManifestPack {
	readonly id?: string;
	readonly name: string;
	readonly source: StickerPackSource;
	readonly tags: readonly string[];
	readonly personaIds: readonly string[];
	readonly metadata?: Record<string, unknown>;
	readonly items: readonly ManifestItem[];
}

interface ParsedManifest {
	readonly packs: readonly ManifestPack[];
	readonly warnings: readonly string[];
}

const REVIEW_STATUSES: readonly StickerReviewStatus[] = ["approved", "pending", "rejected"];

function asSource(value: unknown): StickerPackSource | undefined {
	return value === "builtin" || value === "imported" || value === "generated" || value === "learned"
		? value
		: undefined;
}

function asReviewStatus(value: unknown): StickerReviewStatus | undefined {
	return REVIEW_STATUSES.find((status) => status === value);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function itemFromRecord(
	value: unknown,
	index: number,
	warnings: string[],
): ManifestItem | undefined {
	const record = recordValue(value);
	const file = normalizeText(record.file ?? record.path ?? record.fileName ?? record.file_name);
	const name = normalizeText(
		record.name ?? record.caption ?? record.label,
		file.split("/").at(-1) ?? "",
	);
	if (name.length === 0) {
		warnings.push(`item ${index + 1} has no name or file`);
		return undefined;
	}
	const safeFile = file.length === 0 ? undefined : safeRelativePath(file);
	if (file.length > 0 && safeFile === undefined) {
		warnings.push(`item ${index + 1} has an unsafe file path`);
	}
	const keywordResult = normalizeLabels(textList(record.keywords ?? record.tags));
	const emotionResult = normalizeLabels(textList(record.emotions ?? record.emotion ?? record.mood));
	if (keywordResult.invalid.length > 0) warnings.push(`item ${index + 1} dropped invalid keywords`);
	if (emotionResult.invalid.length > 0) warnings.push(`item ${index + 1} dropped invalid emotions`);
	const hash = normalizeText(record.hash ?? record.sha256);
	const id = normalizeText(record.id);
	const height = asNumber(record.height);
	const width = asNumber(record.width);
	const reviewStatus = asReviewStatus(record.reviewStatus ?? record.review_status);
	const semantic =
		record.semantic === undefined ? undefined : parseSemanticProfile(record.semantic);
	return {
		description: normalizeText(record.description ?? record.caption),
		emotions: emotionResult.values,
		enabled: record.enabled !== false,
		...(safeFile === undefined ? {} : { file: safeFile }),
		...(hash.length === 0 ? {} : { hash }),
		...(height === undefined ? {} : { height }),
		...(id.length === 0 ? {} : { id }),
		keywords: keywordResult.values,
		mimeType: normalizeText(
			record.mimeType ?? record.mime_type,
			safeFile === undefined ? "image/png" : inferMimeType(safeFile),
		),
		name,
		...(reviewStatus === undefined ? {} : { reviewStatus }),
		score: Math.max(0, asNumber(record.score) ?? 1),
		...(semantic === undefined ? {} : { semantic }),
		...(width === undefined ? {} : { width }),
	};
}

function packFromRecord(
	value: unknown,
	fallbackName: string,
	warnings: string[],
): ManifestPack | undefined {
	const record = recordValue(value);
	const rawItems = Array.isArray(record.items)
		? record.items
		: Array.isArray(record.memes)
			? record.memes
			: Array.isArray(record.stickers)
				? record.stickers
				: [];
	const tags = normalizeLabels(textList(record.tags));
	const personas = normalizeLabels(textList(record.personaIds ?? record.personas));
	if (tags.invalid.length > 0) warnings.push("pack dropped invalid tags");
	if (personas.invalid.length > 0) warnings.push("pack dropped invalid persona ids");
	const items = rawItems.flatMap((item, index): ManifestItem[] => {
		const parsed = itemFromRecord(item, index, warnings);
		return parsed === undefined ? [] : [parsed];
	});
	const name = normalizeText(record.name, fallbackName);
	if (name.length === 0) {
		warnings.push("pack has no name");
		return undefined;
	}
	return {
		...(normalizeText(record.id).length === 0 ? {} : { id: normalizeText(record.id) }),
		items,
		metadata: recordValue(record.metadata),
		name,
		personaIds: personas.values,
		source: asSource(record.source) ?? "imported",
		tags: tags.values,
	};
}

export function parsePackManifest(
	manifest: unknown,
	fallbackName = "Imported pack",
): ParsedManifest {
	const warnings: string[] = [];
	const record = recordValue(manifest);
	const packs = Array.isArray(record.packs)
		? record.packs.flatMap((pack) => {
				const parsed = packFromRecord(pack, fallbackName, warnings);
				return parsed === undefined ? [] : [parsed];
			})
		: (() => {
				const parsed = packFromRecord(record, fallbackName, warnings);
				return parsed === undefined ? [] : [parsed];
			})();
	if (packs.length === 0) warnings.push("manifest does not contain a usable pack");
	return { packs, warnings };
}

function findFile(files: readonly ImportFile[], path: string | undefined): ImportFile | undefined {
	if (path === undefined) return undefined;
	const exact = files.find((file) => file.path === path);
	if (exact !== undefined) return exact;
	const base = path.split("/").at(-1);
	const matches = files.filter((file) => file.path.split("/").at(-1) === base);
	return matches.length === 1 ? matches[0] : undefined;
}

function fallbackItemId(packId: string, item: ManifestItem): string {
	return stableId(
		"item",
		`${packId}:${item.id ?? item.name}:${item.file ?? ""}:${item.hash ?? ""}`,
	);
}

export interface StickerImportProgress {
	readonly classified: number;
	readonly current: number;
	readonly currentItem?: string;
	readonly packTitle?: string;
	readonly skipped: number;
	readonly stage: "downloading" | "classifying" | "saving";
	readonly total: number;
}

export interface StickerImportServiceOptions {
	readonly logger?: PluginLogger | undefined;
	readonly media: PluginMediaApi;
	readonly repository: StickerRepository;
}

/** Directory, ZIP/bundle, and DSH meme-pack imports plus portable exports. */
export class StickerImportService {
	readonly #logger: PluginLogger | undefined;
	readonly #media: PluginMediaApi;
	readonly #repository: StickerRepository;

	constructor(options: StickerImportServiceOptions) {
		this.#logger = options.logger;
		this.#media = options.media;
		this.#repository = options.repository;
	}

	async importBundle(input: {
		readonly classifier?: StickerSemanticClassifier;
		readonly files: readonly ImportFile[];
		readonly manifest: unknown;
		readonly dryRun?: boolean;
		readonly fallbackName?: string;
		readonly onProgress?: (progress: StickerImportProgress) => void;
		readonly source?: PluginMediaSource;
	}): Promise<StickerImportReport> {
		const startedAt = Date.now();
		this.#logger?.info("sticker bundle import started", {
			dryRun: input.dryRun === true,
			fallbackName: input.fallbackName ?? "Imported pack",
			fileCount: input.files.length,
			source: input.source ?? "webui",
		});
		const parsed = parsePackManifest(input.manifest, input.fallbackName ?? "Imported pack");
		try {
			const report = await this.importPacks(parsed.packs, input.files, {
				...(input.classifier === undefined ? {} : { classifier: input.classifier }),
				dryRun: input.dryRun === true,
				...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
				source: input.source ?? "webui",
				warnings: parsed.warnings,
			});
			this.#logger?.info("sticker bundle import completed", {
				deduped: report.deduped,
				durationMs: elapsedMs(startedAt),
				dryRun: report.dryRun,
				items: report.items,
				missingMedia: report.missingMedia,
				packs: report.packs,
				warnings: report.warnings.length,
			});
			return report;
		} catch (error) {
			this.#logger?.warn("sticker bundle import failed", {
				durationMs: elapsedMs(startedAt),
				error: logErrorMessage(error),
			});
			throw error;
		}
	}

	async importZip(input: {
		readonly bytes: Uint8Array;
		readonly classifier?: StickerSemanticClassifier;
		readonly dryRun?: boolean;
		readonly onProgress?: (progress: StickerImportProgress) => void;
		readonly source?: PluginMediaSource;
	}): Promise<StickerImportReport> {
		const startedAt = Date.now();
		this.#logger?.info("ZIP sticker import started", {
			bytes: input.bytes.byteLength,
			dryRun: input.dryRun === true,
		});
		const files = readZipEntries(input.bytes, this.#logger);
		const manifestFile =
			files.find((file) => file.path === "manifest.json") ??
			files.find((file) => file.path.endsWith("/manifest.json"));
		if (manifestFile === undefined) {
			this.#logger?.warn("ZIP sticker import failed", {
				durationMs: elapsedMs(startedAt),
				error: "manifest.json is missing",
			});
			throw new Error("ZIP archive has no manifest.json");
		}
		this.#logger?.debug("ZIP sticker import manifest located", {
			entryCount: files.length,
			manifestPath: manifestFile.path,
		});
		const manifest = parseJson<unknown>(new TextDecoder().decode(manifestFile.bytes), undefined);
		if (manifest === undefined) throw new Error("ZIP manifest.json is invalid");
		const prefix = manifestFile.path.slice(0, -"manifest.json".length);
		const relativeFiles =
			prefix.length === 0
				? files
				: files.map((file) => ({
						bytes: file.bytes,
						path: file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
					}));
		return await this.importBundle({
			...(input.classifier === undefined ? {} : { classifier: input.classifier }),
			dryRun: input.dryRun === true,
			files: relativeFiles,
			manifest,
			...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
			source: input.source ?? "webui",
		});
	}

	async importDirectory(input: {
		readonly classifier?: StickerSemanticClassifier;
		readonly directory: string;
		readonly dryRun?: boolean;
		readonly onProgress?: (progress: StickerImportProgress) => void;
		readonly source?: PluginMediaSource;
	}): Promise<StickerImportReport> {
		this.#logger?.info("sticker directory import started", {
			directory: input.directory,
			dryRun: input.dryRun === true,
		});
		const files = await readDirectoryFiles(input.directory, this.#logger);
		const manifestFile = findFile(files, "manifest.json");
		if (manifestFile === undefined) throw new Error("Directory has no manifest.json");
		this.#logger?.debug("sticker directory import manifest located", {
			directory: input.directory,
			entryCount: files.length,
		});
		const manifest = parseJson<unknown>(new TextDecoder().decode(manifestFile.bytes), undefined);
		if (manifest === undefined) throw new Error("Directory manifest.json is invalid");
		return await this.importBundle({
			...(input.classifier === undefined ? {} : { classifier: input.classifier }),
			dryRun: input.dryRun === true,
			files,
			manifest,
			...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
			source: input.source ?? "webui",
		});
	}

	/**
	 * Import the DSH layout (`meme-packs/<pack>/manifest.json` plus optional `index.db` with
	 * a `memes` table). Plain image fixtures without SQLite are accepted as well.
	 */
	async importDshDirectory(input: {
		readonly classifier?: StickerSemanticClassifier;
		readonly directory: string;
		readonly dryRun?: boolean;
		readonly onProgress?: (progress: StickerImportProgress) => void;
	}): Promise<StickerImportReport> {
		this.#logger?.info("DSH sticker directory import started", {
			directory: input.directory,
			dryRun: input.dryRun === true,
		});
		const allFiles = await readDirectoryFiles(input.directory, this.#logger);
		const manifests = allFiles.filter((file) => /(?:^|\/)manifest\.json$/u.test(file.path));
		this.#logger?.debug("DSH sticker directory scanned", {
			directory: input.directory,
			entryCount: allFiles.length,
			manifestCount: manifests.length,
		});
		const reports: StickerImportReport[] = [];
		if (manifests.length === 0) {
			const fallback = await this.importBundle({
				...(input.classifier === undefined ? {} : { classifier: input.classifier }),
				dryRun: input.dryRun === true,
				files: allFiles,
				manifest: {
					items: allFiles.filter((file) => /\.(?:gif|jpe?g|png|webp)$/iu.test(file.path)),
					name: "DSH meme pack",
				},
				...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
				source: "migration",
			});
			return fallback;
		}
		for (const manifestFile of manifests) {
			const prefix = manifestFile.path.slice(0, -"manifest.json".length);
			const files = allFiles
				.filter((file) => file.path.startsWith(prefix))
				.map((file) => ({ bytes: file.bytes, path: file.path.slice(prefix.length) }));
			const manifest = recordValue(
				parseJson<unknown>(new TextDecoder().decode(manifestFile.bytes), {}),
			);
			const sqlitePath = join(input.directory, prefix, "index.db");
			const memes = existsSync(sqlitePath) ? readDshMemes(sqlitePath) : [];
			const items = memes.length > 0 ? memes : (manifest.items ?? manifest.memes ?? []);
			const fallbackName =
				normalizeText(manifest.name) || prefix.split("/").filter(Boolean).at(-1) || "DSH meme pack";
			const report = await this.importBundle({
				...(input.classifier === undefined ? {} : { classifier: input.classifier }),
				dryRun: input.dryRun === true,
				fallbackName,
				files,
				manifest: { ...manifest, items },
				...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
				source: "migration",
			});
			reports.push(report);
		}
		return mergeReports(reports);
	}

	async exportPacks(packId?: string): Promise<StickerExportResult> {
		const startedAt = Date.now();
		this.#logger?.info("sticker pack export started", {
			packId: packId ?? null,
		});
		const allPacks = await this.#repository.listPacks();
		const packs = packId === undefined ? allPacks : allPacks.filter((pack) => pack.id === packId);
		const files: ImportFile[] = [];
		const warnings: string[] = [];
		const exportedPacks: StickerExportResult["manifest"]["packs"][number][] = [];
		const mediaPaths = new Map<string, string>();
		for (const pack of packs) {
			const items = await this.#repository.listItems(pack.id);
			const exportedItems: StickerExportResult["manifest"]["packs"][number]["items"][number][] = [];
			for (const item of items) {
				if (item.mediaId.length === 0) {
					warnings.push(`item ${item.id} has no media and was skipped`);
					continue;
				}
				let path = mediaPaths.get(item.mediaId);
				if (path === undefined) {
					try {
						const bytes = await this.#media.readBytes(item.mediaId);
						path = `items/${item.mediaId.slice(0, 16)}.${fileExtension(item.mimeType, item.hash)}`;
						files.push({ bytes, path });
						mediaPaths.set(item.mediaId, path);
						traceLog(this.#logger, "sticker export media written", {
							bytes: bytes.byteLength,
							itemId: item.id,
							mediaId: item.mediaId,
							path,
						});
					} catch (error) {
						warnings.push(`item ${item.id} media is unavailable and was skipped`);
						this.#logger?.warn("sticker export media unavailable", {
							error: logErrorMessage(error),
							itemId: item.id,
							mediaId: item.mediaId,
						});
						continue;
					}
				}
				exportedItems.push({
					description: item.description,
					emotions: [...item.emotions],
					enabled: item.enabled,
					file: path,
					...(item.height === null ? {} : { height: item.height }),
					id: item.id,
					keywords: [...item.keywords],
					mimeType: item.mimeType,
					name: item.name,
					score: item.score,
					...(item.semantic.source === "none" && item.semantic.labels.length === 0
						? {}
						: { semantic: { ...item.semantic } }),
					...(item.width === null ? {} : { width: item.width }),
				});
			}
			exportedPacks.push({
				id: pack.id,
				items: exportedItems,
				...(Object.keys(pack.metadata).length === 0 ? {} : { metadata: { ...pack.metadata } }),
				name: pack.name,
				personaIds: [...pack.personaIds],
				source: pack.source,
				tags: [...pack.tags],
			});
		}
		this.#logger?.info("sticker pack export completed", {
			durationMs: elapsedMs(startedAt),
			fileCount: files.length,
			packCount: exportedPacks.length,
			warnings: warnings.length,
		});
		return {
			files,
			manifest: { format: "tsukaima-sticker-pack", packs: exportedPacks, version: 1 },
			warnings,
		};
	}

	private async importPacks(
		packs: readonly ManifestPack[],
		files: readonly ImportFile[],
		options: {
			readonly classifier?: StickerSemanticClassifier;
			readonly dryRun: boolean;
			readonly onProgress?: (progress: StickerImportProgress) => void;
			readonly source: PluginMediaSource;
			readonly warnings: readonly string[];
		},
	): Promise<StickerImportReport> {
		const startedAt = Date.now();
		const warnings = [...options.warnings];
		const packIds: string[] = [];
		const totalItems = packs.reduce((sum, pack) => sum + pack.items.length, 0);
		let items = 0;
		let classified = 0;
		let deduped = 0;
		let missingMedia = 0;
		this.#logger?.debug("sticker import packs started", {
			dryRun: options.dryRun,
			itemCount: totalItems,
			packCount: packs.length,
			source: options.source,
		});
		for (const manifestPack of packs) {
			const pack = options.dryRun
				? {
						id: manifestPack.id ?? stableId("pack", manifestPack.name),
						name: manifestPack.name,
						source: manifestPack.source,
					}
				: await this.#repository.savePack({
						...(manifestPack.id === undefined ? {} : { id: manifestPack.id }),
						...(manifestPack.metadata === undefined ? {} : { metadata: manifestPack.metadata }),
						name: manifestPack.name,
						personaIds: manifestPack.personaIds,
						source: manifestPack.source,
						tags: manifestPack.tags,
					});
			packIds.push(pack.id);
			this.#logger?.debug("sticker import pack prepared", {
				dryRun: options.dryRun,
				itemCount: manifestPack.items.length,
				packId: pack.id,
				packName: manifestPack.name,
			});
			for (const manifestItem of manifestPack.items) {
				const emit = (stage: StickerImportProgress["stage"], currentCount: number) => {
					options.onProgress?.({
						classified,
						current: currentCount,
						currentItem: manifestItem.name,
						packTitle: manifestPack.name,
						skipped: missingMedia,
						stage,
						total: totalItems,
					});
				};
				emit("downloading", items);
				items += 1;
				const file = findFile(files, manifestItem.file);
				if (file === undefined) {
					missingMedia += 1;
					warnings.push(`item ${manifestItem.name} has no matching media file`);
					traceLog(this.#logger, "sticker import item skipped", {
						itemName: manifestItem.name,
						packId: pack.id,
						reason: "missing_media",
					});
					if (!options.dryRun) {
						await this.#repository.upsertItem({
							description: manifestItem.description,
							emotions: manifestItem.emotions,
							enabled: false,
							hash: manifestItem.hash ?? fallbackItemId(pack.id, manifestItem),
							...(manifestItem.id === undefined ? {} : { id: manifestItem.id }),
							keywords: manifestItem.keywords,
							mimeType: manifestItem.mimeType,
							name: manifestItem.name,
							packId: pack.id,
							reviewStatus: manifestItem.reviewStatus ?? defaultReviewStatus(manifestPack.source),
							score: manifestItem.score,
							...(manifestItem.semantic === undefined ? {} : { semantic: manifestItem.semantic }),
						});
					}
					emit("saving", items);
					continue;
				}
				const hash = sha256Bytes(file.bytes);
				const existing = await this.#media.findBySha(hash);
				if (existing !== undefined) deduped += 1;
				traceLog(this.#logger, "sticker import item prepared", {
					bytes: file.bytes.byteLength,
					deduped: existing !== undefined,
					itemName: manifestItem.name,
					packId: pack.id,
					path: file.path,
				});
				if (options.dryRun) {
					emit("saving", items);
					continue;
				}
				let semantic = manifestItem.semantic;
				if (semantic === undefined && options.classifier !== undefined) {
					emit("classifying", items - 1);
					try {
						semantic = await options.classifier.classify({
							bytes: file.bytes,
							mimeType: manifestItem.mimeType,
							title: manifestPack.name,
						});
						if (semantic.source !== "none") classified += 1;
					} catch (error) {
						warnings.push(`semantic classification failed for ${manifestItem.name}`);
						this.#logger?.warn("sticker import semantic classification failed", {
							error: logErrorMessage(error),
							itemName: manifestItem.name,
							packId: pack.id,
						});
					}
				}
				const profile = semantic ?? EMPTY_SEMANTIC_PROFILE;
				const stored =
					existing ??
					(await this.#media.store({
						bytes: file.bytes,
						...(manifestItem.height === undefined ? {} : { height: manifestItem.height }),
						kind: "sticker",
						mimeType: manifestItem.mimeType,
						source: options.source,
						...(manifestItem.width === undefined ? {} : { width: manifestItem.width }),
					}));
				emit("saving", items - 1);
				await this.#repository.upsertItem({
					description:
						manifestItem.description.length > 0 ? manifestItem.description : profile.description,
					emotions: normalizeLabels([...manifestItem.emotions, ...profile.emotions]).values,
					enabled: manifestItem.enabled,
					hash,
					height: manifestItem.height ?? stored.height,
					...(manifestItem.id === undefined ? {} : { id: manifestItem.id }),
					keywords: normalizeLabels([...manifestItem.keywords, ...profile.keywords]).values,
					mediaId: stored.id,
					mimeType: manifestItem.mimeType || stored.mimeType,
					name: manifestItem.name,
					packId: pack.id,
					reviewStatus: manifestItem.reviewStatus ?? defaultReviewStatus(manifestPack.source),
					score: manifestItem.score,
					semantic: profile,
					width: manifestItem.width ?? stored.width,
				});
				emit("saving", items);
			}
		}
		this.#logger?.debug("sticker import packs completed", {
			classified,
			deduped,
			durationMs: elapsedMs(startedAt),
			dryRun: options.dryRun,
			itemCount: items,
			missingMedia,
			packCount: packs.length,
			source: options.source,
			warnings: warnings.length,
		});
		return {
			deduped,
			dryRun: options.dryRun,
			items,
			missingMedia,
			packIds,
			packs: packs.length,
			warnings,
		};
	}
}

function defaultReviewStatus(source: StickerPackSource): StickerReviewStatus {
	return source === "learned" || source === "generated" ? "pending" : "approved";
}

function readDshMemes(path: string): unknown[] {
	let database: Database | undefined;
	try {
		database = new Database(path, { readonly: true });
		const rows = database.query("SELECT * FROM memes").all() as Record<string, unknown>[];
		return rows.map((row) => {
			const file = normalizeText(row.path ?? row.file ?? row.file_name);
			const keywords = textList(
				typeof row.keywords === "string"
					? parseJson<unknown>(row.keywords, row.keywords)
					: row.keywords,
			);
			return {
				caption: normalizeText(row.caption ?? row.description),
				emotions: textList(row.tag ?? row.emotion),
				file,
				keywords,
				name: normalizeText(row.caption ?? row.name, file.split("/").at(-1) ?? "meme"),
				path: file,
			};
		});
	} catch {
		return [];
	} finally {
		database?.close();
	}
}

function mergeReports(reports: readonly StickerImportReport[]): StickerImportReport {
	return {
		deduped: reports.reduce((total, report) => total + report.deduped, 0),
		dryRun: reports.every((report) => report.dryRun),
		items: reports.reduce((total, report) => total + report.items, 0),
		missingMedia: reports.reduce((total, report) => total + report.missingMedia, 0),
		packIds: reports.flatMap((report) => report.packIds),
		packs: reports.reduce((total, report) => total + report.packs, 0),
		warnings: reports.flatMap((report) => report.warnings),
	};
}

/** Used by tests/admin helpers to turn a serialized bundle into import files. */
export function filesFromBundle(
	files: readonly { readonly dataBase64?: string; readonly path: string }[],
): ImportFile[] {
	return files.flatMap((file) => {
		const path = safeRelativePath(file.path);
		if (path === undefined || file.dataBase64 === undefined) return [];
		return [{ bytes: decodeBase64(file.dataBase64), path }];
	});
}

export function bundleFilesResponse(files: readonly ImportFile[]): {
	readonly dataBase64: string;
	readonly path: string;
}[] {
	return files.map((file) => ({ dataBase64: encodeBase64(file.bytes), path: file.path }));
}
