import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;

export type AcpArtifactKind = "audio" | "image" | "video";

export interface AcpArtifactSandboxContext {
	readonly artifactDir: string;
}

export interface AcpImageArtifactUpdate {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
	readonly name?: string;
}

export interface AcpAudioArtifactUpdate {
	readonly type: "audio";
	readonly data: string;
	readonly mimeType: string;
	readonly name?: string;
}

export interface AcpResourceArtifactUpdate {
	readonly type: "resource";
	readonly name?: string;
	readonly resource: {
		readonly blob?: string;
		readonly mimeType?: string;
		readonly text?: string;
		readonly uri?: string;
	};
}

export interface AcpResourceLinkArtifactUpdate {
	readonly type: "resource_link";
	readonly uri: string;
	readonly name?: string;
	readonly mimeType?: string;
}

export interface AcpTextArtifactUpdate {
	readonly type: "text";
	readonly text: string;
}

export interface AcpToolCallArtifactUpdate {
	readonly type: "tool_call" | "tool_call_update";
	readonly content?: readonly AcpArtifactUpdateInput[];
}

export type AcpArtifactUpdateInput =
	| AcpAudioArtifactUpdate
	| AcpImageArtifactUpdate
	| AcpResourceArtifactUpdate
	| AcpResourceLinkArtifactUpdate
	| AcpTextArtifactUpdate
	| AcpToolCallArtifactUpdate;

export interface ExtractedAcpArtifact {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly sha256: string;
	readonly fileName?: string;
}

export interface ExtractedAcpArtifacts {
	readonly images: readonly ExtractedAcpArtifact[];
	readonly videos: readonly ExtractedAcpArtifact[];
	readonly audios: readonly ExtractedAcpArtifact[];
}

export interface ExtractAcpArtifactsInput {
	readonly artifactDir: string;
	readonly updates: readonly AcpArtifactUpdateInput[];
	readonly assistantText?: string;
	readonly maxBytesPerFile?: number;
}

export interface DetectedAcpMedia {
	readonly kind: AcpArtifactKind;
	readonly mimeType: string;
	readonly extension: string;
}

interface ArtifactRoot {
	readonly dir: string;
	readonly realPath: string;
}

const EXTENSION_MEDIA: Readonly<Record<string, DetectedAcpMedia>> = {
	gif: { extension: "gif", kind: "image", mimeType: "image/gif" },
	jpeg: { extension: "jpeg", kind: "image", mimeType: "image/jpeg" },
	jpg: { extension: "jpg", kind: "image", mimeType: "image/jpeg" },
	m4a: { extension: "m4a", kind: "audio", mimeType: "audio/mp4" },
	mov: { extension: "mov", kind: "video", mimeType: "video/quicktime" },
	mp3: { extension: "mp3", kind: "audio", mimeType: "audio/mpeg" },
	mp4: { extension: "mp4", kind: "video", mimeType: "video/mp4" },
	ogg: { extension: "ogg", kind: "audio", mimeType: "audio/ogg" },
	png: { extension: "png", kind: "image", mimeType: "image/png" },
	wav: { extension: "wav", kind: "audio", mimeType: "audio/wav" },
	webm: { extension: "webm", kind: "video", mimeType: "video/webm" },
	webp: { extension: "webp", kind: "image", mimeType: "image/webp" },
};

const MIME_MEDIA: Readonly<Record<string, DetectedAcpMedia>> = {
	"application/ogg": { extension: "ogg", kind: "audio", mimeType: "audio/ogg" },
	"audio/m4a": { extension: "m4a", kind: "audio", mimeType: "audio/mp4" },
	"audio/mp3": { extension: "mp3", kind: "audio", mimeType: "audio/mpeg" },
	"audio/mp4": { extension: "m4a", kind: "audio", mimeType: "audio/mp4" },
	"audio/mpeg": { extension: "mp3", kind: "audio", mimeType: "audio/mpeg" },
	"audio/ogg": { extension: "ogg", kind: "audio", mimeType: "audio/ogg" },
	"audio/vnd.wave": { extension: "wav", kind: "audio", mimeType: "audio/wav" },
	"audio/wav": { extension: "wav", kind: "audio", mimeType: "audio/wav" },
	"audio/wave": { extension: "wav", kind: "audio", mimeType: "audio/wav" },
	"audio/x-m4a": { extension: "m4a", kind: "audio", mimeType: "audio/mp4" },
	"audio/x-wav": { extension: "wav", kind: "audio", mimeType: "audio/wav" },
	"image/gif": { extension: "gif", kind: "image", mimeType: "image/gif" },
	"image/jpeg": { extension: "jpg", kind: "image", mimeType: "image/jpeg" },
	"image/jpg": { extension: "jpg", kind: "image", mimeType: "image/jpeg" },
	"image/png": { extension: "png", kind: "image", mimeType: "image/png" },
	"image/webp": { extension: "webp", kind: "image", mimeType: "image/webp" },
	"video/mp4": { extension: "mp4", kind: "video", mimeType: "video/mp4" },
	"video/quicktime": { extension: "mov", kind: "video", mimeType: "video/quicktime" },
	"video/webm": { extension: "webm", kind: "video", mimeType: "video/webm" },
};

const MEDIA_PATH_SOURCE =
	"(?:file:\\/\\/[^\\s\"'`<>()[\\]{}]+|[^\\s\"'`<>()[\\]{};,]+)\\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a)(?![\\w])";

/** Creates a unique run sandbox and always removes it, even when the run throws. */
export async function withArtifactSandbox<T>(
	artifactsRootDir: string,
	runId: string,
	fn: (ctx: AcpArtifactSandboxContext) => Promise<T>,
): Promise<T> {
	await mkdir(artifactsRootDir, { recursive: true });
	const artifactDir = await mkdtemp(join(artifactsRootDir, `${sanitizeAcpRunId(runId)}-`));
	try {
		return await fn({ artifactDir });
	} finally {
		await rm(artifactDir, { force: true, recursive: true });
	}
}

export function sanitizeAcpRunId(runId: string): string {
	const cleaned = runId
		.trim()
		.replace(/[^A-Za-z0-9._-]+/gu, "_")
		.replace(/^[._-]+/u, "")
		.slice(0, 64);
	return cleaned.length === 0 ? "run" : cleaned;
}

export async function extractAcpArtifacts(
	input: ExtractAcpArtifactsInput,
): Promise<ExtractedAcpArtifacts> {
	const maxBytes = input.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
	const collector = new ArtifactCollector(maxBytes);
	const root = await resolveArtifactRoot(input.artifactDir);
	if (root !== undefined) {
		await scanArtifactDirectory(root.realPath, root.realPath, collector, maxBytes, new Set());
	}
	await collectArtifactUpdates(input.updates, root, collector, maxBytes);
	if (input.assistantText !== undefined && root !== undefined) {
		await collectAssistantTextPaths(input.assistantText, root, collector, maxBytes);
	}
	return collector.result();
}

class ArtifactCollector {
	readonly #maxBytes: number;
	readonly #seen = new Set<string>();
	readonly #audios: ExtractedAcpArtifact[] = [];
	readonly #images: ExtractedAcpArtifact[] = [];
	readonly #videos: ExtractedAcpArtifact[] = [];

	constructor(maxBytes: number) {
		this.#maxBytes = maxBytes;
	}

	add(kind: AcpArtifactKind, bytes: Uint8Array, mimeType: string, fileName?: string): void {
		if (bytes.byteLength === 0 || bytes.byteLength > this.#maxBytes) return;
		const digest = sha256Hex(bytes);
		if (this.#seen.has(digest)) return;
		this.#seen.add(digest);
		const artifact: ExtractedAcpArtifact = {
			bytes,
			mimeType,
			sha256: digest,
			...(fileName === undefined ? {} : { fileName }),
		};
		if (kind === "image") this.#images.push(artifact);
		else if (kind === "video") this.#videos.push(artifact);
		else this.#audios.push(artifact);
	}

	result(): ExtractedAcpArtifacts {
		return {
			audios: this.#audios,
			images: this.#images,
			videos: this.#videos,
		};
	}
}

async function resolveArtifactRoot(artifactDir: string): Promise<ArtifactRoot | undefined> {
	try {
		const info = await stat(artifactDir);
		if (!info.isDirectory()) return undefined;
		return { dir: artifactDir, realPath: await realpath(artifactDir) };
	} catch {
		return undefined;
	}
}

async function scanArtifactDirectory(
	dir: string,
	rootRealPath: string,
	collector: ArtifactCollector,
	maxBytes: number,
	visited: Set<string>,
): Promise<void> {
	let realDir: string;
	try {
		realDir = await realpath(dir);
	} catch {
		return;
	}
	if (realDir !== rootRealPath && !isStrictlyInside(rootRealPath, realDir)) return;
	if (visited.has(realDir)) return;
	visited.add(realDir);

	let entries;
	try {
		entries = (await readdir(realDir, { withFileTypes: true })).toSorted((left, right) =>
			left.name.localeCompare(right.name),
		);
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = join(realDir, entry.name);
		if (entry.isSymbolicLink()) {
			let target: string;
			try {
				target = await realpath(fullPath);
			} catch {
				continue;
			}
			if (!isStrictlyInside(rootRealPath, target)) continue;
			let targetInfo;
			try {
				targetInfo = await stat(target);
			} catch {
				continue;
			}
			if (targetInfo.isDirectory()) {
				await scanArtifactDirectory(target, rootRealPath, collector, maxBytes, visited);
			} else if (targetInfo.isFile()) {
				await collectFile(target, entry.name, collector, maxBytes, rootRealPath);
			}
			continue;
		}
		if (entry.isDirectory()) {
			await scanArtifactDirectory(fullPath, rootRealPath, collector, maxBytes, visited);
			continue;
		}
		if (entry.isFile()) {
			await collectFile(fullPath, entry.name, collector, maxBytes, rootRealPath);
		}
	}
}

async function collectFile(
	filePath: string,
	fileName: string,
	collector: ArtifactCollector,
	maxBytes: number,
	rootRealPath: string,
): Promise<void> {
	let target: string;
	try {
		target = await realpath(filePath);
	} catch {
		return;
	}
	if (!isStrictlyInside(rootRealPath, target)) return;
	let info;
	try {
		info = await stat(target);
	} catch {
		return;
	}
	if (!info.isFile() || info.size === 0 || info.size > maxBytes) return;
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(target));
	} catch {
		return;
	}
	const detected = detectAcpMedia(bytes, undefined, fileName);
	if (detected === undefined) return;
	collector.add(detected.kind, bytes, detected.mimeType, safeFileName(fileName));
}

async function collectArtifactUpdates(
	updates: readonly AcpArtifactUpdateInput[],
	root: ArtifactRoot | undefined,
	collector: ArtifactCollector,
	maxBytes: number,
): Promise<void> {
	for (const update of updates) {
		if (update.type === "image" || update.type === "audio") {
			const bytes = decodeBase64Bytes(update.data);
			if (bytes === undefined) continue;
			const fileName = safeFileName(update.name);
			const detected = detectAcpMedia(bytes, update.mimeType, fileName);
			if (detected === undefined || detected.kind !== update.type) continue;
			collector.add(detected.kind, bytes, detected.mimeType, fileName);
			continue;
		}
		if (update.type === "resource") {
			await collectResourceUpdate(update, root, collector, maxBytes);
			continue;
		}
		if (update.type === "resource_link") {
			if (root === undefined) continue;
			const linkPath = filePathFromUri(update.uri);
			if (linkPath === undefined) continue;
			await collectContainedFile(
				linkPath,
				root,
				update.name === undefined ? undefined : basename(update.name),
				collector,
				maxBytes,
			);
			continue;
		}
		if (update.type === "tool_call" || update.type === "tool_call_update") {
			if (update.content !== undefined) {
				await collectArtifactUpdates(update.content, root, collector, maxBytes);
			}
		}
	}
}

async function collectResourceUpdate(
	update: AcpResourceArtifactUpdate,
	root: ArtifactRoot | undefined,
	collector: ArtifactCollector,
	maxBytes: number,
): Promise<void> {
	const uriPath =
		update.resource.uri === undefined ? undefined : filePathFromUri(update.resource.uri);
	const inferredName = safeFileName(update.name);
	if (update.resource.blob !== undefined) {
		const bytes = decodeBase64Bytes(update.resource.blob);
		if (bytes !== undefined) {
			const hintName =
				inferredName ?? (uriPath === undefined ? undefined : safeFileName(basename(uriPath)));
			const detected = detectAcpMedia(bytes, update.resource.mimeType, hintName);
			if (detected !== undefined) {
				collector.add(detected.kind, bytes, detected.mimeType, hintName);
			}
		}
	}
	if (root === undefined || uriPath === undefined) return;
	await collectContainedFile(uriPath, root, inferredName, collector, maxBytes);
}

async function collectAssistantTextPaths(
	text: string,
	root: ArtifactRoot,
	collector: ArtifactCollector,
	maxBytes: number,
): Promise<void> {
	const pattern = new RegExp(MEDIA_PATH_SOURCE, "giu");
	const seen = new Set<string>();
	for (const match of text.matchAll(pattern)) {
		const token = match[0]?.replace(/[.,;:!?]+$/u, "");
		if (token === undefined || token.length === 0 || seen.has(token)) continue;
		seen.add(token);
		const mentionedPath = mentionPath(token);
		if (mentionedPath === undefined) continue;
		await collectContainedFile(mentionedPath, root, undefined, collector, maxBytes);
	}
}

async function collectContainedFile(
	candidatePath: string,
	root: ArtifactRoot,
	fileNameHint: string | undefined,
	collector: ArtifactCollector,
	maxBytes: number,
): Promise<void> {
	const absolute = isAbsolute(candidatePath) ? candidatePath : resolve(root.dir, candidatePath);
	let target: string;
	try {
		target = await realpath(absolute);
	} catch {
		return;
	}
	if (!isStrictlyInside(root.realPath, target)) return;
	await collectFile(target, fileNameHint ?? basename(target), collector, maxBytes, root.realPath);
}

function mentionPath(token: string): string | undefined {
	if (/^file:\/\//iu.test(token)) return filePathFromUri(token);
	if (/^[a-z][a-z0-9+.-]*:/iu.test(token) && !/^[A-Za-z]:[\\/]/u.test(token)) return undefined;
	return token;
}

function filePathFromUri(uri: string): string | undefined {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return undefined;
	}
	if (url.protocol !== "file:") return undefined;
	if (url.hostname.length > 0 && url.hostname.toLowerCase() !== "localhost") return undefined;
	try {
		return fileURLToPath(url);
	} catch {
		return undefined;
	}
}

/** Rejects the root itself and any path resolving outside it, including `..` traversal. */
function isStrictlyInside(rootRealPath: string, candidateRealPath: string): boolean {
	const rel = relative(rootRealPath, candidateRealPath);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function decodeBase64Bytes(value: string): Uint8Array | undefined {
	let payload = value.trim();
	if (payload.length === 0) return undefined;
	const dataUrl = /^data:[^,]*;base64,(.*)$/isu.exec(payload);
	if (dataUrl !== null) {
		payload = dataUrl[1] ?? "";
	} else if (/^data:/iu.test(payload)) {
		return undefined;
	}
	payload = payload.replace(/\s+/gu, "");
	if (payload.length === 0 || payload.length % 4 !== 0) return undefined;
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return undefined;
	const buffer = Buffer.from(payload, "base64");
	if (buffer.byteLength === 0) return undefined;
	return new Uint8Array(buffer);
}

function safeFileName(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const name = basename(value.replaceAll("\\", "/")).trim();
	if (name.length === 0 || name === "." || name === "..") return undefined;
	return name.slice(0, 160);
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function normalizeMimeType(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.split(";")[0]?.trim().toLowerCase();
	return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function fileExtension(fileName: string | undefined): string | undefined {
	if (fileName === undefined) return undefined;
	const extension = extname(fileName).slice(1).toLowerCase();
	return extension.length === 0 ? undefined : extension;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
	if (bytes.byteLength < offset + length) return "";
	let out = "";
	for (let index = 0; index < length; index += 1) {
		out += String.fromCharCode(bytes[offset + index] ?? 0);
	}
	return out;
}

function detectMagicMedia(
	bytes: Uint8Array,
	fileName: string | undefined,
	declaredMimeType: string | undefined,
): DetectedAcpMedia | undefined {
	if (
		bytes.byteLength >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return EXTENSION_MEDIA.png;
	}
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return EXTENSION_MEDIA.jpg;
	}
	const header = asciiAt(bytes, 0, 4);
	if (header === "GIF8") return EXTENSION_MEDIA.gif;
	if (bytes.byteLength >= 12 && asciiAt(bytes, 0, 4) === "RIFF") {
		const riffType = asciiAt(bytes, 8, 4);
		if (riffType === "WEBP") return EXTENSION_MEDIA.webp;
		if (riffType === "WAVE") return EXTENSION_MEDIA.wav;
	}
	if (bytes.byteLength >= 4 && asciiAt(bytes, 0, 4) === "OggS") return EXTENSION_MEDIA.ogg;
	if (bytes.byteLength >= 3 && asciiAt(bytes, 0, 3) === "ID3") return EXTENSION_MEDIA.mp3;
	if (bytes.byteLength >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
		return EXTENSION_MEDIA.mp3;
	}
	if (
		bytes.byteLength >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		return EXTENSION_MEDIA.webm;
	}
	if (bytes.byteLength >= 12 && asciiAt(bytes, 4, 4) === "ftyp") {
		const brand = asciiAt(bytes, 8, 4);
		const extension = fileExtension(fileName);
		if (brand === "qt  " || extension === "mov") return EXTENSION_MEDIA.mov;
		const declared = normalizeMimeType(declaredMimeType);
		if (
			brand === "M4A " ||
			brand === "M4B " ||
			extension === "m4a" ||
			declared?.startsWith("audio/") === true
		) {
			return EXTENSION_MEDIA.m4a;
		}
		return EXTENSION_MEDIA.mp4;
	}
	return undefined;
}

export function detectAcpMedia(
	bytes: Uint8Array,
	declaredMimeType?: string,
	fileName?: string,
): DetectedAcpMedia | undefined {
	const magic = detectMagicMedia(bytes, fileName, declaredMimeType);
	if (magic !== undefined) return magic;
	const declared = normalizeMimeType(declaredMimeType);
	if (declared !== undefined) {
		const byMime = MIME_MEDIA[declared];
		if (byMime !== undefined) return byMime;
	}
	const extension = fileExtension(fileName);
	return extension === undefined ? undefined : EXTENSION_MEDIA[extension];
}
