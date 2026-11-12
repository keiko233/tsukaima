#!/usr/bin/env bun
import {
	createPipeline,
	inspectDshSnapshot,
	type MigrationPlan,
	snapshotPaths,
} from "@tsukaima/migration";

interface CliOptions {
	readonly command: string;
	readonly dryRun: boolean;
	readonly help: boolean;
	readonly planFile?: string;
	readonly runId?: string;
	readonly source: readonly string[];
	readonly target?: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
	const positional: string[] = [];
	const source: string[] = [];
	let dryRun = false;
	let help = false;
	let planFile: string | undefined;
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
		else if (!argument.startsWith("--")) positional.push(argument);
		else throw new Error(`Unknown option: ${argument}`);
	}

	const command = help ? "help" : positional[0];
	if (!command) throw new Error("Usage: bun tools/migration/src/cli.ts <command> [options]");
	return {
		command,
		dryRun,
		help,
		...(planFile === undefined ? {} : { planFile }),
		...(runId === undefined ? {} : { runId }),
		source,
		...(target === undefined ? {} : { target }),
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
			commands: ["inspect", "normalize", "dry-run", "import", "verify", "rollback"],
			defaults: { dryRun: true },
			usage: "bun tools/migration/src/cli.ts <command> [options]",
		});
		return 0;
	}
	const source = snapshotPaths(options.source);
	if (options.command === "inspect") {
		writeJson(await inspectDshSnapshot(source));
		return 0;
	}
	if (options.command === "normalize" || options.command === "dry-run" || options.dryRun) {
		writeJson(await createPipeline(`sqlite:${options.target ?? ":memory:"}`).dryRun(source));
		return 0;
	}
	if (options.command === "import" && !options.dryRun) {
		if (!options.target) throw new Error("import requires --target");
		if (!options.planFile) throw new Error("import requires --plan");
		writeJson(
			await createPipeline(options.target).import(source, {
				dryRunPlan: await readPlan(options.planFile),
			}),
		);
		return 0;
	}
	if (options.command === "verify") {
		if (!options.target) throw new Error("verify requires --target");
		writeJson(await createPipeline(options.target).verify(source));
		return 0;
	}
	if (options.command === "rollback") {
		if (!options.target) throw new Error("rollback requires --target");
		if (!options.runId) throw new Error("rollback requires --run-id");
		writeJson(await createPipeline(options.target).rollback(options.runId));
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
