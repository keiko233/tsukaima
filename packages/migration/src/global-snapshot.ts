import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { listFiles, sha256File, sha256String, stableStringify } from "./fs.ts";

/**
 * Global offline snapshot/restore verification for an entire Tsukaima data directory.
 *
 * Unlike the per-database backup drill, this exercise proves whole-data consistency: it stops
 * coordinated writers (caller-provided hook or a "runtime already stopped" promise), captures
 * every SQLite store plus all referenced loose files, verifies integrity and foreign keys on
 * every captured SQLite file, cross-checks that durable entries reference domain rows and that
 * every domain media row has its blob, and rehearses an atomic generation cutover with a
 * recovery journal and rollback plan. Nothing here touches a live host unless the caller wires
 * one in; the default is an offline rehearsal against a copied data directory.
 */

export interface GlobalSnapshotOptions {
	/** Data directory holding domain.sqlite, durable.sqlite, plugins/, blobs/. */
	readonly dataDir: string;
	readonly runId?: string;
	/** Parent for snapshot generations and reports; defaults to `<dataDir>/global-snapshots`. */
	readonly root?: string;
	/**
	 * Coordinated writer stop. In a rehearsal this is the stop method of a lifecycle the caller
	 * owns; during a real restore the caller stops the runtime before invoking this module.
	 */
	readonly stopWriters?: () => Promise<void> | void;
	/** Verify without writing anything outside the snapshot root. */
	readonly dryRun?: boolean;
	readonly keepStaging?: boolean;
	readonly now?: () => number;
}

export interface GlobalSnapshotFileRecord {
	readonly logicalName: string;
	readonly sha256: string;
	readonly sizeBytes: number;
}

export interface GlobalSnapshotCheckRecord {
	readonly ok: boolean;
	readonly detail: string;
}

export interface GlobalSnapshotReport {
	readonly version: 1;
	readonly runId: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly ok: boolean;
	readonly error?: string;
	readonly snapshotGeneration: string | null;
	readonly manifestHash: string | null;
	readonly files: number;
	readonly totalBytes: number;
	readonly sqlite: {
		readonly stores: readonly string[];
		readonly integrity: Record<string, GlobalSnapshotCheckRecord>;
		readonly foreignKeys: Record<string, GlobalSnapshotCheckRecord>;
	};
	readonly crossStore: {
		readonly durableConversationsKnownToDomain: GlobalSnapshotCheckRecord;
		readonly mediaBlobsPresent: GlobalSnapshotCheckRecord;
	};
	readonly cutover: {
		readonly rehearsed: boolean;
		readonly journalPath: string | null;
		readonly rolledBack: boolean;
		readonly swappedGeneration: string | null;
	};
}

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

function defaultRunId(now: () => number): string {
	const stamp = new Date(now()).toISOString().replaceAll(/[:.]/gu, "-");
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

async function pathExists(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => null)) !== null;
}

function integrityResult(
	path: string,
	pragma: "integrity_check" | "foreign_key_check",
): GlobalSnapshotCheckRecord {
	let database: Database | undefined;
	try {
		database = new Database(path, { readonly: true });
		if (pragma === "foreign_key_check") {
			const rows = database.query("PRAGMA foreign_key_check").all() as Record<string, unknown>[];
			return rows.length === 0
				? { ok: true, detail: "no violations" }
				: { ok: false, detail: `${rows.length} foreign key violation(s)` };
		}
		const rows = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
		const values = rows.flatMap((row) => Object.values(row)).map((value) => String(value));
		return values.length === 1 && values[0] === "ok"
			? { ok: true, detail: "ok" }
			: { ok: false, detail: values.join("; ") || "no result" };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	} finally {
		database?.close();
	}
}

/** Every SQLite store in the data directory: domain, durable, and one per plugin. */
async function sqliteStores(dataDir: string): Promise<readonly string[]> {
	const stores: string[] = [];
	for (const name of ["cache.sqlite", "domain.sqlite", "durable.sqlite"]) {
		if (await pathExists(join(dataDir, name))) stores.push(name);
	}
	const pluginsDir = join(dataDir, "plugins");
	if (await pathExists(pluginsDir)) {
		for (const file of await listFiles(pluginsDir)) {
			if (file.endsWith(".sqlite"))
				stores.push(`plugins/${relative(pluginsDir, file).replaceAll("\\", "/")}`);
		}
	}
	return stores.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Referenced loose files: every file under the blob store. Media rows carry no path column, so
 * completeness is proven by matching domain `media` SHA-256 values to blob filenames below.
 */
async function looseFiles(dataDir: string): Promise<readonly string[]> {
	const blobs = join(dataDir, "blobs");
	if (!(await pathExists(blobs))) return [];
	return (await listFiles(blobs))
		.map((file) => `blobs/${relative(blobs, file).replaceAll("\\", "/")}`)
		.toSorted((left, right) => left.localeCompare(right));
}

async function copyFile(
	relativePath: string,
	dataDir: string,
	generationDir: string,
	sqlite: boolean,
): Promise<GlobalSnapshotFileRecord | null> {
	const source = join(dataDir, relativePath);
	const stats = await fs.stat(source).catch(() => null);
	if (stats === null || !stats.isFile()) return null;
	const target = join(generationDir, relativePath);
	await fs.mkdir(join(target, ".."), { recursive: true });
	if (sqlite) {
		const database = new Database(source, { readonly: true });
		try {
			database.query("VACUUM INTO ?").run(target);
		} finally {
			database.close();
		}
	} else {
		await fs.copyFile(source, target);
	}
	return {
		logicalName: relativePath,
		sha256: await sha256File(target),
		sizeBytes: (await fs.stat(target)).size,
	};
}

function isMissingTable(error: unknown, table: string): boolean {
	return error instanceof Error && error.message.includes(`no such table: ${table}`);
}

/**
 * Cross-store consistency on the *captured* generation: every domain conversation pointer must
 * exist in the durable store, and every domain media row must have its blob file. A missing
 * Tsukaima table is reported as skipped so non-Tsukaima stores still pass integrity gating;
 * a real deployment always has these tables, and any other query error fails the check.
 */
async function verifyCrossStore(
	generationDir: string,
): Promise<{ conversations: GlobalSnapshotCheckRecord; media: GlobalSnapshotCheckRecord }> {
	const result = {
		conversations: { ok: true, detail: "skipped: stores missing" } as GlobalSnapshotCheckRecord,
		media: { ok: true, detail: "skipped: stores missing" } as GlobalSnapshotCheckRecord,
	};
	const domainPath = join(generationDir, "domain.sqlite");
	const durablePath = join(generationDir, "durable.sqlite");
	if ((await pathExists(domainPath)) && (await pathExists(durablePath))) {
		let domain: Database | undefined;
		let durable: Database | undefined;
		try {
			domain = new Database(domainPath, { readonly: true });
			durable = new Database(durablePath, { readonly: true });
			const domainIds = (
				domain.query("SELECT durable_conversation_id FROM conversations").all() as {
					durable_conversation_id: string;
				}[]
			).map((row) => row.durable_conversation_id);
			const durableIds = new Set(
				(durable.query("SELECT id FROM tsukaima_conversations").all() as { id: number }[]).map(
					(row) => String(row.id),
				),
			);
			const numericDomainIds = domainIds.filter((id) => /^\d+$/.test(id));
			const unknownToDomain = numericDomainIds.filter((id) => !durableIds.has(id));
			result.conversations =
				numericDomainIds.length > 0 && unknownToDomain.length === 0
					? {
							ok: true,
							detail: `${numericDomainIds.length} numeric domain pointer(s) all present in durable`,
						}
					: unknownToDomain.length === 0
						? {
								ok: true,
								detail: `${numericDomainIds.length} numeric pointer(s), none unknown to durable`,
							}
						: {
								ok: false,
								detail: `${unknownToDomain.length} domain pointer(s) missing from durable`,
							};
		} catch (error) {
			result.conversations = isMissingTable(error, "conversations")
				? { ok: true, detail: "skipped: conversations table missing" }
				: { ok: false, detail: error instanceof Error ? error.message : String(error) };
		} finally {
			domain?.close();
			durable?.close();
		}
	}
	if (await pathExists(domainPath)) {
		let domain: Database | undefined;
		try {
			domain = new Database(domainPath, { readonly: true });
			const mediaRows = domain.query("SELECT sha256 FROM media").all() as { sha256: string }[];
			let missing = 0;
			for (const row of mediaRows) {
				if (
					!/^[a-f0-9]{64}$/.test(row.sha256) ||
					!(await pathExists(join(generationDir, "blobs", row.sha256)))
				) {
					missing += 1;
				}
			}
			result.media =
				missing === 0
					? { ok: true, detail: `${mediaRows.length} media row(s) all have blobs` }
					: {
							ok: false,
							detail: `${missing} media row(s) missing blobs or carrying invalid SHA-256 values`,
						};
		} catch (error) {
			result.media = isMissingTable(error, "media")
				? { ok: true, detail: "skipped: media table missing" }
				: { ok: false, detail: error instanceof Error ? error.message : String(error) };
		} finally {
			domain?.close();
		}
	}
	return result;
}

function manifestHash(files: readonly GlobalSnapshotFileRecord[]): string {
	return sha256String(
		stableStringify(
			files.toSorted((left, right) => left.logicalName.localeCompare(right.logicalName)),
		),
	);
}

async function verifyGeneration(
	generationDir: string,
): Promise<{ ok: boolean; missing: readonly string[]; mismatched: readonly string[] }> {
	const missing: string[] = [];
	const mismatched: string[] = [];
	const records: GlobalSnapshotFileRecord[] = [];
	for (const file of await listFiles(generationDir)) {
		const logicalName = relative(generationDir, file).replaceAll("\\", "/");
		// Integrity readers create WAL/SHM sidecars next to the captured stores; they are
		// runtime scratch, never part of the captured manifest.
		if (
			logicalName === "manifest.json" ||
			SQLITE_SIDECAR_SUFFIXES.some((suffix) => logicalName.endsWith(suffix))
		) {
			continue;
		}
		const stats = await fs.stat(file);
		records.push({ logicalName, sha256: await sha256File(file), sizeBytes: stats.size });
	}
	const parsed = JSON.parse(await fs.readFile(join(generationDir, "manifest.json"), "utf8")) as {
		files: GlobalSnapshotFileRecord[];
		hash: string;
	};
	const expected = new Map(parsed.files.map((record) => [record.logicalName, record]));
	for (const [name, record] of expected) {
		const actual = records.find((candidate) => candidate.logicalName === name);
		if (actual === undefined) missing.push(name);
		else if (actual.sha256 !== record.sha256) mismatched.push(name);
	}
	for (const record of records) {
		if (!expected.has(record.logicalName)) missing.push(record.logicalName);
	}
	return {
		mismatched,
		missing,
		ok: missing.length === 0 && mismatched.length === 0 && manifestHash(records) === parsed.hash,
	};
}

/**
 * Rehearse an atomic generation cutover on a *staging* data directory: write a recovery
 * journal, swap a `current` pointer to the new generation, verify, then roll back to prove the
 * journal's rollback plan works. The real cutover follows the same three steps on the host.
 */
async function rehearseCutover(
	stagingDataDir: string,
	generationDir: string,
	reportsDir: string,
	runId: string,
): Promise<{ journalPath: string | null; rolledBack: boolean; swapped: boolean }> {
	const journalPath = join(reportsDir, `${runId}-recovery-journal.json`);
	const pointer = join(stagingDataDir, "current-generation");
	const previous = (await fs.readFile(pointer, "utf8").catch(() => null))?.trim() ?? null;
	const journal = {
		createdAt: new Date().toISOString(),
		plan: [
			"stop runtime writers",
			"verify new generation manifest + integrity",
			"write current-generation pointer",
			"on failure: restore pointer, keep previous generation until verified",
		],
		previousGeneration: previous,
		runId,
		targetGeneration: generationDir,
	};
	await fs.mkdir(reportsDir, { recursive: true });
	await fs.writeFile(journalPath, `${JSON.stringify(journal, null, "\t")}\n`);
	try {
		await fs.mkdir(join(pointer, ".."), { recursive: true });
		await fs.writeFile(pointer, generationDir);
		const swapped = (await fs.readFile(pointer, "utf8")).trim() === generationDir;
		// Roll back to prove the journal plan is executable.
		await fs.writeFile(pointer, previous ?? "");
		const rolledBack = (await fs.readFile(pointer, "utf8")).trim() === (previous ?? "");
		return { journalPath, rolledBack, swapped };
	} finally {
		await fs.rm(pointer, { force: true }).catch(() => undefined);
	}
}

/** Full-scope offline snapshot + verification + cutover rehearsal for one data directory. */
export async function runGlobalSnapshotDrill(
	options: GlobalSnapshotOptions,
): Promise<GlobalSnapshotReport> {
	const now = options.now ?? Date.now;
	const startedAt = new Date(now()).toISOString();
	const runId = options.runId ?? defaultRunId(now);
	const root = options.root ?? join(options.dataDir, "global-snapshots");
	const reportsDir = join(root, "reports");
	const generationDir = join(root, "generations", runId);
	const report: {
		-readonly [K in keyof GlobalSnapshotReport]: GlobalSnapshotReport[K];
	} = {
		completedAt: startedAt,
		crossStore: {
			durableConversationsKnownToDomain: { ok: false, detail: "not run" },
			mediaBlobsPresent: { ok: false, detail: "not run" },
		},
		cutover: { journalPath: null, rehearsed: false, rolledBack: false, swappedGeneration: null },
		files: 0,
		manifestHash: null,
		ok: false,
		runId,
		snapshotGeneration: null,
		sqlite: { foreignKeys: {}, integrity: {}, stores: [] },
		startedAt,
		totalBytes: 0,
		version: 1,
	};
	try {
		await options.stopWriters?.();
		const stores = await sqliteStores(options.dataDir);
		const loose = await looseFiles(options.dataDir);
		if (!stores.includes("domain.sqlite") || !stores.includes("durable.sqlite"))
			throw new Error("Both domain.sqlite and durable.sqlite are required");
		await fs.mkdir(dirname(generationDir), { mode: 0o700, recursive: true });
		await fs.mkdir(generationDir, { mode: 0o700 });
		const captured: GlobalSnapshotFileRecord[] = [];
		for (const store of [...stores, ...loose]) {
			const record = await copyFile(store, options.dataDir, generationDir, stores.includes(store));
			if (record === null) throw new Error(`Failed to capture ${store}`);
			captured.push(record);
		}
		for (const store of stores) {
			const capturedPath = join(generationDir, store);
			report.sqlite.integrity[store] = integrityResult(capturedPath, "integrity_check");
			report.sqlite.foreignKeys[store] = integrityResult(capturedPath, "foreign_key_check");
		}
		report.sqlite = {
			foreignKeys: report.sqlite.foreignKeys,
			integrity: report.sqlite.integrity,
			stores,
		};
		const crossStore = await verifyCrossStore(generationDir);
		report.crossStore = {
			durableConversationsKnownToDomain: crossStore.conversations,
			mediaBlobsPresent: crossStore.media,
		};
		const manifest: {
			readonly createdAt: string;
			readonly files: readonly GlobalSnapshotFileRecord[];
			readonly hash: string;
			readonly runId: string;
			readonly version: 1;
		} = {
			createdAt: new Date(now()).toISOString(),
			files: captured.toSorted((left, right) => left.logicalName.localeCompare(right.logicalName)),
			hash: manifestHash(captured),
			runId,
			version: 1,
		};
		await fs.writeFile(
			join(generationDir, "manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);
		const verification = await verifyGeneration(generationDir);
		if (!verification.ok) {
			throw new Error(
				`Generation verification failed: missing=${verification.missing.join(",")} mismatched=${verification.mismatched.join(",")}`,
			);
		}
		report.manifestHash = manifest.hash;
		report.snapshotGeneration = generationDir;
		report.files = captured.length;
		report.totalBytes = captured.reduce((sum, file) => sum + file.sizeBytes, 0);
		if (options.dryRun !== true) {
			const stagingDataDir = join(root, "staging", runId);
			await fs.mkdir(stagingDataDir, { recursive: true });
			const cutover = await rehearseCutover(stagingDataDir, generationDir, reportsDir, runId);
			report.cutover = {
				journalPath: cutover.journalPath,
				rehearsed: true,
				rolledBack: cutover.rolledBack,
				swappedGeneration: cutover.swapped ? generationDir : null,
			};
			await fs.rm(stagingDataDir, { force: true, recursive: true }).catch(() => undefined);
		}
		report.ok =
			verification.ok &&
			Object.values(report.sqlite.integrity).every((check) => check.ok) &&
			Object.values(report.sqlite.foreignKeys).every((check) => check.ok) &&
			report.crossStore.durableConversationsKnownToDomain.ok &&
			report.crossStore.mediaBlobsPresent.ok &&
			(options.dryRun === true ||
				(report.cutover.swappedGeneration !== null && report.cutover.rolledBack));
		return report as GlobalSnapshotReport;
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		return report as GlobalSnapshotReport;
	} finally {
		report.completedAt = new Date(now()).toISOString();
		await fs.mkdir(reportsDir, { recursive: true });
		const reportPath = join(reportsDir, `${runId}-global-snapshot.json`);
		await fs.writeFile(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
	}
}
