import type { PluginLogger } from "@tsukaima/sdk";

/** Cap for user-supplied text previews so a single log field cannot flood the sink. */
export const LOG_PREVIEW_CHARS = 120;

const MAX_ERROR_CHARS = 240;
const MAX_PATH_CHARS = 80;

/** Collapse whitespace and cap a user string before it reaches a log sink. */
export function previewText(value: string, maxChars = LOG_PREVIEW_CHARS): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`;
}

/**
 * Reduce a URL to scheme, host, and a bounded path. Credentials, query strings, and fragments
 * are dropped because fetch and provider URLs can carry tokens or signatures.
 */
export function sanitizedUrl(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	try {
		const url = new URL(trimmed);
		const path =
			url.pathname.length > MAX_PATH_CHARS
				? `${url.pathname.slice(0, MAX_PATH_CHARS)}…`
				: url.pathname;
		return `${url.protocol}//${url.hostname}${path}${url.search.length > 0 ? "?[redacted]" : ""}`;
	} catch {
		return "[invalid-url]";
	}
}

/** Lowercase hostname for log correlation, or an empty string when the URL is unusable. */
export function hostOf(value: string): string {
	try {
		return new URL(value.trim()).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** One-line, bounded error text. Callers must redact it when secrets are in scope. */
export function errorSummary(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return previewText(message, MAX_ERROR_CHARS);
}

/** Milliseconds elapsed since a `performance.now()` reading, rounded for readable logs. */
export function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}

/**
 * Optional child logger. Classes accept an optional `PluginLogger`, so this keeps old test
 * doubles (and loggers without `child`) working while still labelling host log streams.
 */
export function childLogger(
	logger: PluginLogger | undefined,
	target: string,
): PluginLogger | undefined {
	if (logger === undefined || typeof logger.child !== "function") return logger;
	try {
		return logger.child(target);
	} catch {
		return logger;
	}
}
