#!/usr/bin/env bun
import {
	runBackupDrill,
	runGlobalSnapshotDrill,
	type BackupDrillOptions,
	type GlobalSnapshotOptions,
} from "@tsukaima/migration";

interface CliOptions {
	readonly dataDir?: string;
	readonly runId?: string;
	readonly root?: string;
	readonly backupRoot?: string;
	readonly stagingRoot?: string;
	readonly reportsDir?: string;
	readonly mediaDir?: string;
	readonly keepStaging: boolean;
	/** Run the aggregate global-snapshot drill (all stores + blobs + cutover rehearsal). */
	readonly global: boolean;
	readonly dryRun: boolean;
	readonly help: boolean;
}

const USAGE = `Usage: bun tools/ops/backup-drill.ts [options]

Runs a backup/restore drill against a running-or-stopped data directory.

Default: SQLite (domain/durable) + blob backup/restore drill.

Options:
  --data-dir <dir>       Data directory containing domain.sqlite/durable.sqlite/blobs
  --run-id <id>          Stable run id (default: timestamp + random suffix)
  --root <dir>           Parent for backups/reports (default: <data-dir>/backup-drills)
  --backup-root <dir>    Override the backup directory
  --staging-root <dir>   Override the isolated restore staging parent
  --reports-dir <dir>    Override the report directory
  --media-dir <dir>      Override the blob/media directory
  --keep-staging         Keep the restored staging copy for inspection
  --global               Full-scope aggregate drill: every SQLite store (domain, durable,
                         plugins), all referenced blobs, integrity + foreign keys, cross-store
                         consistency, and an atomic generation cutover rehearsal
  --dry-run              With --global: verify only, skip the cutover rehearsal
  --help                 Show this help
`;

export function parseBackupDrillArgs(argv: readonly string[]): CliOptions {
	let dataDir: string | undefined;
	let runId: string | undefined;
	let root: string | undefined;
	let backupRoot: string | undefined;
	let stagingRoot: string | undefined;
	let reportsDir: string | undefined;
	let mediaDir: string | undefined;
	let keepStaging = false;
	let global = false;
	let dryRun = false;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) continue;
		if (argument === "--help" || argument === "-h") help = true;
		else if (argument === "--keep-staging") keepStaging = true;
		else if (argument === "--global") global = true;
		else if (argument === "--dry-run") dryRun = true;
		else if (argument === "--data-dir") dataDir = argv[++index];
		else if (argument === "--run-id") runId = argv[++index];
		else if (argument === "--root") root = argv[++index];
		else if (argument === "--backup-root") backupRoot = argv[++index];
		else if (argument === "--staging-root") stagingRoot = argv[++index];
		else if (argument === "--reports-dir") reportsDir = argv[++index];
		else if (argument === "--media-dir") mediaDir = argv[++index];
		else throw new Error(`Unknown option: ${argument}`);
	}
	return {
		...(backupRoot === undefined ? {} : { backupRoot }),
		...(dataDir === undefined ? {} : { dataDir }),
		dryRun,
		global,
		help,
		keepStaging,
		...(mediaDir === undefined ? {} : { mediaDir }),
		...(reportsDir === undefined ? {} : { reportsDir }),
		...(root === undefined ? {} : { root }),
		...(runId === undefined ? {} : { runId }),
		...(stagingRoot === undefined ? {} : { stagingRoot }),
	};
}

export function drillOptionsFromEnv(
	env: Record<string, string | undefined>,
	options: CliOptions,
): BackupDrillOptions | GlobalSnapshotOptions {
	const dataDir = options.dataDir ?? env.TSUKAIMA_DATA_DIR ?? "./data";
	if (options.global) {
		const globalOptions: GlobalSnapshotOptions = {
			dataDir,
			dryRun: options.dryRun,
			keepStaging: options.keepStaging,
			...(options.root === undefined ? {} : { root: options.root }),
			...(options.runId === undefined ? {} : { runId: options.runId }),
		};
		return globalOptions;
	}
	return {
		dataDir,
		...(options.backupRoot === undefined ? {} : { backupRoot: options.backupRoot }),
		...(options.keepStaging ? { keepStaging: true } : {}),
		...(options.mediaDir === undefined ? {} : { mediaDir: options.mediaDir }),
		...(options.reportsDir === undefined ? {} : { reportsDir: options.reportsDir }),
		...(options.root === undefined ? {} : { root: options.root }),
		...(options.runId === undefined ? {} : { runId: options.runId }),
		...(options.stagingRoot === undefined ? {} : { stagingRoot: options.stagingRoot }),
	};
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const options = parseBackupDrillArgs(argv);
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	const drillOptions = drillOptionsFromEnv(process.env, options);
	const report =
		"sqlite" in drillOptions
			? await runGlobalSnapshotDrill(drillOptions as GlobalSnapshotOptions)
			: await runBackupDrill(drillOptions as BackupDrillOptions);
	process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
	return report.ok ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
