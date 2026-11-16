import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createPreImportBackup, verifyPreImportBackup, type BackupManifest } from "./backup.ts";
import { listFiles, sha256File, sha256String, stableStringify } from "./fs.ts";

export interface BackupDrillOptions {
	readonly dataDir: string;
	readonly runId?: string;
	/** Parent directory for backups and reports; defaults to `<dataDir>/backup-drills`. */
	readonly root?: string;
	readonly backupRoot?: string;
	readonly stagingRoot?: string;
	readonly reportsDir?: string;
	/** Blob/media directory; defaults to `<dataDir>/blobs`, then `<dataDir>/media`. */
	readonly mediaDir?: string;
	readonly keepStaging?: boolean;
	readonly now?: () => number;
}

export interface BackupDrillIntegrityCheck {
	readonly ok: boolean;
	readonly result: string;
}

export interface BackupDrillReport {
	version: 1;
	runId: string;
	startedAt: string;
	completedAt: string;
	ok: boolean;
	error?: string;
	backup: {
		fileCount: number;
		totalBytes: number;
		databaseFiles: readonly string[];
		manifestHash: string | null;
	};
	manifest: {
		ok: boolean;
		missing: readonly string[];
		mismatched: readonly string[];
	};
	restore: {
		restoredFiles: readonly string[];
		blobFileCount: number;
		blobTotalBytes: number;
	};
	integrity: {
		domain: BackupDrillIntegrityCheck | null;
		durable: BackupDrillIntegrityCheck | null;
	};
	blobs: {
		mediaPresent: boolean;
		expectedFileCount: number;
		actualFileCount: number;
		missing: readonly string[];
		mismatched: readonly string[];
		unexpected: readonly string[];
		expectedHash: string | null;
		actualHash: string | null;
		ok: boolean;
	};
	reportPath: string;
}

interface BlobRecord {
	readonly logicalName: string;
	readonly sha256: string;
	readonly sizeBytes: number;
}

function defaultRunId(now: () => number): string {
	const stamp = new Date(now()).toISOString().replaceAll(/[:.]/gu, "-");
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

async function pathExists(path: string): Promise<boolean> {
	return (await fs.stat(path).catch(() => null)) !== null;
}

async function resolveMediaDir(options: BackupDrillOptions): Promise<string> {
	if (options.mediaDir !== undefined) return options.mediaDir;
	const blobs = join(options.dataDir, "blobs");
	if (await pathExists(blobs)) return blobs;
	return join(options.dataDir, "media");
}

function expectedBlobs(manifest: BackupManifest): BlobRecord[] {
	return manifest.files
		.filter(
			(file): file is typeof file & { backupPath: string; sha256: string } =>
				file.logicalName.startsWith("media/") &&
				file.present &&
				file.backupPath !== null &&
				file.sha256 !== null,
		)
		.map((file) => ({
			logicalName: file.logicalName,
			sha256: file.sha256,
			sizeBytes: file.sizeBytes,
		}))
		.toSorted((left, right) => left.logicalName.localeCompare(right.logicalName));
}

function blobHash(records: readonly BlobRecord[]): string {
	return sha256String(
		stableStringify(
			records
				.map((record) => ({
					logicalName: record.logicalName,
					sha256: record.sha256,
					sizeBytes: record.sizeBytes,
				}))
				.toSorted((left, right) => left.logicalName.localeCompare(right.logicalName)),
		),
	);
}

function integrity(path: string): BackupDrillIntegrityCheck {
	let database: Database | undefined;
	try {
		database = new Database(path, { readonly: true });
		const rows = database.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
		const values = rows.flatMap((row) => Object.values(row)).map((value) => String(value));
		const result = values.join("; ") || "no result";
		return { ok: values.length === 1 && values[0] === "ok", result };
	} catch (error) {
		return { ok: false, result: error instanceof Error ? error.message : String(error) };
	} finally {
		database?.close();
	}
}

async function restoreIntoStaging(
	manifest: BackupManifest,
	stagingDir: string,
): Promise<{ restoredFiles: string[]; blobFileCount: number; blobTotalBytes: number }> {
	await fs.rm(stagingDir, { force: true, recursive: true });
	await fs.mkdir(stagingDir, { recursive: true });
	const restoredFiles: string[] = [];
	let blobFileCount = 0;
	let blobTotalBytes = 0;
	for (const file of manifest.files) {
		if (!file.present || file.backupPath === null) continue;
		if (file.logicalName.startsWith("media/")) {
			const relativePath = file.logicalName.slice("media/".length);
			const target = join(stagingDir, "media", relativePath);
			await fs.mkdir(join(target, ".."), { recursive: true });
			await fs.copyFile(file.backupPath, target);
			restoredFiles.push(`media/${relativePath}`);
			blobFileCount += 1;
			blobTotalBytes += (await fs.stat(target)).size;
			continue;
		}
		const target = join(stagingDir, basename(file.logicalName));
		await fs.copyFile(file.backupPath, target);
		restoredFiles.push(basename(file.logicalName));
	}
	return { blobFileCount, blobTotalBytes, restoredFiles };
}

async function actualBlobs(
	stagingDir: string,
): Promise<{ records: BlobRecord[]; totalBytes: number }> {
	const mediaDir = join(stagingDir, "media");
	if (!(await pathExists(mediaDir))) return { records: [], totalBytes: 0 };
	const records: BlobRecord[] = [];
	let totalBytes = 0;
	for (const file of await listFiles(mediaDir)) {
		const relativePath = relative(mediaDir, file).replaceAll("\\", "/");
		const stats = await fs.stat(file);
		records.push({
			logicalName: `media/${relativePath}`,
			sha256: await sha256File(file),
			sizeBytes: stats.size,
		});
		totalBytes += stats.size;
	}
	return {
		records: records.toSorted((a, b) => a.logicalName.localeCompare(b.logicalName)),
		totalBytes,
	};
}

function emptyReport(input: {
	readonly runId: string;
	readonly startedAt: string;
	readonly now: () => number;
	readonly reportPath: string;
}): BackupDrillReport {
	return {
		backup: { databaseFiles: [], fileCount: 0, manifestHash: null, totalBytes: 0 },
		blobs: {
			actualFileCount: 0,
			actualHash: null,
			expectedFileCount: 0,
			expectedHash: null,
			mediaPresent: false,
			mismatched: [],
			missing: [],
			ok: false,
			unexpected: [],
		},
		completedAt: new Date(input.now()).toISOString(),
		integrity: { domain: null, durable: null },
		manifest: { mismatched: [], missing: [], ok: false },
		ok: false,
		reportPath: input.reportPath,
		restore: { blobFileCount: 0, blobTotalBytes: 0, restoredFiles: [] },
		runId: input.runId,
		startedAt: input.startedAt,
		version: 1,
	};
}

async function writeReport(report: BackupDrillReport): Promise<void> {
	await fs.mkdir(join(report.reportPath, ".."), { recursive: true });
	await fs.writeFile(report.reportPath, `${JSON.stringify(report, null, "\t")}\n`);
}

/**
 * Runs a full SQLite + blob backup/restore drill. The report deliberately contains only logical
 * names, counts, hashes, and integrity results; it never copies environment values, file contents,
 * or connection credentials.
 */
export async function runBackupDrill(options: BackupDrillOptions): Promise<BackupDrillReport> {
	const now = options.now ?? Date.now;
	const startedAt = new Date(now()).toISOString();
	const runId = options.runId ?? defaultRunId(now);
	const root = options.root ?? join(options.dataDir, "backup-drills");
	const backupRoot = options.backupRoot ?? join(root, "backups");
	const reportsDir = options.reportsDir ?? join(root, "reports");
	const reportPath = join(reportsDir, `${runId}-drill.json`);
	const report = emptyReport({ now, reportPath, runId, startedAt });
	const stagingBase =
		options.stagingRoot ?? (await fs.mkdtemp(join(tmpdir(), "tsukaima-backup-drill-")));
	const stagingDir = join(stagingBase, runId);
	let keepStaging = options.keepStaging ?? false;
	try {
		const mediaDir = await resolveMediaDir(options);
		const manifest = await createPreImportBackup({
			backupRoot,
			databasePath: join(options.dataDir, "domain.sqlite"),
			durablePath: join(options.dataDir, "durable.sqlite"),
			mediaDir,
			now,
			runId,
		});
		const verification = await verifyPreImportBackup(join(backupRoot, runId));
		const restored = await restoreIntoStaging(manifest, stagingDir);
		const actual = await actualBlobs(stagingDir);
		const expected = expectedBlobs(manifest);
		const expectedByPath = new Map(expected.map((record) => [record.logicalName, record]));
		const actualByPath = new Map(actual.records.map((record) => [record.logicalName, record]));
		const missing = expected
			.filter((record) => !actualByPath.has(record.logicalName))
			.map((record) => record.logicalName);
		const unexpected = actual.records
			.filter((record) => !expectedByPath.has(record.logicalName))
			.map((record) => record.logicalName);
		const mismatched = expected
			.filter((record) => {
				const found = actualByPath.get(record.logicalName);
				return found !== undefined && found.sha256 !== record.sha256;
			})
			.map((record) => record.logicalName);
		const expectedHash = blobHash(expected);
		const actualHash = blobHash(actual.records);
		const mediaRecord = manifest.files.find((file) => file.logicalName === "media");
		const mediaPresent = mediaRecord?.present !== false;
		const domains = manifest.files
			.filter(
				(file) => file.logicalName === "domain.sqlite" || file.logicalName === "durable.sqlite",
			)
			.map((file) => file.logicalName);
		const totalBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
		report.backup.databaseFiles = domains;
		report.backup.fileCount = manifest.files.filter((file) => file.present).length;
		report.backup.manifestHash = verification.expectedHash;
		report.backup.totalBytes = totalBytes;
		report.manifest = {
			mismatched: verification.mismatched,
			missing: verification.missing,
			ok: verification.ok,
		};
		report.restore = restored;
		report.integrity = {
			domain: (await pathExists(join(stagingDir, "domain.sqlite")))
				? integrity(join(stagingDir, "domain.sqlite"))
				: null,
			durable: (await pathExists(join(stagingDir, "durable.sqlite")))
				? integrity(join(stagingDir, "durable.sqlite"))
				: null,
		};
		report.blobs = {
			actualFileCount: actual.records.length,
			actualHash,
			expectedFileCount: expected.length,
			expectedHash,
			mediaPresent,
			mismatched,
			missing,
			ok:
				mediaPresent &&
				missing.length === 0 &&
				mismatched.length === 0 &&
				unexpected.length === 0 &&
				expectedHash === actualHash,
			unexpected,
		};
		report.ok =
			verification.ok &&
			report.integrity.domain?.ok === true &&
			report.integrity.durable?.ok === true &&
			domains.includes("domain.sqlite") &&
			domains.includes("durable.sqlite") &&
			report.blobs.ok;
		return report;
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		return report;
	} finally {
		report.completedAt = new Date(now()).toISOString();
		await writeReport(report);
		if (!keepStaging) {
			await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => undefined);
			if (options.stagingRoot === undefined) {
				await fs.rm(stagingBase, { force: true, recursive: true }).catch(() => undefined);
			}
		}
	}
}
