import type { CodingRunner, CommandResult } from "./runner.ts";

/** Bound on untracked files expanded into a diff, so one task cannot produce an unbounded read. */
const MAX_UNTRACKED_DIFF_FILES = 200;

/** Lines an `--no-index` diff adds (`+` lines except the `+++` header). */
function countAddedLines(diff: string): number {
	return diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
}

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
	/** Set when more untracked files exist than the diff expands; the diff is then incomplete. */
	readonly untrackedTruncated?: true;
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
		// Tracked and untracked changes are read without touching the index: `git add` would need
		// to write objects into the repository's object database, which stays read-only in the
		// sandbox. `--no-index` against /dev/null yields an untracked file's content as a diff.
		const [tracked, untracked] = await Promise.all([
			this.#diffAgainstHead(),
			this.#untrackedPaths(),
		]);
		const expanded = await this.#expandUntracked(tracked, untracked.paths);
		return untracked.truncated ? { ...expanded, untrackedTruncated: true } : expanded;
	}

	async #expandUntracked(tracked: DiffResult, untracked: readonly string[]): Promise<DiffResult> {
		const extra: DiffResult[] = [];
		for (const path of untracked) {
			const result = await this.#runner.exec("git", [
				"diff",
				"--no-color",
				"--no-index",
				"--",
				"/dev/null",
				path,
			]);
			// `--no-index` exits 1 when files differ, which is the expected case here.
			if (result.stdout.length > 0) {
				const files: DiffFileEntry[] = [
					{
						deletions: 0,
						insertions: countAddedLines(result.stdout),
						path,
						status: "added",
					},
				];
				extra.push({
					files,
					raw: result.stdout,
					totalDeletions: 0,
					totalInsertions: countAddedLines(result.stdout),
				});
			}
		}
		if (extra.length === 0) return tracked;
		return {
			files: [...tracked.files, ...extra.flatMap((entry) => entry.files)],
			raw: [tracked.raw, ...extra.map((entry) => entry.raw)]
				.filter((part) => part.length > 0)
				.join("\n"),
			totalDeletions:
				tracked.totalDeletions + extra.reduce((sum, entry) => sum + entry.totalDeletions, 0),
			totalInsertions:
				tracked.totalInsertions + extra.reduce((sum, entry) => sum + entry.totalInsertions, 0),
		};
	}

	async #diffAgainstHead(): Promise<DiffResult> {
		const [numstatResult, nameStatusResult, rawResult] = await Promise.all([
			this.#runner.exec("git", ["diff", "HEAD", "--numstat"]),
			this.#runner.exec("git", ["diff", "HEAD", "--name-status"]),
			this.#runner.exec("git", ["diff", "HEAD", "--no-color"]),
		]);
		return parseDiffOutput(numstatResult.stdout, nameStatusResult.stdout, rawResult.stdout);
	}

	async #untrackedPaths(): Promise<{
		readonly paths: readonly string[];
		readonly truncated: boolean;
	}> {
		const result = await this.#runner.exec("git", [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		]);
		if (result.exitCode !== 0) return { paths: [], truncated: false };
		const all = result.stdout
			.split("\0")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		return {
			paths: all.slice(0, MAX_UNTRACKED_DIFF_FILES),
			truncated: all.length > MAX_UNTRACKED_DIFF_FILES,
		};
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
