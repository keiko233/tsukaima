import type { PluginLogger } from "@tsukaima/sdk";

/** Log levels a plugin can emit. Mirrors `PluginLogger` without `child`. */
export type ScopedLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** Always-safe logger surface: never throws, never requires `child` or `trace`. */
export interface ScopedLogger {
	debug(message: string, details?: Record<string, unknown>): void;
	error(message: string, details?: Record<string, unknown>): void;
	info(message: string, details?: Record<string, unknown>): void;
	trace(message: string, details?: Record<string, unknown>): void;
	warn(message: string, details?: Record<string, unknown>): void;
}

/** Maximum characters kept in a single-line preview of untrusted text. */
export const PREVIEW_LIMIT = 120;

const FALLBACK_ORDER = ["error", "warn", "info", "debug"] as const;

type LogWriter = (message: string, details?: unknown) => void;

const noop = (): void => undefined;

const NOOP_LOGGER: ScopedLogger = {
	debug: noop,
	error: noop,
	info: noop,
	trace: noop,
	warn: noop,
};

function pickHandler(logger: PluginLogger, level: ScopedLogLevel): LogWriter | undefined {
	const exact = logger[level];
	if (typeof exact === "function") return exact.bind(logger);
	if (level === "trace" && typeof logger.debug === "function") return logger.debug.bind(logger);
	for (const fallback of FALLBACK_ORDER) {
		const handler = logger[fallback];
		if (typeof handler === "function") return handler.bind(logger);
	}
	return undefined;
}

/**
 * Wraps a possibly partial or absent `PluginLogger` into an always-safe logger.
 *
 * - `undefined` loggers degrade to a no-op, so services stay constructible without a logger.
 * - A logger without `trace` degrades to `debug`, matching `normalizePluginLogger` in the SDK.
 * - A throwing sink can never break the operation it observes.
 */
export function scopedLogger(logger: PluginLogger | undefined, target?: string): ScopedLogger {
	if (logger === undefined) return NOOP_LOGGER;
	const base = target === undefined ? logger : (logger.child?.(target) ?? logger);
	const at =
		(level: ScopedLogLevel) =>
		(message: string, details?: Record<string, unknown>): void => {
			const handler = pickHandler(base, level);
			if (handler === undefined) return;
			try {
				handler(message, details);
			} catch {
				// Logging must never fail the operation it observes.
			}
		};
	return {
		debug: at("debug"),
		error: at("error"),
		info: at("info"),
		trace: at("trace"),
		warn: at("warn"),
	};
}

function stringifyPreview(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	if (value === null) return "null";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Bounded, single-line preview of untrusted text (task briefs, proposals, commands) suitable for
 * `trace` details. Newlines and tabs are escaped and the result is clamped to `limit` characters.
 */
export function preview(value: unknown, limit = PREVIEW_LIMIT): string {
	const single = stringifyPreview(value)
		.replace(/\r/gu, "\\r")
		.replace(/\n/gu, "\\n")
		.replace(/\t/gu, "\\t");
	if (single.length <= limit) return single;
	return `${single.slice(0, Math.max(0, limit - 1))}…`;
}

/** Milliseconds elapsed since a `performance.now()` marker, rounded for log readability. */
export function elapsedMs(startedAt: number): number {
	return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

/** Command preview such as `bun test --bail`, bounded for `trace` details. */
export function previewCommand(command: string, args: readonly string[]): string {
	return preview([command, ...args].join(" "));
}
