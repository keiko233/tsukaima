import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANALYSIS_MOUNT,
	buildBubblewrapArgv,
	createBubblewrapSandbox,
	createHostSandbox,
	probeBubblewrapSandbox,
	resolveExecutable,
	SANDBOX_PATH_DIRS,
	SandboxUnavailableError,
} from "../src/index.ts";

const root = await mkdtemp(join(tmpdir(), "tsukaima-sandbox-"));
const repositoryPath = join(root, "repo");
const worktreePath = join(root, "worktree");
await mkdir(repositoryPath, { recursive: true });
await mkdir(worktreePath, { recursive: true });
await writeFile(join(worktreePath, "README.md"), "# sandbox fixture\n");

const probe = await probeBubblewrapSandbox({ repositoryPath });
const shellAvailable = existsSync("/bin/sh");
const realSandboxUsable = probe.ok && shellAvailable;

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

describe("buildBubblewrapArgv", () => {
	test("isolates namespaces, clears the environment, and terminates options", () => {
		const argv = buildBubblewrapArgv({
			args: ["--pre=evil", "pattern"],
			commandPath: "/usr/bin/rg",
			cwd: worktreePath,
			env: { HOME: "/tmp/home", PATH: "/usr/bin" },
			repositoryPath,
			writable: false,
		});
		const text = argv.join(" ");
		expect(text).toContain("--unshare-all");
		expect(text).toContain("--die-with-parent");
		expect(text).toContain("--clearenv");
		expect(text).toContain("--ro-bind");
		expect(argv.filter((entry) => entry === "--setenv")).toHaveLength(2);
		expect(argv).toContain("--");
		expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "/usr/bin/rg", "--pre=evil", "pattern"]);
	});

	test("never binds the whole repository, only explicit read-only mounts", () => {
		const mounts = [
			{ directory: true, path: join(repositoryPath, "node_modules") },
			{ directory: true, path: join(repositoryPath, ".git", "worktrees", "task") },
		];
		const argv = buildBubblewrapArgv({
			args: [],
			commandPath: "/usr/bin/git",
			cwd: worktreePath,
			env: { HOME: "/tmp/home" },
			readOnlyPaths: mounts,
			repositoryPath,
			writable: false,
		});
		// The repository appears exactly once, as an empty `--dir`, so nested state such as
		// `.env.production`, `.git/config`, or `data/` cannot be reached by any path.
		const repoOccurrences = argv.filter((entry) => entry === repositoryPath);
		expect(repoOccurrences).toHaveLength(1);
		const repoIndex = argv.indexOf(repositoryPath);
		expect(argv[repoIndex - 1]).toBe("--dir");
		const repoBinds = argv.reduce<number[]>(
			(indexes, entry, index) =>
				entry === repositoryPath && argv[index - 1] === "--ro-bind" ? [...indexes, index] : indexes,
			[],
		);
		expect(repoBinds).toHaveLength(0);
		for (const mount of mounts) {
			const mountIndex = argv.indexOf(mount.path);
			expect(mountIndex).toBeGreaterThan(repoIndex);
			// `--ro-bind-try <source> <target>`: the flag is two entries before the source.
			expect(argv[mountIndex - 1]).toBe("--ro-bind-try");
		}
	});

	test("binds a writable worktree after the read-only mounts", () => {
		const argv = buildBubblewrapArgv({
			args: [],
			commandPath: "/usr/bin/git",
			cwd: worktreePath,
			env: { HOME: "/tmp/home" },
			readOnlyPaths: [{ directory: true, path: join(repositoryPath, "node_modules") }],
			repositoryPath,
			writable: true,
		});
		const worktreeIndex = argv.indexOf(worktreePath);
		expect(worktreeIndex).toBeGreaterThan(-1);
		expect(argv[worktreeIndex - 1]).toBe("--bind");
	});
});

describe("resolveExecutable", () => {
	test("refuses path-bearing command names", async () => {
		expect(await resolveExecutable("../evil", SANDBOX_PATH_DIRS)).toBeUndefined();
		expect(await resolveExecutable("bin/tool", SANDBOX_PATH_DIRS)).toBeUndefined();
	});

	test("resolves allowlisted commands from fixed directories", async () => {
		const resolved = await resolveExecutable("sh", ["/bin"]);
		// The real path is returned so the sandbox mounts the binary's actual directory.
		expect(resolved).toBe(await realpath("/bin/sh"));
	});
});

describe("bubblewrap sandbox", () => {
	test("fails closed when bwrap is not installed", async () => {
		const provider = createBubblewrapSandbox({
			env: { PATH: join(root, "empty-path") },
			repositoryPath,
		});
		await expect(provider()).rejects.toThrow(SandboxUnavailableError);
		await expect(provider()).rejects.toThrow("sandbox_unavailable");
	});

	test.skipIf(!realSandboxUsable)(
		"runs commands with a scrubbed environment and no inherited secrets",
		async () => {
			process.env.TSUKAIMA_SANDBOX_SECRET = "must-not-leak";
			try {
				const provider = createBubblewrapSandbox({ repositoryPath });
				const sandbox = await provider();
				const result = await sandbox.exec({
					args: [],
					command: "env",
					cwd: worktreePath,
					env: { ALLOWED_FLAG: "1" },
					maxOutputBytes: 64 * 1024,
					timeoutMs: 10_000,
					writable: false,
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("ALLOWED_FLAG=1");
				expect(result.stdout).not.toContain("must-not-leak");
				expect(result.stdout).not.toContain("TSUKAIMA_SANDBOX_SECRET");
			} finally {
				delete process.env.TSUKAIMA_SANDBOX_SECRET;
			}
		},
	);

	test.skipIf(!realSandboxUsable)("writes are confined to the writable worktree", async () => {
		const provider = createBubblewrapSandbox({ repositoryPath });
		const sandbox = await provider();
		const write = await sandbox.exec({
			args: ["-c", "printf ok > probe.txt"],
			command: "sh",
			cwd: worktreePath,
			maxOutputBytes: 4096,
			timeoutMs: 10_000,
			writable: true,
		});
		expect(write.exitCode).toBe(0);
		expect(await readFile(join(worktreePath, "probe.txt"), "utf-8")).toBe("ok");

		const escape = await sandbox.exec({
			args: ["-c", `printf escaped > ${repositoryPath}/escape.txt 2>/dev/null || true`],
			command: "sh",
			cwd: worktreePath,
			maxOutputBytes: 4096,
			timeoutMs: 10_000,
			writable: true,
		});
		// The repository exists only as an empty directory; the write fails and no file appears.
		expect(escape.stdout).toBe("");
		expect(existsSync(join(repositoryPath, "escape.txt"))).toBe(false);

		// Naming the repository as the working directory must fail closed rather than bind it.
		await expect(
			sandbox.exec({
				args: ["-c", "true"],
				command: "sh",
				cwd: repositoryPath,
				maxOutputBytes: 4096,
				timeoutMs: 10_000,
				writable: true,
			}),
		).rejects.toThrow(SandboxUnavailableError);
	});

	test.skipIf(!realSandboxUsable)(
		"hides repository dotenv, data, and nested secrets from a worktree command",
		async () => {
			await writeFile(join(repositoryPath, ".env"), "SECRET=leak");
			await mkdir(join(repositoryPath, "config", "secrets"), { recursive: true });
			await writeFile(
				join(repositoryPath, "config", "secrets", "nested.env"),
				"NESTED=nested-leak",
			);
			await writeFile(join(repositoryPath, "config", "credentials.json"), '{"token":"creds-leak"}');
			await writeFile(join(repositoryPath, "local.sqlite"), "db");
			await mkdir(join(repositoryPath, "data"), { recursive: true });
			await writeFile(join(repositoryPath, "data", "chat.txt"), "private");
			const provider = createBubblewrapSandbox({ repositoryPath });
			const sandbox = await provider();
			const read = await sandbox.exec({
				args: [
					"-c",
					`cat ${repositoryPath}/.env ${repositoryPath}/config/secrets/nested.env ${repositoryPath}/config/credentials.json ${repositoryPath}/local.sqlite ${repositoryPath}/data/chat.txt 2>&1 || true; ls ${repositoryPath} 2>&1 || true`,
				],
				command: "sh",
				cwd: worktreePath,
				maxOutputBytes: 64 * 1024,
				timeoutMs: 10_000,
				writable: false,
			});
			expect(read.stdout).not.toContain("leak");
			expect(read.stdout).not.toContain("private");
			expect(read.stdout).not.toContain("nested-leak");
			expect(read.stdout).not.toContain("creds-leak");
			// Every unlisted path is absent, not masked file by file, so a nested secret cannot
			// leak by simply not matching a mask pattern.
			expect(read.stdout).not.toContain("No such file or directory:\n");
		},
	);

	test.skipIf(!realSandboxUsable)(
		"hides git config, credentials, and repository internals from the sandbox",
		async () => {
			// A real repository with a worktree proves the read-only git view exposes objects and
			// refs without exposing `.git/config`, hooks, or credential helpers.
			const { execFileSync } = await import("node:child_process");
			const repo = join(root, "git-repo");
			const tree = join(root, "git-worktree");
			await mkdir(repo, { recursive: true });
			const git = (cwd: string, args: readonly string[]): void => {
				execFileSync(
					"git",
					["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
					{ cwd },
				);
			};
			git(repo, ["init", "-q"]);
			await writeFile(join(repo, "a.txt"), "one\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["commit", "-qm", "init"]);
			git(repo, ["worktree", "add", "-q", "-b", "iteration", tree, "HEAD"]);
			git(repo, ["config", "credential.helper", "store --file /tmp/leaked-credentials"]);
			await writeFile(
				join(repo, ".git", "config"),
				"[credential]\n\thelper = store\nSECRET=config-leak\n",
			);
			await writeFile(join(tree, "a.txt"), "two\n");
			const provider = createBubblewrapSandbox({ repositoryPath: repo });
			const sandbox = await provider();
			const diff = await sandbox.exec({
				args: ["diff", "HEAD"],
				command: "git",
				cwd: tree,
				maxOutputBytes: 64 * 1024,
				timeoutMs: 10_000,
				writable: false,
			});
			expect(diff.exitCode).toBe(0);
			expect(diff.stdout).toContain("+two");

			const gitConfigProbe = await sandbox.exec({
				args: ["-c", `cat ${repo}/.git/config ${repo}/.git/hooks/* 2>&1 || true`],
				command: "sh",
				cwd: tree,
				maxOutputBytes: 64 * 1024,
				timeoutMs: 10_000,
				writable: false,
			});
			expect(gitConfigProbe.stdout).not.toContain("config-leak");
			expect(gitConfigProbe.stdout).not.toContain("credential");
		},
	);
});

describe("host sandbox", () => {
	test("runs in a worktree with a scrubbed environment and bounded output", async () => {
		process.env.TSUKAIMA_HOST_SECRET = "must-not-leak";
		try {
			const provider = createHostSandbox({ repositoryPath, worktreeRoot: root });
			const sandbox = await provider();
			const result = await sandbox.exec({
				args: [],
				command: "env",
				cwd: worktreePath,
				env: { ALLOWED_FLAG: "1" },
				maxOutputBytes: 64 * 1024,
				timeoutMs: 10_000,
				writable: false,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ALLOWED_FLAG=1");
			expect(result.stdout).not.toContain("must-not-leak");
			expect(result.stdout).not.toContain("TSUKAIMA_HOST_SECRET");
		} finally {
			delete process.env.TSUKAIMA_HOST_SECRET;
		}
	});

	test("refuses the live repository and paths outside the worktree root", async () => {
		const sandbox = await createHostSandbox({ repositoryPath, worktreeRoot: root })();
		await expect(
			sandbox.exec({
				args: ["-c", "true"],
				command: "sh",
				cwd: repositoryPath,
				maxOutputBytes: 1024,
				timeoutMs: 10_000,
				writable: false,
			}),
		).rejects.toThrow(SandboxUnavailableError);
		await expect(
			sandbox.exec({
				args: ["-c", "true"],
				command: "sh",
				cwd: tmpdir(),
				maxOutputBytes: 1024,
				timeoutMs: 10_000,
				writable: false,
			}),
		).rejects.toThrow(SandboxUnavailableError);
	});

	test.skipIf(!existsSync("/bin/tar"))(
		"redirects analysis reads into a private copy of the task tree",
		async () => {
			const analysisTree = join(root, "analysis-tree");
			await mkdir(join(analysisTree, ".git"), { recursive: true });
			await writeFile(join(analysisTree, "README.md"), "# analysis marker\n");
			await writeFile(join(analysisTree, ".git", "config"), "SECRET=analysis-leak\n");
			const sandbox = await createHostSandbox({ repositoryPath, worktreeRoot: root })();
			const result = await sandbox.exec({
				args: ["-c", "128", "--", `${ANALYSIS_MOUNT}/README.md`],
				analysisTree,
				command: "head",
				cwd: worktreePath,
				maxOutputBytes: 4096,
				timeoutMs: 10_000,
				writable: false,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("# analysis marker");
		},
	);
});
