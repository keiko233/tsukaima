#!/usr/bin/env bun
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
	captureSnapshot,
	createPipeline,
	type DshBaselineTargetInput,
	extractDshBaseline,
	inspectDshSnapshot,
	type MigrationPlan,
	type PipelineOptions,
	resolveDshBaselineTarget,
	resolveSnapshotTarget,
	runRemoteSnapshot,
	snapshotPaths,
} from "@elaina/migration";
import { runRemoteDshBaseline } from "./remote-baseline.ts";

interface CliOptions {
	readonly backupDir?: string;
	readonly command: string;
	readonly container?: string;
	readonly dryRun: boolean;
	readonly durablePath?: string;
	readonly excludes: readonly string[];
	readonly help: boolean;
	readonly host?: string;
	readonly mediaDir?: string;
	readonly output?: string;
	readonly planFile?: string;
	readonly project?: string;
	readonly runId?: string;
	readonly source: readonly string[];
	readonly target?: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
	const positional: string[] = [];
	const source: string[] = [];
	const excludes: string[] = [];
	let backupDir: string | undefined;
	let container: string | undefined;
	let dryRun = false;
	let durablePath: string | undefined;
	let help = false;
	let host: string | undefined;
	let mediaDir: string | undefined;
	let output: string | undefined;
	let planFile: string | undefined;
	let project: string | undefined;
	let runId: string | undefined;
	let target: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument) continue;
		if (argument === "--dry-run") dryRun = true;
		else if (argument === "--help" || argument === "-h") help = true;
		else if (argument === "--source") source.push(argv[++index] ?? "");
		else if (argument === "--target") target = argv[++index];
		else if (argument === "--plan") planFile = argv[++index];
		else if (argument === "--run-id") runId = argv[++index];
		else if (argument === "--host") host = argv[++index];
		else if (argument === "--project") project = argv[++index];
		else if (argument === "--container") container = argv[++index];
		else if (argument === "--output") output = argv[++index];
		else if (argument === "--exclude") excludes.push(argv[++index] ?? "");
		else if (argument === "--backup-dir") backupDir = argv[++index];
		else if (argument === "--durable") durablePath = argv[++index];
		else if (argument === "--media-dir") mediaDir = argv[++index];
		else if (!argument.startsWith("--")) positional.push(argument);
		else throw new Error(`Unknown option: ${argument}`);
	}

	const command = help ? "help" : positional[0];
	if (!command) throw new Error("Usage: bun tools/migration/src/cli.ts <command> [options]");
	return {
		...(backupDir === undefined ? {} : { backupDir }),
		command,
		...(container === undefined ? {} : { container }),
		dryRun,
		...(durablePath === undefined ? {} : { durablePath }),
		excludes,
		help,
		...(host === undefined ? {} : { host }),
		...(mediaDir === undefined ? {} : { mediaDir }),
		...(output === undefined ? {} : { output }),
		...(planFile === undefined ? {} : { planFile }),
		...(project === undefined ? {} : { project }),
		...(runId === undefined ? {} : { runId }),
		source,
		...(target === undefined ? {} : { target }),
	};
}

function auditTargetInput(options: CliOptions): DshBaselineTargetInput {
	return {
		...(options.host === undefined ? {} : { host: options.host }),
		...(options.project === undefined ? {} : { project: options.project }),
		...(options.container === undefined ? {} : { container: options.container }),
	};
}

function pipelineOptions(options: CliOptions): PipelineOptions {
	return {
		...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
		...(options.durablePath === undefined ? {} : { durablePath: options.durablePath }),
		...(options.mediaDir === undefined ? {} : { mediaDir: options.mediaDir }),
	};
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`);
}

async function readPlan(path: string): Promise<MigrationPlan> {
	return JSON.parse(await Bun.file(path).text()) as MigrationPlan;
}

async function main(): Promise<number> {
	const options = parseOptions(process.argv.slice(2));
	if (options.help) {
		writeJson({
			commands: [
				"snapshot",
				"inspect",
				"normalize",
				"dry-run",
				"import",
				"verify",
				"rollback",
				"baseline",
			],
			defaults: { dryRun: true },
			usage: "bun tools/migration/src/cli.ts <command> [options]",
		});
		return 0;
	}
	const source = snapshotPaths(options.source);
	if (options.command === "baseline") {
		const targetInput = auditTargetInput(options);
		const target = resolveDshBaselineTarget(targetInput);
		if (source.length > 0) {
			writeJson(await extractDshBaseline(source, { target: targetInput }));
			return 0;
		}
		if (!target.host) {
			throw new Error("baseline requires --source <dir...> or --host/DSH_AUDIT_HOST");
		}
		if (!target.project || !target.container) {
			throw new Error(
				"baseline --host requires --project/DSH_AUDIT_PROJECT and --container/DSH_AUDIT_CONTAINER",
			);
		}
		writeJson(
			await runRemoteDshBaseline({
				container: target.container,
				host: target.host,
				project: target.project,
			}),
		);
		return 0;
	}
	if (options.command === "snapshot") {
		if (!options.output) throw new Error("snapshot requires --output <dir>");
		const target = resolveSnapshotTarget(auditTargetInput(options));
		if (options.source.length > 0) {
			writeJson(
				await captureSnapshot({
					dryRun: options.dryRun,
					excludes: options.excludes,
					output: options.output,
					sources: source,
					target: auditTargetInput(options),
				}),
			);
			return 0;
		}
		if (!target.host || !target.project) {
			throw new Error(
				"snapshot requires --source <dir...> or --host/--project (or DSH_SNAPSHOT_* / DSH_AUDIT_* env)",
			);
		}
		if (options.dryRun) {
			writeJson(
				await captureSnapshot({
					dryRun: true,
					excludes: options.excludes,
					output: options.output,
					sources: [],
					target: auditTargetInput(options),
				}),
			);
			return 0;
		}
		writeJson(
			await runRemoteSnapshot(
				{ container: target.container, host: target.host, project: target.project },
				{
					dryRun: false,
					excludes: options.excludes,
					output: options.output,
				},
			),
		);
		return 0;
	}
	if (options.command === "inspect") {
		writeJson(await inspectDshSnapshot(source));
		return 0;
	}
	if (options.command === "normalize" || options.command === "dry-run" || options.dryRun) {
		const plan = await createPipeline(
			`sqlite:${options.target ?? ":memory:"}`,
			pipelineOptions(options),
		).dryRun(source);
		if (options.planFile) {
			await fs.mkdir(dirname(options.planFile), { recursive: true });
			await fs.writeFile(options.planFile, `${JSON.stringify(plan, null, "\t")}\n`);
		}
		writeJson(plan);
		return 0;
	}
	if (options.command === "import" && !options.dryRun) {
		if (!options.target) throw new Error("import requires --target");
		if (!options.planFile) throw new Error("import requires --plan");
		writeJson(
			await createPipeline(options.target, pipelineOptions(options)).import(source, {
				dryRunPlan: await readPlan(options.planFile),
			}),
		);
		return 0;
	}
	if (options.command === "verify") {
		if (!options.target) throw new Error("verify requires --target");
		writeJson(await createPipeline(options.target, pipelineOptions(options)).verify(source));
		return 0;
	}
	if (options.command === "rollback") {
		if (!options.target) throw new Error("rollback requires --target");
		if (!options.runId) throw new Error("rollback requires --run-id");
		writeJson(
			await createPipeline(options.target, pipelineOptions(options)).rollback(options.runId),
		);
		return 0;
	}
	throw new Error(`Unknown command: ${options.command}`);
}

try {
	process.exit(await main());
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
