import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logging.ts";

/** Structural subset of the OneBot video frame extractor binding input. */
export interface VideoFrameInput {
	readonly channelRef?: string;
	readonly durationMs?: number;
	readonly messageId?: string;
	readonly mimeType?: string;
	readonly sourceUrl?: string;
}

export interface VideoFrameReference {
	readonly mediaId?: string;
	readonly offsetMs?: number;
	readonly sha256?: string;
}

/** Resolves the source video bytes through the channel or the host's guarded media fetch. */
export type VideoFrameBytesResolver = (input: VideoFrameInput) => Promise<Uint8Array | undefined>;

/** Stores one extracted still as canonical host media and returns its durable reference. */
export type VideoFrameStore = (
	bytes: Uint8Array,
	input: { readonly index: number; readonly mimeType: string },
) => Promise<{ readonly mediaId: string; readonly sha256: string }>;

export interface VideoFrameExtractorOptions {
	readonly resolveBytes: VideoFrameBytesResolver;
	readonly storeFrame: VideoFrameStore;
	readonly ffmpegPath?: string | undefined;
	readonly logger?: Logger | undefined;
	readonly maxFrames?: number;
	readonly timeoutMs?: number;
}

const DEFAULT_MAX_FRAMES = 3;
/** Leaves headroom under `normalizeOneBotEventAsync`'s 5 s outer extraction timeout. */
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_FRAME_WIDTH = 1_280;
const FRAME_FILE_PATTERN = /^frame-\d{3}\.jpg$/u;

function findFfmpeg(configured?: string): string | undefined {
	const candidate = configured?.trim() || process.env.TSUKAIMA_FFMPEG_PATH?.trim();
	if (candidate !== undefined && candidate.length > 0) return candidate;
	return Bun.which("ffmpeg") ?? undefined;
}

function extensionFor(mimeType: string | undefined): string {
	switch (mimeType?.toLowerCase()) {
		case "video/webm":
			return ".webm";
		case "video/quicktime":
			return ".mov";
		case "video/x-matroska":
			return ".mkv";
		default:
			return ".mp4";
	}
}

function runFfmpeg(ffmpeg: string, args: readonly string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = "";
		const child = spawn(ffmpeg, [...args], { stdio: ["ignore", "ignore", "pipe"] });
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === undefined) resolve();
			else reject(error);
		};
		const timer = setTimeout(
			() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish(new Error("video frame extraction timed out"));
			},
			Math.max(250, timeoutMs),
		);
		child.stderr?.on("data", (chunk: unknown) => {
			if (stderr.length >= 2_000) return;
			stderr += String(chunk);
		});
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			if (code === 0) {
				finish();
				return;
			}
			const detail = stderr.replace(/\s+/gu, " ").trim().slice(0, 500);
			finish(new Error(detail.length > 0 ? `ffmpeg failed: ${detail}` : `ffmpeg exited ${code}`));
		});
	});
}

/**
 * Bounded keyframe extraction for inbound videos. Every failure (no ffmpeg, no source bytes,
 * timeout, unsupported codec) degrades to an empty frame list so the original video part is
 * still delivered to the model. The temporary workspace is always removed in `finally`.
 */
export function createVideoFrameExtractor(
	options: VideoFrameExtractorOptions,
): (input: VideoFrameInput) => Promise<readonly VideoFrameReference[]> {
	const logger = options.logger?.child("tsukaima::server::video-frames");
	const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? DEFAULT_MAX_FRAMES));
	const timeoutMs = Math.max(250, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	return async (input) => {
		const ffmpeg = findFfmpeg(options.ffmpegPath);
		if (ffmpeg === undefined) return [];
		const startedAtMs = Date.now();
		let directory: string | undefined;
		try {
			const bytes = await options.resolveBytes(input);
			if (bytes === undefined || bytes.byteLength === 0) return [];
			directory = await mkdtemp(join(tmpdir(), "tsukaima-video-"));
			const sourcePath = join(directory, `source${extensionFor(input.mimeType)}`);
			await writeFile(sourcePath, bytes);
			const outputPattern = join(directory, "frame-%03d.jpg");
			await runFfmpeg(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					sourcePath,
					"-vf",
					`select=eq(pict_type\\,I),scale=min(${MAX_FRAME_WIDTH}\\,iw):-2`,
					"-frames:v",
					String(maxFrames),
					"-q:v",
					"4",
					outputPattern,
				],
				timeoutMs,
			);
			const files = (await readdir(directory))
				.filter((name) => FRAME_FILE_PATTERN.test(name))
				.toSorted()
				.slice(0, maxFrames);
			const frames: VideoFrameReference[] = [];
			for (const [index, name] of files.entries()) {
				try {
					const frameBytes = await readFile(join(directory, name));
					if (frameBytes.byteLength === 0) continue;
					const stored = await options.storeFrame(new Uint8Array(frameBytes), {
						index,
						mimeType: "image/jpeg",
					});
					frames.push(stored);
				} catch (error) {
					logger?.warn("video frame could not be stored; skipping frame", {
						error: error instanceof Error ? error.message : String(error),
						index,
					});
				}
			}
			logger?.debug("video frame extraction completed", {
				durationMs: Date.now() - startedAtMs,
				frames: frames.length,
			});
			return frames;
		} catch (error) {
			logger?.debug("video frame extraction skipped", {
				durationMs: Date.now() - startedAtMs,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		} finally {
			if (directory !== undefined) {
				await rm(directory, { force: true, recursive: true }).catch(() => undefined);
			}
		}
	};
}
