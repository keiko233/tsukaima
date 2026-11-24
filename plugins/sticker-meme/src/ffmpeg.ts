import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export function findFfmpeg(ffmpegPath?: string): string | undefined {
	const configured = ffmpegPath?.trim() || process.env.TSUKAIMA_FFMPEG_PATH?.trim();
	if (configured !== undefined && configured.length > 0) return configured;
	return Bun.which("ffmpeg") ?? undefined;
}

export function findFfprobe(ffmpegPath?: string): string | undefined {
	const resolvedFfmpeg = findFfmpeg(ffmpegPath);
	if (resolvedFfmpeg !== undefined && isAbsolute(resolvedFfmpeg)) {
		const sibling = join(dirname(resolvedFfmpeg), "ffprobe");
		if (existsSync(sibling)) return sibling;
	}
	return Bun.which("ffprobe") ?? undefined;
}

export interface VideoMetadata {
	readonly durationSeconds?: number;
	readonly fps?: number;
	readonly hasAlpha: boolean;
	readonly height?: number;
	readonly width?: number;
}

function parseFrameRate(raw: unknown): number | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return undefined;
	const parts = trimmed.split("/");
	if (parts.length === 2) {
		const num = Number(parts[0]);
		const den = Number(parts[1]);
		if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
			return num / den;
		}
		return undefined;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function probeVideoMetadata(
	ffprobePath: string,
	inputPath: string,
): Promise<VideoMetadata | undefined> {
	try {
		const { stdout } = await runFfmpegCommand(
			ffprobePath,
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height,r_frame_rate,avg_frame_rate,pix_fmt,duration",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				inputPath,
			],
			{ timeoutMs: 10_000 },
		);
		const parsed = JSON.parse(stdout) as {
			format?: { duration?: string };
			streams?: Array<{
				avg_frame_rate?: string;
				duration?: string;
				height?: number;
				pix_fmt?: string;
				r_frame_rate?: string;
				width?: number;
			}>;
		};
		const stream = parsed.streams?.[0];
		if (stream === undefined) return undefined;
		const fps = parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate);
		const rawDuration = Number(stream.duration ?? parsed.format?.duration);
		const durationSeconds =
			Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : undefined;
		const pixFmt = typeof stream.pix_fmt === "string" ? stream.pix_fmt.trim().toLowerCase() : "";
		const hasAlpha = /^(?:rgba|bgra|argb|abgr|yuva|gbrap|ya|pal8)/u.test(pixFmt);
		return {
			...(durationSeconds === undefined ? {} : { durationSeconds }),
			...(fps === undefined ? {} : { fps }),
			hasAlpha,
			...(typeof stream.height === "number" && stream.height > 0 ? { height: stream.height } : {}),
			...(typeof stream.width === "number" && stream.width > 0 ? { width: stream.width } : {}),
		};
	} catch {
		return undefined;
	}
}

export interface FfmpegCommandOptions {
	readonly timeoutMs?: number;
}

/**
 * Run an ffmpeg command with a bounded stderr tail and an optional hard timeout, so a corrupt
 * sticker cannot stall an import worker forever.
 */
export function runFfmpegCommand(
	command: string,
	args: readonly string[],
	options: FfmpegCommandOptions = {},
): Promise<{ readonly stderr: string; readonly stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let stdout = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (error === undefined) resolve({ stderr, stdout });
			else reject(error);
		};
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish(new Error(`${command} timed out after ${options.timeoutMs}ms`));
			}, options.timeoutMs);
			timer.unref?.();
		}
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > 8_000) stdout = stdout.slice(-8_000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
		});
	});
}
