import { basename, relative } from "node:path";
import { promises as fs } from "node:fs";
import { listFiles, resolveSnapshotRoot, sha256File, sha256String } from "./fs.ts";
import { readZip } from "./zip.ts";

export const DSH_SOURCE = "dsh" as const;
export const DSH_TARGET_FIELDS = {
	sessions: "conversation",
	personas: "persona",
	memory: "memory",
	stickers: "sticker",
	settings: "setting",
} as const;

export type SnapshotSource = readonly (readonly [path: string, label: string])[];
export type SnapshotPathSource = readonly string[];

export interface SnapshotFile {
	readonly path: string;
	readonly source: string;
	readonly sizeBytes: number;
	readonly hash: string;
}

export interface SnapshotInventory {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly roots: readonly string[];
	readonly files: readonly SnapshotFile[];
	readonly sessions: readonly string[];
	readonly personas: readonly string[];
	readonly memory: readonly string[];
	readonly stickers: readonly string[];
	readonly settings: readonly string[];
	readonly warnings: readonly string[];
}

export function snapshotPaths(source: SnapshotPathSource): SnapshotSource {
	return source.map((path) => [path, basename(path)] as const);
}

async function loadSnapshotFiles(source: SnapshotSource): Promise<{
	files: SnapshotFile[];
	textFiles: Map<string, string>;
}> {
	const files: SnapshotFile[] = [];
	const textFiles = new Map<string, string>();
	for (const [path, label] of source) {
		const stats = await fs.stat(path);
		if (stats.isDirectory()) {
			const root = await resolveSnapshotRoot(path);
			for (const file of await listFiles(root)) {
				const snapshotPath = `${label}/${relative(root, file).replaceAll("\\", "/")}`;
				files.push({
					path: snapshotPath,
					source: path,
					sizeBytes: (await fs.stat(file)).size,
					hash: await sha256File(file),
				});
				if (/\.(json|jsonl|ya?ml|txt)$/i.test(file)) {
					textFiles.set(snapshotPath, await fs.readFile(file, "utf8"));
				}
			}
		} else if (path.toLowerCase().endsWith(".zip")) {
			files.push({
				path: label,
				source: path,
				sizeBytes: stats.size,
				hash: await sha256File(path),
			});
			for (const [entryName, content] of Object.entries(await readZip(path))) {
				const snapshotPath = `${label}/${entryName}`;
				textFiles.set(snapshotPath, content);
				files.push({
					path: snapshotPath,
					source: `${path}#${entryName}`,
					sizeBytes: Buffer.byteLength(content),
					hash: sha256String(content),
				});
			}
		} else if (path.toLowerCase().endsWith(".jsonl") || path.toLowerCase().endsWith(".json")) {
			const content = await fs.readFile(path, "utf8");
			files.push({
				path: label,
				source: path,
				sizeBytes: stats.size,
				hash: await sha256File(path),
			});
			textFiles.set(label, content);
		}
	}
	return { files, textFiles };
}

function isSessionPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (/(?:^|\/)(?:node_modules|backups)\//i.test(normalized)) return false;
	if (!/(?:^|\/)sessions\//i.test(normalized)) return false;
	return /\.jsonl(?:\.zst(?:d)?)?$/i.test(normalized);
}

export async function inspectDshSnapshot(source: SnapshotSource): Promise<SnapshotInventory> {
	const { files, textFiles } = await loadSnapshotFiles(source);
	const pathGroups = (pattern: RegExp): string[] =>
		[...textFiles.keys()]
			.filter((path) => pattern.test(path))
			.toSorted((a, b) => a.localeCompare(b));
	const allPaths = [...new Set([...textFiles.keys(), ...files.map((file) => file.path)])];
	const sessions = allPaths
		.filter(isSessionPath)
		.toSorted((left, right) => left.localeCompare(right));
	const personas = pathGroups(/(?:^|\/)(?:personas?)\/(?!.*node_modules).*\.(?:json|jsonl)$/i);
	const memory = pathGroups(/(?:^|\/)(?:memory|\.mnemon)\/(?!.*node_modules).*\.(?:json|jsonl)$/i);
	// Real meme packs are parsed from their manifests/index DBs by the meme importer.
	const stickers = pathGroups(/(?:^|\/)stickers?\/(?!.*node_modules).*\.(?:json|jsonl)$/i);
	const settings = pathGroups(
		/(?:^|\/)home\/(?:node\/)?\.dsh\/profiles\/[^/]+\/cordis\.patch\.ya?ml$|(?:^|\/)settings?\/(?!.*node_modules).*\.json$|(?:^|\/)config\.ya?ml$/i,
	);
	const warnings: string[] = [];
	const roots = source.map(([, label]) => label);
	if (!sessions.length) {
		warnings.push("No JSONL session files found.");
	}
	if (!personas.length) {
		warnings.push("No persona files found.");
	}
	return {
		sourceSystem: DSH_SOURCE,
		roots,
		files,
		sessions,
		personas,
		memory,
		stickers,
		settings,
		warnings,
	};
}
