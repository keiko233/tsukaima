import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDomainDatabase, openDomainDatabase, type TsukaimaDatabase } from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import { InboundMediaResolver } from "../src/services/inbound-media.ts";
import { MediaService } from "../src/services/media-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function fixture(): Promise<{
	database: TsukaimaDatabase;
	media: MediaService;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-inbound-media-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const media = new MediaService({
		blobsDir: join(directory, "blobs"),
		database: () => database,
	});
	return { database, media };
}

describe("InboundMediaResolver", () => {
	test("prefers channel bytes and content-sniffs the stored media", async () => {
		const { database, media } = await fixture();
		const logger = createLogger({ level: "error", sink: () => {} });
		try {
			const resolver = new InboundMediaResolver({ logger, media });
			const result = await resolver.resolve(
				{ channelRef: "image-1", type: "image" },
				{ fetchMedia: async () => png },
			);
			expect(result.kind).toBe("stored");
			if (result.kind !== "stored") throw new Error("expected stored media");
			expect(result.via).toBe("channel");
			expect(result.stored).toMatchObject({
				kind: "image",
				mimeType: "image/png",
				sizeBytes: png.byteLength,
			});
			expect(await media.readBytes(result.stored.sha256)).toEqual(png);
		} finally {
			database.$client.close();
		}
	});

	test("records the blocked-address reason and warns once per host with the allowlist remedy", async () => {
		const { database, media } = await fixture();
		const logger = createLogger({ level: "debug", sink: () => {} });
		try {
			const resolver = new InboundMediaResolver({ logger, media });
			const part = { sourceUrl: "http://127.0.0.1:8080/a.png", type: "image" } as const;
			const first = await resolver.resolve(part, undefined);
			const second = await resolver.resolve(part, undefined);
			expect(first).toEqual({ kind: "unavailable", reason: "blocked_address" });
			expect(second).toEqual({ kind: "unavailable", reason: "blocked_address" });

			const warnings = logger.buffer
				.list({ level: "warn" })
				.filter((entry) => entry.message.includes("non-public address"));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.fields).toMatchObject({
				host: "127.0.0.1",
				remedy: expect.stringContaining("TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS") as string,
			});
		} finally {
			database.$client.close();
		}
	});

	test("enforces the channel byte cap instead of storing an oversized body", async () => {
		const { database, media } = await fixture();
		const logger = createLogger({ level: "error", sink: () => {} });
		try {
			const resolver = new InboundMediaResolver({ logger, maxBytes: 4, media });
			const result = await resolver.resolve(
				{ channelRef: "image-1", type: "image" },
				{ fetchMedia: async () => png },
			);
			expect(result).toEqual({ kind: "unavailable", reason: "response_too_large" });
		} finally {
			database.$client.close();
		}
	});
});
