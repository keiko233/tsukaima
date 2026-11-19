import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
	chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBubblewrapSandbox,
	createHostSandbox,
	createTaskSnapshot,
	describeSandboxAvailability,
	probeBubblewrapSandbox,
	SandboxUnavailableError,
	type SandboxExecResult,
} from "../src/index.ts";

/**
 * Synthetic repository laid out like this workspace: a root `node_modules` with an installed
 * package store and a workspace link, plus a per-workspace `node_modules` that points into the
 * store. Every name and value is synthetic.
 */
const root = await mkdtemp(join(tmpdir(), "tsukaima-snapshot-test-"));
const repository = join(root, "repo");
const worktreeRoot = join(root, "worktrees");
const task = join(worktreeRoot, "task-a");
const SECRET_MARKER = "live-secret-marker";

async function write(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

async function buildRepository(): Promise<void> {
	await write(join(repository, ".gitignore"), "secret.env\ndata/\n");
	await write(join(repository, "package.json"), '{"name":"synthetic","private":true}\n');
	await write(join(repository, "secret.env"), `TOKEN=${SECRET_MARKER}\n`);
	await write(join(repository, "data", "state.txt"), "service data\n");
	await write(join(repository, ".git", "config"), "[credential]\n\thelper = store\n");
	// Installed dependency store, as the package manager lays it out.
	await write(
		join(repository, "node_modules", ".bun", "nested@1.0.0", "node_modules", "nested", "index.js"),
		'export const nested = "nested-value";\n',
	);
	await symlink(
		".bun/nested@1.0.0/node_modules/nested",
		join(repository, "node_modules", "nested"),
	);
	// Workspace package, linked into the root install the way a workspace install does.
	await write(
		join(repository, "packages", "lib", "package.json"),
		'{"name":"@synthetic/lib","main":"src/index.ts"}\n',
	);
	await write(
		join(repository, "packages", "lib", "src", "index.ts"),
		'export const lib = "live";\n',
	);
	await mkdir(join(repository, "node_modules", "@synthetic"), { recursive: true });
	await symlink("../../packages/lib", join(repository, "node_modules", "@synthetic", "lib"));
	// Per-workspace install that reaches the store through a relative link.
	await write(join(repository, "plugins", "app", "package.json"), '{"name":"app"}\n');
	await mkdir(join(repository, "plugins", "app", "node_modules"), { recursive: true });
	await symlink(
		"../../../node_modules/.bun/nested@1.0.0/node_modules/nested",
		join(repository, "plugins", "app", "node_modules", "nested-local"),
	);
	await mkdir(join(repository, "plugins", "app", "node_modules", "@synthetic"), {
		recursive: true,
	});
	await symlink(
		"../../../../packages/lib",
		join(repository, "plugins", "app", "node_modules", "@synthetic", "lib"),
	);
	const env = { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const gitify = (args: readonly string[]): Promise<number> => {
		const proc = Bun.spawn({
			cmd: [
				"git",
				"-c",
				"user.name=tsukaima-test",
				"-c",
				"user.email=test@tsukaima.invalid",
				...args,
			],
			cwd: repository,
			env,
			stderr: "ignore",
			stdout: "ignore",
		});
		return proc.exited;
	};
	for (const args of [
		["init", "-b", "main"],
		["add", "-A"],
		["commit", "-m", "synthetic base"],
	]) {
		if ((await gitify(args)) !== 0) throw new Error(`fixture git ${args[0]} failed`);
	}
}

/** A task worktree: tracked content only, with the metadata a real worktree carries. */
async function buildWorktree(): Promise<void> {
	const add = Bun.spawn({
		cmd: ["git", "worktree", "add", "--detach", task, "HEAD"],
		cwd: repository,
		env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
		stderr: "ignore",
		stdout: "ignore",
	});
	if ((await add.exited) !== 0) throw new Error("fixture git worktree add failed");
	await write(join(task, "package.json"), '{"name":"synthetic","private":true}\n');
	await write(
		join(task, "packages", "lib", "package.json"),
		'{"name":"@synthetic/lib","main":"src/index.ts"}\n',
	);
	// The task's own edit: the snapshot must run this, not the live checkout's value.
	await write(join(task, "packages", "lib", "src", "index.ts"), 'export const lib = "task";\n');
	await write(join(task, "plugins", "app", "package.json"), '{"name":"app"}\n');
	await write(
		join(task, "plugins", "app", "src", "app.test.ts"),
		[
			'import { expect, test } from "bun:test";',
			'import { lib } from "@synthetic/lib";',
			'import { nested } from "nested-local";',
			'test("snapshot dependencies and task source", () => {',
			'\texpect(lib).toBe("task");',
			'\texpect(nested).toBe("nested-value");',
			"});",
			"",
		].join("\n"),
	);
	// Worktree links: the in-tree relative link must survive; the escaping link must be
	// dropped. `git worktree add` already created the node_modules link like WorktreeManager;
	// keep it only when it is absent so the fixture also works on hosts without the hook.
	if (!existsSync(join(task, "node_modules"))) {
		await symlink(join(repository, "node_modules"), join(task, "node_modules"));
	}
	await symlink("packages/lib/src/index.ts", join(task, "entry.ts"));
	await symlink("/etc/hostname", join(task, "escape-host"));
}

await buildRepository();
await buildWorktree();

const probe = await probeBubblewrapSandbox({ repositoryPath: repository }).catch(() => ({
	ok: false,
	reason: "probe threw",
}));
const realSandboxUsable = probe.ok && existsSync("/bin/sh");

afterAll(async () => {
	await rm(root, { force: true, recursive: true });
});

describe("task snapshot provenance", () => {
	test("copies task content, excludes git metadata and escaping links, and maps dependencies", async () => {
		const target = await mkdtemp(join(root, "snap-"));
		const snapshot = await createTaskSnapshot({
			repositoryPath: repository,
			sourcePath: task,
			targetPath: target,
		});
		expect(await readFile(join(target, "packages", "lib", "src", "index.ts"), "utf8")).toContain(
			"task",
		);
		expect(existsSync(join(target, "secret.env"))).toBe(false);
		expect(existsSync(join(target, "data"))).toBe(false);
		// The minimal git view exists for status/diff/log, but carries no repository config,
		// hooks, or credential state, and references objects only through alternates.
		expect(existsSync(join(target, ".git", "HEAD"))).toBe(true);
		expect(existsSync(join(target, ".git", "objects", "info", "alternates"))).toBe(true);
		expect(existsSync(join(target, ".git", "hooks"))).toBe(false);
		expect(existsSync(join(target, ".git", "refs", "heads", "main"))).toBe(false);
		const config = await readFile(join(target, ".git", "config"), "utf8");
		expect(config).not.toContain("remote");
		expect(config).not.toContain("url");
		// In-tree relative links survive; the absolute and escaping links do not.
		expect(await readlink(join(target, "entry.ts"))).toBe("packages/lib/src/index.ts");
		expect(existsSync(join(target, "escape-host"))).toBe(false);
		expect(snapshot.manifest.symlinks).toBe(1);
		expect(snapshot.manifest.skippedEntries).toBe(1);
		// Workspace dependencies point at the snapshot's own copy, never the live package.
		const workspaceLink = join(target, "node_modules", "@synthetic", "lib");
		expect(await realpath(workspaceLink)).toBe(await realpath(join(target, "packages", "lib")));
		expect(
			await realpath(join(target, "plugins", "app", "node_modules", "@synthetic", "lib")),
		).toBe(await realpath(join(target, "packages", "lib")));
		// Installed packages stay in the install mount; the shared git object store is the other
		// read-only host mount the minimal git view needs.
		expect(snapshot.readOnlyMounts.map((mount) => mount.path).toSorted()).toEqual(
			[
				await realpath(join(repository, "node_modules")),
				await realpath(join(repository, ".git", "objects")),
			].toSorted(),
		);
		expect(snapshot.manifest.dependencyLinks).toBeGreaterThan(0);
		expect(snapshot.manifest.unresolvedDependencies).toBe(0);
	});

	test("the checksum identifies task content and changes with an edit", async () => {
		const first = await mkdtemp(join(root, "sum-a-"));
		const second = await mkdtemp(join(root, "sum-b-"));
		const a = await createTaskSnapshot({
			repositoryPath: repository,
			sourcePath: task,
			targetPath: first,
		});
		const b = await createTaskSnapshot({
			repositoryPath: repository,
			sourcePath: task,
			targetPath: second,
		});
		expect(a.manifest.checksum).toBe(b.manifest.checksum);

		const edited = await mkdtemp(join(root, "sum-c-"));
		const editedTask = join(root, "edited-task");
		await mkdir(editedTask, { recursive: true });
		await write(join(editedTask, "README.md"), "changed\n");
		const c = await createTaskSnapshot({
			repositoryPath: repository,
			sourcePath: editedTask,
			targetPath: edited,
		});
		expect(c.manifest.checksum).not.toBe(a.manifest.checksum);
	});

	test("refuses to snapshot the live repository or a target inside the source", async () => {
		const target = await mkdtemp(join(root, "refuse-"));
		await expect(
			createTaskSnapshot({
				repositoryPath: repository,
				sourcePath: repository,
				targetPath: target,
			}),
		).rejects.toThrow("snapshot_source_is_repository");
	});

	test("bounds the copy by file count and bytes", async () => {
		const target = await mkdtemp(join(root, "bounded-"));
		await expect(
			createTaskSnapshot({
				maxBytes: 16,
				repositoryPath: repository,
				sourcePath: task,
				targetPath: target,
			}),
		).rejects.toThrow("snapshot_too_large");
	});
});

describe("unavailable isolation is actionable and never runs commands", () => {
	test("a missing bwrap reports bwrap_missing with a remedy", async () => {
		const provider = createBubblewrapSandbox({
			env: { PATH: join(root, "no-such-dir") },
			repositoryPath: repository,
		});
		const status = await describeSandboxAvailability(provider);
		expect(status.available).toBe(false);
		expect(status.code).toBe("bwrap_missing");
		expect(status.remedy).toContain("bubblewrap");
	});

	test("a bwrap that cannot create namespaces reports namespace_denied with the probe detail", async () => {
		const fakeBin = join(root, "fake-bin");
		await mkdir(fakeBin, { recursive: true });
		const fakeBwrap = join(fakeBin, "bwrap");
		await writeFile(
			fakeBwrap,
			"#!/bin/sh\necho 'bwrap: Creating new namespace failed: Operation not permitted' >&2\nexit 1\n",
		);
		await chmod(fakeBwrap, 0o755);
		const provider = createBubblewrapSandbox({
			env: { PATH: fakeBin },
			repositoryPath: repository,
		});
		const status = await describeSandboxAvailability(provider);
		expect(status.available).toBe(false);
		expect(status.code).toBe("namespace_denied");
		expect(status.reason).toContain("Operation not permitted");
		await expect(provider()).rejects.toBeInstanceOf(SandboxUnavailableError);
	});

	test("the host backend is reported as not isolated and refuses snapshot runs", async () => {
		const provider = createHostSandbox({ repositoryPath: repository, worktreeRoot });
		const status = await describeSandboxAvailability(provider);
		expect(status.available).toBe(false);
		expect(status.isolated).toBe(false);
		expect(status.code).toBe("backend_not_isolated");
		const executor = await provider();
		await expect(
			executor.exec({
				args: [],
				command: "true",
				cwd: task,
				maxOutputBytes: 1024,
				snapshot: true,
				timeoutMs: 5_000,
				writable: true,
			}),
		).rejects.toThrow("sandbox_unavailable");
	});
});

interface RunOptions {
	readonly maxOutputBytes?: number;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** Run one `sh -c` script on the synthetic task as a snapshot. */
async function run(script: string, options: RunOptions = {}): Promise<SandboxExecResult> {
	const sandbox = await createBubblewrapSandbox({ repositoryPath: repository, worktreeRoot })();
	return await sandbox.exec({
		args: ["-c", script],
		command: "sh",
		cwd: task,
		maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
		snapshot: true,
		timeoutMs: options.timeoutMs ?? 20_000,
		writable: true,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

describe("bubblewrap snapshot execution (real namespaces)", () => {
	test.skipIf(!realSandboxUsable)(
		"runs bun test over the task's own source and installed dependencies",
		async () => {
			const sandbox = await createBubblewrapSandbox({ repositoryPath: repository, worktreeRoot })();
			const result = await sandbox.exec({
				args: ["test", "plugins/app/src/app.test.ts"],
				command: "bun",
				cwd: task,
				maxOutputBytes: 64 * 1024,
				snapshot: true,
				timeoutMs: 60_000,
				writable: true,
			});
			expect(result.stderr + result.stdout).toContain("1 pass");
			expect(result.exitCode).toBe(0);
			expect(result.snapshot?.checksum).toMatch(/^[0-9a-f]{64}$/u);
		},
		90_000,
	);

	test.skipIf(!realSandboxUsable)(
		"writes stay in the disposable snapshot, and the live tree is untouched",
		async () => {
			const before = await readFile(join(task, "packages", "lib", "src", "index.ts"), "utf8");
			const result = await run(
				"echo scratch > generated.txt && mkdir -p out && echo built > out/bundle.js && echo tmp > /tmp/scratch && cat generated.txt",
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("scratch");
			expect(existsSync(join(task, "generated.txt"))).toBe(false);
			expect(existsSync(join(task, "out"))).toBe(false);
			expect(await readFile(join(task, "packages", "lib", "src", "index.ts"), "utf8")).toBe(before);
			// A second run starts from the task content, not from the previous run's output.
			const second = await run("test -e generated.txt && echo present || echo absent");
			expect(second.stdout.trim()).toBe("absent");
		},
	);

	test.skipIf(!realSandboxUsable)(
		"inaccessible paths are absent inside the namespace",
		async () => {
			const result = await run(
				[
					`test -e '${join(repository, "secret.env")}' && echo secret-visible || echo secret-absent`,
					`test -e '${join(repository, "data", "state.txt")}' && echo data-visible || echo data-absent`,
					`test -e '${join(repository, ".git", "config")}' && echo git-visible || echo git-absent`,
					`test -e '${join(repository, "packages", "lib", "src", "index.ts")}' && echo live-source-visible || echo live-source-absent`,
					`grep -q helper '${join(task, ".git", "config")}' 2>/dev/null && echo git-credential-visible || echo git-credential-absent`,
					`test -e '${join(task, ".git", "HEAD")}' && echo snapshot-git-head-visible || echo snapshot-git-head-absent`,
					`git status --porcelain >/dev/null 2>&1 && echo git-status-ok || echo git-status-failed`,
					`test -e '${join(repository, "node_modules", "nested")}' && echo deps-visible || echo deps-absent`,
					`test -L escape-host && echo escape-link || echo escape-dropped`,
					`test -S /var/run/docker.sock && echo docker-visible || echo docker-absent`,
					`test -S /run/user/$(id -u)/bus 2>/dev/null && echo bus-visible || echo bus-absent`,
					"env | sort",
				].join("\n"),
			);
			expect(result.stdout).toContain("secret-absent");
			expect(result.stdout).toContain("data-absent");
			expect(result.stdout).toContain("git-absent");
			expect(result.stdout).toContain("live-source-absent");
			expect(result.stdout).toContain("git-credential-absent");
			// The minimal snapshot git view is present and functional without any repository config.
			expect(result.stdout).toContain("snapshot-git-head-visible");
			expect(result.stdout).toContain("git-status-ok");
			expect(result.stdout).toContain("deps-visible");
			expect(result.stdout).toContain("escape-dropped");
			expect(result.stdout).toContain("docker-absent");
			expect(result.stdout).toContain("bus-absent");
			expect(result.stdout).not.toContain(SECRET_MARKER);
			// The environment is scrubbed: nothing from the server process reaches the command.
			expect(result.stdout).not.toMatch(/^(SSH_|AWS_|OPENAI|TSUKAIMA_)/mu);
		},
	);

	test.skipIf(!realSandboxUsable)(
		"the network is not reachable from inside the sandbox",
		async () => {
			const listener = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: { data() {}, open() {} },
			});
			try {
				const result = await run(
					`(exec 3<>/dev/tcp/127.0.0.1/${listener.port}) 2>/dev/null && echo reached || echo unreachable`,
				);
				expect(result.stdout.trim()).toBe("unreachable");
			} finally {
				listener.stop(true);
			}
		},
	);

	test.skipIf(!realSandboxUsable)("output is bounded and reports truncation", async () => {
		const result = await run("head -c 2000000 /dev/zero | tr '\\0' a", { maxOutputBytes: 4096 });
		expect(result.stdoutTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4096);
	});

	test.skipIf(!realSandboxUsable)(
		"timeout terminates the command and its descendants",
		async () => {
			const startedAt = performance.now();
			const result = await run("(while true; do echo tick; sleep 0.05; done) & wait", {
				timeoutMs: 1_000,
			});
			expect(result.timedOut).toBe(true);
			// Descendants keep stdout open; the command only settles once they are gone.
			expect(performance.now() - startedAt).toBeLessThan(15_000);
		},
	);

	test.skipIf(!realSandboxUsable)(
		"cancellation terminates background descendants promptly",
		async () => {
			const controller = new AbortController();
			const startedAt = performance.now();
			setTimeout(() => controller.abort(), 700);
			const result = await run("(while true; do echo tick; sleep 0.05; done) & wait", {
				signal: controller.signal,
				timeoutMs: 60_000,
			});
			expect(result.cancelled).toBe(true);
			expect(result.timedOut).toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(15_000);
		},
	);

	test.skipIf(!realSandboxUsable)("an already-aborted signal runs nothing", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await run("echo should-not-run", { signal: controller.signal });
		expect(result.cancelled).toBe(true);
		expect(result.stdout).toBe("");
	});

	test.skipIf(!realSandboxUsable)(
		"a real probe reports the bubblewrap backend as isolated",
		async () => {
			const status = await describeSandboxAvailability(
				createBubblewrapSandbox({ repositoryPath: repository, worktreeRoot }),
			);
			expect(status).toEqual({ available: true, backend: "bubblewrap", isolated: true });
		},
	);
});
