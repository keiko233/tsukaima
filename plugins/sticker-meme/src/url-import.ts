import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AuditEntry, PluginLogger, PluginMediaApi } from "@tsukaima/sdk";
import type { AnimatedConversionOptions, AnimatedConverter } from "./animated.ts";
import {
	EMPTY_SEMANTIC_PROFILE,
	normalizeLabels,
	normalizeText,
	sha256Bytes,
	stableId,
	type StickerItem,
	type StickerPack,
} from "./domain.ts";
import { elapsedMs, logErrorMessage } from "./logging.ts";
import { normalizeStickerMedia } from "./media-format.ts";
import type { StickerItemInput, StickerRepository } from "./repository.ts";
import type { StickerSemanticClassifier } from "./semantic.ts";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

export type UrlDnsResolver = (hostname: string) => Promise<readonly string[]>;
export type UrlFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchStickerUrlOptions {
	readonly fetchFn?: UrlFetchFn;
	readonly maxBytes?: number;
	readonly maxRedirects?: number;
	readonly resolveDns?: UrlDnsResolver;
	readonly timeoutMs?: number;
}

export interface StickerUrlImportInput {
	readonly approve?: boolean;
	readonly classifier?: StickerSemanticClassifier;
	readonly conversion?: AnimatedConversionOptions;
	readonly description?: string;
	readonly emotions?: readonly string[] | string;
	readonly keywords?: readonly string[] | string;
	readonly name?: string;
	readonly packId?: string;
	readonly sourceConversationId?: string;
	readonly url: string;
}

export interface StickerUrlImportResult {
	readonly convertedFromVideo: boolean;
	readonly duplicate: boolean;
	readonly item: StickerItem;
	readonly originalMimeType: string;
	readonly pack: StickerPack;
}

export function isPrivateOrReservedIp(address: string): boolean {
	const clean = address
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/gu, "");
	const v4Mapped = clean.startsWith("::ffff:") ? clean.slice("::ffff:".length) : clean;
	const version = isIP(v4Mapped);
	if (version === 4) {
		const parts = v4Mapped.split(".").map((part) => Number(part));
		if (
			parts.length !== 4 ||
			parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
		) {
			return true;
		}
		const [a = 0, b = 0] = parts;
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a >= 224) return true;
		return false;
	}
	if (version === 6) {
		if (clean === "::" || clean === "::1") return true;
		if (clean.startsWith("fc") || clean.startsWith("fd")) return true;
		if (
			clean.startsWith("fe8") ||
			clean.startsWith("fe9") ||
			clean.startsWith("fea") ||
			clean.startsWith("feb")
		) {
			return true;
		}
		if (clean.startsWith("ff")) return true;
		return false;
	}
	return true;
}

async function defaultResolveDns(hostname: string): Promise<readonly string[]> {
	const records = await lookup(hostname, { all: true });
	return records.map((record) => record.address);
}

async function assertSafePublicUrl(rawUrl: string, resolveDns: UrlDnsResolver): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl.trim());
	} catch {
		throw new Error("Invalid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
	}
	const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
	if (hostname.length === 0 || hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("Refusing to fetch local or private host");
	}
	if (isIP(hostname) !== 0) {
		if (isPrivateOrReservedIp(hostname)) {
			throw new Error("Refusing to fetch private or reserved IP address");
		}
		return parsed;
	}
	const addresses = await resolveDns(hostname);
	if (addresses.length === 0) {
		throw new Error(`Could not resolve host: ${hostname}`);
	}
	for (const address of addresses) {
		if (isPrivateOrReservedIp(address)) {
			throw new Error("Refusing to fetch host resolving to a private or reserved IP");
		}
	}
	return parsed;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new Error(`Remote file exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`);
	}
	if (response.body === null) {
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > maxBytes) {
			throw new Error(`Remote file exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`);
		}
		return buffer;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`Remote file exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB limit`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function extractOpenGraphMediaUrl(html: string, baseUrl: string): string | undefined {
	const metaTags = html.match(/<meta\b[^>]*>/giu) ?? [];
	const candidates = new Map<string, string>();
	for (const tag of metaTags) {
		const keyMatch = /\b(?:property|name)\s*=\s*["']([^"']+)["']/iu.exec(tag);
		const contentMatch = /\bcontent\s*=\s*["']([^"']+)["']/iu.exec(tag);
		if (keyMatch?.[1] === undefined || contentMatch?.[1] === undefined) continue;
		const key = keyMatch[1].toLowerCase();
		if (!candidates.has(key)) candidates.set(key, contentMatch[1].replace(/&amp;/gu, "&"));
	}
	const preferredKeys = [
		"og:video:secure_url",
		"og:video:url",
		"og:video",
		"twitter:player:stream",
		"og:image:secure_url",
		"og:image:url",
		"og:image",
	];
	for (const key of preferredKeys) {
		const raw = candidates.get(key);
		if (raw === undefined || raw.trim().length === 0) continue;
		try {
			return new URL(raw.trim(), baseUrl).toString();
		} catch {
			continue;
		}
	}
	return undefined;
}

function defaultNameFromUrl(rawUrl: string, hash: string): string {
	try {
		const pathname = new URL(rawUrl).pathname;
		const segment = pathname.split("/").filter(Boolean).at(-1);
		if (segment !== undefined && segment.length > 0) {
			const clean = decodeURIComponent(segment)
				.replace(/\.[a-z0-9]{1,8}$/iu, "")
				.trim();
			if (clean.length > 0) return clean.slice(0, 64);
		}
	} catch {}
	return `url-${hash.slice(0, 8)}`;
}

/**
 * Download media bytes from an HTTP(S) URL with SSRF protection, redirect validation,
 * bounded body size, and optional OpenGraph video/image extraction for HTML pages.
 */
export async function fetchStickerUrl(
	rawUrl: string,
	options: FetchStickerUrlOptions = {},
): Promise<{
	readonly bytes: Uint8Array;
	readonly contentType?: string;
	readonly finalUrl: string;
}> {
	const fetchFn = options.fetchFn ?? fetch;
	const resolveDns = options.resolveDns ?? defaultResolveDns;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const fetchOnce = async (
		targetUrl: string,
	): Promise<{
		readonly bytes: Uint8Array;
		readonly contentType?: string;
		readonly finalUrl: string;
	}> => {
		let current = await assertSafePublicUrl(targetUrl, resolveDns);
		for (let hop = 0; hop <= maxRedirects; hop += 1) {
			const response = await fetchFn(current.toString(), {
				headers: {
					Accept: "image/*,video/*,text/html;q=0.5,*/*;q=0.1",
					"User-Agent": "TsukaimaStickerFetcher/1.0",
				},
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (location === null || location.trim().length === 0) {
					throw new Error(`Redirect (${response.status}) missing Location header`);
				}
				if (hop === maxRedirects) {
					throw new Error("Too many redirects while fetching sticker URL");
				}
				const nextUrl = new URL(location, current).toString();
				current = await assertSafePublicUrl(nextUrl, resolveDns);
				continue;
			}
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} while fetching sticker URL`);
			}
			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
			const bytes = await readBoundedResponse(response, maxBytes);
			return {
				bytes,
				...(contentType === undefined ? {} : { contentType }),
				finalUrl: current.toString(),
			};
		}
		throw new Error("Too many redirects while fetching sticker URL");
	};

	const first = await fetchOnce(rawUrl);
	if (first.contentType === "text/html" || first.contentType === "application/xhtml+xml") {
		const html = new TextDecoder().decode(first.bytes.slice(0, 256 * 1024));
		const ogUrl = extractOpenGraphMediaUrl(html, first.finalUrl);
		if (ogUrl === undefined) {
			throw new Error(
				"URL returned an HTML page without embedded og:video or og:image media. Paste a direct image/video URL (e.g. https://video.twimg.com/...mp4 or https://pbs.twimg.com/...).",
			);
		}
		return await fetchOnce(ogUrl);
	}
	return first;
}

export interface StickerUrlImportServiceOptions {
	readonly audit?: { record(entry: AuditEntry): Promise<void> };
	readonly converter?: AnimatedConverter;
	readonly fetchFn?: UrlFetchFn;
	readonly logger?: PluginLogger | undefined;
	readonly media: PluginMediaApi;
	readonly repository: StickerRepository;
	readonly resolveDns?: UrlDnsResolver;
}

/** Downloads a sticker from a URL, converts video formats (e.g. Twitter MP4) to GIF, and saves it. */
export class StickerUrlImportService {
	readonly #audit: StickerUrlImportServiceOptions["audit"];
	readonly #converter: AnimatedConverter | undefined;
	readonly #fetchFn: UrlFetchFn | undefined;
	readonly #logger: PluginLogger | undefined;
	readonly #media: PluginMediaApi;
	readonly #repository: StickerRepository;
	readonly #resolveDns: UrlDnsResolver | undefined;

	constructor(options: StickerUrlImportServiceOptions) {
		this.#audit = options.audit;
		this.#converter = options.converter;
		this.#fetchFn = options.fetchFn;
		this.#logger = options.logger;
		this.#media = options.media;
		this.#repository = options.repository;
		this.#resolveDns = options.resolveDns;
	}

	async importUrl(input: StickerUrlImportInput): Promise<StickerUrlImportResult> {
		const startedAt = Date.now();
		const fetched = await fetchStickerUrl(input.url, {
			...(this.#fetchFn === undefined ? {} : { fetchFn: this.#fetchFn }),
			...(this.#resolveDns === undefined ? {} : { resolveDns: this.#resolveDns }),
		});
		const normalized = await normalizeStickerMedia(fetched.bytes, {
			...(input.conversion === undefined ? {} : { conversion: input.conversion }),
			...(this.#converter === undefined ? {} : { converter: this.#converter }),
			...(fetched.contentType === undefined ? {} : { declaredMimeType: fetched.contentType }),
			logger: this.#logger,
		});
		const hash = sha256Bytes(normalized.bytes);
		const existing = await this.#repository.findItemsByHash(hash);
		if (existing[0] !== undefined) {
			const pack =
				(await this.#repository.getPack(existing[0].packId)) ??
				(await this.#ensureUrlPack(input.packId));
			this.#logger?.debug("url sticker import deduplicated", {
				durationMs: elapsedMs(startedAt),
				itemId: existing[0].id,
				packId: pack.id,
			});
			return {
				convertedFromVideo: normalized.convertedFromVideo,
				duplicate: true,
				item: existing[0],
				originalMimeType: normalized.originalMimeType,
				pack,
			};
		}

		const pack = await this.#ensureUrlPack(input.packId);
		const name = normalizeText(input.name, defaultNameFromUrl(fetched.finalUrl, hash));
		const stored = await this.#media.store({
			bytes: normalized.bytes,
			...(normalized.height === null ? {} : { height: normalized.height }),
			kind: "sticker",
			mimeType: normalized.mimeType,
			source: "webui",
			...(normalized.width === null ? {} : { width: normalized.width }),
		});

		const manualKeywords = normalizeLabels(input.keywords).values;
		const manualEmotions = normalizeLabels(input.emotions).values;
		let semantic = EMPTY_SEMANTIC_PROFILE;
		let description = normalizeText(input.description);
		let keywords = manualKeywords;
		let emotions = manualEmotions;

		if (input.classifier !== undefined) {
			try {
				semantic = await input.classifier.classify({
					bytes: normalized.bytes,
					mimeType: normalized.mimeType,
					title: name,
				});
				if (description.length === 0) description = semantic.description;
				keywords = normalizeLabels([...manualKeywords, ...semantic.keywords]).values;
				emotions = normalizeLabels([...manualEmotions, ...semantic.emotions]).values;
			} catch (error) {
				this.#logger?.warn("url sticker semantic classification failed", {
					error: logErrorMessage(error),
				});
			}
		}

		const itemInput: StickerItemInput = {
			description,
			emotions,
			enabled: true,
			hash,
			height: normalized.height,
			keywords,
			mediaId: stored.id,
			mimeType: stored.mimeType,
			name,
			packId: pack.id,
			reviewStatus: input.approve === false ? "pending" : "approved",
			semantic,
			sourceConversationId: input.sourceConversationId ?? null,
			width: normalized.width,
		};
		const item = await this.#repository.upsertItem(itemInput);
		await this.#audit?.record({
			action: "sticker.url.imported",
			actorKind: "user",
			payload: {
				convertedFromVideo: normalized.convertedFromVideo,
				itemId: item.id,
				mimeType: item.mimeType,
				originalMimeType: normalized.originalMimeType,
				packId: pack.id,
			},
			result: "ok",
			targetId: item.id,
			targetKind: "sticker-item",
		});
		this.#logger?.debug("url sticker imported", {
			convertedFromVideo: normalized.convertedFromVideo,
			durationMs: elapsedMs(startedAt),
			itemId: item.id,
			mimeType: item.mimeType,
			originalMimeType: normalized.originalMimeType,
			packId: pack.id,
		});
		return {
			convertedFromVideo: normalized.convertedFromVideo,
			duplicate: false,
			item,
			originalMimeType: normalized.originalMimeType,
			pack,
		};
	}

	async #ensureUrlPack(packIdOrName: string | undefined): Promise<StickerPack> {
		const trimmed = normalizeText(packIdOrName);
		if (trimmed.length > 0) {
			const byId = await this.#repository.getPack(trimmed);
			if (byId !== undefined) return byId;
			const all = await this.#repository.listPacks();
			const byName = all.find((pack) => pack.name.toLowerCase() === trimmed.toLowerCase());
			if (byName !== undefined) return byName;
			return await this.#repository.savePack({
				id: stableId("pack", `url:${trimmed}`),
				name: trimmed,
				source: "imported",
				tags: ["url"],
			});
		}
		return await this.#repository.savePack({
			id: stableId("pack", "url:default"),
			name: "URL stickers",
			source: "imported",
			tags: ["url"],
		});
	}
}
