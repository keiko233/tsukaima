import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoFrameExtractor } from "../src/services/video-frames.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function fixtureScript(contents: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-video-frames-test-"));
	directories.push(directory);
	const path = join(directory, "ffmpeg-fake.sh");
	await writeFile(path, `#!/bin/sh\n${contents}\n`);
	await chmod(path, 0o755);
	return path;
}

describe("bounded video frame extraction", () => {
	test("stores at most three keyframes from the temporary ffmpeg output", async () => {
		const ffmpegPath = await fixtureScript(`
			for arg in "$@"; do out="$arg"; done
			dir=$(dirname "$out")
			for index in 1 2 3 4; do
				file="$dir/frame-00$index.jpg"
				printf 'frame-%s' "$index" > "$file"
			done
		`);
		const stored: { index: number; mediaId: string; sha256: string }[] = [];
		const extract = createVideoFrameExtractor({
			ffmpegPath,
			resolveBytes: async () => new Uint8Array([1, 2, 3]),
			storeFrame: async (bytes, input) => {
				const mediaId = `media-${input.index}`;
				const sha256 = `sha-${input.index}-${bytes.byteLength}`;
				stored.push({ index: input.index, mediaId, sha256 });
				return { mediaId, sha256 };
			},
		});
		const frames = await extract({
			mimeType: "video/mp4",
			sourceUrl: "https://media.invalid/v.mp4",
		});
		expect(frames).toHaveLength(3);
		expect(frames.map((frame) => frame.mediaId)).toEqual(["media-0", "media-1", "media-2"]);
		expect(stored.map((entry) => entry.index)).toEqual([0, 1, 2]);
	});

	test("returns no frames when the source or ffmpeg binary is unavailable", async () => {
		const ffmpegPath = await fixtureScript('printf "unexpected" >&2');
		const missingSource = createVideoFrameExtractor({
			ffmpegPath,
			resolveBytes: async () => undefined,
			storeFrame: async () => {
				throw new Error("must not store without bytes");
			},
		});
		expect(await missingSource({ mimeType: "video/mp4" })).toEqual([]);

		const missingBinary = createVideoFrameExtractor({
			ffmpegPath: join(tmpdir(), "tsukaima-no-such-ffmpeg"),
			resolveBytes: async () => new Uint8Array([4, 5]),
			storeFrame: async () => ({ mediaId: "unused", sha256: "unused" }),
		});
		expect(await missingBinary({ mimeType: "video/mp4" })).toEqual([]);
	});

	test("kills a stalled ffmpeg process and degrades to no frames", async () => {
		const ffmpegPath = await fixtureScript("sleep 5");
		const extract = createVideoFrameExtractor({
			ffmpegPath,
			timeoutMs: 250,
			resolveBytes: async () => new Uint8Array([6, 7]),
			storeFrame: async () => ({ mediaId: "unused", sha256: "unused" }),
		});
		const startedAt = Date.now();
		expect(await extract({ mimeType: "video/mp4" })).toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});
});
