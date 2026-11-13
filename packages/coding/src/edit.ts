import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { sha256Hex } from "./hash.ts";
import { assertSafeWorktreePath } from "./worktree.ts";

export interface StructuredEdit {
	/** `content` replaces the whole file, `find`/`replace` performs one exact substitution. */
	readonly content?: string;
	readonly create?: boolean;
	readonly find?: string;
	readonly path: string;
	readonly replace?: string;
}

export interface EditResult {
	readonly bytesWritten: number;
	readonly checksum: string;
	readonly created: boolean;
	readonly path: string;
}

export interface EditOptions {
	readonly maxBytes?: number;
	readonly maxReplacements?: number;
}

export class EditValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EditValidationError";
	}
}

const DEFAULT_MAX_BYTES = 256 * 1024;

/** Validate before touching the filesystem so denial happens before any side effect. */
export function validateStructuredEdit(edit: StructuredEdit, options: EditOptions = {}): void {
	if (typeof edit.path !== "string" || edit.path.trim().length === 0) {
		throw new EditValidationError("Edit path is required");
	}
	if (edit.path.includes("\0")) throw new EditValidationError("Edit path contains a null byte");
	if (edit.path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(edit.path)) {
		throw new EditValidationError("Edit path must be relative to the task worktree");
	}
	if (edit.path.split(/[\\/]/u).includes("..")) {
		throw new EditValidationError("Edit path must not contain '..'");
	}
	const hasContent = edit.content !== undefined;
	const hasFind = edit.find !== undefined;
	const hasReplace = edit.replace !== undefined;
	if (hasContent && (hasFind || hasReplace)) {
		throw new EditValidationError("Provide either content or find/replace, not both");
	}
	if (hasContent && edit.create !== true) {
		throw new EditValidationError("content edits require create: true");
	}
	if (hasFind !== hasReplace) {
		throw new EditValidationError("find and replace must be supplied together");
	}
	if (!hasContent && !hasFind) {
		throw new EditValidationError("Edit requires content or find/replace");
	}
	if (hasFind && edit.find === "") throw new EditValidationError("find must not be empty");
	if (hasContent && edit.content!.length === 0) {
		throw new EditValidationError("content must not be empty");
	}
	const size = Buffer.byteLength(hasContent ? edit.content! : (edit.replace ?? ""), "utf-8");
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (size > maxBytes) {
		throw new EditValidationError(`Edit payload exceeds ${maxBytes} bytes`);
	}
}

export async function applyStructuredEdit(
	worktreePath: string,
	pathAllowlist: readonly string[],
	edit: StructuredEdit,
	options: EditOptions = {},
): Promise<EditResult> {
	validateStructuredEdit(edit, options);
	const target = await assertSafeWorktreePath(worktreePath, pathAllowlist, edit.path);
	const relPath = relative(worktreePath, target);
	if (edit.content !== undefined) {
		if (edit.create !== true) throw new EditValidationError("content edits require create: true");
		try {
			await lstat(target);
			throw new EditValidationError(`File "${relPath}" already exists (create: false)`);
		} catch (error) {
			if (error instanceof EditValidationError) throw error;
		}
		await mkdir(dirname(target), { recursive: true });
		await assertSafeWorktreePath(worktreePath, pathAllowlist, edit.path);
		await writeFile(target, edit.content, "utf-8");
		return {
			bytesWritten: Buffer.byteLength(edit.content, "utf-8"),
			checksum: sha256Hex(edit.content),
			created: true,
			path: relPath,
		};
	}

	const previous = await readFile(target, "utf-8");
	const find = edit.find!;
	const replace = edit.replace!;
	const occurrences = previous.split(find).length - 1;
	if (occurrences === 0) throw new EditValidationError(`find text not present in "${relPath}"`);
	const maxReplacements = options.maxReplacements ?? 1;
	if (occurrences > maxReplacements) {
		throw new EditValidationError(
			`find text occurs ${occurrences} times in "${relPath}" (max ${maxReplacements})`,
		);
	}
	const next = previous.replace(find, replace);
	await writeFile(target, next, "utf-8");
	return {
		bytesWritten: Buffer.byteLength(next, "utf-8"),
		checksum: sha256Hex(next),
		created: false,
		path: relPath,
	};
}

/** Bounded, allowlisted read used by the analysis tool. */
export async function readAllowedTextFile(
	rootPath: string,
	pathAllowlist: readonly string[],
	candidatePath: string,
	maxBytes = 64 * 1024,
): Promise<{ readonly content: string; readonly path: string; readonly truncated: boolean }> {
	const target = await assertSafeWorktreePath(rootPath, pathAllowlist, candidatePath);
	const buffer = await readFile(target);
	const truncated = buffer.length > maxBytes;
	return {
		content: buffer.subarray(0, maxBytes).toString("utf-8"),
		path: relative(rootPath, target),
		truncated,
	};
}
