import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	extractAcpArtifacts,
	sanitizeAcpRunId,
	withArtifactSandbox,
	type AcpArtifactUpdateInput,
} from "./artifacts.ts";

const directories: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function bytes(...parts: readonly (string | readonly number[] | Uint8Array)[]): Uint8Array {
	const arrays = parts.map((part) => {
		if (typeof part === "string") return encoder.encode(part);
		return part instanceof Uint8Array ? part : Uint8Array.from(part);
	});
	const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.byteLength;
	}
	return result;
}

function pngBytes(suffix = 0): Uint8Array {
	return bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		[0x49, 0x48, 0x44, 0x52],
		[suffix],
	);
}

function jpegBytes(suffix = 0): Uint8Array {
	return bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], [suffix]);
}

function gifBytes(suffix = 0): Uint8Array {
	return bytes("GIF89a", [0x01, 0x00, 0x01, 0x00, suffix]);
}

function webpBytes(suffix = 0): Uint8Array {
	return bytes("RIFF", [0x04, 0x00, 0x00, 0x00], "WEBP", "VP8 ", [suffix]);
}

function mp4Bytes(suffix = 0): Uint8Array {
	return bytes([0x00, 0x00, 0x00, 0x18], "ftyp", "isom", [0x00, 0x00, 0x02, 0x00], "isom", [
		suffix,
	]);
}

function movBytes(suffix = 0): Uint8Array {
	return bytes([0x00, 0x00, 0x00, 0x14], "ftyp", "qt  ", [suffix]);
}

function m4aBytes(suffix = 0): Uint8Array {
	return bytes([0x00, 0x00, 0x00, 0x14], "ftyp", "M4A ", [suffix]);
}

function webmBytes(suffix = 0): Uint8Array {
	return bytes([0x1a, 0x45, 0xdf, 0xa3], [0x01, 0x00, 0x00, 0x00, suffix]);
}

function mp3Bytes(suffix = 0): Uint8Array {
	return bytes("ID3", [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, suffix]);
}

function wavBytes(suffix = 0): Uint8Array {
	return bytes("RIFF", [0x04, 0x00, 0x00, 0x00], "WAVE", "fmt ", [suffix]);
}

function oggBytes(suffix = 0): Uint8Array {
	return bytes("OggS", [0x00, 0x02, 0x00, 0x00, suffix]);
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

describe("withArtifactSandbox", () => {
	test("creates an isolated sandbox directory and removes it after success", async () => {
		const root = await tempDir("tsukaima-acp-sandbox-");
		const runId = "session 1/../../escape";
		const artifactDir = await withArtifactSandbox(root, runId, async (context) => {
			await writeFile(join(context.artifactDir, "note.txt"), "hello");
			const info = await stat(context.artifactDir);
			expect(info.isDirectory()).toBe(true);
			return context.artifactDir;
		});

		expect(artifactDir.startsWith(`${root}/`)).toBe(true);
		expect(basename(artifactDir).startsWith(`${sanitizeAcpRunId(runId)}-`)).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
	});

	test("removes the sandbox when the run throws", async () => {
		const root = await tempDir("tsukaima-acp-sandbox-error-");
		let artifactDir = "";
		await expect(
			withArtifactSandbox(root, "failing-run", async (context) => {
				artifactDir = context.artifactDir;
				await writeFile(join(context.artifactDir, "partial.png"), pngBytes());
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(artifactDir.length).toBeGreaterThan(0);
		expect(existsSync(artifactDir)).toBe(false);
	});
});

describe("extractAcpArtifacts", () => {
	test("scans nested directories and sniffs image, video, and audio media", async () => {
		const artifactDir = await tempDir("tsukaima-acp-scan-");
		await mkdir(join(artifactDir, "nested", "media"), { recursive: true });
		await writeFile(join(artifactDir, "nested", "media", "photo.png"), pngBytes(1));
		await writeFile(join(artifactDir, "nested", "cover.jpg"), jpegBytes(2));
		await writeFile(join(artifactDir, "clip.mp4"), mp4Bytes(3));
		await writeFile(join(artifactDir, "scene.webm"), webmBytes(4));
		await writeFile(join(artifactDir, "voice.mp3"), mp3Bytes(5));
		await mkdir(join(artifactDir, "sounds"), { recursive: true });
		await writeFile(join(artifactDir, "sounds", "noop.txt"), "not media");

		const artifacts = await extractAcpArtifacts({ artifactDir, updates: [] });

		expect(artifacts.images.map((artifact) => artifact.fileName).toSorted()).toEqual([
			"cover.jpg",
			"photo.png",
		]);
		expect(artifacts.images.map((artifact) => artifact.mimeType).toSorted()).toEqual([
			"image/jpeg",
			"image/png",
		]);
		expect(artifacts.videos.map((artifact) => artifact.fileName).toSorted()).toEqual([
			"clip.mp4",
			"scene.webm",
		]);
		expect(artifacts.audios.map((artifact) => artifact.fileName)).toEqual(["voice.mp3"]);
		expect(artifacts.audios[0]?.mimeType).toBe("audio/mpeg");
	});

	test("ignores symlinks that escape the artifact directory", async () => {
		const root = await tempDir("tsukaima-acp-symlink-");
		const artifactDir = join(root, "run");
		const outsideDir = join(root, "outside");
		await mkdir(artifactDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		const secret = join(outsideDir, "secret.png");
		await writeFile(secret, pngBytes(9));
		await mkdir(join(outsideDir, "bundle"));
		await writeFile(join(outsideDir, "bundle", "hidden.png"), pngBytes(6));
		const inside = join(artifactDir, "inside.png");
		await writeFile(inside, pngBytes(8));
		const target = join(artifactDir, "target.png");
		await writeFile(target, pngBytes(7));
		await symlink(secret, join(artifactDir, "escaped.png"));
		await symlink(join(outsideDir, "bundle"), join(artifactDir, "escaped-dir"));
		await symlink(target, join(artifactDir, "safe.png"));

		const artifacts = await extractAcpArtifacts({ artifactDir, updates: [] });

		expect(artifacts.images.map((artifact) => artifact.fileName).toSorted()).toEqual([
			"inside.png",
			"safe.png",
		]);
	});

	test("extracts inline images, audio, resource blobs, and contained resource links", async () => {
		const root = await tempDir("tsukaima-acp-inline-");
		const artifactDir = join(root, "run");
		const outsideDir = join(root, "outside");
		await mkdir(artifactDir, { recursive: true });
		await mkdir(outsideDir, { recursive: true });
		const insideVideo = join(artifactDir, "attached.webm");
		await writeFile(insideVideo, webmBytes(9));
		const outsideImage = join(outsideDir, "escaped.png");
		await writeFile(outsideImage, pngBytes(7));

		const inlinePng = pngBytes(1);
		const updates: readonly AcpArtifactUpdateInput[] = [
			{ data: base64(inlinePng), mimeType: "image/png", name: "inline.png", type: "image" },
			{ data: base64(inlinePng), mimeType: "image/png", name: "duplicate.png", type: "image" },
			{ data: base64(mp3Bytes(2)), mimeType: "audio/mpeg", type: "audio" },
			{
				resource: { blob: base64(gifBytes(3)), mimeType: "image/gif" },
				type: "resource",
			},
			{
				name: "attached.webm",
				type: "resource_link",
				uri: pathToFileURL(insideVideo).href,
			},
			{
				type: "resource_link",
				uri: pathToFileURL(outsideImage).href,
			},
			{
				type: "resource_link",
				uri: "https://example.com/remote.png",
			},
		];

		const artifacts = await extractAcpArtifacts({ artifactDir, updates });

		expect(artifacts.images).toHaveLength(2);
		expect(artifacts.images.some((artifact) => artifact.fileName === "inline.png")).toBe(true);
		expect(artifacts.images.some((artifact) => artifact.fileName === undefined)).toBe(true);
		expect(artifacts.images.some((artifact) => artifact.mimeType === "image/gif")).toBe(true);
		expect(artifacts.audios).toHaveLength(1);
		expect(artifacts.audios[0]?.mimeType).toBe("audio/mpeg");
		expect(artifacts.videos).toHaveLength(1);
		expect(artifacts.videos[0]?.fileName).toBe("attached.webm");
	});

	test("only accepts assistant text paths that resolve strictly inside the artifact directory", async () => {
		const root = await tempDir("tsukaima-acp-text-");
		const artifactDir = join(root, "run");
		await mkdir(join(artifactDir, "nested"), { recursive: true });
		await writeFile(join(artifactDir, "inside.png"), pngBytes(1));
		await writeFile(join(artifactDir, "nested", "photo.jpg"), jpegBytes(2));
		await writeFile(join(artifactDir, "clip.mp4"), mp4Bytes(3));
		await writeFile(join(root, "parent.png"), pngBytes(4));
		await writeFile(join(root, "outside.png"), pngBytes(5));

		const assistantText = [
			`Saved ${join(artifactDir, "inside.png")} and ./nested/photo.jpg.`,
			`Also ${pathToFileURL(join(artifactDir, "clip.mp4")).href}.`,
			`Ignore ../parent.png, ${join(root, "outside.png")}, and /etc/passwd.`,
		].join("\n");

		const artifacts = await extractAcpArtifacts({ artifactDir, assistantText, updates: [] });

		expect(artifacts.images.map((artifact) => artifact.fileName).toSorted()).toEqual([
			"inside.png",
			"photo.jpg",
		]);
		expect(artifacts.videos.map((artifact) => artifact.fileName)).toEqual(["clip.mp4"]);
	});

	test("walks nested tool call updates and rejects arbitrary file URIs", async () => {
		const root = await tempDir("tsukaima-acp-tool-");
		const artifactDir = join(root, "run");
		const outside = join(root, "passwd.png");
		await mkdir(artifactDir, { recursive: true });
		await writeFile(outside, pngBytes(6));

		const updates: readonly AcpArtifactUpdateInput[] = [
			{
				content: [
					{
						data: base64(gifBytes(4)),
						mimeType: "image/gif",
						name: "nested.gif",
						type: "image",
					},
					{ type: "resource_link", uri: pathToFileURL(outside).href },
				],
				type: "tool_call_update",
			},
		];

		const artifacts = await extractAcpArtifacts({ artifactDir, updates });

		expect(artifacts.images).toHaveLength(1);
		expect(artifacts.images[0]?.fileName).toBe("nested.gif");
	});

	test("skips files and inline payloads above maxBytesPerFile", async () => {
		const artifactDir = await tempDir("tsukaima-acp-size-");
		const small = pngBytes(1);
		const large = bytes(pngBytes(2), new Uint8Array(64));
		await writeFile(join(artifactDir, "small.png"), small);
		await writeFile(join(artifactDir, "large.png"), large);

		const artifacts = await extractAcpArtifacts({
			artifactDir,
			maxBytesPerFile: 32,
			updates: [
				{ data: base64(large), mimeType: "image/png", name: "inline-large.png", type: "image" },
			],
		});

		expect(artifacts.images).toHaveLength(1);
		expect(artifacts.images[0]?.fileName).toBe("small.png");
	});

	test("detects m4a, mov, wav, ogg, and webp formats", async () => {
		const artifactDir = await tempDir("tsukaima-acp-formats-");
		await writeFile(join(artifactDir, "song.m4a"), m4aBytes(1));
		await writeFile(join(artifactDir, "trailer.mov"), movBytes(2));
		await writeFile(join(artifactDir, "tone.wav"), wavBytes(3));
		await writeFile(join(artifactDir, "voice.ogg"), oggBytes(4));
		await writeFile(join(artifactDir, "still.webp"), webpBytes(5));

		const artifacts = await extractAcpArtifacts({ artifactDir, updates: [] });

		expect(artifacts.audios.map((artifact) => artifact.mimeType).toSorted()).toEqual([
			"audio/mp4",
			"audio/ogg",
			"audio/wav",
		]);
		expect(artifacts.videos.map((artifact) => artifact.mimeType)).toEqual(["video/quicktime"]);
		expect(artifacts.images.map((artifact) => artifact.mimeType)).toEqual(["image/webp"]);
	});
});
