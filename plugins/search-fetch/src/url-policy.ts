import { isIP } from "node:net";

export type FetchFailureCode =
	| "blocked_domain"
	| "blocked_host"
	| "blocked_ip"
	| "blocked_scheme"
	| "dns_failure"
	| "dns_rebinding"
	| "empty_response"
	| "http_error"
	| "invalid_redirect"
	| "invalid_url"
	| "network_error"
	| "redirect_limit"
	| "response_too_large"
	| "timeout"
	| "unsupported_content_type";

export class SafeFetchError extends Error {
	readonly code: FetchFailureCode;
	constructor(code: FetchFailureCode, message: string) {
		super(message);
		this.name = "SafeFetchError";
		this.code = code;
	}
}

export interface DomainPolicy {
	readonly allowDomains?: readonly string[];
	readonly blockDomains?: readonly string[];
}

export type IpResolver = (hostname: string) => Promise<readonly string[]>;

export function normalizeHost(input: string): string {
	return input.trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
}

function parseIPv4(address: string): number[] | undefined {
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

/** True for every IPv4 range that must never be reachable through plugin fetches. */
export function isNonPublicIPv4(address: string): boolean {
	const octets = parseIPv4(address);
	if (octets === undefined) return true;
	return NON_PUBLIC_IPV4.some(([base, bits]) => inCidr4(octets, base, bits));
}

function expandIPv6Parts(parts: string[]): number[] {
	const output: number[] = [];
	for (const part of parts) {
		if (part.includes(".")) {
			const octets = parseIPv4(part);
			if (octets === undefined) return [];
			output.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
			continue;
		}
		const value = Number.parseInt(part, 16);
		if (!Number.isFinite(value)) return [];
		output.push(value);
	}
	return output;
}

function parseIPv6Hextets(address: string): number[] | undefined {
	const cleaned = normalizeHost(address).replace(/%.*$/u, "");
	if (isIP(cleaned) !== 6) return undefined;
	const [head = "", tail = ""] = cleaned.split("::");
	const headParts = head.length === 0 ? [] : head.split(":");
	const tailParts = tail.length === 0 ? [] : tail.split(":");
	const left = expandIPv6Parts(headParts);
	const right = expandIPv6Parts(tailParts);
	const missing = 8 - left.length - right.length;
	if (missing < 0) return undefined;
	return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/** True for loopback, ULA, link-local, multicast, unspecified, and IPv4-mapped non-public IPs. */
export function isNonPublicIPv6(address: string): boolean {
	const hextets = parseIPv6Hextets(address);
	if (hextets === undefined) return true;
	const first = hextets[0]!;
	const allZero = hextets.every((value) => value === 0);
	if (allZero) return true;
	if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true;
	// ::ffff:a.b.c.d (IPv4-mapped) must be unwrapped and checked as IPv4.
	if (
		hextets[0] === 0 &&
		hextets[1] === 0 &&
		hextets[2] === 0 &&
		hextets[3] === 0 &&
		hextets[4] === 0 &&
		hextets[5] === 0xffff
	) {
		const octets = [hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff];
		return isNonPublicIPv4(octets.join("."));
	}
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
	return false;
}

export function isNonPublicIp(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isNonPublicIPv4(address);
	if (version === 6) return isNonPublicIPv6(address);
	return true;
}

export function isIpLiteral(host: string): boolean {
	return isIP(normalizeHost(host)) !== 0;
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
	return new RegExp(`^${escaped}$`, "iu");
}

/** Exact, suffix, or glob host matching used by the domain allow/block lists. */
export function hostMatches(pattern: string, hostname: string): boolean {
	const host = normalizeHost(hostname);
	const raw = pattern.trim().toLowerCase();
	const candidate = raw.includes("://") ? (safeHostname(raw) ?? raw) : raw.replace(/\/.*$/u, "");
	const normalized = normalizeHost(candidate);
	if (normalized.length === 0) return false;
	if (normalized === "*") return true;
	if (normalized.includes("*")) return globToRegExp(normalized).test(host);
	return host === normalized || host.endsWith(`.${normalized}`);
}

function safeHostname(input: string): string | undefined {
	try {
		return new URL(input).hostname;
	} catch {
		return undefined;
	}
}

export function isHostAllowed(hostname: string, policy: DomainPolicy): boolean {
	const block = policy.blockDomains ?? [];
	if (block.some((pattern) => hostMatches(pattern, hostname))) return false;
	const allow = policy.allowDomains ?? [];
	return allow.length === 0 || allow.some((pattern) => hostMatches(pattern, hostname));
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal"];

export interface ValidatedTarget {
	readonly hostname: string;
	readonly url: URL;
}

/**
 * Scheme, credential, literal-host, and domain policy validation. The URL is returned with
 * credentials stripped so no Authorization-like userinfo can reach a provider or be logged.
 */
export function validateHttpUrl(input: string, policy: DomainPolicy = {}): ValidatedTarget {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new SafeFetchError("invalid_url", "The URL is not valid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SafeFetchError("blocked_scheme", `The ${url.protocol} scheme is not allowed`);
	}
	url.username = "";
	url.password = "";
	const hostname = normalizeHost(url.hostname);
	if (hostname.length === 0) throw new SafeFetchError("invalid_url", "The URL has no host");
	if (hostname === "localhost" || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		throw new SafeFetchError("blocked_host", "Local hosts are not reachable");
	}
	if (isIpLiteral(hostname)) {
		if (isNonPublicIp(hostname)) {
			throw new SafeFetchError("blocked_ip", "The destination address is not public");
		}
	}
	if (!isHostAllowed(hostname, policy)) {
		throw new SafeFetchError("blocked_domain", "The destination domain is not allowed");
	}
	return { hostname, url };
}

export async function resolvePublicAddresses(
	hostname: string,
	resolver: IpResolver,
): Promise<readonly string[]> {
	if (isIpLiteral(hostname)) return [normalizeHost(hostname)];
	let addresses: readonly string[];
	try {
		addresses = await resolver(hostname);
	} catch {
		throw new SafeFetchError("dns_failure", "The destination name could not be resolved");
	}
	if (addresses.length === 0) {
		throw new SafeFetchError("dns_failure", "The destination name did not resolve");
	}
	if (addresses.some((address) => isNonPublicIp(address))) {
		throw new SafeFetchError("blocked_ip", "The destination resolves to a non-public address");
	}
	return addresses.map((address) => normalizeHost(address));
}

/** Compare the pre-request and pre-connect resolution results to catch rebinding. */
export function assertNoDnsRebinding(first: readonly string[], second: readonly string[]): void {
	const a = [...new Set(first)].toSorted();
	const b = [...new Set(second)].toSorted();
	if (a.length !== b.length || a.some((address, index) => address !== b[index])) {
		throw new SafeFetchError("dns_rebinding", "DNS resolution changed during the request");
	}
}
