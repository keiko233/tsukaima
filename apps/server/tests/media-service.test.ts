import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { media, migrateDomainDatabase, openDomainDatabase, type ElainaDatabase } from "@elaina/db";
import { createLogger } from "../src/logging.ts";
import { MediaService } from "../src/services/media-service.ts";
import { createPluginMediaBridge } from "../src/services/plugin-media.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "elaina::test" });

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function openFixture(): Promise<{
	database: ElainaDatabase;
	directory: string;
	service: MediaService;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-media-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const service = new MediaService({
		blobsDir: join(directory, "blobs"),
		database: () => database,
		logger,
	});
	return { database, directory, service };
}

describe("MediaService", () => {
	test("stores bytes once by sha256 and returns the canonical row", async () => {
		const { database, service } = await openFixture();
		try {
			const bytes = new TextEncoder().encode("same bytes");
			const first = await service.store({
				bytes,
				kind: "file",
				mimeType: "text/plain",
				source: "channel",
				sourceUrl: "https://example.test/a.txt",
			});
			const second = await service.store({
				bytes,
				kind: "file",
				mimeType: "text/plain",
				source: "webui",
			});
			expect(second.id).toBe(first.id);
			expect(second.sha256).toBe(first.sha256);
			expect(first.sizeBytes).toBe(bytes.byteLength);
			expect(await service.readBytes(first.sha256)).toEqual(bytes);
			expect(await database.select().from(media)).toHaveLength(1);
			expect(await service.findBySha(first.sha256)).toMatchObject({
				id: first.id,
				sourceUrl: "https://example.test/a.txt",
			});
		} finally {
			database.$client.close();
		}
	});

	test("stores base64 assets and attaches canonical references to parts", async () => {
		const { database, service } = await openFixture();
		try {
			const data = Buffer.from("hello image").toString("base64");
			const stored = await service.storeBase64(data, {
				height: 10,
				kind: "image",
				mimeType: "image/png",
				source: "generated",
				width: 20,
			});
			expect(stored).toMatchObject({
				height: 10,
				kind: "image",
				mimeType: "image/png",
				sizeBytes: 11,
				width: 20,
			});
			const legacy = service.reference({ sha256: "legacy", type: "image" }, stored);
			expect(legacy).toMatchObject({
				height: 10,
				mediaId: stored.id,
				sha256: stored.sha256,
				type: "image",
				width: 20,
			});
		} finally {
			database.$client.close();
		}
	});

	test("rejects unsafe blob paths", async () => {
		const { database, service } = await openFixture();
		try {
			expect(() => service.blobPath("../escape")).toThrow("Invalid media sha256");
		} finally {
			database.$client.close();
		}
	});

	test("plugin media bridge enforces read/write grants and hides source URLs", async () => {
		const { database, service } = await openFixture();
		try {
			const reader = createPluginMediaBridge(service, "sticker-meme", ["media.read"]);
			await expect(reader.store({ bytes: new Uint8Array([1]), kind: "sticker" })).rejects.toThrow(
				"media.write",
			);
			const writer = createPluginMediaBridge(service, "sticker-meme", [
				"media.read",
				"media.write",
			]);
			const stored = await writer.store({
				bytes: new Uint8Array([1, 2, 3]),
				kind: "sticker",
				mimeType: "image/png",
				source: "channel",
			});
			expect(stored).toMatchObject({ kind: "sticker", mimeType: "image/png" });
			expect(JSON.stringify(stored)).not.toContain("sourceUrl");
			expect(await writer.findById(stored.id)).toEqual(stored);
			expect(await writer.findBySha(stored.sha256)).toEqual(stored);
			expect(await writer.readBytes(stored.id)).toEqual(new Uint8Array([1, 2, 3]));
		} finally {
			database.$client.close();
		}
	});
});
