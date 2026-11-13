import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { listFiles, sha256File, sha256String, stableStringify } from "./fs.ts";

export interface BackupFileRecord {
	readonly logicalName: string;
	readonly targetPath: string;
	readonly backupPath: string | null;
	readonly present: boolean;
	readonly sizeBytes: number;
	readonly sha256: string | null;
}

export interface BackupManifest {
	readonly version: 1;
	readonly runId: string;
	readonly createdAt: string;
	readonly databasePath: string;
	readonly durablePath: string | null;
	readonly mediaDir: string | null;
	readonly files: readonly BackupFileRecord[];
	readonly hash: string;
}

export interface CreateBackupOptions {
	readonly databasePath: string;
	readonly runId: string;
	readonly backupRoot: string;
	readonly durablePath?: string;
	readonly mediaDir?: string;
	readonly now?: () => number;
}

export interface VerifyBackupResult {
	readonly ok: boolean;
	readonly expectedHash: string;
	readonly actualHash: string;
	readonly mismatched: readonly string[];
	readonly missing: readonly string[];
}

export interface RestoreBackupOptions {
	readonly backupDir: string;
	/** Optional runtime hook; the host process must be stopped before restore. */
	readonly stopRuntime?: () => Promise<void> | void;
	/** Optional report/audit directory preserved outside the restored data. */
	readonly reportsDir?: string;
}

export interface RestoreBackupResult {
	readonly backupDir: string;
	readonly backupHash: string;
	readonly restoredFiles: readonly string[];
	readonly removedPaths: readonly string[];
	readonly auditPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function checkpoint(path: string): void {
	if (!Bun.file(path).size) return;
	let database: Database | undefined;
	try {
		database = new Database(path);
		database.run("PRAGMA wal_checkpoint(FULL)");
	} catch {
		// A missing or non-SQLite target is backed up as an absent path.
	} finally {
		database?.close();
	}
}

async function pathStat(path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
	return await fs.stat(path).catch(() => null);
}

async function copyDatabase(source: string, destination: string): Promise<BackupFileRecord | null> {
	const stats = await pathStat(source);
	if (stats === null) {
		return {
			backupPath: null,
			logicalName: basename(source),
			present: false,
			sha256: null,
			sizeBytes: 0,
			targetPath: source,
		};
	}
	checkpoint(source);
	await fs.mkdir(dirname(destination), { recursive: true });
	await fs.copyFile(source, destination);
	const copied = await fs.stat(destination);
	return {
		backupPath: destination,
		logicalName: basename(source),
		present: true,
		sha256: await sha256File(destination),
		sizeBytes: copied.size,
		targetPath: source,
	};
}

async function copyMedia(source: string, destination: string): Promise<BackupFileRecord[]> {
	const stats = await pathStat(source);
	if (stats === null) {
		return [
			{
				backupPath: null,
				logicalName: "media",
				present: false,
				sha256: null,
				sizeBytes: 0,
				targetPath: source,
			},
		];
	}
	const records: BackupFileRecord[] = [];
	for (const file of await listFiles(source)) {
		const relativePath = relative(source, file).replaceAll("\\", "/");
		const backupPath = join(destination, relativePath);
		await fs.mkdir(dirname(backupPath), { recursive: true });
		await fs.copyFile(file, backupPath);
		const copied = await fs.stat(backupPath);
		records.push({
			backupPath,
			logicalName: `media/${relativePath}`,
			present: true,
			sha256: await sha256File(backupPath),
			sizeBytes: copied.size,
			targetPath: join(source, relativePath),
		});
	}
	return records;
}

function manifestHash(files: readonly BackupFileRecord[]): string {
	return sha256String(
		stableStringify(
			files
				.map((file) => ({
					logicalName: file.logicalName,
					present: file.present,
					sha256: file.sha256,
					sizeBytes: file.sizeBytes,
				}))
				.toSorted((left, right) => left.logicalName.localeCompare(right.logicalName)),
		),
	);
}

export function backupRunDirectory(backupRoot: string, runId: string): string {
	return join(backupRoot, runId);
}

export async function createPreImportBackup(options: CreateBackupOptions): Promise<BackupManifest> {
	const now = options.now ?? Date.now;
	const directory = backupRunDirectory(options.backupRoot, options.runId);
	await fs.mkdir(directory, { recursive: true });
	const files: BackupFileRecord[] = [];
	const domain = await copyDatabase(options.databasePath, join(directory, "domain.sqlite"));
	if (domain !== null) files.push(domain);
	const durablePath =
		options.durablePath ??
		((await pathStat(join(dirname(options.databasePath), "durable.sqlite"))) === null
			? null
			: join(dirname(options.databasePath), "durable.sqlite"));
	if (durablePath !== null) {
		const durable = await copyDatabase(durablePath, join(directory, "durable.sqlite"));
		if (durable !== null) files.push(durable);
	}
	const mediaDir = options.mediaDir ?? join(dirname(options.databasePath), "media");
	if ((await pathStat(mediaDir))?.isDirectory()) {
		files.push(...(await copyMedia(mediaDir, join(directory, "media"))));
	} else {
		files.push({
			backupPath: null,
			logicalName: "media",
			present: false,
			sha256: null,
			sizeBytes: 0,
			targetPath: mediaDir,
		});
	}
	const manifest: BackupManifest = {
		createdAt: new Date(now()).toISOString(),
		databasePath: options.databasePath,
		durablePath,
		files,
		hash: manifestHash(files),
		mediaDir: mediaDir,
		runId: options.runId,
		version: 1,
	};
	await fs.writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	return manifest;
}

export async function readBackupManifest(backupDir: string): Promise<BackupManifest> {
	const parsed = JSON.parse(await fs.readFile(join(backupDir, "manifest.json"), "utf8")) as unknown;
	if (!isRecord(parsed) || !Array.isArray(parsed.files)) {
		throw new Error(`Invalid pre-import backup manifest: ${backupDir}`);
	}
	return parsed as unknown as BackupManifest;
}

export async function verifyPreImportBackup(backupDir: string): Promise<VerifyBackupResult> {
	const manifest = await readBackupManifest(backupDir);
	const mismatched: string[] = [];
	const missing: string[] = [];
	for (const file of manifest.files) {
		if (!file.present) continue;
		if (file.backupPath === null) {
			missing.push(file.logicalName);
			continue;
		}
		const stats = await pathStat(file.backupPath);
		if (stats === null) {
			missing.push(file.logicalName);
			continue;
		}
		const hash = await sha256File(file.backupPath);
		if (hash !== file.sha256) mismatched.push(file.logicalName);
	}
	const actualHash = manifestHash(
		await Promise.all(
			manifest.files.map(async (file) => {
				if (!file.present || file.backupPath === null) return file;
				const hash = await sha256File(file.backupPath).catch(() => null);
				return { ...file, sha256: hash };
			}),
		),
	);
	return {
		actualHash,
		expectedHash: manifest.hash,
		mismatched,
		missing,
		ok: mismatched.length === 0 && missing.length === 0 && actualHash === manifest.hash,
	};
}

async function removePath(path: string): Promise<boolean> {
	const stats = await pathStat(path);
	if (stats === null) return false;
	await fs.rm(path, { force: true, recursive: true });
	return true;
}

async function removeSqliteSidecars(path: string): Promise<void> {
	await Promise.all(
		["-wal", "-shm"].map(async (suffix) => {
			await fs.rm(`${path}${suffix}`, { force: true }).catch(() => undefined);
		}),
	);
}

export async function restorePreImportBackup(
	options: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
	const manifest = await readBackupManifest(options.backupDir);
	const verification = await verifyPreImportBackup(options.backupDir);
	if (!verification.ok) {
		throw new Error(
			`Pre-import backup hash verification failed: ${[
				...verification.missing,
				...verification.mismatched,
			].join(", ")}`,
		);
	}
	await options.stopRuntime?.();
	const restoredFiles: string[] = [];
	const removedPaths: string[] = [];
	const mediaDirectory =
		manifest.mediaDir ??
		(manifest.files.some((file) => file.logicalName.startsWith("media/"))
			? null
			: (manifest.files.find((file) => file.logicalName === "media")?.targetPath ?? null));

	// Remove the current media store first so restore is authoritative rather than additive.
	if (mediaDirectory !== null) {
		if (await removePath(mediaDirectory)) removedPaths.push(mediaDirectory);
	}

	for (const file of manifest.files) {
		if (file.logicalName === "media" || file.logicalName.startsWith("media/")) {
			continue;
		}
		if (!file.present || file.backupPath === null) {
			await removeSqliteSidecars(file.targetPath);
			if (await removePath(file.targetPath)) removedPaths.push(file.targetPath);
			continue;
		}
		await fs.mkdir(dirname(file.targetPath), { recursive: true });
		await fs.copyFile(file.backupPath, file.targetPath);
		await removeSqliteSidecars(file.targetPath);
		restoredFiles.push(file.targetPath);
	}
	for (const file of manifest.files) {
		if (!file.logicalName.startsWith("media/") || file.backupPath === null) continue;
		await fs.mkdir(dirname(file.targetPath), { recursive: true });
		await fs.copyFile(file.backupPath, file.targetPath);
		restoredFiles.push(file.targetPath);
	}
	const auditPath = join(options.backupDir, "rollback.json");
	await fs.writeFile(
		auditPath,
		`${JSON.stringify(
			{
				backupHash: verification.actualHash,
				completedAt: new Date().toISOString(),
				removedPaths,
				restoredFiles,
				runId: manifest.runId,
			},
			null,
			"\t",
		)}\n`,
	);
	return {
		auditPath,
		backupDir: options.backupDir,
		backupHash: verification.actualHash,
		removedPaths,
		restoredFiles,
	};
}

export async function writeRollbackReport(input: {
	readonly reportsDir: string;
	readonly runId: string;
	readonly payload: unknown;
}): Promise<string> {
	await fs.mkdir(input.reportsDir, { recursive: true });
	const path = join(input.reportsDir, `${input.runId}-rollback.json`);
	await fs.writeFile(path, `${JSON.stringify(input.payload, null, "\t")}\n`);
	return path;
}
