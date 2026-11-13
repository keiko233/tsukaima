import { isCredentialLikeKey } from "./dsh-baseline.ts";
import { stableStringify } from "./fs.ts";

export interface SecretRedaction {
	readonly path: string;
	readonly key: string;
}

export interface RedactionResult<T = unknown> {
	readonly value: T;
	readonly redactions: readonly SecretRedaction[];
}

export interface CollectSecretsOptions {
	/** Include host-specific URLs and absolute paths when they must never be imported. */
	readonly includeHostSpecific?: boolean;
}

const HOST_SPECIFIC_KEYS = new Set([
	"url",
	"urls",
	"host",
	"hostname",
	"port",
	"baseurl",
	"endpoint",
	"workspacepath",
	"sharedmemorypath",
	"crossstorepath",
	"memesdirs",
	"memedirs",
	"imagecache",
	"imageeditoutdir",
	"compactrpcurl",
	"layagateurl",
	"imageediturl",
]);

const IDENTIFYING_KEYS = new Set([
	"adminusers",
	"allowfrom",
	"botqq",
	"groupallowfrom",
	"personaoverrides",
	"qq",
	"userid",
	"groupid",
]);

function segments(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

export function isSecretKey(key: string): boolean {
	return isCredentialLikeKey(key);
}

export function isHostSpecificKey(key: string): boolean {
	const lower = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
	return HOST_SPECIFIC_KEYS.has(lower) || segments(key).includes("url");
}

export function isIdentifyingKey(key: string): boolean {
	return IDENTIFYING_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function isContainer(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Replace credential-like values while keeping the shape of structured source files.
 * Values are never copied into the redaction list, only their paths, so reports stay safe.
 */
export function redactSecrets<T>(
	value: T,
	options: CollectSecretsOptions = {},
): RedactionResult<T> {
	const redactions: SecretRedaction[] = [];
	const visit = (current: unknown, path: string, key: string): unknown => {
		const sensitive =
			isSecretKey(key) || (options.includeHostSpecific === true && isHostSpecificKey(key));
		if (sensitive) {
			redactions.push({ key, path });
			if (Array.isArray(current)) {
				return current.map(() => "[REDACTED]");
			}
			if (isContainer(current)) {
				return Object.fromEntries(Object.keys(current).map((child) => [child, "[REDACTED]"]));
			}
			return current === null || current === undefined || current === "" ? current : "[REDACTED]";
		}
		if (Array.isArray(current)) {
			return current.map((item, index) => visit(item, `${path}[${index}]`, key));
		}
		if (!isContainer(current)) {
			return current;
		}
		return Object.fromEntries(
			Object.entries(current).map(([childKey, childValue]) => [
				childKey,
				visit(childValue, `${path}.${childKey}`, childKey),
			]),
		);
	};
	return { redactions, value: visit(value, "$", "") as T };
}

/** Collect actual secret values for leak verification. Never serialize the result. */
export function collectSecretValues(value: unknown, path = "$"): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => collectSecretValues(item, `${path}[${index}]`));
	}
	if (!isContainer(value)) {
		return [];
	}
	return Object.entries(value).flatMap(([key, child]) => {
		const childPath = `${path}.${key}`;
		if (isSecretKey(key) && typeof child === "string" && child.trim() !== "") {
			return [child];
		}
		return collectSecretValues(child, childPath);
	});
}

export function containsSecretValue(serialized: string, secrets: readonly string[]): boolean {
	return secrets.some((secret) => secret.length > 0 && serialized.includes(secret));
}

export function redactSecretText(text: string, secrets: readonly string[]): string {
	let output = text;
	for (const secret of secrets) {
		if (secret.length > 0) {
			output = output.replaceAll(secret, "[REDACTED]");
		}
	}
	return output;
}

/** Stable fingerprint used by leak checks without writing raw values. */
export function secretFingerprint(secrets: readonly string[]): string {
	return stableStringify(secrets.toSorted());
}
