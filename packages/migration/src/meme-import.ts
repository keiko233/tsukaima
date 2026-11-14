import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import type { SnapshotSource } from "./dsh-inspect.ts";
import {
	listFiles,
	resolveSnapshotRoot,
	sha256Bytes,
	sha256String,
	stableStringify,
} from "./fs.ts";
import type { DecisionEntry } from "./decision.ts";

export interface ImportedMemeItem {
	readonly id: string;
	readonly packId: string;
	readonly name: string;
	readonly description: string;
	readonly keywords: readonly string[];
	readonly emotions: readonly string[];
	readonly tags: readonly string[];
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly fileHash: string | null;
	readonly mediaId: string;
	readonly mediaSourcePath: string | null;
	readonly mediaRelativePath: string | null;
	readonly enabled: false;
	readonly reviewStatus: "pending";
	readonly provenance: Readonly<Record<string, unknown>>;
}

export interface ImportedMemePack {
	readonly id: string;
	readonly name: string;
	readonly version: string | null;
	readonly tags: readonly string[];
	readonly source: "imported";
	readonly enabled: false;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly manifest: Readonly<Record<string, unknown>>;
	readonly sourcePath: string;
	readonly items: readonly ImportedMemeItem[];
}

export interface MemeMediaFile {
	readonly sha256: string;
	readonly sizeBytes: number;
	readonly sourcePath: string;
	readonly relativePath: string;
}

export interface MemeImportResult {
	readonly packs: readonly ImportedMemePack[];
	readonly items: readonly ImportedMemeItem[];
	readonly media: readonly MemeMediaFile[];
	readonly decisions: readonly DecisionEntry[];
	readonly warnings: readonly string[];
	readonly deduped: number;
	readonly missing: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function list(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(/[,，]/u)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
		: [];
}

function tableRows(databasePath: string): Record<string, unknown>[] {
	let database: Database | undefined;
	try {
		database = new Database(databasePath, { readonly: true });
		const table = database
			.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memes' LIMIT 1")
			.get() as { name?: string } | null;
		if (table?.name === undefined) return [];
		return database.query("SELECT * FROM memes").all() as Record<string, unknown>[];
	} catch {
		return [];
	} finally {
		database?.close();
	}
}

function inferMime(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	if (extension === "gif") return "image/gif";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "webp") return "image/webp";
	return "image/png";
}

function safeRelative(path: string): string | null {
	const normalized = path
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.trim();
	if (normalized === "" || normalized.startsWith("/") || normalized.includes("\0")) return null;
	if (normalized.split("/").some((segment) => segment === ".." || segment === "")) return null;
	return normalized;
}

interface PackFiles {
	readonly byRelative: Map<string, string>;
	readonly byBasename: Map<string, string[]>;
}

async function packFiles(packRoot: string): Promise<PackFiles> {
	const byRelative = new Map<string, string>();
	const byBasename = new Map<string, string[]>();
	for (const absolutePath of await listFiles(packRoot)) {
		const relativePath = relative(packRoot, absolutePath).replaceAll("\\", "/");
		byRelative.set(relativePath, absolutePath);
		const name = basename(absolutePath);
		byBasename.set(name, [...(byBasename.get(name) ?? []), absolutePath]);
	}
	return { byBasename, byRelative };
}

function resolveMedia(
	requested: string | null,
	files: PackFiles,
): { absolutePath: string; relativePath: string } | null {
	if (requested === null) return null;
	const safe = safeRelative(requested);
	if (safe === null) return null;
	const direct = files.byRelative.get(safe);
	if (direct !== undefined) return { absolutePath: direct, relativePath: safe };
	const matches = files.byBasename.get(basename(safe)) ?? [];
	return matches.length === 1
		? { absolutePath: matches[0]!, relativePath: relative(dirnameSafe(matches[0]!), matches[0]!) }
		: null;
}

function dirnameSafe(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "." : path.slice(0, index);
}

async function itemFromRow(input: {
	readonly row: Record<string, unknown>;
	readonly index: number;
	readonly packId: string;
	readonly packRoot: string;
	readonly files: PackFiles;
	readonly mediaByHash: Map<string, MemeMediaFile>;
	readonly decisions: DecisionEntry[];
	readonly warnings: string[];
}): Promise<ImportedMemeItem | null> {
	const { row, index, packId, files, mediaByHash, decisions, warnings } = input;
	const requested = text(row.path ?? row.file ?? row.file_name ?? row.fileName, "") || null;
	const media = resolveMedia(requested, files);
	const name = text(
		row.caption ?? row.name ?? row.description,
		media === null ? `meme-${index + 1}` : basename(media.absolutePath),
	);
	const keywords = list(row.keywords ?? row.keyword);
	const emotions = list(row.tag ?? row.emotion ?? row.emotions);
	const tags = list(row.tags ?? row.pack_tags);
	const idBase = text(row.id, `${packId}:${index}:${requested ?? name}`);
	const id = `dsh_meme_${sha256String(`${packId}:${idBase}`).slice(7, 23)}`;
	if (media === null) {
		warnings.push(`Meme ${id} references missing media ${requested ?? "<none>"}`);
		decisions.push({
			action: "review",
			area: "meme",
			reason: "Referenced media file is missing from the snapshot",
			source: `${packId}:${requested ?? idBase}`,
			target: "plugin.sticker-meme.items",
		});
		return {
			description: text(row.caption ?? row.description),
			emotions,
			enabled: false,
			fileHash: null,
			id,
			keywords,
			mediaId: "",
			mediaRelativePath: null,
			mediaSourcePath: null,
			mimeType: inferMime(requested ?? name),
			name,
			packId,
			provenance: { missing: true, row: index, sourcePath: requested },
			reviewStatus: "pending",
			sizeBytes: 0,
			tags,
		};
	}
	const bytes = await fs.readFile(media.absolutePath);
	const hash = sha256Bytes(bytes).slice("sha256:".length);
	const existing = mediaByHash.get(hash);
	const mediaRecord: MemeMediaFile = existing ?? {
		relativePath: media.relativePath,
		sha256: hash,
		sizeBytes: bytes.byteLength,
		sourcePath: media.absolutePath,
	};
	if (existing === undefined) mediaByHash.set(hash, mediaRecord);
	return {
		description: text(row.caption ?? row.description),
		emotions,
		enabled: false,
		fileHash: hash,
		id,
		keywords,
		mediaId: `dsh_media_${hash.slice(0, 16)}`,
		mediaRelativePath: media.relativePath,
		mediaSourcePath: media.absolutePath,
		mimeType: inferMime(media.relativePath),
		name,
		packId,
		provenance: {
			row: index,
			sourcePath: requested,
			sourcePack: input.packId,
		},
		reviewStatus: "pending",
		sizeBytes: bytes.byteLength,
		tags,
	};
}

export async function parseDshMemePacks(source: SnapshotSource): Promise<MemeImportResult> {
	const files: { absolutePath: string; path: string }[] = [];
	for (const [root, label] of source) {
		const stats = await fs.stat(root).catch(() => null);
		if (stats?.isDirectory()) {
			const dataRoot = await resolveSnapshotRoot(root);
			for (const file of await listFiles(dataRoot)) {
				files.push({
					absolutePath: file,
					path: `${label}/${relative(dataRoot, file).replaceAll("\\", "/")}`,
				});
			}
		} else if (stats?.isFile()) {
			files.push({ absolutePath: root, path: label });
		}
	}
	const manifests = files.filter((file) => /(?:^|\/)manifest\.json$/i.test(file.path));
	const packs: ImportedMemePack[] = [];
	const decisions: DecisionEntry[] = [];
	const warnings: string[] = [];
	const mediaByHash = new Map<string, MemeMediaFile>();
	let deduped = 0;
	let missing = 0;
	const seenPacks = new Set<string>();
	const seenHashes = new Set<string>();

	for (const manifestFile of manifests) {
		const packRoot = dirnameSafe(manifestFile.absolutePath);
		if (seenPacks.has(packRoot)) continue;
		seenPacks.add(packRoot);
		let manifest: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(await fs.readFile(manifestFile.absolutePath, "utf8")) as unknown;
			manifest = isRecord(parsed) ? parsed : {};
		} catch {
			warnings.push(`Invalid meme manifest: ${manifestFile.path}`);
			decisions.push({
				action: "review",
				area: "meme",
				reason: "Meme manifest is not valid JSON",
				source: manifestFile.path,
				target: "plugin.sticker-meme.packs",
			});
		}
		const directoryName = basename(packRoot);
		const packId = text(manifest.id, directoryName);
		const indexDatabase = files.find(
			(file) =>
				dirnameSafe(file.absolutePath) === packRoot && /(?:^|\/)index\.db$/i.test(file.path),
		);
		const rows = indexDatabase === undefined ? [] : tableRows(indexDatabase.absolutePath);
		const manifestItems = Array.isArray(manifest.items)
			? manifest.items
			: Array.isArray(manifest.memes)
				? manifest.memes
				: Array.isArray(manifest.stickers)
					? manifest.stickers
					: [];
		const itemRows = rows.length > 0 ? rows : manifestItems.filter(isRecord);
		const packFileIndex = await packFiles(packRoot);
		const items: ImportedMemeItem[] = [];
		for (const [index, row] of itemRows.entries()) {
			const item = await itemFromRow({
				decisions,
				files: packFileIndex,
				index,
				mediaByHash,
				packId,
				packRoot,
				row,
				warnings,
			});
			if (item === null) continue;
			if (item.fileHash === null) {
				missing += 1;
			} else if (seenHashes.has(item.fileHash)) {
				deduped += 1;
			} else {
				seenHashes.add(item.fileHash);
			}
			items.push(item);
		}
		const tags = list(manifest.tags);
		packs.push({
			enabled: false,
			id: packId,
			items,
			manifest,
			metadata: {
				manifestFields: Object.keys(manifest).toSorted((left, right) => left.localeCompare(right)),
				source: "dsh",
				sourcePath: manifestFile.path,
			},
			name: text(manifest.name, packId),
			source: "imported",
			sourcePath: packRoot,
			tags,
			version: text(manifest.version, "") || null,
		});
	}
	const uniqueMedia = [...mediaByHash.values()].toSorted((left, right) =>
		left.sha256.localeCompare(right.sha256),
	);
	const items = packs.flatMap((pack) => pack.items);
	return {
		decisions,
		deduped,
		items,
		media: uniqueMedia,
		missing,
		packs,
		warnings,
	};
}

export interface CopyMemeMediaResult {
	readonly copied: number;
	readonly deduped: number;
	readonly directory: string;
	readonly errors: readonly string[];
}

export async function copyMemeMedia(
	result: MemeImportResult,
	directory: string,
	dryRun = false,
): Promise<CopyMemeMediaResult> {
	if (dryRun) {
		return { copied: 0, deduped: result.deduped, directory, errors: [] };
	}
	await fs.mkdir(directory, { recursive: true });
	let copied = 0;
	let deduped = 0;
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const media of result.media) {
		const destination = join(directory, media.sha256);
		if (seen.has(media.sha256)) {
			deduped += 1;
			continue;
		}
		seen.add(media.sha256);
		try {
			const existing = await fs.stat(destination).catch(() => null);
			if (existing?.isFile()) {
				deduped += 1;
				continue;
			}
			await fs.copyFile(media.sourcePath, destination);
			copied += 1;
		} catch (error) {
			errors.push(`${media.sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { copied, deduped, directory, errors };
}

export function memeFingerprint(result: MemeImportResult): string {
	return sha256String(
		stableStringify(result.items.map((item) => [item.id, item.fileHash, item.packId])),
	);
}
