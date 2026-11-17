import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	media,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import { MediaService } from "../src/services/media-service.ts";
import { createPluginMediaBridge } from "../src/services/plugin-media.ts";

const directories: string[] = [];
const logger = createLogger({ level: "error", target: "tsukaima::test" });

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function openFixture(): Promise<{
	database: TsukaimaDatabase;
	directory: string;
	service: MediaService;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-media-"));
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

	test("storeFromUrl goes through the public-destination and content-type guard", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-media-guard-"));
		directories.push(directory);
		const database = await openDomainDatabase(join(directory, "domain.sqlite"));
		migrateDomainDatabase(database);
		const requests: string[] = [];
		const service = new MediaService({
			blobsDir: join(directory, "blobs"),
			database: () => database,
			logger,
			transport: async (input) => {
				requests.push(input.url.toString());
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					headers: { "content-type": "image/png" },
				});
			},
		});
		try {
			await expect(
				service.storeFromUrl("http://127.0.0.1/private.png", { kind: "image", source: "channel" }),
			).rejects.toThrow("non-public");
			await expect(
				service.storeFromUrl("http://169.254.169.254/latest/meta-data/", {
					kind: "image",
					source: "channel",
				}),
			).rejects.toThrow();
			expect(requests).toHaveLength(0);
		} finally {
			database.$client.close();
		}
	});

	test("storeFromUrl pins the validated address instead of re-resolving the host", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-media-pin-"));
		directories.push(directory);
		const database = await openDomainDatabase(join(directory, "domain.sqlite"));
		migrateDomainDatabase(database);
		let resolutions = 0;
		const pins: string[] = [];
		const service = new MediaService({
			blobsDir: join(directory, "blobs"),
			database: () => database,
			logger,
			resolve: async () => {
				resolutions += 1;
				return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
			},
			transport: async (input) => {
				pins.push(input.address.address);
				return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
					headers: { "content-type": "image/png" },
				});
			},
		});
		try {
			await service.storeFromUrl("https://cdn.example/a.png", { kind: "image", source: "channel" });
			expect(resolutions).toBe(1);
			expect(pins).toEqual(["93.184.216.34"]);
		} finally {
			database.$client.close();
		}
	});

	test("the default transport sends the validated hostname while connecting to the pinned IP", async () => {
		const { createServer } = await import("node:http");
		const seen: { host: string | undefined; url: string | undefined } = {
			host: undefined,
			url: undefined,
		};
		const server = createServer((request, response) => {
			seen.host = request.headers.host;
			seen.url = request.url;
			response.writeHead(200, { "content-type": "image/png" });
			response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-media-host-"));
		directories.push(directory);
		const database = await openDomainDatabase(join(directory, "domain.sqlite"));
		migrateDomainDatabase(database);
		try {
			const { fetchGuardedMedia } = await import("../src/services/media-fetch-guard.ts");
			// The host resolves to the loopback test server; the operator opt-in models a local
			// channel sidecar. The validated hostname must still be the Host header.
			const result = await fetchGuardedMedia(`http://media.example:${address.port}/a.png`, {
				policy: { allowedPrivateHosts: ["media.example"] },
				resolve: async () => ["127.0.0.1"],
			});
			expect(result.mimeType).toBe("image/png");
			expect(seen.host).toBe(`media.example:${address.port}`);
			expect(seen.url).toBe("/a.png");
		} finally {
			server.close();
			database.$client.close();
		}
	});

	test("the default TLS transport verifies the validated hostname over a pinned IP", async () => {
		// A real TLS server proves the socket connects to the validated address while SNI and
		// certificate verification use the URL hostname. The child process trusts the fixture CA
		// via NODE_EXTRA_CA_CERTS, which Bun reads at start.
		const { createServer } = await import("node:https");
		const { execFileSync } = await import("node:child_process");
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-media-tls-"));
		directories.push(directory);
		const keyPath = join(directory, "key.pem");
		const certPath = join(directory, "cert.pem");
		execFileSync("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-subj",
			"/CN=media.example",
			"-addext",
			"subjectAltName=DNS:media.example",
		]);
		const seen: { host: string | undefined; servername: string | undefined } = {
			host: undefined,
			servername: undefined,
		};
		const server = createServer(
			{ cert: await fs.readFile(certPath), key: await fs.readFile(keyPath) },
			(request, response) => {
				seen.host = request.headers.host;
				seen.servername = (request.socket as { servername?: string }).servername;
				response.writeHead(200, { "content-type": "image/png" });
				response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			},
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		const guardUrl = new URL("../src/services/media-fetch-guard.ts", import.meta.url).href;
		const script = [
			`import { fetchGuardedMedia } from ${JSON.stringify(guardUrl)};`,
			`const result = await fetchGuardedMedia(${JSON.stringify(`https://media.example:${address.port}/a.png`)}, {`,
			`  policy: { allowedPrivateHosts: ["media.example"] },`,
			`  resolve: async () => ["127.0.0.1"],`,
			`});`,
			`console.log(JSON.stringify({ bytes: result.bytes.length, mimeType: result.mimeType }));`,
		].join("\n");
		try {
			const proc = Bun.spawn(["bun", "-e", script], {
				cwd: process.cwd(),
				env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
				stderr: "pipe",
				stdout: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stderr).toBe("");
			expect(JSON.parse(stdout.trim())).toEqual({ bytes: 4, mimeType: "image/png" });
			expect(seen.host).toBe(`media.example:${address.port}`);
			expect(seen.servername).toBe("media.example");
		} finally {
			server.close();
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
