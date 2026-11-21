import { spawn } from "node:child_process";

export function findFfmpeg(ffmpegPath?: string): string | undefined {
	const configured = ffmpegPath?.trim() || process.env.TSUKAIMA_FFMPEG_PATH?.trim();
	if (configured !== undefined && configured.length > 0) return configured;
	return Bun.which("ffmpeg") ?? undefined;
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
