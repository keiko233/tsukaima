import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { media, messages, type TsukaimaDatabase } from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import type { MediaKind, MediaService } from "./media-service.ts";

export const SANDBOX_INPUT_MAX_FILES = 10;
export const SANDBOX_INPUT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const SANDBOX_OUTPUT_MAX_FILES = 5;
export const SANDBOX_OUTPUT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface SandboxStagedInput {
	readonly mediaId: string;
	readonly mimeType: string;
	readonly name: string;
	readonly sizeBytes: number;
}

export interface SandboxOutputFile {
	readonly fileName: string;
	readonly mediaId: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
}

function safeFileName(input: string): string {
	const base = basename(input.replaceAll("\\", "/"))
		.replace(/[\p{Cc}]+/gu, "")
		.replace(/[^A-Za-z0-9._-]+/gu, "_")
		.replace(/^\.+/u, "")
		.slice(0, 120);
	return base.length === 0 ? "file" : base;
}

function uniqueName(name: string, used: Set<string>): string {
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	const extension = extname(name);
	const stem = extension.length === 0 ? name : name.slice(0, -extension.length);
	let index = 2;
	while (true) {
		const candidate = `${stem}-${index}${extension}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
		index += 1;
	}
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function safeInputsDirectory(sandboxPath: string): Promise<string> {
	const root = await realpath(sandboxPath);
	const inputs = join(root, "inputs");
	try {
		await mkdir(inputs, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(inputs);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error("sandbox_inputs_unsafe");
	}
	const resolved = await realpath(inputs);
	if (resolved !== inputs || !isInside(root, resolved)) {
		throw new Error("sandbox_inputs_unsafe");
	}
	return resolved;
}

async function writeExclusiveFile(
	directory: { readonly fd: number; readonly path: string },
	baseName: string,
	used: Set<string>,
	bytes: Uint8Array,
): Promise<string> {
	let name = uniqueName(baseName, used);
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const target =
			process.platform === "linux"
				? `/proc/self/fd/${directory.fd}/${name}`
				: join(directory.path, name);
		let handle;
		try {
			handle = await open(
				target,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				name = uniqueName(baseName, used);
				continue;
			}
			throw error;
		}
		try {
			await handle.writeFile(bytes);
			return name;
		} catch (error) {
			await handle.close().catch(() => undefined);
			await unlink(target).catch(() => undefined);
			throw error;
		} finally {
			await handle.close().catch(() => undefined);
		}
	}
	throw new Error("sandbox_input_name_collision");
}

/**
 * Stage only media referenced by messages in the caller's own session. Message ids and media
 * ids are both caller-supplied, so an id from another conversation must never be reachable by
 * naming it here.
 */
export async function stageSandboxInputs(input: {
	readonly autoStageRecentFiles?: boolean;
	readonly database: TsukaimaDatabase;
	readonly fileNames?: readonly string[];
	readonly logger: Logger;
	readonly media: MediaService;
	readonly mediaIds: readonly string[];
	readonly sandboxPath: string;
	readonly senderPlatformId?: string;
	readonly sourceSessionId: string;
}): Promise<readonly SandboxStagedInput[]> {
	const requestedIds = [
		...new Set(input.mediaIds.map((id) => id.trim()).filter((id) => id.length > 0)),
	];
	const requestedNames = [
		...new Set(
			(input.fileNames ?? []).map((name) => name.trim()).filter((name) => name.length > 0),
		),
	];
	if (
		requestedIds.length === 0 &&
		requestedNames.length === 0 &&
		input.autoStageRecentFiles !== true
	) {
		return [];
	}
	const rows = await input.database
		.select({
			partsJson: messages.partsJson,
			senderExternalId: messages.senderExternalId,
		})
		.from(messages)
		.where(
			and(eq(messages.conversationId, input.sourceSessionId), eq(messages.direction, "inbound")),
		)
		.orderBy(desc(messages.occurredAt), desc(messages.ingestedAt), desc(sql`${messages}.rowid`));
	const owned = new Map<string, string>();
	const ownedByFileName = new Map<string, string>();
	const recentCallerFileIds: string[] = [];
	for (const row of rows) {
		if (row.partsJson === null) continue;
		let parts: unknown;
		try {
			parts = JSON.parse(row.partsJson);
		} catch {
			continue;
		}
		if (!Array.isArray(parts)) continue;
		const rowFileIds: string[] = [];
		const senderMatches =
			input.senderPlatformId === undefined || row.senderExternalId === input.senderPlatformId;
		for (const part of parts) {
			if (
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				(part.type === "file" || part.type === "image") &&
				"mediaId" in part &&
				typeof part.mediaId === "string"
			) {
				const rawName =
					"fileName" in part && typeof part.fileName === "string" ? part.fileName : part.mediaId;
				if (!owned.has(part.mediaId)) owned.set(part.mediaId, rawName);
				const normalizedRaw = rawName.trim().toLowerCase();
				const normalizedSafe = safeFileName(rawName).toLowerCase();
				if (senderMatches || !ownedByFileName.has(normalizedRaw)) {
					if (!ownedByFileName.has(normalizedRaw)) ownedByFileName.set(normalizedRaw, part.mediaId);
					if (!ownedByFileName.has(normalizedSafe)) {
						ownedByFileName.set(normalizedSafe, part.mediaId);
					}
				}
				if (part.type === "file" && senderMatches) {
					rowFileIds.push(part.mediaId);
				}
			}
		}
		if (recentCallerFileIds.length === 0 && rowFileIds.length > 0) {
			recentCallerFileIds.push(...rowFileIds);
		}
	}
	const resolvedIds = new Set<string>();
	for (const id of requestedIds) {
		if (owned.has(id)) resolvedIds.add(id);
	}
	if (requestedIds.length !== resolvedIds.size) {
		input.logger.warn("sandbox input media rejected outside the source session", {
			requested: requestedIds.length,
			accepted: resolvedIds.size,
			sourceSessionId: input.sourceSessionId,
		});
	}
	for (const fileName of requestedNames) {
		const matchedId =
			ownedByFileName.get(fileName.toLowerCase()) ??
			ownedByFileName.get(safeFileName(fileName).toLowerCase());
		if (matchedId !== undefined) resolvedIds.add(matchedId);
	}
	if (
		input.autoStageRecentFiles === true &&
		requestedIds.length === 0 &&
		requestedNames.length === 0
	) {
		for (const id of recentCallerFileIds) resolvedIds.add(id);
	}
	const accepted = [...resolvedIds];
	const mediaRows =
		accepted.length === 0
			? []
			: await input.database.select().from(media).where(inArray(media.id, accepted));
	const inputsDir = await safeInputsDirectory(input.sandboxPath);
	const directory = await open(
		inputsDir,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	const used = new Set<string>();
	const staged: SandboxStagedInput[] = [];
	let total = 0;
	try {
		for (const row of mediaRows.slice(0, SANDBOX_INPUT_MAX_FILES)) {
			if (total + row.sizeBytes > SANDBOX_INPUT_MAX_TOTAL_BYTES) break;
			try {
				const stored = await input.media.findById(row.id);
				if (stored === undefined) continue;
				const bytes = await input.media.readBytes(stored.sha256);
				if (total + bytes.byteLength > SANDBOX_INPUT_MAX_TOTAL_BYTES) break;
				const name = await writeExclusiveFile(
					{ fd: directory.fd, path: inputsDir },
					safeFileName(owned.get(row.id) ?? row.id),
					used,
					bytes,
				);
				total += bytes.byteLength;
				staged.push({
					mediaId: stored.id,
					mimeType: stored.mimeType,
					name,
					sizeBytes: bytes.byteLength,
				});
			} catch (error) {
				input.logger.warn("sandbox input staging failed", {
					error: error instanceof Error ? error.message : String(error),
					mediaId: row.id,
				});
			}
		}
	} finally {
		await directory.close().catch(() => undefined);
	}
	return staged;
}

export function describeStagedInputs(inputs: readonly SandboxStagedInput[]): string {
	if (inputs.length === 0) return "";
	return [
		"Staged user input files are available under inputs/ (read-only guidance; the directory is writable because it is inside the sandbox):",
		...inputs.map(
			(entry) => `- inputs/${entry.name} (${entry.mimeType}, ${entry.sizeBytes} bytes)`,
		),
	].join("\n");
}

function mimeForOutput(fileName: string): { kind: MediaKind; mimeType: string } {
	const extension = extname(fileName).toLowerCase();
	switch (extension) {
		case ".csv":
			return { kind: "file", mimeType: "text/csv" };
		case ".gif":
			return { kind: "image", mimeType: "image/gif" };
		case ".htm":
		case ".html":
			return { kind: "file", mimeType: "text/html" };
		case ".jpeg":
		case ".jpg":
			return { kind: "image", mimeType: "image/jpeg" };
		case ".json":
			return { kind: "file", mimeType: "application/json" };
		case ".md":
			return { kind: "file", mimeType: "text/markdown" };
		case ".pdf":
			return { kind: "file", mimeType: "application/pdf" };
		case ".png":
			return { kind: "image", mimeType: "image/png" };
		case ".svg":
			return { kind: "file", mimeType: "image/svg+xml" };
		case ".txt":
		case ".log":
			return { kind: "file", mimeType: "text/plain" };
		case ".webp":
			return { kind: "image", mimeType: "image/webp" };
		case ".xml":
		case ".yaml":
		case ".yml":
			return { kind: "file", mimeType: "application/xml" };
		default:
			return { kind: "file", mimeType: "application/octet-stream" };
	}
}

/** Store bounded regular files the sandbox produced under output/. Symlinks are ignored. */
export async function collectSandboxOutputs(input: {
	readonly logger: Logger;
	readonly media: MediaService;
	readonly sandboxPath: string;
	readonly sandboxSessionId: string;
}): Promise<readonly SandboxOutputFile[]> {
	const outputDir = join(input.sandboxPath, "output");
	const resolved = await realpath(outputDir).catch(() => undefined);
	if (resolved === undefined) return [];
	const entries = await readdir(resolved).catch(() => []);
	const outputs: SandboxOutputFile[] = [];
	for (const entry of entries.slice(0, SANDBOX_OUTPUT_MAX_FILES * 2)) {
		if (outputs.length >= SANDBOX_OUTPUT_MAX_FILES) break;
		const path = join(resolved, entry);
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink()) continue;
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const opened = await handle.stat();
				if (!opened.isFile() || opened.size <= 0 || opened.size > SANDBOX_OUTPUT_MAX_FILE_BYTES) {
					continue;
				}
				const bytes = Buffer.alloc(opened.size);
				let offset = 0;
				while (offset < bytes.byteLength) {
					const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
					if (read.bytesRead === 0) break;
					offset += read.bytesRead;
				}
				const content = bytes.subarray(0, offset);
				const kind = mimeForOutput(entry);
				const stored = await input.media.store({
					bytes: content,
					kind: kind.kind,
					metadata: {
						fileName: entry,
						sandboxSessionId: input.sandboxSessionId,
						sha256: createHash("sha256").update(content).digest("hex"),
					},
					mimeType: kind.mimeType,
					source: "generated",
				});
				outputs.push({
					fileName: safeFileName(entry),
					mediaId: stored.id,
					mimeType: stored.mimeType,
					sizeBytes: stored.sizeBytes,
				});
			} finally {
				await handle.close().catch(() => undefined);
			}
		} catch (error) {
			input.logger.warn("sandbox output collection failed", {
				error: error instanceof Error ? error.message : String(error),
				file: entry,
				sandboxSessionId: input.sandboxSessionId,
			});
		}
	}
	return outputs;
}
