#!/usr/bin/env bun
import { runBackupDrill, type BackupDrillOptions } from "@tsukaima/migration";

interface CliOptions {
	readonly dataDir?: string;
	readonly runId?: string;
	readonly root?: string;
	readonly backupRoot?: string;
	readonly stagingRoot?: string;
	readonly reportsDir?: string;
	readonly mediaDir?: string;
	readonly keepStaging: boolean;
	readonly help: boolean;
}

const USAGE = `Usage: bun tools/ops/backup-drill.ts [options]

Runs a SQLite + blob backup/restore drill against a running-or-stopped data directory.

Options:
  --data-dir <dir>       Data directory containing domain.sqlite/durable.sqlite/blobs
  --run-id <id>          Stable run id (default: timestamp + random suffix)
  --root <dir>           Parent for backups/reports (default: <data-dir>/backup-drills)
  --backup-root <dir>    Override the backup directory
  --staging-root <dir>   Override the isolated restore staging parent
  --reports-dir <dir>    Override the report directory
  --media-dir <dir>      Override the blob/media directory
  --keep-staging         Keep the restored staging copy for inspection
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
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === undefined) continue;
		if (argument === "--help" || argument === "-h") help = true;
		else if (argument === "--keep-staging") keepStaging = true;
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
): BackupDrillOptions {
	const dataDir = options.dataDir ?? env.TSUKAIMA_DATA_DIR ?? "./data";
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
	const report = await runBackupDrill(drillOptionsFromEnv(process.env, options));
	process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
	return report.ok ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
