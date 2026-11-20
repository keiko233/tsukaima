import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MessagePart } from "@tsukaima/contracts";
import { media, type TsukaimaDatabase } from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import {
	DEFAULT_MEDIA_FETCH_POLICY,
	fetchGuardedMedia,
	type MediaDnsResolver,
	type MediaFetchPolicy,
	type MediaFetchTransport,
} from "./media-fetch-guard.ts";

export type MediaKind = "image" | "sticker" | "audio" | "video" | "file";
export type MediaSource = "channel" | "webui" | "migration" | "generated";

export interface MediaStoreInput {
	readonly bytes: Uint8Array;
	readonly durationMs?: number;
	readonly expiresAt?: string;
	readonly height?: number;
	readonly kind: MediaKind;
	readonly metadata?: unknown;
	readonly mimeType?: string;
	readonly source: MediaSource;
	readonly sourceUrl?: string;
	readonly width?: number;
}

export interface StoredMedia {
	readonly createdAt: string;
	readonly durationMs: number | null;
	readonly expiresAt: string | null;
	readonly height: number | null;
	readonly id: string;
	readonly kind: MediaKind;
	readonly metadataJson: string | null;
	readonly mimeType: string;
	readonly sha256: string;
	readonly sizeBytes: number;
	readonly source: MediaSource;
	readonly sourceUrl: string | null;
	readonly width: number | null;
}

/** Video responses NapCat/CDNs return; octet-stream is sniffed/followed by kind. */
const VIDEO_MEDIA_CONTENT_TYPES: readonly string[] = [
	"application/octet-stream",
	"video/mp4",
	"video/quicktime",
	"video/webm",
	"video/x-matroska",
];

const DEFAULT_MIME: Record<MediaKind, string> = {
	audio: "audio/ogg",
	file: "application/octet-stream",
	image: "image/png",
	sticker: "image/png",
	video: "video/mp4",
};

const normalizeBytes = (value: Uint8Array): Buffer =>
	value instanceof Buffer ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.byteLength >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.byteLength >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return "image/gif";
	}
	if (
		bytes.byteLength >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	return undefined;
}

/**
 * Content-addressed media store. Bytes live once at `<dataDir>/blobs/<sha256>` and the domain
 * `media` row carries the canonical metadata. Re-ingesting identical bytes returns the
 * existing row without writing the blob again.
 */
export class MediaService {
	readonly #blobsDir: string;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #fetchPolicy: Partial<MediaFetchPolicy>;
	readonly #resolve: MediaDnsResolver | undefined;
	readonly #transport: MediaFetchTransport | undefined;
	readonly #logger: Logger | undefined;

	constructor(options: {
		readonly blobsDir: string;
		readonly database: () => TsukaimaDatabase | undefined;
		/** Overrides the default public-destination/size/content-type guard. */
		readonly fetchPolicy?: Partial<MediaFetchPolicy>;
		/** Hosts explicitly trusted to resolve privately (a local channel sidecar). */
		readonly allowedPrivateHosts?: readonly string[];
		/** Test/embedding seams; production uses the pinned socket transport and system DNS. */
		readonly resolve?: MediaDnsResolver;
		readonly transport?: MediaFetchTransport;
		readonly logger?: Logger;
	}) {
		this.#blobsDir = options.blobsDir;
		this.#database = options.database;
		this.#fetchPolicy = options.fetchPolicy ?? DEFAULT_MEDIA_FETCH_POLICY;
		this.#fetchPolicy = {
			...this.#fetchPolicy,
			...(options.allowedPrivateHosts === undefined
				? {}
				: { allowedPrivateHosts: options.allowedPrivateHosts }),
		};
		this.#resolve = options.resolve;
		this.#transport = options.transport;
		this.#logger = options.logger?.child("tsukaima::server::media");
	}

	async store(input: MediaStoreInput): Promise<StoredMedia> {
		const database = this.#requireDatabase();
		const bytes = normalizeBytes(input.bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const existing = await this.findBySha(sha256);
		if (existing !== undefined) {
			await this.#ensureBlob(sha256, bytes);
			return existing;
		}
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const mimeType = input.mimeType ?? DEFAULT_MIME[input.kind];
		// Write the blob before publishing the row. Readers find media by row and then open its
		// content-addressed path, so a row must never be visible while its bytes are still queued.
		await this.#ensureBlob(sha256, bytes);
		await database.insert(media).values({
			createdAt,
			...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
			...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			...(input.height === undefined ? {} : { height: input.height }),
			id,
			kind: input.kind,
			...(input.metadata === undefined ? {} : { metadataJson: JSON.stringify(input.metadata) }),
			mimeType,
			sha256,
			sizeBytes: bytes.byteLength,
			source: input.source,
			...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
			...(input.width === undefined ? {} : { width: input.width }),
		});
		const stored = await this.findById(id);
		if (stored === undefined) throw new Error("Failed to persist media row");
		this.#logger?.debug("media stored", {
			bytes: stored.sizeBytes,
			kind: stored.kind,
			mediaId: stored.id,
		});
		return stored;
	}

	async storeBase64(base64: string, input: Omit<MediaStoreInput, "bytes">): Promise<StoredMedia> {
		const value = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
		return this.store({ ...input, bytes: Buffer.from(value, "base64") });
	}

	/**
	 * Store bytes supplied by a channel. Content sniffing wins over the declared type for the same
	 * reason as `storeFromUrl`: NapCat often labels images as `application/octet-stream`.
	 */
	async storeFetchedBytes(
		bytes: Uint8Array,
		input: Omit<MediaStoreInput, "bytes">,
	): Promise<StoredMedia> {
		const sniffed = sniffImageMime(bytes);
		return this.store({
			...input,
			bytes,
			...(sniffed === undefined ? {} : { mimeType: sniffed }),
		});
	}

	async storeFromUrl(
		url: string,
		input: Omit<MediaStoreInput, "bytes" | "sourceUrl">,
	): Promise<StoredMedia> {
		// Inbound URLs are attacker-controlled. Public-destination, redirect, size, and content
		// type checks live in the guard; a failure means the part stays a placeholder. Video parts
		// get a video MIME allowlist on the exact same DNS-pinned fetch guard.
		const policy =
			input.kind === "video"
				? { ...this.#fetchPolicy, allowedContentTypes: VIDEO_MEDIA_CONTENT_TYPES }
				: this.#fetchPolicy;
		const fetched = await fetchGuardedMedia(url, {
			policy,
			...(this.#resolve === undefined ? {} : { resolve: this.#resolve }),
			...(this.#transport === undefined ? {} : { transport: this.#transport }),
		});
		const bytes = fetched.bytes;
		const sniffed = sniffImageMime(bytes);
		// Trust content sniffing over a declared type; fall back to the validated response type.
		const mimeType = sniffed ?? fetched.mimeType;
		return this.store({
			...input,
			bytes,
			...(mimeType === undefined ? {} : { mimeType }),
			sourceUrl: fetched.finalUrl,
		});
	}

	async findBySha(sha256: string): Promise<StoredMedia | undefined> {
		const database = this.#requireDatabase();
		const [row] = await database.select().from(media).where(eq(media.sha256, sha256)).limit(1);
		return row === undefined ? undefined : toStoredMedia(row);
	}

	async findById(mediaId: string): Promise<StoredMedia | undefined> {
		const database = this.#requireDatabase();
		const [row] = await database.select().from(media).where(eq(media.id, mediaId)).limit(1);
		return row === undefined ? undefined : toStoredMedia(row);
	}

	blobPath(sha256: string): string {
		if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error("Invalid media sha256");
		return join(this.#blobsDir, sha256);
	}

	async readBytes(sha256: string): Promise<Uint8Array> {
		return readFile(this.blobPath(sha256));
	}

	/** Attach the canonical media reference to a core message part. */
	reference(part: MessagePart, stored: StoredMedia): MessagePart {
		if (part.type === "text" || part.type === "channel-native") return part;
		return {
			...part,
			mediaId: stored.id,
			mimeType: part.mimeType ?? stored.mimeType,
			sha256: stored.sha256,
			sizeBytes: part.sizeBytes ?? stored.sizeBytes,
			...(stored.sourceUrl === null || part.sourceUrl !== undefined
				? {}
				: { sourceUrl: stored.sourceUrl }),
			...(stored.width === null || part.type === "audio" || part.type === "file"
				? {}
				: { width: part.width ?? stored.width }),
			...(stored.height === null || part.type === "audio" || part.type === "file"
				? {}
				: { height: part.height ?? stored.height }),
			...(stored.durationMs === null || (part.type !== "audio" && part.type !== "video")
				? {}
				: { durationMs: part.durationMs ?? stored.durationMs }),
		};
	}

	async #ensureBlob(sha256: string, bytes: Buffer): Promise<void> {
		await mkdir(this.#blobsDir, { recursive: true });
		const target = this.blobPath(sha256);
		try {
			const existing = await stat(target);
			if (existing.size === bytes.byteLength) return;
		} catch {}
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, bytes);
		await rename(temporary, target);
	}

	#requireDatabase(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}
}

function toStoredMedia(row: typeof media.$inferSelect): StoredMedia {
	return {
		createdAt: row.createdAt,
		durationMs: row.durationMs,
		expiresAt: row.expiresAt,
		height: row.height,
		id: row.id,
		kind: row.kind,
		metadataJson: row.metadataJson,
		mimeType: row.mimeType,
		sha256: row.sha256,
		sizeBytes: row.sizeBytes,
		source: row.source,
		sourceUrl: row.sourceUrl,
		width: row.width,
	};
}
