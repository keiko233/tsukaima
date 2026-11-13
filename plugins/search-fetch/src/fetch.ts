import { lookup } from "node:dns/promises";
import { MAX_FETCH_URL_LENGTH, truncate } from "./domain.ts";
import { extractHtmlContent } from "./html.ts";
import {
	assertNoDnsRebinding,
	type DomainPolicy,
	type IpResolver,
	resolvePublicAddresses,
	SafeFetchError,
	validateHttpUrl,
} from "./url-policy.ts";

export const DEFAULT_ALLOWED_CONTENT_TYPES = [
	"text/html",
	"application/xhtml+xml",
	"text/plain",
	"text/markdown",
	"application/json",
	"application/xml",
	"text/xml",
] as const;

export interface FetchPolicy extends DomainPolicy {
	readonly allowedContentTypes: readonly string[];
	readonly maxBytes: number;
	readonly maxRedirects: number;
	readonly maxTextChars: number;
	readonly timeoutMs: number;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = Object.freeze({
	allowDomains: [],
	allowedContentTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
	blockDomains: [],
	maxBytes: 1_000_000,
	maxRedirects: 3,
	maxTextChars: 20_000,
	timeoutMs: 10_000,
});

export interface FetchTransport {
	readonly fetch: typeof fetch;
	readonly resolve: IpResolver;
}

export interface SafeFetchResult {
	readonly bytes: number;
	readonly contentType: string;
	readonly description?: string;
	readonly fetchedAtMs: number;
	readonly finalUrl: string;
	readonly httpStatus: number;
	readonly language?: string;
	readonly text: string;
	readonly title: string;
	readonly truncated: boolean;
	readonly url: string;
}

export interface SafeFetcherOptions {
	readonly now?: () => number;
	readonly policy: FetchPolicy;
	readonly transport: FetchTransport;
}

type RequestOutcome =
	| { readonly kind: "redirect"; readonly location: string | null }
	| {
			readonly kind: "response";
			readonly bytes: number;
			readonly contentType: string;
			readonly status: number;
			readonly text: string;
			readonly url: string;
	  };

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentType(header: string | null): { mime: string; charset?: string } {
	if (header === null || header.trim().length === 0) return { mime: "" };
	const [rawMime = "", ...parameters] = header.split(";").map((part) => part.trim());
	const charset = parameters
		.map((parameter) => /^charset\s*=\s*"?([^";]+)"?$/iu.exec(parameter)?.[1])
		.find((value) => value !== undefined);
	return {
		...(charset === undefined ? {} : { charset }),
		mime: rawMime.toLowerCase(),
	};
}

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
	try {
		return new TextDecoder((charset ?? "utf-8") as never, { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
}

export function createDefaultFetchTransport(): FetchTransport {
	return {
		fetch: ((input, init) => fetch(input, init)) as typeof fetch,
		resolve: async (hostname) =>
			(await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
	};
}

/**
 * SSRF-hardened fetcher: validated schemes/hosts, DNS + rebinding checks, manual bounded
 * redirects, MIME allowlist, streaming byte cap, timeout, and bounded text extraction.
 */
export class SafeFetcher {
	readonly #now: () => number;
	#policy: FetchPolicy;
	readonly #transport: FetchTransport;

	constructor(options: SafeFetcherOptions) {
		this.#now = options.now ?? Date.now;
		this.#policy = options.policy;
		this.#transport = options.transport;
	}

	get policy(): FetchPolicy {
		return this.#policy;
	}

	setPolicy(policy: FetchPolicy): void {
		this.#policy = policy;
	}

	async fetch(input: string): Promise<SafeFetchResult> {
		if (input.trim().length === 0 || input.length > MAX_FETCH_URL_LENGTH) {
			throw new SafeFetchError("invalid_url", "The URL is missing or too long");
		}
		let url = validateHttpUrl(input, this.#policy);
		let redirects = 0;
		const originalUrl = url.url.toString();
		while (true) {
			const first = await resolvePublicAddresses(url.hostname, this.#transport.resolve);
			const second = await resolvePublicAddresses(url.hostname, this.#transport.resolve);
			assertNoDnsRebinding(first, second);
			const outcome = await this.#fetchOnce(url.url);
			if (outcome.kind === "response") {
				const extracted = this.#extract(outcome.text, outcome.contentType);
				return {
					bytes: outcome.bytes,
					contentType: outcome.contentType,
					fetchedAtMs: this.#now(),
					finalUrl: outcome.url,
					httpStatus: outcome.status,
					text: extracted.text,
					title: extracted.title,
					truncated: extracted.truncated,
					url: originalUrl,
					...(extracted.description === undefined ? {} : { description: extracted.description }),
					...(extracted.language === undefined ? {} : { language: extracted.language }),
				};
			}
			if (outcome.location === null) {
				throw new SafeFetchError("invalid_redirect", "The redirect has no Location header");
			}
			redirects += 1;
			if (redirects > this.#policy.maxRedirects) {
				throw new SafeFetchError("redirect_limit", "The redirect limit was exceeded");
			}
			let next: URL;
			try {
				next = new URL(outcome.location, url.url);
			} catch {
				throw new SafeFetchError("invalid_redirect", "The redirect target is invalid");
			}
			// Every Location target is fully revalidated, including DNS and IP policy.
			url = validateHttpUrl(next.toString(), this.#policy);
		}
	}

	#extract(
		raw: string,
		contentType: string,
	): {
		description?: string;
		language?: string;
		text: string;
		title: string;
		truncated: boolean;
	} {
		const mime = parseContentType(contentType).mime;
		if (mime !== "text/html" && mime !== "application/xhtml+xml") {
			return { ...truncate(raw, this.#policy.maxTextChars), title: "" };
		}
		const parsed = extractHtmlContent(raw);
		return {
			...(parsed.description === undefined ? {} : { description: parsed.description }),
			...(parsed.language === undefined ? {} : { language: parsed.language }),
			...truncate(parsed.text, this.#policy.maxTextChars),
			title: parsed.title.slice(0, 300),
		};
	}

	async #fetchOnce(url: URL): Promise<RequestOutcome> {
		const controller = new AbortController();
		const aborted = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener(
				"abort",
				() => reject(new SafeFetchError("timeout", "The fetch request timed out")),
				{ once: true },
			);
		});
		const timer = setTimeout(() => controller.abort(), this.#policy.timeoutMs);
		try {
			let response: Response;
			try {
				const request = this.#transport.fetch(url.toString(), {
					headers: {
						accept:
							"text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
						"user-agent": "TsukaimaSearchFetch/0.1 (+safe-fetch)",
					},
					redirect: "manual",
					signal: controller.signal,
				});
				void request.catch(() => undefined);
				response = await Promise.race([request, aborted]);
			} catch (error) {
				if (error instanceof SafeFetchError) throw error;
				if (controller.signal.aborted) {
					throw new SafeFetchError("timeout", "The fetch request timed out");
				}
				throw new SafeFetchError(
					"network_error",
					error instanceof Error ? error.message : "The fetch request failed",
				);
			}
			if (isRedirect(response.status)) {
				try {
					await response.body?.cancel();
				} catch {}
				return { kind: "redirect", location: response.headers.get("location") };
			}
			if (!response.ok) {
				try {
					await response.body?.cancel();
				} catch {}
				throw new SafeFetchError("http_error", `The destination returned HTTP ${response.status}`);
			}
			const { charset, mime } = parseContentType(response.headers.get("content-type"));
			if (!this.#policy.allowedContentTypes.includes(mime)) {
				try {
					await response.body?.cancel();
				} catch {}
				throw new SafeFetchError(
					"unsupported_content_type",
					`The content type ${mime.length === 0 ? "(missing)" : mime} is not allowed`,
				);
			}
			const bytes = await this.#readBounded(response, controller, aborted);
			if (bytes.byteLength === 0) {
				throw new SafeFetchError("empty_response", "The destination returned an empty body");
			}
			return {
				bytes: bytes.byteLength,
				contentType: mime,
				kind: "response",
				status: response.status,
				text: decodeBytes(bytes, charset),
				url: url.toString(),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	async #readBounded(
		response: Response,
		controller: AbortController,
		aborted: Promise<never>,
	): Promise<Uint8Array> {
		const maxBytes = this.#policy.maxBytes;
		const body = response.body;
		if (body === null) {
			let buffer: ArrayBuffer;
			try {
				const read = response.arrayBuffer();
				void read.catch(() => undefined);
				buffer = await Promise.race([read, aborted]);
			} catch (error) {
				if (error instanceof SafeFetchError) throw error;
				throw this.#readError(error, controller);
			}
			if (buffer.byteLength > maxBytes) {
				throw new SafeFetchError("response_too_large", "The response exceeded the byte limit");
			}
			return new Uint8Array(buffer);
		}
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await Promise.race([reader.read(), aborted]);
				if (done) break;
				if (value === undefined) continue;
				total += value.byteLength;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {}
					throw new SafeFetchError("response_too_large", "The response exceeded the byte limit");
				}
				chunks.push(value);
			}
		} catch (error) {
			if (error instanceof SafeFetchError) throw error;
			throw this.#readError(error, controller);
		}
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return merged;
	}

	#readError(error: unknown, controller: AbortController): SafeFetchError {
		if (controller.signal.aborted) {
			return new SafeFetchError("timeout", "The fetch request timed out");
		}
		return new SafeFetchError(
			"network_error",
			error instanceof Error ? error.message : "Reading the response failed",
		);
	}
}
