import { open, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

export type PathFailure =
	| "absolute_path"
	| "escapes_root"
	| "invalid_path"
	| "not_found"
	| "not_file"
	| "not_text"
	| "too_large"
	| "traversal";

export type PathResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: PathFailure };

export interface RelativePath {
	readonly path: string;
	readonly segments: readonly string[];
}

export interface ResolvedFile {
	readonly bytes: number;
	readonly real: string;
}

export interface ReadTextResult {
	readonly bytes: number;
	readonly text: string;
}

const MAX_RELATIVE_PATH_CHARS = 512;

function failure<T>(reason: PathFailure): PathResult<T> {
	return { ok: false, reason };
}

/**
 * Accepts only a relative, slash-separated path with no traversal, no dot segments, and no
 * hidden segments. Callers use this before any filesystem lookup so absolute paths and
 * `..` escapes never reach `realpath`.
 */
export function normalizeRelative(input: unknown): PathResult<RelativePath> {
	if (typeof input !== "string") return failure("invalid_path");
	if (input.length === 0 || input.length > MAX_RELATIVE_PATH_CHARS) return failure("invalid_path");
	if (input.includes("\0")) return failure("invalid_path");
	const slashed = input.replace(/\\/gu, "/");
	if (slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed) || slashed.startsWith("//")) {
		return failure("absolute_path");
	}
	const segments: string[] = [];
	for (const segment of slashed.split("/")) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") return failure("traversal");
		if (segment.startsWith(".")) return failure("invalid_path");
		segments.push(segment);
	}
	if (segments.length === 0) return failure("invalid_path");
	return { ok: true, value: { path: segments.join("/"), segments } };
}

export function isInside(rootReal: string, candidateReal: string): boolean {
	return candidateReal === rootReal || candidateReal.startsWith(rootReal + sep);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { readonly code?: unknown }).code)
		: undefined;
}

/** Resolves one normalized path below an already-real root, without requiring a file. */
export async function resolveEntryInside(
	rootReal: string,
	relative: unknown,
): Promise<PathResult<{ readonly real: string }>> {
	const normalized = normalizeRelative(relative);
	if (!normalized.ok) return normalized;
	let resolved: string;
	try {
		resolved = await realpath(join(rootReal, ...normalized.value.segments));
	} catch {
		return failure("not_found");
	}
	if (!isInside(rootReal, resolved)) return failure("escapes_root");
	return { ok: true, value: { real: resolved } };
}

/** Resolves one normalized path below an already-real root and requires a regular file. */
export async function resolveInside(
	rootReal: string,
	relative: unknown,
): Promise<PathResult<ResolvedFile>> {
	const normalized = normalizeRelative(relative);
	if (!normalized.ok) return normalized;
	const candidate = join(rootReal, ...normalized.value.segments);
	let resolved: string;
	try {
		resolved = await realpath(candidate);
	} catch (error) {
		return failure(errorCode(error) === "ENOENT" ? "not_found" : "not_found");
	}
	if (!isInside(rootReal, resolved)) return failure("escapes_root");
	try {
		const info = await stat(resolved);
		if (!info.isFile()) return failure("not_file");
		return { ok: true, value: { bytes: info.size, real: resolved } };
	} catch {
		return failure("not_found");
	}
}

/**
 * Reads a bounded UTF-8 text file inside the root. A file is rejected when it exceeds the cap,
 * contains a NUL byte, or is not valid UTF-8; contents never leave through an error message.
 */
export async function readFileInside(
	rootReal: string,
	relative: unknown,
	maxBytes: number,
): Promise<PathResult<ReadTextResult>> {
	const resolved = await resolveInside(rootReal, relative);
	if (!resolved.ok) return resolved;
	if (resolved.value.bytes > maxBytes) return failure("too_large");
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(resolved.value.real, "r");
		const info = await handle.stat();
		if (info.size > maxBytes) return failure("too_large");
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maxBytes) return failure("too_large");
		const bytes = buffer.subarray(0, bytesRead);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.includes("\0")) return failure("not_text");
		return { ok: true, value: { bytes: bytesRead, text } };
	} catch {
		return failure("not_text");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
