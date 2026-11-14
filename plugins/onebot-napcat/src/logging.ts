import type { PluginLogger } from "@elaina/sdk";

/**
 * Logging helpers for the OneBot plugin.
 *
 * Two rules keep this plugin safe to run at `trace`:
 * 1. Callers log summaries (types, counts, ids, previews), never whole config objects.
 * 2. Every message/detail passes through `createSafeLogger`, which redacts token-like keys and
 *    `access_token=...` / `Bearer ...` values. That second rule is a net for mistakes, not a
 *    license to log secrets.
 */

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const MAX_PREVIEW_CHARS = 120;
const MAX_SCRUB_DEPTH = 6;
const MAX_SCRUB_ARRAY = 50;
const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
	/access[-_]?token|token|secret|password|passwd|authorization|cookie|credential|api[-_]?key|apikey/iu;

const INLINE_SECRET_PATTERN =
	/((?:(?:[?&])?(?:access[-_]?token|token|auth|key|api[-_]?key|signature|sig)=)|(?:Bearer\s+))([^&\s"',;]+)/giu;

const noop = (): void => {};

/** Shared no-op logger so optional logger plumbing never needs a guard at each call site. */
export const NOOP_LOGGER: PluginLogger = {
	debug: noop,
	error: noop,
	info: noop,
	trace: noop,
	warn: noop,
};

/** Redact token material that appears inside a plain string (URLs, header values, messages). */
export const redactLogString = (value: string): string =>
	value.replace(INLINE_SECRET_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);

const scrubLogValue = (value: unknown, depth: number): unknown => {
	if (typeof value === "string") return redactLogString(value);
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Error) {
		return { message: redactLogString(value.message), name: value.name };
	}
	if (depth >= MAX_SCRUB_DEPTH) return "[truncated]";
	if (Array.isArray(value)) {
		return value.slice(0, MAX_SCRUB_ARRAY).map((entry) => scrubLogValue(entry, depth + 1));
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : scrubLogValue(entry, depth + 1);
	}
	return result;
};

/** Recursively redact token-like keys/values from structured log details. */
export const scrubLogDetails = (details: unknown): unknown => scrubLogValue(details, 0);

/**
 * Wrap any `PluginLogger` so every write is redacted. `child` keeps working and stays redacted,
 * which lets protocol layers log freely without re-implementing secret handling.
 */
export const createSafeLogger = (logger: PluginLogger | undefined): PluginLogger => {
	if (logger === undefined) return NOOP_LOGGER;
	const write =
		(level: LogLevel) =>
		(message: string, details?: unknown): void => {
			logger[level](
				redactLogString(message),
				details === undefined ? undefined : scrubLogDetails(details),
			);
		};
	const safe: PluginLogger = {
		debug: write("debug"),
		error: write("error"),
		info: write("info"),
		trace: write("trace"),
		warn: write("warn"),
	};
	if (typeof logger.child === "function") {
		safe.child = (target, fields) => createSafeLogger(logger.child?.(target, fields));
	}
	return safe;
};

/**
 * Preferred entry point: derive a named child logger when the host supports it, then guard it.
 * A plain logger without `child` is reused instead of being dropped.
 */
export const scopedLogger = (
	logger: PluginLogger | undefined,
	target: string,
	fields?: Record<string, unknown>,
): PluginLogger => {
	if (logger === undefined) return NOOP_LOGGER;
	const child = typeof logger.child === "function" ? logger.child(target, fields) : logger;
	return createSafeLogger(child);
};

/** Collapse whitespace and bound a free-text preview so one frame stays one log line. */
export const singleLinePreview = (
	value: string | undefined,
	maxChars = MAX_PREVIEW_CHARS,
): string | undefined => {
	if (value === undefined) return undefined;
	const collapsed = value.replace(/\s+/gu, " ").trim();
	if (collapsed.length === 0) return undefined;
	return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 3)}...` : collapsed;
};

/**
 * Endpoint safe for logs: scheme, host, port, and path only. Userinfo, query strings (which may
 * carry `access_token`), and fragments are dropped before redaction has to catch them.
 */
export const safeEndpoint = (value: string | undefined): string | undefined => {
	if (value === undefined || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "[unparsed-endpoint]";
	}
};

/** Count segments by OneBot type — the useful wire summary that reveals no payload. */
export const segmentTypeCounts = (
	segments: readonly { readonly type?: unknown }[] | undefined,
): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const segment of segments ?? []) {
		const type = typeof segment.type === "string" ? segment.type : "unknown";
		counts[type] = (counts[type] ?? 0) + 1;
	}
	return counts;
};
