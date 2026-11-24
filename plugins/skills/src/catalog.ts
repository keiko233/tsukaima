import {
	SKILL_BODY_MAX_CHARS,
	SKILL_DOCUMENT_MAX_BYTES,
	SKILL_RESOURCE_MAX_BYTES,
	type SkillDetail,
	type SkillsSnapshot,
	type SkillSummary,
	type SkillSurface,
} from "@tsukaima/contracts";
import type { PluginLogger } from "@tsukaima/sdk";
import { type SkillsConfig } from "./config.ts";
import {
	scanSkillRoots,
	walkSkillResources,
	type SkillRecord,
	type SkillResourceListing,
} from "./discovery.ts";
import { parseSkillDocument } from "./frontmatter.ts";
import { normalizeRelative, readFileInside, type PathFailure } from "./paths.ts";

export type SkillResourceFailure = PathFailure | "resources_disabled" | "unknown_skill";

export type SkillResourceReadResult =
	| {
			readonly ok: true;
			readonly bytes: number;
			readonly name: string;
			readonly path: string;
			readonly text: string;
	  }
	| { readonly ok: false; readonly reason: SkillResourceFailure };

export interface SkillCatalogOptions {
	readonly config: SkillsConfig;
	readonly logger: PluginLogger;
}

interface CatalogMemo {
	readonly key: string;
	readonly text: string | undefined;
}

function summaryMetadata(record: SkillRecord): Record<string, string> | undefined {
	const metadata: Record<string, string> = {
		...(record.metadata === undefined ? {} : record.metadata),
	};
	if (record.category !== undefined && metadata.category === undefined) {
		metadata.category = record.category;
	}
	return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function summaryOf(record: SkillRecord): SkillSummary {
	const metadata = summaryMetadata(record);
	return {
		description: record.description,
		enabled: record.enabled,
		fingerprint: record.fingerprint,
		name: record.name,
		scope: record.scope,
		...(record.allowedTools === undefined ? {} : { allowedTools: [...record.allowedTools] }),
		...(record.compatibility === undefined ? {} : { compatibility: record.compatibility }),
		...(record.license === undefined ? {} : { license: record.license }),
		...(metadata === undefined ? {} : { metadata }),
	};
}

function safeDescription(description: string): string {
	return description.replace(/</gu, "‹").replace(/>/gu, "›");
}

function safeMetadataValue(value: string): string {
	return safeDescription(value.replace(/\s+/gu, " ")).slice(0, 256);
}

function entryFor(record: SkillRecord): string {
	const metadata = summaryMetadata(record);
	const extras = [
		record.category === undefined
			? undefined
			: `  category: ${safeMetadataValue(record.category)}\n`,
		metadata?.version === undefined
			? undefined
			: `  version: ${safeMetadataValue(metadata.version)}\n`,
		metadata?.tags === undefined ? undefined : `  tags: ${safeMetadataValue(metadata.tags)}\n`,
	];
	return `- name: ${record.name}\n  description: ${safeDescription(record.description)}\n${extras.join("")}  location: skill://${record.name}/SKILL.md\n`;
}

function emptySnapshot(roots: number): SkillsSnapshot {
	return {
		diagnostics: [],
		roots,
		skills: [],
		updatedAtMs: 0,
		version: 0,
	};
}

/**
 * In-memory catalog over the configured skill roots. Reads happen only during a single-flight
 * rescan or an explicit detail/resource request; turn-context rendering is memoized per version
 * and never touches the filesystem.
 */
export class SkillCatalog {
	readonly #logger: PluginLogger;
	readonly #onWarn = (message: string, error: unknown): void => {
		this.#logger.warn(message, {
			error: error instanceof Error ? error.message : String(error),
		});
	};
	#config: SkillsConfig;
	#disposed = false;
	#inflight: Promise<SkillsSnapshot> | undefined;
	#loaded = false;
	#memo: CatalogMemo | undefined;
	#records: readonly SkillRecord[] = [];
	#signature = "";
	#snapshot: SkillsSnapshot;
	#version = 0;

	constructor(options: SkillCatalogOptions) {
		this.#config = options.config;
		this.#logger = options.logger;
		this.#snapshot = emptySnapshot(options.config.paths.length);
	}

	get config(): SkillsConfig {
		return this.#config;
	}

	configure(config: SkillsConfig): void {
		this.#config = config;
		this.#memo = undefined;
	}

	snapshot(): SkillsSnapshot {
		return this.#snapshot;
	}

	/**
	 * Cached snapshot for hot paths. The first call scans synchronously from the caller's point
	 * of view; later stale reads return the cache and refresh it in the background.
	 */
	async current(): Promise<SkillsSnapshot> {
		if (this.#disposed || !this.#loaded) return await this.rescan();
		if (Date.now() - this.#snapshot.updatedAtMs > this.#config.refreshIntervalMs) {
			void this.rescan().catch((error: unknown) => {
				this.#onWarn("skill catalog refresh failed", error);
			});
		}
		return this.#snapshot;
	}

	rescan(): Promise<SkillsSnapshot> {
		if (this.#inflight !== undefined) return this.#inflight;
		let run: Promise<SkillsSnapshot>;
		run = this.#runScan().finally(() => {
			if (this.#inflight === run) this.#inflight = undefined;
		});
		this.#inflight = run;
		return run;
	}

	find(name: string): SkillRecord | undefined {
		return this.#records.find((record) => record.name === name && record.enabled);
	}

	findAny(name: string): SkillRecord | undefined {
		return this.#records.find((record) => record.name === name);
	}

	surfaceAllowed(surface: SkillSurface): boolean {
		return this.#config.surfaces.has(surface);
	}

	renderTurnContext(surface: SkillSurface, isAdmin = false): string | undefined {
		if (!this.surfaceAllowed(surface)) return undefined;
		const key = `${this.#snapshot.version}|${surface}|${isAdmin ? 1 : 0}|${this.#config.maxCatalogChars}|${this.#config.allowResources ? 1 : 0}|${this.#config.paths.join("\0")}`;
		if (this.#memo?.key === key) return this.#memo.text;
		const text = this.#render(surface, isAdmin);
		this.#memo = { key, text };
		return text;
	}

	/** Re-reads SKILL.md and lists bundled resources for the WebUI preview and `load_skill`. */
	async loadDetail(name: string): Promise<SkillDetail | undefined> {
		const record = this.findAny(name);
		if (record === undefined) return undefined;
		const document = await readFileInside(record.directory, "SKILL.md", SKILL_DOCUMENT_MAX_BYTES);
		if (!document.ok) return undefined;
		const parsed = parseSkillDocument(document.value.text);
		if (!parsed.ok) return undefined;
		const listing: SkillResourceListing = this.#config.allowResources
			? await walkSkillResources(record.directory, { maxBytes: SKILL_RESOURCE_MAX_BYTES })
			: { resources: [], truncated: false };
		const body =
			parsed.document.body.length > SKILL_BODY_MAX_CHARS
				? parsed.document.body.slice(0, SKILL_BODY_MAX_CHARS)
				: parsed.document.body;
		return {
			...summaryOf(record),
			body,
			resources: [...listing.resources],
		};
	}

	async readResource(name: string, relative: unknown): Promise<SkillResourceReadResult> {
		if (!this.#config.allowResources) return { ok: false, reason: "resources_disabled" };
		const record = this.find(name);
		if (record === undefined) return { ok: false, reason: "unknown_skill" };
		const normalized = normalizeRelative(relative);
		if (!normalized.ok) return normalized;
		const file = await readFileInside(
			record.directory,
			normalized.value.path,
			SKILL_RESOURCE_MAX_BYTES,
		);
		if (!file.ok) return file;
		return {
			ok: true,
			bytes: file.value.bytes,
			name: record.name,
			path: normalized.value.path,
			text: file.value.text,
		};
	}

	dispose(): void {
		this.#disposed = true;
		this.#inflight = undefined;
	}

	#render(surface: SkillSurface, isAdmin: boolean): string | undefined {
		const enabled = this.#records
			.filter((record) => record.enabled && (isAdmin || record.scope === "everyone"))
			.toSorted((left, right) => left.name.localeCompare(right.name));
		if (enabled.length === 0) return undefined;
		const base =
			"Agent skills are available on demand. When a request clearly matches a skill's description, call load_skill with that name before acting, then follow the loaded instructions. Do not claim to use a skill you have not loaded.";
		const header = this.#config.allowResources
			? `${base} Bundled files can be read with read_skill_resource.`
			: base;
		const open = "<available_skills>\n";
		const close = "</available_skills>";
		const max = this.#config.maxCatalogChars;
		let body = "";
		let shown = 0;
		for (const record of enabled) {
			const entry = entryFor(record);
			if (header.length + 1 + open.length + body.length + entry.length + close.length > max) break;
			body += entry;
			shown += 1;
		}
		const remaining = enabled.length - shown;
		const note =
			remaining > 0
				? `(+${remaining} more skills not shown; call load_skill without a name to list all.)\n`
				: "";
		let text = `${header}\n${open}${body}${note}${close}`;
		if (text.length > max) {
			text = `${header}\n${open}${body}${close}`;
			if (text.length > max) text = text.slice(0, max);
		}
		this.#logger.debug("rendered skills turn context", {
			enabled: enabled.length,
			renderedChars: text.length,
			shown,
			surface,
		});
		return text;
	}

	async #runScan(): Promise<SkillsSnapshot> {
		const result = await scanSkillRoots(this.#config);
		const records = result.skills.toSorted((left, right) => left.name.localeCompare(right.name));
		const summaries = records.map(summaryOf);
		const signature = summaries
			.map(
				(summary) =>
					`${summary.name}\0${summary.description}\0${summary.enabled ? 1 : 0}\0${summary.scope}\0${summary.fingerprint}`,
			)
			.join("\n");
		if (signature !== this.#signature) {
			this.#version += 1;
			this.#signature = signature;
		}
		this.#records = records;
		this.#loaded = true;
		this.#memo = undefined;
		this.#snapshot = {
			diagnostics: [...result.diagnostics],
			roots: result.roots,
			skills: [...summaries],
			updatedAtMs: Date.now(),
			version: this.#version,
		};
		this.#logger.debug("skill catalog rescanned", {
			diagnostics: result.diagnostics.length,
			enabled: summaries.filter((summary) => summary.enabled).length,
			roots: result.roots,
			skills: summaries.length,
			version: this.#version,
		});
		return this.#snapshot;
	}
}
