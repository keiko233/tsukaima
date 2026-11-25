import type { MediaUnavailableReason, MessagePart } from "@tsukaima/contracts";
import type { Logger } from "../logging.ts";
import {
	DEFAULT_MEDIA_FETCH_POLICY,
	MediaFetchError,
	type MediaFetchFailureCode,
} from "./media-fetch-guard.ts";
import type { MediaService, StoredMedia } from "./media-service.ts";

/** Bounded channel read: a channel hook must answer quickly and never stream unbounded bytes. */
export const INBOUND_CHANNEL_MEDIA_TIMEOUT_MS = 10_000;
export const INBOUND_CHANNEL_MEDIA_MAX_BYTES = DEFAULT_MEDIA_FETCH_POLICY.maxBytes;

export interface InboundMediaChannel {
	fetchMedia?(part: MessagePart): Promise<Uint8Array | undefined>;
}

type InboundMediaPart = Extract<MessagePart, { type: "file" | "image" | "sticker" }>;

export type InboundMediaResolution =
	| {
			readonly kind: "stored";
			readonly stored: StoredMedia;
			readonly via: "channel" | "url";
	  }
	| {
			readonly kind: "unavailable";
			readonly reason: MediaUnavailableReason;
	  };

type ChannelMediaResult =
	| { readonly kind: "bytes"; readonly bytes: Uint8Array }
	| { readonly kind: "failed"; readonly reason: MediaUnavailableReason };

const GUARD_REASONS: readonly MediaFetchFailureCode[] = [
	"blocked_address",
	"blocked_content_type",
	"blocked_host",
	"blocked_scheme",
	"dns_failure",
	"http_error",
	"invalid_redirect",
	"invalid_url",
	"network_error",
	"redirect_limit",
	"response_too_large",
	"timeout",
];

const isExplicitlyExpired = (error: unknown): boolean =>
	/expired|过期/iu.test(error instanceof Error ? error.message : String(error));

/** Map a fetch failure to the bounded reason stored on the part. */
export function mediaUnavailableReasonFor(error: unknown): MediaUnavailableReason {
	if (error instanceof MediaFetchError) {
		return GUARD_REASONS.includes(error.code) ? error.code : "unknown";
	}
	return isExplicitlyExpired(error) ? "expired" : "unknown";
}

const hostnameOf = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return undefined;
	}
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("inbound media fetch timed out")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

/**
 * Resolves inbound image/sticker bytes without unconditionally giving the host's network access
 * to an attacker-controlled URL. A channel-side hook wins; the guarded HTTP fetch is only the
 * fallback. A failure is returned as a bounded reason so the transcript never pretends a part
 * is renderable and a later backfill can retry the source reference.
 */
export class InboundMediaResolver {
	readonly #addressWarnings = new Set<string>();
	readonly #channelTimeoutMs: number;
	readonly #logger: Logger;
	readonly #maxBytes: number;
	readonly #media: MediaService;

	constructor(options: {
		readonly channelTimeoutMs?: number;
		readonly logger: Logger;
		readonly maxBytes?: number;
		readonly media: MediaService;
	}) {
		this.#channelTimeoutMs = options.channelTimeoutMs ?? INBOUND_CHANNEL_MEDIA_TIMEOUT_MS;
		this.#logger = options.logger;
		this.#maxBytes = options.maxBytes ?? INBOUND_CHANNEL_MEDIA_MAX_BYTES;
		this.#media = options.media;
	}

	async resolve(
		part: InboundMediaPart,
		channel: InboundMediaChannel | undefined,
	): Promise<InboundMediaResolution> {
		const channelResult = await this.#fromChannel(part, channel);
		if (channelResult.kind === "bytes") {
			try {
				const stored =
					part.type === "file"
						? await this.#media.store({
								bytes: channelResult.bytes,
								...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
								kind: "file",
								...(part.sourceUrl === undefined ? {} : { sourceUrl: part.sourceUrl }),
								source: "channel",
							})
						: await this.#media.storeFetchedBytes(
								channelResult.bytes,
								this.#storeInput(part, true),
							);
				return { kind: "stored", stored, via: "channel" };
			} catch (error) {
				this.#logger.warn("inbound channel media could not be stored", {
					error: error instanceof Error ? error.message : String(error),
					type: part.type,
				});
				return { kind: "unavailable", reason: "unknown" };
			}
		}
		if (part.sourceUrl !== undefined) {
			try {
				const stored = await this.#media.storeFromUrl(
					part.sourceUrl,
					this.#storeInput(part, false),
				);
				return { kind: "stored", stored, via: "url" };
			} catch (error) {
				const reason = mediaUnavailableReasonFor(error);
				if (reason === "blocked_address") this.#warnBlockedAddress(part.sourceUrl);
				this.#logger.debug("inbound media url fetch failed", {
					host: hostnameOf(part.sourceUrl),
					reason,
					type: part.type,
				});
				return { kind: "unavailable", reason };
			}
		}
		return { kind: "unavailable", reason: channelResult.reason };
	}

	#storeInput(
		part: InboundMediaPart,
		withSourceUrl: boolean,
	): {
		readonly kind: "file" | "image" | "sticker";
		readonly mimeType?: string;
		readonly source: "channel";
		readonly sourceUrl?: string;
	} {
		return {
			kind: part.type === "file" ? "file" : part.type === "sticker" ? "sticker" : "image",
			...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
			source: "channel",
			...(withSourceUrl && part.sourceUrl !== undefined ? { sourceUrl: part.sourceUrl } : {}),
		};
	}

	async #fromChannel(
		part: InboundMediaPart,
		channel: InboundMediaChannel | undefined,
	): Promise<ChannelMediaResult> {
		const fetchMedia = channel?.fetchMedia;
		if (fetchMedia === undefined) return { kind: "failed", reason: "channel_unavailable" };
		if (part.channelRef === undefined && part.sourceUrl === undefined) {
			return { kind: "failed", reason: "not_found" };
		}
		let bytes: Uint8Array | undefined;
		try {
			bytes = await withTimeout(
				Promise.resolve(fetchMedia.call(channel, part)),
				this.#channelTimeoutMs,
			);
		} catch (error) {
			this.#logger.debug("inbound channel media fetch failed", {
				error: error instanceof Error ? error.message : String(error),
				type: part.type,
			});
			return { kind: "failed", reason: "channel_fetch_failed" };
		}
		if (bytes === undefined || bytes.byteLength === 0) {
			return { kind: "failed", reason: "not_found" };
		}
		if (bytes.byteLength > this.#maxBytes) {
			return { kind: "failed", reason: "response_too_large" };
		}
		return { kind: "bytes", bytes };
	}

	#warnBlockedAddress(sourceUrl: string): void {
		const host = hostnameOf(sourceUrl);
		if (host === undefined || this.#addressWarnings.has(host)) return;
		this.#addressWarnings.add(host);
		this.#logger.warn("inbound media host resolves to a non-public address", {
			host,
			remedy:
				"Add the exact CDN hostname to TSUKAIMA_MEDIA_FETCH_ALLOWED_HOSTS when that host is trusted",
		});
	}
}
