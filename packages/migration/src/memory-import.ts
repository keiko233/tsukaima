import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import type { SnapshotSource } from "./dsh-inspect.ts";
import { listFiles, resolveSnapshotRoot } from "./fs.ts";
import { sha256String, stableStringify } from "./fs.ts";
import type { DecisionEntry } from "./decision.ts";
import { isCredentialLikeKey, sanitizeMemorySpace } from "./dsh-baseline.ts";

export interface ImportedMemoryRecord {
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly scope: "global" | "conversation";
	readonly kind: string;
	readonly content: string;
	readonly summary: string;
	readonly confidence: number;
	readonly importance: number;
	readonly conversationId: string;
	readonly subjectUserId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly provenance: Readonly<Record<string, unknown>>;
}

export interface ImportedSchedulerState {
	readonly sourceId: string;
	readonly conversationId: string;
	readonly lastMessageAtMs: number | null;
	readonly lastInboundAtMs: number | null;
	readonly lastOutboundAtMs: number | null;
	readonly inboundCount: number;
	readonly unansweredStreak: number;
	readonly refusedCount: number;
	readonly silenceUntilMs: number | null;
	readonly activeHoursHistogram: Readonly<Record<string, number>>;
	readonly warmness: number;
	readonly openers: readonly string[];
	readonly dailyCountDate: string | null;
	readonly dailyCount: number;
	readonly hourlyWindowMs: number | null;
	readonly hourlyCount: number;
	readonly updatedAtMs: number;
	readonly sourceHash: string;
}

/**
 * DSH `human-profiles.json` record mapped onto Tsukaima's `social_profiles` columns. Kept next to
 * the legacy scheduler-state mapping because proactive scheduling and social familiarity learn
 * from the same snapshot but persist to different domains.
 */
export interface ImportedSocialProfile {
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly conversationId: string;
	readonly interactions: number;
	readonly otherFirst: number;
	readonly selfFirst: number;
	readonly proactiveSent: number;
	readonly proactiveAnswered: number;
	readonly unansweredStreak: number;
	readonly refusedCount: number;
	readonly refusedAt: number | null;
	readonly unansweredAt: number | null;
	readonly silentUntil: number | null;
	readonly activeHours: Readonly<Record<string, number>>;
	readonly level: "L0" | "L1" | "L2";
	readonly warm: boolean;
	readonly proactiveToday: number;
	readonly dayKey: string | null;
	readonly updatedAtMs: number;
}

export interface MemoryImportResult {
	readonly memories: readonly ImportedMemoryRecord[];
	readonly schedulerStates: readonly ImportedSchedulerState[];
	readonly socialProfiles: readonly ImportedSocialProfile[];
	readonly decisions: readonly DecisionEntry[];
	readonly warnings: readonly string[];
	readonly spaces: readonly string[];
}

interface SourceFile {
	readonly path: string;
	readonly absolutePath: string;
}

/** Preserve the real memory space in IDs; the baseline sanitizer is for reports only. */
function importSpace(raw: string): string {
	const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
	return cleaned === "" ? "custom" : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function toIso(value: unknown, fallback = new Date(0).toISOString()): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value < 1e12 ? value * 1000 : value).toISOString();
	}
	if (typeof value === "string" && value !== "") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	return fallback;
}

function toMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string" && value !== "") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date.getTime();
	}
	return null;
}

function canonicalId(kind: string, sourceId: string): string {
	return `dsh_${kind}_${sourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function conversationIdForSpace(space: string): string {
	if (space === "dsh-host") return "";
	if (space.startsWith("napcat-group-")) {
		return canonicalId("conversation", space);
	}
	if (space.startsWith("napcat-private-")) {
		return canonicalId("conversation", space);
	}
	if (/^(?:group|private)[-_]/.test(space)) {
		return canonicalId("conversation", `napcat-${space}`);
	}
	if (space.startsWith("workspace-")) {
		return canonicalId("conversation", space);
	}
	return "";
}

export function conversationIdForPlatformKey(key: string): string {
	if (/^group[_:]/.test(key) || key.startsWith("napcat-group-")) {
		const source = key.startsWith("napcat-group-") ? key : `napcat-group-${key}`;
		return canonicalId("conversation", source);
	}
	if (/^qq[_:]|^private[_:]|^napcat-private-/.test(key)) {
		const source = key.startsWith("napcat-private-") ? key : `napcat-private-${key}`;
		return canonicalId("conversation", source);
	}
	return "";
}

function sourceFiles(source: SnapshotSource): Promise<SourceFile[]> {
	const files: SourceFile[] = [];
	return (async () => {
		for (const [root, label] of source) {
			const stats = await fs.stat(root).catch(() => null);
			if (stats?.isDirectory()) {
				const dataRoot = await resolveSnapshotRoot(root);
				for (const file of await listFiles(dataRoot)) {
					files.push({
						absolutePath: file,
						path: `${label}/${file.slice(dataRoot.length + 1).replaceAll("\\", "/")}`,
					});
				}
			} else if (stats?.isFile()) {
				files.push({ absolutePath: root, path: label });
			}
		}
		return files;
	})();
}

function tables(databasePath: string): string[] {
	try {
		const database = new Database(databasePath, { readonly: true });
		try {
			return (
				database
					.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
					.all() as { name: string }[]
			).map((row) => row.name);
		} finally {
			database.close();
		}
	} catch {
		return [];
	}
}

function rows(databasePath: string, table: string): Record<string, unknown>[] {
	try {
		const database = new Database(databasePath, { readonly: true });
		try {
			return database
				.query(`SELECT * FROM "${table.replaceAll('"', '""')}" LIMIT 10000`)
				.all() as Record<string, unknown>[];
		} finally {
			database.close();
		}
	} catch {
		return [];
	}
}

function memoryFromRow(input: {
	readonly row: Record<string, unknown>;
	readonly table: string;
	readonly databasePath: string;
	readonly space: string;
	readonly conversationSpace?: string;
	readonly index: number;
}): ImportedMemoryRecord | null {
	const { row, table, databasePath, space, index } = input;
	const content =
		string(row.content) ??
		string(row.text) ??
		string(row.summary) ??
		string(row.value) ??
		string(row.body);
	if (content === null) return null;
	const id = string(row.id) ?? string(row.memory_id) ?? `${space}:${table}:${index}`;
	const createdAt = toIso(row.created_at ?? row.createdAt ?? row.stored_at ?? row.storedAt);
	const updatedAt = toIso(
		row.updated_at ?? row.updatedAt ?? row.last_accessed_at ?? row.lastAccessedAt,
		createdAt,
	);
	const conversationId = conversationIdForSpace(input.conversationSpace ?? space);
	const summary = string(row.summary) ?? content.slice(0, 240);
	const sourceId = `${space}:${table}:${id}`;
	return {
		canonicalId: canonicalId("memory", sourceId),
		confidence: number(row.confidence ?? row.effective_importance) ?? 1,
		content,
		conversationId,
		createdAt,
		importance: number(row.importance ?? row.effective_importance ?? row.score) ?? 0.5,
		kind: string(row.category ?? row.kind ?? row.type) ?? table,
		provenance: {
			database: `${space}/${basename(databasePath)}`,
			row: index,
			space,
			table,
		},
		scope: conversationId === "" ? "global" : "conversation",
		sourceHash: sha256String(stableStringify(row)),
		sourceId,
		summary,
		updatedAt,
		subjectUserId: "",
	};
}

function activeHoursHistogram(profile: Record<string, unknown>): Record<string, number> {
	const histogram: Record<string, number> = {};
	const activeHours = Array.isArray(profile.activeHours)
		? profile.activeHours.filter((value): value is number => typeof value === "number")
		: [];
	if (activeHours.length >= 2) {
		const [start, end] = [activeHours[0]!, activeHours[1]!];
		if (start <= end) {
			for (let hour = start; hour <= end; hour += 1) histogram[String(hour)] = 1;
		} else {
			for (let hour = start; hour <= 23; hour += 1) histogram[String(hour)] = 1;
			for (let hour = 0; hour <= end; hour += 1) histogram[String(hour)] = 1;
		}
	} else if (activeHours.length === 1) {
		histogram[String(activeHours[0])] = 1;
	} else if (isRecord(profile.activeHours)) {
		for (const [hour, count] of Object.entries(profile.activeHours)) {
			const parsed = number(count);
			if (parsed !== null && parsed >= 0) histogram[hour] = Math.floor(parsed);
		}
	}
	return histogram;
}

function socialProfileFromProfile(
	key: string,
	profile: Record<string, unknown>,
	path: string,
	nowMs: number,
): ImportedSocialProfile | null {
	const conversationId = conversationIdForPlatformKey(key);
	if (conversationId === "") return null;
	const rawLevel = profile.level;
	const level: ImportedSocialProfile["level"] =
		rawLevel === "L2" || rawLevel === 2 ? "L2" : rawLevel === "L1" || rawLevel === 1 ? "L1" : "L0";
	return {
		activeHours: activeHoursHistogram(profile),
		conversationId,
		dayKey: string(profile.dayKey),
		interactions: number(profile.interactions) ?? 0,
		level,
		otherFirst: number(profile.otherFirst) ?? 0,
		proactiveAnswered: number(profile.proactiveAnswered) ?? 0,
		proactiveSent: number(profile.proactiveSent) ?? 0,
		proactiveToday: number(profile.proactiveToday) ?? 0,
		refusedAt: toMs(profile.refusedAt),
		refusedCount: number(profile.refusedCount) ?? 0,
		selfFirst: number(profile.selfFirst) ?? 0,
		silentUntil: toMs(profile.silentUntil),
		sourceHash: sha256String(stableStringify({ key, path, profile })),
		sourceId: `napcat-human-profile:${key}`,
		unansweredAt: toMs(profile.unansweredAt),
		unansweredStreak: number(profile.unansweredStreak) ?? 0,
		updatedAtMs: toMs(profile.updatedAt) ?? nowMs,
		warm: profile.warm === true,
	};
}

function stateFromProfile(
	key: string,
	profile: Record<string, unknown>,
	path: string,
): ImportedSchedulerState | null {
	const conversationId = conversationIdForPlatformKey(key);
	if (conversationId === "") return null;
	const now = toMs(profile.updatedAt ?? profile.createdAt) ?? Date.now();
	const histogram = activeHoursHistogram(profile);
	const warm = profile.warm === true;
	const level = number(profile.level) ?? 0;
	return {
		activeHoursHistogram: histogram,
		conversationId,
		dailyCount: number(profile.proactiveToday) ?? 0,
		dailyCountDate: string(profile.dayKey),
		hourlyCount: 0,
		hourlyWindowMs: null,
		inboundCount: number(profile.interactions) ?? 0,
		lastInboundAtMs: toMs(profile.updatedAt),
		lastMessageAtMs: toMs(profile.updatedAt),
		lastOutboundAtMs: toMs(profile.lastOutboundAt ?? profile.updatedAt),
		openers: Array.isArray(profile.openers)
			? profile.openers.filter((entry): entry is string => typeof entry === "string")
			: [],
		refusedCount: number(profile.refusedCount) ?? 0,
		silenceUntilMs: toMs(profile.silentUntil),
		sourceHash: sha256String(stableStringify({ key, path, profile })),
		sourceId: `napcat-human-profile:${key}`,
		unansweredStreak: number(profile.unansweredStreak) ?? 0,
		updatedAtMs: now,
		warmness: warm
			? Math.min(1, 0.5 + level * 0.1)
			: Math.min(1, (number(profile.interactions) ?? 0) / 10),
	};
}

function readJsonl(content: string): Record<string, unknown>[] {
	return content.split(/\r?\n/).flatMap((line) => {
		if (line.trim() === "") return [];
		try {
			const parsed = JSON.parse(line) as unknown;
			return isRecord(parsed) ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

export async function importDshMemory(
	source: SnapshotSource,
	options: { readonly now?: () => number } = {},
): Promise<MemoryImportResult> {
	const now = options.now ?? Date.now;
	const files = await sourceFiles(source);
	const memories: ImportedMemoryRecord[] = [];
	const schedulerStates: ImportedSchedulerState[] = [];
	const socialProfiles: ImportedSocialProfile[] = [];
	const decisions: DecisionEntry[] = [];
	const warnings: string[] = [];
	const spaces = new Set<string>();

	for (const file of files) {
		const match = /(?:^|\/)\.mnemon\/data\/([^/]+)\/mnemon\.db$/i.exec(file.path);
		if (match?.[1]) {
			const rawSpace = match[1];
			const space = importSpace(rawSpace);
			spaces.add(sanitizeMemorySpace(rawSpace));
			const tableNames = tables(file.absolutePath);
			for (const table of tableNames) {
				if (!/insight|memor|item|document|note/i.test(table)) continue;
				const tableRows = rows(file.absolutePath, table);
				for (const [index, row] of tableRows.entries()) {
					const memory = memoryFromRow({
						conversationSpace: rawSpace,
						databasePath: file.absolutePath,
						index,
						row,
						space,
						table,
					});
					if (memory === null) {
						decisions.push({
							action: "review",
							area: "memory",
							reason: "Mnemon row has no recognizable memory content",
							source: `${file.path}#${table}[${index}]`,
							target: "memories",
						});
						continue;
					}
					memories.push(memory);
				}
			}
			continue;
		}
		if (/(?:^|\/)\.mnemon\/runtime\/memories\.json$/i.test(file.path)) {
			try {
				const parsed = JSON.parse(await fs.readFile(file.absolutePath, "utf8")) as unknown;
				const entries = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
				for (const [index, entry] of entries.entries()) {
					if (!isRecord(entry)) continue;
					const memory = memoryFromRow({
						databasePath: file.absolutePath,
						index,
						row: entry,
						space: "dsh-host",
						table: "runtime",
					});
					if (memory !== null) memories.push(memory);
				}
			} catch (error) {
				warnings.push(`Failed to parse ${file.path}: ${String(error)}`);
			}
			continue;
		}
		if (/(?:^|\/)\.mnemon\/documents\/(?:active|archived)\/[^/]+\.md$/i.test(file.path)) {
			const archived = /\/archived\//.test(file.path);
			const content = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
			if (content.trim() === "") continue;
			const sourceId = `document:${file.path}`;
			memories.push({
				canonicalId: canonicalId("memory", sourceId),
				confidence: archived ? 0.8 : 1,
				content,
				conversationId: "",
				createdAt: new Date(now()).toISOString(),
				importance: archived ? 0.4 : 0.7,
				kind: archived ? "document-archived" : "document",
				provenance: { archived, path: file.path },
				scope: "global",
				sourceHash: sha256String(stableStringify({ content, path: file.path })),
				sourceId,
				subjectUserId: "",
				summary: content.slice(0, 240),
				updatedAt: new Date(now()).toISOString(),
			});
			continue;
		}
		const workspaceMemory = /(?:^|\/)workspace\/memory\/([^/]+)\/(items|summary)\.json$/i.exec(
			file.path,
		);
		if (workspaceMemory !== null) {
			const rawSpace = workspaceMemory[1]!;
			const space = importSpace(rawSpace);
			spaces.add(sanitizeMemorySpace(rawSpace));
			const conversationSpace = /^(?:group|private)[-_]/.test(rawSpace)
				? `napcat-${rawSpace}`
				: rawSpace;
			const conversationId = conversationIdForSpace(conversationSpace);
			try {
				const parsed = JSON.parse(await fs.readFile(file.absolutePath, "utf8")) as unknown;
				if (workspaceMemory[2]!.toLowerCase() === "items") {
					const entries = isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
					for (const [index, entry] of entries.entries()) {
						if (!isRecord(entry)) continue;
						const memory = memoryFromRow({
							conversationSpace,
							databasePath: file.absolutePath,
							index,
							row: entry,
							space,
							table: "items",
						});
						if (memory !== null) {
							const score = number(entry.score);
							memories.push({
								...memory,
								confidence: score ?? memory.confidence,
								importance: score ?? memory.importance,
								kind: string(entry.kind ?? entry.type) ?? memory.kind,
							});
						}
					}
				} else {
					const content =
						isRecord(parsed) && typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (content !== "") {
						const sourceId = `memory-store:${rawSpace}:summary`;
						const updatedAt = isRecord(parsed)
							? toIso(parsed.updatedAt, new Date(now()).toISOString())
							: new Date(now()).toISOString();
						memories.push({
							canonicalId: canonicalId("memory", sourceId),
							confidence: 1,
							content,
							conversationId,
							createdAt: updatedAt,
							importance: 0.8,
							kind: "summary",
							provenance: { path: file.path, space },
							scope: conversationId === "" ? "global" : "conversation",
							sourceHash: sha256String(content),
							sourceId,
							subjectUserId: "",
							summary: content.slice(0, 240),
							updatedAt,
						});
					}
				}
			} catch (error) {
				warnings.push(`Failed to parse ${file.path}: ${String(error)}`);
			}
			continue;
		}
		// Other files in a memory store (space.json, archive.json, recent.jsonl, memory.md,
		// .mnemon internals) are either handled above or are not standalone memories.
		if (/(?:^|\/)workspace\/memory\/[^/]+\//i.test(file.path)) continue;
		if (
			/(?:^|\/)(?:shared-memory|cross-recent|cross-memory|memory)\.(?:json|jsonl|md)$/i.test(
				file.path,
			)
		) {
			const content = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
			if (content.trim() === "") continue;
			const entries = /\.jsonl$/i.test(file.path) ? readJsonl(content) : [];
			if (entries.length === 0) {
				const sourceId = `napcat-memory:${file.path}`;
				memories.push({
					canonicalId: canonicalId("memory", sourceId),
					confidence: 1,
					content,
					conversationId: "",
					createdAt: new Date(now()).toISOString(),
					importance: 0.6,
					kind: /cross/i.test(file.path) ? "cross-session" : "shared",
					provenance: { path: file.path },
					scope: "global",
					sourceHash: sha256String(content),
					sourceId,
					subjectUserId: "",
					summary: content.slice(0, 240),
					updatedAt: new Date(now()).toISOString(),
				});
			} else {
				for (const [index, entry] of entries.entries()) {
					const memory = memoryFromRow({
						databasePath: file.absolutePath,
						index,
						row: entry,
						space: "dsh-host",
						table: "napcat-cross",
					});
					if (memory !== null) memories.push(memory);
				}
			}
			continue;
		}
		if (/(?:^|\/)human-profiles\.json$/i.test(file.path)) {
			try {
				const parsed = JSON.parse(await fs.readFile(file.absolutePath, "utf8")) as unknown;
				const profiles = isRecord(parsed) && isRecord(parsed.profiles) ? parsed.profiles : {};
				for (const [key, profile] of Object.entries(profiles)) {
					if (!isRecord(profile)) continue;
					const state = stateFromProfile(key, profile, file.path);
					const social = socialProfileFromProfile(key, profile, file.path, now());
					if (state === null || social === null) {
						decisions.push({
							action: "review",
							area: "schedule-proactive",
							reason: "Human profile has no resolvable conversation id",
							source: `${file.path}#profiles.${key}`,
							target: "plugin.proactive-scheduler.state",
						});
					} else {
						schedulerStates.push(state);
						socialProfiles.push(social);
					}
				}
			} catch (error) {
				warnings.push(`Failed to parse human profiles: ${String(error)}`);
			}
		}
	}

	// Drop any credential-looking value accidentally present in imported memory text.
	const safeMemories = memories.filter((memory) => {
		if (/(?:token|password|secret|api[_ -]?key)/i.test(memory.content)) {
			decisions.push({
				action: "discard",
				area: "memory",
				reason: "Memory text resembles a credential and is not imported",
				source: memory.sourceId,
				target: "memories",
				redacted: true,
			});
			return false;
		}
		return true;
	});

	return {
		decisions,
		memories: safeMemories,
		schedulerStates,
		socialProfiles,
		spaces: [...spaces].toSorted((left, right) => left.localeCompare(right)),
		warnings,
	};
}

export function isSensitiveMemoryKey(key: string): boolean {
	return isCredentialLikeKey(key);
}
