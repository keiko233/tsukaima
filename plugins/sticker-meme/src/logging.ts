import type { PluginLogger } from "@tsukaima/sdk";

const BOT_TOKEN_PATTERN = /\/bot\d+:[^/\s]+/giu;

/** Strips Telegram bot-token URL segments before anything reaches a log sink. */
export function redactLogText(value: string): string {
	return value.replace(BOT_TOKEN_PATTERN, "/bot[REDACTED]");
}

export function logErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactLogText(raw);
}

/**
 * Emits `trace` when the logger supports it and falls back to `debug` for older or partial
 * loggers (for example test doubles that only implement the SDK-required levels).
 */
export function traceLog(
	logger: PluginLogger | undefined,
	message: string,
	details?: unknown,
): void {
	if (logger === undefined) return;
	if (typeof logger.trace === "function") {
		logger.trace(message, details);
		return;
	}
	logger.debug(message, details);
}

/** Returns a namespaced child logger when the host supports `child`, else the same logger. */
export function childLogger(
	logger: PluginLogger | undefined,
	target: string,
	fields?: Record<string, unknown>,
): PluginLogger | undefined {
	if (logger === undefined) return undefined;
	if (typeof logger.child === "function") return logger.child(target, fields);
	return logger;
}

/** Millisecond duration rounded to two decimals so log lines stay easy to read. */
export function elapsedMs(startedAt: number): number {
	return Math.round((Date.now() - startedAt) * 100) / 100;
}
