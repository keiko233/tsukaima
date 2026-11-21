import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GitCli } from "@tsukaima/coding";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_FILES = 250;

function inside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== "" && !isAbsolute(path) && !path.split(sep).includes("..");
}

async function readCode(root: string, path: string) {
	const unavailable = { code: null, truncated: false };
	const target = resolve(root, path);
	if (!inside(root, target) || path.split("/").includes(".git")) return unavailable;
	const resolved = await realpath(target).catch(() => undefined);
	if (resolved !== target) return unavailable;
	const file = await open(
		target,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	).catch(() => undefined);
	if (file === undefined) return unavailable;
	try {
		if (
			process.platform === "linux" &&
			(await realpath(`/proc/self/fd/${file.fd}`).catch(() => undefined)) !== target
		) {
			return unavailable;
		}
		if (!(await file.stat()).isFile()) return unavailable;
		const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const content = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES));
		if (content.includes(0)) return unavailable;
		return { code: content.toString("utf8"), truncated: bytesRead > MAX_FILE_BYTES };
	} finally {
		await file.close();
	}
}

export async function inspectWorkspaceGit(worktree: string, path?: string) {
	const root = await realpath(worktree).catch(() => undefined);
	if (root === undefined) return null;
	const git = new GitCli({
		baseEnv: { GIT_OPTIONAL_LOCKS: "0", PATH: process.env.PATH ?? "/usr/bin:/bin" },
		repositoryPath: root,
		timeoutMs: 5_000,
	});
	const prefix = ["-c", "core.fsmonitor=false", "--literal-pathspecs"];
	const status = await git.exec([
		...prefix,
		"status",
		"--porcelain=v1",
		"-z",
		"--no-renames",
		"--ignore-submodules=all",
		"--untracked-files=all",
	]);
	if (status.exitCode !== 0) throw new Error("Unable to read workspace Git status");
	const entries = status.stdout.split("\0").slice(0, -1);
	const files = entries.slice(0, MAX_FILES).map((entry) => ({
		path: entry.slice(3),
		status: entry.slice(0, 2),
	}));
	const truncated =
		status.stdoutTruncated ||
		(!status.stdout.endsWith("\0") && status.stdout !== "") ||
		entries.length > MAX_FILES;
	if (path === undefined || !files.some((file) => file.path === path)) {
		return { file: null, files, truncated };
	}
	const [patch, source] = await Promise.all([
		git.exec(
			[...prefix, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", path],
			{ maxOutputBytes: MAX_FILE_BYTES + 1 },
		),
		readCode(root, path),
	]);
	if (patch.exitCode !== 0) throw new Error("Unable to read workspace Git diff");
	return {
		file: {
			code: source.code,
			diff: patch.stdout.slice(0, MAX_FILE_BYTES),
			truncated: source.truncated || patch.stdoutTruncated || patch.stdout.length > MAX_FILE_BYTES,
		},
		files,
		truncated,
	};
}
