import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/**
 * Bounded, fail-closed fetch for inbound channel media.
 *
 * Channel envelopes carry attacker-controlled URLs. Fetching one with a bare `fetch` gives the
 * remote peer server-side request forgery (loopback, link-local metadata services, private
 * networks), unbounded memory growth, and arbitrary content types rendered back to the admin
 * WebUI. This module only permits public HTTP(S) destinations, re-validates every redirect,
 * streams with a hard byte cap, and accepts only the image types the media store understands.
 */

export type MediaFetchFailureCode =
	| "blocked_address"
	| "blocked_content_type"
	| "blocked_host"
	| "blocked_scheme"
	| "dns_failure"
	| "http_error"
	| "invalid_redirect"
	| "invalid_url"
	| "network_error"
	| "redirect_limit"
	| "response_too_large"
	| "timeout";

export class MediaFetchError extends Error {
	readonly code: MediaFetchFailureCode;
	constructor(code: MediaFetchFailureCode, message: string) {
		super(message);
		this.name = "MediaFetchError";
		this.code = code;
	}
}

export interface MediaFetchPolicy {
	/**
	 * Hosts explicitly trusted even when they resolve to a private/loopback address. This is the
	 * opt-in for a local channel sidecar; the default is empty, so no inbound URL may reach the
	 * host's own network without an operator decision.
	 */
	readonly allowedPrivateHosts: readonly string[];
	/** Maximum accepted body size; a longer body is rejected, never truncated. */
	readonly maxBytes: number;
	readonly maxRedirects: number;
	readonly timeoutMs: number;
	/** Exact MIME types accepted after normalization. */
	readonly allowedContentTypes: readonly string[];
	/** Document mode accepts the shared text/document allowlist instead of image/media types. */
	readonly mode?: "document" | "media";
}

export const DEFAULT_MEDIA_FETCH_POLICY: MediaFetchPolicy = Object.freeze({
	// `application/octet-stream` is common for NapCat/CDN image links; the media store sniffs the
	// bytes and stores the real image type, and serving only passes image/media types through.
	allowedContentTypes: [
		"application/octet-stream",
		"image/gif",
		"image/jpeg",
		"image/png",
		"image/webp",
	],
	allowedPrivateHosts: [],
	maxBytes: 8 * 1024 * 1024,
	maxRedirects: 3,
	timeoutMs: 15_000,
});

/** Document/archive/text types safe to store as a file attachment. */
export const DOCUMENT_MEDIA_CONTENT_TYPES: readonly string[] = Object.freeze([
	"application/epub+zip",
	"application/json",
	"application/msword",
	"application/octet-stream",
	"application/ogg",
	"application/pdf",
	"application/rtf",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/vnd.oasis.opendocument.presentation",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/x-7z-compressed",
	"application/x-bzip2",
	"application/x-gzip",
	"application/x-rar-compressed",
	"application/x-tar",
	"application/xml",
	"application/zip",
	"text/csv",
	"text/html",
	"text/markdown",
	"text/plain",
	"text/tab-separated-values",
	"text/xml",
]);

export const DOCUMENT_MEDIA_CONTENT_TYPE_PREFIXES: readonly string[] = Object.freeze(["text/"]);

export type MediaDnsResolver = (hostname: string) => Promise<readonly string[]>;

/** One address that passed validation. The socket is connected to exactly this address. */
export interface PinnedAddress {
	readonly address: string;
	readonly family: 4 | 6;
}

export interface MediaFetchTransportInput {
	readonly address: PinnedAddress;
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly url: URL;
}

/**
 * Performs the HTTP(S) exchange for one validated hop. The default implementation connects to
 * `address` directly; a custom transport is a test seam and must honour the same pinning.
 */
export type MediaFetchTransport = (input: MediaFetchTransportInput) => Promise<Response>;

export interface MediaFetchResult {
	readonly bytes: Uint8Array;
	readonly finalUrl: string;
	readonly mimeType: string;
}

export interface MediaFetchOptions {
	readonly policy?: Partial<MediaFetchPolicy>;
	readonly resolve?: MediaDnsResolver;
	/** Test/embedding seam; production uses the pinned node:http(s) transport. */
	readonly transport?: MediaFetchTransport;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function normalizeHost(input: string): string {
	return input.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
}

function ipv4Octets(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => Number(part));
	return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
		? octets
		: undefined;
}

function inCidr4(octets: readonly number[], base: readonly number[], bits: number): boolean {
	const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
	const network = ((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) === (network & mask);
}

const NON_PUBLIC_IPV4: readonly (readonly [readonly number[], number])[] = [
	[[0, 0, 0, 0], 8],
	[[10, 0, 0, 0], 8],
	[[100, 64, 0, 0], 10],
	[[127, 0, 0, 0], 8],
	[[169, 254, 0, 0], 16],
	[[172, 16, 0, 0], 12],
	[[192, 0, 0, 0], 24],
	[[192, 0, 2, 0], 24],
	[[192, 88, 99, 0], 24],
	[[192, 168, 0, 0], 16],
	[[198, 18, 0, 0], 15],
	[[198, 51, 100, 0], 24],
	[[203, 0, 113, 0], 24],
	[[224, 0, 0, 0], 4],
	[[240, 0, 0, 0], 4],
];

function isNonPublicIpv4(address: string): boolean {
	const octets = ipv4Octets(address);
	if (octets === undefined) return true;
	return NON_PUBLIC_IPV4.some(([base, bits]) => inCidr4(octets, base, bits));
}

function ipv6Hextets(address: string): number[] | undefined {
	const cleaned = normalizeHost(address).replace(/%.*$/u, "");
	if (isIP(cleaned) !== 6) return undefined;
	const [head = "", tail = ""] = cleaned.split("::");
	const left = expandIpv6Parts(head.length === 0 ? [] : head.split(":"));
	const right = expandIpv6Parts(tail.length === 0 ? [] : tail.split(":"));
	if (left === undefined || right === undefined) return undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 0) return undefined;
	return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function expandIpv6Parts(parts: readonly string[]): number[] | undefined {
	const output: number[] = [];
	for (const part of parts) {
		if (part.includes(".")) {
			const octets = ipv4Octets(part);
			if (octets === undefined) return undefined;
			output.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
			continue;
		}
		const value = Number.parseInt(part, 16);
		if (!Number.isFinite(value)) return undefined;
		output.push(value);
	}
	return output;
}

function isNonPublicIpv6(address: string): boolean {
	const hextets = ipv6Hextets(address);
	if (hextets === undefined) return true;
	const first = hextets[0]!;
	if (hextets.every((value) => value === 0)) return true;
	if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true;
	if (
		hextets[0] === 0 &&
		hextets[1] === 0 &&
		hextets[2] === 0 &&
		hextets[3] === 0 &&
		hextets[4] === 0 &&
		hextets[5] === 0xffff
	) {
		const octets = [hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff];
		return isNonPublicIpv4(octets.join("."));
	}
	if ((first & 0xfe00) === 0xfc00) return true;
	if ((first & 0xffc0) === 0xfe80) return true;
	if ((first & 0xff00) === 0xff00) return true;
	return false;
}

/** True for every address an inbound media fetch must never reach. */
export function isNonPublicAddress(address: string): boolean {
	const version = isIP(normalizeHost(address));
	if (version === 4) return isNonPublicIpv4(normalizeHost(address));
	if (version === 6) return isNonPublicIpv6(normalizeHost(address));
	return true;
}

function hostMatches(pattern: string, hostname: string): boolean {
	const normalized = normalizeHost(pattern);
	if (normalized.length === 0) return false;
	return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function validateTarget(input: string, allowedPrivateHosts: readonly string[]): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new MediaFetchError("invalid_url", "Media URL is not valid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new MediaFetchError("blocked_scheme", `Media URL scheme ${url.protocol} is not allowed`);
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new MediaFetchError("invalid_url", "Media URL must not carry credentials");
	}
	const hostname = normalizeHost(url.hostname);
	if (hostname.length === 0) throw new MediaFetchError("invalid_url", "Media URL has no host");
	const trusted = allowedPrivateHosts.some((pattern) => hostMatches(pattern, hostname));
	if (
		!trusted &&
		(hostname === "localhost" || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
	) {
		throw new MediaFetchError("blocked_host", "Media URL points at a local host");
	}
	if (!trusted && isIP(hostname) !== 0 && isNonPublicAddress(hostname)) {
		throw new MediaFetchError("blocked_address", "Media URL points at a non-public address");
	}
	return url;
}

function toPinnedAddress(address: string): PinnedAddress | undefined {
	const normalized = normalizeHost(address);
	const version = isIP(normalized);
	if (version !== 4 && version !== 6) return undefined;
	return { address: normalized, family: version };
}

/**
 * Resolve a target and return the exact addresses a socket may connect to.
 *
 * Validation and connection are deliberately split: the caller connects to one of these
 * addresses, never to a fresh lookup of the hostname, so a DNS answer that changes between
 * validation and connect cannot redirect the request.
 */
async function resolvePinnedAddresses(
	hostname: string,
	resolve: MediaDnsResolver,
	allowedPrivateHosts: readonly string[],
): Promise<readonly PinnedAddress[]> {
	const trusted = allowedPrivateHosts.some((pattern) => hostMatches(pattern, hostname));
	const literal = toPinnedAddress(hostname);
	if (literal !== undefined) {
		if (!trusted && isNonPublicAddress(literal.address)) {
			throw new MediaFetchError("blocked_address", "Media host is not public");
		}
		return [literal];
	}
	let addresses: readonly string[];
	try {
		addresses = await resolve(hostname);
	} catch {
		throw new MediaFetchError("dns_failure", "Media host could not be resolved");
	}
	if (addresses.length === 0) {
		throw new MediaFetchError("dns_failure", "Media host did not resolve");
	}
	const pinned: PinnedAddress[] = [];
	for (const address of addresses.slice(0, MAX_PINNED_ADDRESSES)) {
		const parsed = toPinnedAddress(address);
		if (parsed === undefined) {
			throw new MediaFetchError("dns_failure", "Media host resolved to an invalid address");
		}
		if (!trusted && isNonPublicAddress(parsed.address)) {
			throw new MediaFetchError("blocked_address", "Media host resolves to a non-public address");
		}
		if (!pinned.some((entry) => entry.address === parsed.address)) pinned.push(parsed);
	}
	if (pinned.length === 0) {
		throw new MediaFetchError("blocked_address", "Media host resolves to a non-public address");
	}
	return pinned;
}

function normalizeMime(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const base = value.split(";")[0]?.trim().toLowerCase();
	return base === undefined || base.length === 0 ? undefined : base;
}

/** At most this many validated addresses are tried for one hop. */
const MAX_PINNED_ADDRESSES = 8;

/**
 * A `Host` header value for `url`: the hostname plus a port only when it is not the scheme
 * default, so the origin seen by the peer matches the URL we validated.
 */
function hostHeader(url: URL): string {
	const hostname = normalizeHost(url.hostname);
	const rendered = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	const defaultPort = url.protocol === "https:" ? "443" : "80";
	return url.port === "" || url.port === defaultPort ? rendered : `${rendered}:${url.port}`;
}

/**
 * Connect to one pinned address and speak HTTP(S) to it while keeping the validated hostname as
 * the TLS SNI/verification name and `Host` header. `lookup` is overridden to return only the
 * pinned address, so the connection cannot be redirected by a second DNS answer.
 */
async function pinnedTransport(input: MediaFetchTransportInput): Promise<Response> {
	const { address, signal, timeoutMs, url } = input;
	const secure = url.protocol === "https:";
	const hostname = normalizeHost(url.hostname);
	const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
	const requestFn = secure ? httpsRequest : httpRequest;
	return await new Promise<Response>((resolve, reject) => {
		const request = requestFn(
			{
				agent: false,
				headers: {
					accept: "*/*",
					"accept-encoding": "identity",
					host: hostHeader(url),
				},
				host: hostname,
				lookup: (_name, lookupOptions, callback) => {
					// Node's `all` mode expects an address array; returning a bare string there is a
					// hard error. Either shape still resolves only the validated address.
					if (lookupOptions.all === true) {
						callback(null, [{ address: address.address, family: address.family }]);
						return;
					}
					callback(null, address.address, address.family);
				},
				method: "GET",
				path: `${url.pathname}${url.search}`,
				port,
				...(secure ? { servername: hostname } : {}),
				signal,
			},
			(message: IncomingMessage) => {
				const headers = new Headers();
				for (const [key, value] of Object.entries(message.headers)) {
					if (value === undefined) continue;
					if (Array.isArray(value)) {
						for (const entry of value) headers.append(key, entry);
					} else {
						headers.set(key, value);
					}
				}
				const body =
					message.statusCode !== undefined && message.statusCode >= 300 && message.statusCode < 400
						? null
						: (Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>);
				// A redirect has no body to read; release its socket immediately instead of leaving
				// it paused until the request timeout.
				if (body === null) message.destroy();
				resolve(
					new Response(body, {
						headers,
						status: message.statusCode ?? 0,
						statusText: message.statusMessage ?? "",
					}),
				);
			},
		);
		request.setTimeout(timeoutMs, () => {
			request.destroy(new Error("Media request timed out"));
		});
		request.on("error", (error: Error) => {
			reject(error);
		});
		request.end();
	});
}

/** Convert a transport failure into the guard's bounded error codes. */
function toTransportError(error: unknown): MediaFetchError {
	if (error instanceof MediaFetchError) return error;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	if (name === "AbortError" || name === "TimeoutError" || /timed out/u.test(message)) {
		return new MediaFetchError("timeout", "Media fetch timed out");
	}
	return new MediaFetchError("network_error", "Media fetch failed");
}

/**
 * Fetch one inbound media URL under `policy`. Redirects are followed manually so each hop is
 * re-validated and re-pinned; a `content-length` over the cap is rejected before reading, and a
 * streamed body over the cap aborts the request instead of being truncated and stored.
 *
 * The connection is made to the exact address that validation approved, never to a second DNS
 * lookup of the hostname. For HTTPS the TLS peer name stays the validated hostname, so a
 * certificate for that host is still required even though the socket goes to an IP.
 */
export async function fetchGuardedMedia(
	rawUrl: string,
	options: MediaFetchOptions = {},
): Promise<MediaFetchResult> {
	const policy = { ...DEFAULT_MEDIA_FETCH_POLICY, ...options.policy };
	const transport = options.transport ?? pinnedTransport;
	const resolve: MediaDnsResolver =
		options.resolve ??
		(async (hostname) =>
			(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
	const deadline = AbortSignal.timeout(policy.timeoutMs);
	let current = validateTarget(rawUrl, policy.allowedPrivateHosts);
	for (let redirects = 0; ; redirects += 1) {
		const pinned = await resolvePinnedAddresses(
			normalizeHost(current.hostname),
			resolve,
			policy.allowedPrivateHosts,
		);
		const response = await requestPinned(transport, {
			addresses: pinned,
			deadline,
			timeoutMs: policy.timeoutMs,
			url: current,
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => undefined);
			if (location === null || location.length === 0) {
				throw new MediaFetchError("invalid_redirect", "Media redirect has no location");
			}
			if (redirects >= policy.maxRedirects) {
				throw new MediaFetchError("redirect_limit", "Media redirect limit exceeded");
			}
			try {
				current = validateTarget(new URL(location, current).toString(), policy.allowedPrivateHosts);
			} catch (error) {
				if (error instanceof MediaFetchError) {
					throw new MediaFetchError("invalid_redirect", "Media redirect target is not allowed");
				}
				throw error;
			}
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new MediaFetchError("http_error", `Media fetch returned ${response.status}`);
		}
		const mimeType = normalizeMime(response.headers.get("content-type"));
		if (
			mimeType === undefined ||
			(policy.mode === "document"
				? !(
						DOCUMENT_MEDIA_CONTENT_TYPES.includes(mimeType) ||
						DOCUMENT_MEDIA_CONTENT_TYPE_PREFIXES.some((prefix) => mimeType.startsWith(prefix))
					)
				: !policy.allowedContentTypes.includes(mimeType))
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new MediaFetchError(
				"blocked_content_type",
				`Media content type "${mimeType ?? "unknown"}" is not allowed`,
			);
		}
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > policy.maxBytes) {
			await response.body?.cancel().catch(() => undefined);
			throw new MediaFetchError("response_too_large", "Media response exceeds the size limit");
		}
		const bytes = await readBounded(response, policy.maxBytes);
		return { bytes, finalUrl: current.toString(), mimeType };
	}
}

/**
 * Request one hop, trying each validated address in order. A connection failure on one address
 * may fall through to the next; any other error ends the fetch. The caller never re-resolves.
 */
async function requestPinned(
	transport: MediaFetchTransport,
	input: {
		readonly addresses: readonly PinnedAddress[];
		readonly deadline: AbortSignal;
		readonly timeoutMs: number;
		readonly url: URL;
	},
): Promise<Response> {
	let lastError: MediaFetchError | undefined;
	for (const address of input.addresses) {
		if (input.deadline.aborted) throw new MediaFetchError("timeout", "Media fetch timed out");
		try {
			return await transport({
				address,
				signal: input.deadline,
				timeoutMs: input.timeoutMs,
				url: input.url,
			});
		} catch (error) {
			const mapped = toTransportError(error);
			if (mapped.code !== "network_error") throw mapped;
			lastError = mapped;
		}
	}
	throw lastError ?? new MediaFetchError("network_error", "Media fetch failed");
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (response.body === null) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new MediaFetchError("response_too_large", "Media response exceeds the size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}
