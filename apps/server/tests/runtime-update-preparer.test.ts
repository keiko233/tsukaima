import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logging.ts";
import {
	RuntimeUpdatePreparer,
	type RuntimeUpdatePreparerExec,
} from "../src/services/runtime-update-preparer.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

function git(cwd: string, args: readonly string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
		{ cwd },
	).toString();
}

interface PreparedRepository {
	readonly appDir: string;
	readonly installCalls: number[];
	readonly logger: ReturnType<typeof createLogger>;
	readonly root: string;
	readonly webDistDir: string;
}

async function repository(
	options: { readonly webApp?: boolean } = {},
): Promise<PreparedRepository> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-prepare-"));
	directories.push(root);
	git(root, ["init"]);
	await writeFile(join(root, "README.md"), "# Fixture\n");
	if (options.webApp !== false) {
		await mkdir(join(root, "apps/web"), { recursive: true });
		await writeFile(join(root, "apps/web/package.json"), JSON.stringify({ name: "web-fixture" }));
		git(root, ["add", "."]);
	} else {
		git(root, ["add", "README.md"]);
	}
	git(root, ["commit", "-m", "initial"]);
	return {
		appDir: join(root, "apps/web"),
		installCalls: [],
		logger: createLogger({ capacity: 10, level: "error", target: "test" }),
		root,
		webDistDir: join(root, "apps/web/dist"),
	};
}

interface RecordedCommand {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

function recordingExec(options: {
	readonly commands: RecordedCommand[];
	readonly viteExitCode?: number;
}): RuntimeUpdatePreparerExec {
	return async (_command, args, execOptions) => {
		options.commands.push({ args, cwd: execOptions.cwd, env: execOptions.env });
		const isViteBuild = args[0] === "run" && args[1] === "vite";
		if (isViteBuild && options.viteExitCode !== undefined && options.viteExitCode !== 0) {
			const viteExitCode = options.viteExitCode;
			return { exitCode: viteExitCode, stderr: "synthetic build failure", stdout: "" };
		}
		if (isViteBuild) {
			const outDirIndex = args.indexOf("--outDir");
			const outDir = outDirIndex === -1 ? undefined : args[outDirIndex + 1];
			if (outDir === undefined) throw new Error("missing --outDir");
			await mkdir(outDir, { recursive: true });
			await writeFile(join(outDir, "index.html"), "<!doctype html><title>built</title>");
		}
		return { exitCode: 0, stderr: "", stdout: "" };
	};
}

function preparer(input: {
	readonly repo: PreparedRepository;
	readonly exec?: RuntimeUpdatePreparerExec;
}): RuntimeUpdatePreparer {
	return new RuntimeUpdatePreparer({
		dependencyInstaller: {
			install: async () => {
				input.repo.installCalls.push(Date.now());
			},
		},
		...(input.exec === undefined ? {} : { exec: input.exec }),
		logger: input.repo.logger,
		repositoryRoot: input.repo.root,
		timeoutMs: 30_000,
		webDistDir: input.repo.webDistDir,
	});
}

describe("RuntimeUpdatePreparer", () => {
	test("installs dependencies, rebuilds the WebUI, and swaps the dist atomically", async () => {
		const repo = await repository();
		await mkdir(repo.webDistDir, { recursive: true });
		await writeFile(join(repo.webDistDir, "index.html"), "<title>old</title>");
		const commands: RecordedCommand[] = [];
		const service = preparer({ exec: recordingExec({ commands }), repo });

		await service.prepare();

		expect(repo.installCalls).toHaveLength(1);
		expect(commands).toHaveLength(2);
		expect(commands[0]?.args).toEqual(["run", "i18n:plugins"]);
		expect(commands[0]?.cwd).toBe(repo.appDir);
		expect(commands[1]?.args.slice(0, 5)).toEqual([
			"run",
			"vite",
			"build",
			"--outDir",
			expect.stringContaining(".dist-staging-"),
		]);
		expect(commands[1]?.args.at(-1)).toBe("--emptyOutDir");
		expect(commands[1]?.env.NODE_ENV).toBeUndefined();
		expect(commands[1]?.env.CI).toBe("1");
		expect(await readFile(join(repo.webDistDir, "index.html"), "utf8")).toContain("built");
		const siblings = await readdir(repo.appDir);
		expect(siblings.some((name) => name.startsWith(".dist-staging-"))).toBe(false);
		expect(siblings.some((name) => name.startsWith(".dist-backup-"))).toBe(false);
	});

	test("keeps the existing dist and cleans staging when the build fails", async () => {
		const repo = await repository();
		await mkdir(repo.webDistDir, { recursive: true });
		await writeFile(join(repo.webDistDir, "index.html"), "<title>old</title>");
		const commands: RecordedCommand[] = [];
		const service = preparer({
			exec: recordingExec({ commands, viteExitCode: 1 }),
			repo,
		});

		await expect(service.prepare()).rejects.toThrow("synthetic build failure");
		expect(await readFile(join(repo.webDistDir, "index.html"), "utf8")).toContain("old");
		const siblings = await readdir(repo.appDir);
		expect(siblings.some((name) => name.startsWith(".dist-staging-"))).toBe(false);
		expect(siblings.some((name) => name.startsWith(".dist-backup-"))).toBe(false);
	});

	test("deduplicates the same revision and rebuilds when HEAD changes", async () => {
		const repo = await repository();
		const commands: RecordedCommand[] = [];
		const service = preparer({ exec: recordingExec({ commands }), repo });

		await service.prepare();
		await service.prepare();
		expect(commands).toHaveLength(2);
		expect(repo.installCalls).toHaveLength(1);

		git(repo.root, ["commit", "--allow-empty", "-m", "next revision"]);
		await service.prepare();
		expect(commands).toHaveLength(4);
		expect(repo.installCalls).toHaveLength(2);
	});

	test("skips the WebUI build when apps/web is not part of the checkout", async () => {
		const repo = await repository({ webApp: false });
		const commands: RecordedCommand[] = [];
		const service = preparer({ exec: recordingExec({ commands }), repo });

		await service.prepare();

		expect(repo.installCalls).toHaveLength(1);
		expect(commands).toHaveLength(0);
	});
});
