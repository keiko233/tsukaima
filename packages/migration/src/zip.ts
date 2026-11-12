import { inflateRawSync } from "node:zlib";
import { promises as fs } from "node:fs";

const localFileSignature = 0x04034b50;
const centralDirectorySignature = 0x02014b50;
const endOfDirectorySignature = 0x06054b50;
const storedMethod = 0;
const deflateMethod = 8;

interface ZipEntry {
	name: string;
	offset: number;
	compressedSize: number;
	method: number;
}

function readUint16(data: Uint8Array, offset: number): number {
	return data[offset]! | (data[offset + 1]! << 8);
}

function readUint32(data: Uint8Array, offset: number): number {
	return (
		data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)
	);
}

function readEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
	const compressed = data.slice(entry.offset + 30, entry.offset + 30 + entry.compressedSize);
	if (entry.method === storedMethod) {
		return compressed;
	}
	if (entry.method === deflateMethod) {
		return inflateRawSync(compressed);
	}
	throw new Error(`Unsupported ZIP compression method: ${entry.method}`);
}

export async function readZip(path: string): Promise<Record<string, string>> {
	const data = await fs.readFile(path);
	let directoryOffset = data.length - 22;
	while (directoryOffset >= 0 && readUint32(data, directoryOffset) !== endOfDirectorySignature) {
		directoryOffset -= 1;
	}
	if (directoryOffset < 0) {
		throw new Error(`Invalid ZIP file: ${path}`);
	}
	const count = readUint16(data, directoryOffset + 10);
	const directoryStart = readUint32(data, directoryOffset + 16);
	const files: Record<string, string> = {};
	const textDecoder = new TextDecoder("utf-8");
	let offset = directoryStart;
	for (let index = 0; index < count; index += 1) {
		if (readUint32(data, offset) !== centralDirectorySignature) {
			throw new Error(`Invalid ZIP central directory entry at ${offset}`);
		}
		const method = readUint16(data, offset + 10);
		const compressedSize = readUint32(data, offset + 20);
		const nameLength = readUint16(data, offset + 28);
		const extraLength = readUint16(data, offset + 30);
		const commentLength = readUint16(data, offset + 32);
		const localOffset = readUint32(data, offset + 42);
		const name = textDecoder.decode(data.slice(offset + 46, offset + 46 + nameLength));
		if (readUint32(data, localOffset) !== localFileSignature) {
			throw new Error(`Invalid ZIP local header for ${name}`);
		}
		const localNameLength = readUint16(data, localOffset + 26);
		const localExtraLength = readUint16(data, localOffset + 28);
		files[name] = textDecoder.decode(
			readEntry(data, {
				method,
				compressedSize,
				offset: localOffset + 30 + localNameLength + localExtraLength,
				name,
			}),
		);
		offset += 46 + nameLength + extraLength + commentLength;
	}
	return files;
}
