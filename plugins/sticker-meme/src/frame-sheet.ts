import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg, runFfmpegCommand } from "./ffmpeg.ts";

/** Minimal logging port, so a semantic classifier logger can be passed straight through. */
export interface FrameSheetLogger {
	debug?(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Many providers only accept a single still image. Animated stickers are therefore sampled into
 * one contact sheet so the model can still read the motion as a time sequence.
 */
export interface FrameSheet {
	readonly bytes: Uint8Array;
	readonly frameCount: number;
	readonly mimeType: "image/png";
}

export interface FrameSheetOptions {
	/** Longest edge of one frame cell in the sheet. Defaults to 224px. */
	readonly cellSize?: number;
	readonly ffmpegPath?: string;
	readonly logger?: FrameSheetLogger | undefined;
	/** Frames sampled across the animation. Defaults to 6 and is capped at 12. */
	readonly maxFrames?: number;
	readonly timeoutMs?: number;
}

const DEFAULT_CELL_SIZE = 224;
const DEFAULT_MAX_FRAMES = 6;
const MAX_MAX_FRAMES = 12;
/** Bounded decode, so a long GIF cannot fill the temp directory. */
const FRAME_EXTRACT_LIMIT = 120;
const SHEET_GAP = 4;
const FRAME_FILE_PATTERN = /^frame-(\d+)\.png$/u;

const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
const VP8X = [0x56, 0x50, 0x38, 0x58] as const;

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
	if (bytes.byteLength < offset + expected.length) return false;
	return expected.every((value, index) => bytes[offset + index] === value);
}

/** An animated WebP carries the animation flag in its VP8X extended header. */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
	return (
		startsWith(bytes, 0, RIFF) &&
		startsWith(bytes, 8, WEBP) &&
		startsWith(bytes, 12, VP8X) &&
		((bytes[20] ?? 0) & 0x02) !== 0
	);
}

export function isAnimatedImage(mimeType: string, bytes: Uint8Array): boolean {
	const type = mimeType.toLowerCase();
	if (type === "image/gif") return true;
	return type === "image/webp" && isAnimatedWebp(bytes);
}

function frameFiles(files: readonly string[]): string[] {
	return files
		.filter((file) => FRAME_FILE_PATTERN.test(file))
		.toSorted((left, right) => {
			const leftIndex = Number(FRAME_FILE_PATTERN.exec(left)?.[1] ?? 0);
			const rightIndex = Number(FRAME_FILE_PATTERN.exec(right)?.[1] ?? 0);
			return leftIndex - rightIndex;
		});
}

function sampleIndices(total: number, wanted: number): number[] {
	const count = Math.min(total, Math.max(2, wanted));
	if (count >= total) return Array.from({ length: total }, (_, index) => index);
	if (count === 1) return [0];
	return Array.from({ length: count }, (_, index) =>
		Math.round((index * (total - 1)) / (count - 1)),
	);
}

/**
 * Decode an animated GIF/WebP with ffmpeg, sample frames evenly, and tile them left-to-right,
 * top-to-bottom onto a white PNG sheet. Returns undefined for still images or when ffmpeg is
 * unavailable, so callers can keep the original bytes.
 */
export async function buildAnimatedFrameSheet(
	bytes: Uint8Array,
	mimeType: string,
	options: FrameSheetOptions = {},
): Promise<FrameSheet | undefined> {
	if (!isAnimatedImage(mimeType, bytes)) return undefined;
	const ffmpeg = findFfmpeg(options.ffmpegPath);
	if (ffmpeg === undefined) return undefined;
	const logger = options.logger;
	const maxFrames = Math.max(
		2,
		Math.min(MAX_MAX_FRAMES, Math.floor(options.maxFrames ?? DEFAULT_MAX_FRAMES)),
	);
	const cellSize = Math.max(32, Math.min(512, Math.floor(options.cellSize ?? DEFAULT_CELL_SIZE)));
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-sticker-sheet-"));
	try {
		const extension = mimeType.toLowerCase() === "image/webp" ? "webp" : "gif";
		const input = join(directory, `input.${extension}`);
		await writeFile(input, bytes);
		try {
			await runFfmpegCommand(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					input,
					"-vf",
					"format=rgba",
					"-frames:v",
					String(FRAME_EXTRACT_LIMIT),
					"-f",
					"image2",
					"-start_number",
					"0",
					join(directory, "frame-%03d.png"),
				],
				{ timeoutMs: options.timeoutMs ?? 15_000 },
			);
		} catch (error) {
			logger?.debug?.("animated frame sheet extraction failed", {
				error: error instanceof Error ? error.message : String(error),
				mimeType,
			});
			return undefined;
		}
		const files = frameFiles(await readdir(directory));
		if (files.length < 2) return undefined;
		const indices = sampleIndices(files.length, maxFrames);
		const canvasModule = await import("canvas");
		const firstPath = join(directory, files[indices[0] as number] as string);
		const first = await canvasModule.loadImage(await readFile(firstPath));
		const scale = cellSize / Math.max(1, first.width);
		const cellWidth = cellSize;
		const cellHeight = Math.max(1, Math.round(first.height * scale));
		const columns = Math.ceil(Math.sqrt(indices.length));
		const rows = Math.ceil(indices.length / columns);
		const width = columns * cellWidth + (columns + 1) * SHEET_GAP;
		const height = rows * cellHeight + (rows + 1) * SHEET_GAP;
		const canvas = new canvasModule.Canvas(width, height);
		const context = canvas.getContext("2d");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
		for (const [cell, frameIndex] of indices.entries()) {
			const image = await canvasModule.loadImage(
				await readFile(join(directory, files[frameIndex] as string)),
			);
			const column = cell % columns;
			const row = Math.floor(cell / columns);
			context.drawImage(
				image,
				SHEET_GAP + column * (cellWidth + SHEET_GAP),
				SHEET_GAP + row * (cellHeight + SHEET_GAP),
				cellWidth,
				cellHeight,
			);
		}
		const png = canvas.toBuffer("image/png");
		logger?.debug?.("animated frame sheet built", {
			bytes: png.byteLength,
			decodedFrames: files.length,
			frameCount: indices.length,
			height,
			mimeType,
			width,
		});
		return { bytes: new Uint8Array(png), frameCount: indices.length, mimeType: "image/png" };
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}
