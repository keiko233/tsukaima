/**
 * Structured logging contract for `@tsukaima/core`.
 *
 * The package never owns a logging backend: callers inject the server/app logger
 * (which already implements this shape) and tests can inject a collector. When no
 * logger is supplied the fallback keeps the historical behavior of reporting only
 * errors, so lower levels stay free at runtime.
 */
export interface CoreLogger {
	trace(message: string, fields?: Record<string, unknown>): void;
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	child?(target: string, fields?: Record<string, unknown>): CoreLogger;
	span?(name: string, fields?: Record<string, unknown>): CoreLogger;
}

/** Marker appended to a preview that had to be shortened. */
const ELLIPSIS = "…";

/**
 * Collapse every run of whitespace (including newlines) into a single space and
 * truncate to `maxLength`, ending a shortened preview with an ellipsis. Log lines
 * must stay single-line, so this is the only text transform core applies to
 * message/answer content before logging it.
 */
export function previewText(value: string, maxLength = 120): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	if (maxLength <= 0) return "";
	const keep = Math.max(0, maxLength - ELLIPSIS.length);
	return `${collapsed.slice(0, keep)}${ELLIPSIS}`;
}

const noop = (): void => {};

/**
 * Logger used when the caller injects none: `error` reaches `console.error` and
 * everything below is a no-op, matching the previous direct `console.error` calls.
 */
export function createFallbackCoreLogger(): CoreLogger {
	return {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error(message: string, fields?: Record<string, unknown>): void {
			if (fields === undefined) {
				console.error(message);
				return;
			}
			console.error(message, fields);
		},
	};
}
