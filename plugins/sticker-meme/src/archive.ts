import { promises as fs } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { PluginLogger } from "@tsukaima/sdk";
import { safeRelativePath } from "./domain.ts";
import { elapsedMs } from "./logging.ts";

export interface ImportFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

const localFileSignature = 0x04034b50;
const centralDirectorySignature = 0x02014b50;
const endOfDirectorySignature = 0x06054b50;
const storedMethod = 0;
const deflateMethod = 8;

const readUint16 = (data: Uint8Array, offset: number): number =>
	(data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);

const readUint32 = (data: Uint8Array, offset: number): number =>
	(data[offset] ?? 0) |
	((data[offset + 1] ?? 0) << 8) |
	((data[offset + 2] ?? 0) << 16) |
	((data[offset + 3] ?? 0) << 24);

function readEntry(
	data: Uint8Array,
	entry: { compressedSize: number; method: number; offset: number },
): Uint8Array {
	const compressed = data.slice(entry.offset, entry.offset + entry.compressedSize);
	if (entry.method === storedMethod) return compressed;
	if (entry.method === deflateMethod) return inflateRawSync(compressed);
	throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
}

/** Read a ZIP archive into path -> bytes pairs without writing it to disk. */
export function readZipEntries(data: Uint8Array, logger?: PluginLogger): ImportFile[] {
	const startedAt = Date.now();
	logger?.info("ZIP archive read started", { bytes: data.byteLength });
	let directoryOffset = data.length - 22;
	while (directoryOffset >= 0 && readUint32(data, directoryOffset) !== endOfDirectorySignature) {
		directoryOffset -= 1;
	}
	if (directoryOffset < 0) throw new Error("Invalid ZIP archive");
	const count = readUint16(data, directoryOffset + 10);
	const directoryStart = readUint32(data, directoryOffset + 16);
	const decoder = new TextDecoder("utf-8");
	const files: ImportFile[] = [];
	let offset = directoryStart;
	for (let index = 0; index < count; index += 1) {
		if (readUint32(data, offset) !== centralDirectorySignature) {
			throw new Error("Invalid ZIP central directory");
		}
		const method = readUint16(data, offset + 10);
		const compressedSize = readUint32(data, offset + 20);
		const nameLength = readUint16(data, offset + 28);
		const extraLength = readUint16(data, offset + 30);
		const commentLength = readUint16(data, offset + 32);
		const localOffset = readUint32(data, offset + 42);
		const rawName = decoder.decode(data.slice(offset + 46, offset + 46 + nameLength));
		if (readUint32(data, localOffset) !== localFileSignature) {
			throw new Error(`Invalid ZIP local header for ${rawName}`);
		}
		const localNameLength = readUint16(data, localOffset + 26);
		const localExtraLength = readUint16(data, localOffset + 28);
		const path = safeRelativePath(rawName);
		if (path === undefined || rawName.endsWith("/")) {
			offset += 46 + nameLength + extraLength + commentLength;
			continue;
		}
		files.push({
			bytes: readEntry(data, {
				compressedSize,
				method,
				offset: localOffset + 30 + localNameLength + localExtraLength,
			}),
			path,
		});
		offset += 46 + nameLength + extraLength + commentLength;
	}
	logger?.info("ZIP archive read completed", {
		durationMs: elapsedMs(startedAt),
		fileCount: files.length,
	});
	return files;
}

/** Read a pack directory recursively; only regular files with safe relative names are kept. */
export async function readDirectoryFiles(
	directory: string,
	logger?: PluginLogger,
): Promise<ImportFile[]> {
	const startedAt = Date.now();
	logger?.info("sticker pack directory scan started", { directory });
	const files: ImportFile[] = [];
	const walk = async (current: string, prefix: string): Promise<void> => {
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const relative = safeRelativePath(
				prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`,
			);
			if (relative === undefined) continue;
			const absolute = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(absolute, relative);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push({ bytes: new Uint8Array(await fs.readFile(absolute)), path: relative });
		}
	};
	await walk(directory, "");
	logger?.info("sticker pack directory scan completed", {
		directory,
		durationMs: elapsedMs(startedAt),
		fileCount: files.length,
	});
	return files;
}

export function decodeBase64(value: string): Uint8Array {
	const payload = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
	return new Uint8Array(Buffer.from(payload, "base64"));
}

export function encodeBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
