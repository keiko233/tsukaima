import type { CodingRunner, CommandResult } from "./runner.ts";

export interface TestRunResult {
	readonly exitCode: number | null;
	readonly failed: number;
	readonly passed: boolean;
	readonly stderr: string;
	readonly stdout: string;
	readonly total: number;
}

export interface BuildResult {
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly stdout: string;
	readonly success: boolean;
}

export interface DiffFileEntry {
	readonly deletions: number;
	readonly insertions: number;
	readonly path: string;
	readonly status: "added" | "deleted" | "modified" | "renamed";
}

export interface DiffResult {
	readonly files: readonly DiffFileEntry[];
	readonly raw: string;
	readonly totalDeletions: number;
	readonly totalInsertions: number;
}

export class CodingTools {
	readonly #runner: CodingRunner;

	constructor(runner: CodingRunner) {
		this.#runner = runner;
	}

	async build(): Promise<BuildResult> {
		const result = await this.#runner.exec("bun", ["run", "build"]);
		return {
			exitCode: result.exitCode,
			stderr: result.stderr,
			stdout: result.stdout,
			success: result.exitCode === 0,
		};
	}

	async diff(): Promise<DiffResult> {
		await this.#runner.exec("git", ["add", "--intent-to-add", "."]);
		const [numstatResult, nameStatusResult, rawResult] = await Promise.all([
			this.#runner.exec("git", ["diff", "HEAD", "--numstat"]),
			this.#runner.exec("git", ["diff", "HEAD", "--name-status"]),
			this.#runner.exec("git", ["diff", "HEAD", "--no-color"]),
		]);
		return parseDiffOutput(numstatResult.stdout, nameStatusResult.stdout, rawResult.stdout);
	}

	async runTests(pattern?: string): Promise<TestRunResult> {
		const args = pattern !== undefined ? ["test", pattern] : ["test"];
		const result = await this.#runner.exec("bun", args);
		return parseTestOutput(result);
	}
}

export function parseDiffOutput(
	numstatOutput: string,
	nameStatusOutput: string,
	rawOutput: string,
): DiffResult {
	const statusMap = new Map<string, DiffFileEntry["status"]>();
	for (const line of nameStatusOutput.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const parts = trimmed.split("\t");
		const statusCode = parts[0];
		if (statusCode === undefined) {
			continue;
		}
		if (statusCode.startsWith("R")) {
			const newPath = parts[2];
			if (newPath !== undefined) {
				statusMap.set(newPath, "renamed");
			}
		} else {
			const path = parts[1];
			if (path === undefined) {
				continue;
			}
			if (statusCode === "A") {
				statusMap.set(path, "added");
			} else if (statusCode === "D") {
				statusMap.set(path, "deleted");
			} else {
				statusMap.set(path, "modified");
			}
		}
	}

	const files: DiffFileEntry[] = [];
	let totalInsertions = 0;
	let totalDeletions = 0;
	for (const line of numstatOutput.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const parts = trimmed.split("\t");
		const insertionsStr = parts[0];
		const deletionsStr = parts[1];
		const path = parts[2];
		if (insertionsStr === undefined || deletionsStr === undefined || path === undefined) {
			continue;
		}
		const insertions = insertionsStr === "-" ? -1 : Number.parseInt(insertionsStr, 10);
		const deletions = deletionsStr === "-" ? -1 : Number.parseInt(deletionsStr, 10);
		const status = statusMap.get(path) ?? "modified";
		files.push({ deletions, insertions, path, status });
		if (insertions > 0) {
			totalInsertions += insertions;
		}
		if (deletions > 0) {
			totalDeletions += deletions;
		}
	}

	return { files, raw: rawOutput, totalDeletions, totalInsertions };
}

export function parseTestOutput(result: CommandResult): TestRunResult {
	const combinedOutput = `${result.stdout}\n${result.stderr}`;
	const passMatch = combinedOutput.match(/(\d+)\s+pass/);
	const failMatch = combinedOutput.match(/(\d+)\s+fail/);
	const failed = failMatch ? Number.parseInt(failMatch[1] ?? "0", 10) : 0;
	const passedCount = passMatch ? Number.parseInt(passMatch[1] ?? "0", 10) : 0;
	return {
		exitCode: result.exitCode,
		failed,
		passed: result.exitCode === 0,
		stderr: result.stderr,
		stdout: result.stdout,
		total: passedCount + failed,
	};
}
