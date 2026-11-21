import { delimiter, resolve } from "node:path";
import type { SkillSurface } from "@tsukaima/contracts";

export const DEFAULT_SKILLS_MAX_CATALOG_CHARS = 4_000;
export const MIN_SKILLS_MAX_CATALOG_CHARS = 500;
export const MAX_SKILLS_MAX_CATALOG_CHARS = 8_000;
export const DEFAULT_SKILLS_REFRESH_INTERVAL_MS = 30_000;
export const MIN_SKILLS_REFRESH_INTERVAL_SECONDS = 5;
export const MAX_SKILLS_REFRESH_INTERVAL_SECONDS = 3_600;

export interface SkillsConfig {
	readonly allowResources: boolean;
	readonly disabled: ReadonlySet<string>;
	readonly maxCatalogChars: number;
	readonly paths: readonly string[];
	readonly refreshIntervalMs: number;
	readonly surfaces: ReadonlySet<SkillSurface>;
}

function textValues(value: unknown): string[] {
	const raw =
		typeof value === "string"
			? value.split(delimiter).flatMap((part) => part.split(/\r?\n/u))
			: Array.isArray(value)
				? value
				: [];
	return raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function clampedInteger(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Reads the plugin config defensively: an invalid key falls back to its default instead of
 * failing plugin setup, because the loader must stay alive to report a useful status.
 */
export function parseSkillsConfig(raw: unknown, cwd = process.cwd()): SkillsConfig {
	const config =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const paths: string[] = [];
	const seen = new Set<string>();
	for (const entry of textValues(config.paths)) {
		const resolved = resolve(cwd, entry);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		paths.push(resolved);
	}
	const disabled = new Set(textValues(config.disabled));
	const configuredSurfaces = Array.isArray(config.surfaces)
		? config.surfaces.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const surfaces = new Set<SkillSurface>();
	if (configuredSurfaces === undefined) {
		surfaces.add("chat");
		surfaces.add("workspace");
	} else {
		for (const surface of configuredSurfaces) {
			if (surface === "chat" || surface === "workspace") surfaces.add(surface);
		}
	}
	const maxCatalogChars = clampedInteger(
		config.maxCatalogChars,
		MIN_SKILLS_MAX_CATALOG_CHARS,
		MAX_SKILLS_MAX_CATALOG_CHARS,
		DEFAULT_SKILLS_MAX_CATALOG_CHARS,
	);
	const refreshIntervalSeconds = clampedInteger(
		config.refreshIntervalSeconds,
		MIN_SKILLS_REFRESH_INTERVAL_SECONDS,
		MAX_SKILLS_REFRESH_INTERVAL_SECONDS,
		DEFAULT_SKILLS_REFRESH_INTERVAL_MS / 1_000,
	);
	return {
		allowResources: typeof config.allowResources === "boolean" ? config.allowResources : true,
		disabled,
		maxCatalogChars,
		paths,
		refreshIntervalMs: refreshIntervalSeconds * 1_000,
		surfaces,
	};
}
