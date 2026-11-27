import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AuditEntry } from "@tsukaima/sdk";
import { ACP_RUNTIME_PACKAGES } from "./config.ts";
import {
	AcpRuntimeInstaller,
	isValidPackageSpec,
	type CommandExecFn,
	type CommandExecOptions,
} from "./installer.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function writeExecutable(filePath: string): Promise<string> {
	await writeFile(filePath, "#!/bin/sh\nexit 0\n");
	await chmod(filePath, 0o755);
	return filePath;
}

async function managedBinary(toolsRootDir: string, binaryName: string): Promise<string> {
	const binDir = join(toolsRootDir, "node_modules", ".bin");
	await mkdir(binDir, { recursive: true });
	return await writeExecutable(join(binDir, binaryName));
}

interface ExecCall {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly signal: AbortSignal | undefined;
}

interface FakeExecOptions {
	readonly delayMs?: number;
	readonly failCommands?: boolean;
	readonly throwOnVersion?: boolean;
}

function createFakeExec(options: FakeExecOptions = {}): {
	readonly calls: ExecCall[];
	readonly exec: CommandExecFn;
	readonly maxConcurrency: () => number;
} {
	const calls: ExecCall[] = [];
	let active = 0;
	let maxConcurrency = 0;
	const exec: CommandExecFn = async (
		command: string,
		args: readonly string[],
		execOptions: CommandExecOptions,
	) => {
		calls.push({
			args: [...args],
			command,
			cwd: execOptions.cwd,
			signal: execOptions.signal,
		});
		if (args[0] === "--version") {
			if (options.throwOnVersion === true) throw new Error("version probe failed");
			return { exitCode: 0, stderr: "", stdout: `${basename(command)} 1.2.3\n` };
		}
		active += 1;
		maxConcurrency = Math.max(maxConcurrency, active);
		try {
			if (options.delayMs !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			}
		} finally {
			active -= 1;
		}
		if (options.failCommands === true) {
			return { exitCode: 1, stderr: "install failed", stdout: "" };
		}
		return { exitCode: 0, stderr: "", stdout: "ok" };
	};
	return { calls, exec, maxConcurrency: () => maxConcurrency };
}

function runtimeById(snapshot: Awaited<ReturnType<AcpRuntimeInstaller["status"]>>, id: string) {
	return snapshot.runtimes.find((runtime) => runtime.id === id);
}

describe("AcpRuntimeInstaller.status", () => {
	test("probes managed binaries before PATH and lists custom packages", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-tools-");
		const pathDir = await tempDir("tsukaima-acp-path-");
		const managedCodex = await managedBinary(toolsRootDir, "codex-acp");
		const managedCustom = await managedBinary(toolsRootDir, "tool-cli");
		await writeExecutable(join(pathDir, "claude-agent-acp"));
		await writeFile(
			join(toolsRootDir, "package.json"),
			`${JSON.stringify(
				{
					dependencies: {
						"@acme/tool-cli": "^2.0.0",
						"@agentclientprotocol/codex-acp": "^1.0.0",
						"../../evil": "1.0.0",
					},
					name: "custom-tools",
					private: true,
				},
				null,
				"\t",
			)}\n`,
		);
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: pathDir,
			toolsRootDir,
		});

		const snapshot = await installer.status();

		expect(snapshot.toolsRootDir).toBe(toolsRootDir);
		expect(snapshot.runtimes).toHaveLength(ACP_RUNTIME_PACKAGES.length);
		expect(runtimeById(snapshot, "codex-acp")).toMatchObject({
			binaryPath: managedCodex,
			source: "managed",
			version: "1.2.3",
		});
		expect(runtimeById(snapshot, "claude-agent-acp")).toMatchObject({
			source: "system",
			version: "1.2.3",
		});
		expect(runtimeById(snapshot, "codex-cli")?.source).toBe("none");
		expect(runtimeById(snapshot, "claude-cli")?.source).toBe("none");
		expect(runtimeById(snapshot, "antigravity-cli")?.source).toBe("none");
		expect(snapshot.customPackages).toHaveLength(1);
		expect(snapshot.customPackages[0]).toMatchObject({
			binaryName: "tool-cli",
			binaryPath: managedCustom,
			packageName: "@acme/tool-cli",
			source: "managed",
			version: "1.2.3",
			versionSpec: "^2.0.0",
		});
		expect(fake.calls.some((call) => call.args[0] === "--version")).toBe(true);
	});

	test("reports managed binaries without a version when the probe fails", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-tools-probe-");
		await managedBinary(toolsRootDir, "codex-acp");
		const fake = createFakeExec({ throwOnVersion: true });
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const snapshot = await installer.status();

		expect(runtimeById(snapshot, "codex-acp")).toMatchObject({ source: "managed" });
		expect(runtimeById(snapshot, "codex-acp")?.version).toBeUndefined();
	});
});

describe("AcpRuntimeInstaller.install", () => {
	test("installs a bun-managed preset and creates the tools package.json", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});
		const controller = new AbortController();

		const result = await installer.install({ id: "codex-acp", signal: controller.signal });

		expect(result).toMatchObject({
			id: "codex-acp",
			ok: true,
			packages: ["@agentclientprotocol/codex-acp"],
		});
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toMatchObject({
			args: ["add", "@agentclientprotocol/codex-acp"],
			command: "bun",
			cwd: toolsRootDir,
			signal: controller.signal,
		});
		const manifest = JSON.parse(await readFile(join(toolsRootDir, "package.json"), "utf8"));
		expect(manifest).toEqual({ name: "tsukaima-acp-tools", private: true });
	});

	test("installs the claude adapter and preserves an existing package.json", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-claude-");
		const existing = {
			dependencies: { existing: "1.0.0" },
			name: "custom-tools",
			private: true,
		};
		await writeFile(
			join(toolsRootDir, "package.json"),
			`${JSON.stringify(existing, null, "\t")}\n`,
		);
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const result = await installer.install({ id: "claude-agent-acp" });

		expect(result.ok).toBe(true);
		expect(fake.calls[0]?.args).toEqual(["add", "@agentclientprotocol/claude-agent-acp"]);
		const manifest = JSON.parse(await readFile(join(toolsRootDir, "package.json"), "utf8"));
		expect(manifest).toEqual(existing);
	});

	test("installs a custom npm package with a version range", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-custom-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const result = await installer.install({ packageName: "@scope/tool@^1.2.3" });

		expect(result).toMatchObject({
			ok: true,
			packageName: "@scope/tool@^1.2.3",
			packages: ["@scope/tool@^1.2.3"],
		});
		expect(fake.calls[0]?.args).toEqual(["add", "@scope/tool@^1.2.3"]);
	});

	test("rejects invalid and malicious package names without running bun", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-invalid-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});
		const invalid = [
			"left-pad && rm -rf /",
			"file:../evil",
			"https://evil.example/pkg.tgz",
			"foo\nbar",
			"--save-dev",
			".hidden",
			"_hidden",
			"foo/bar",
			"@scope/",
			"a;b",
			"",
		];

		for (const packageName of invalid) {
			const result = await installer.install({ packageName });
			expect(result.ok).toBe(false);
		}

		expect(fake.calls).toHaveLength(0);
		expect(isValidPackageSpec("left-pad")).toBe(true);
		expect(isValidPackageSpec("@scope/pkg@1.2.3")).toBe(true);
		expect(isValidPackageSpec("@scope/pkg@>=1.2.3 <2.0.0")).toBe(false);
	});

	test("returns the manual install hint for system runtimes", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-system-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});
		const spec = ACP_RUNTIME_PACKAGES.find((candidate) => candidate.id === "antigravity-cli");

		const result = await installer.install({ id: "antigravity-cli" });

		expect(result.message).toBe(spec?.installHint ?? "");
		expect(result).toMatchObject({
			id: "antigravity-cli",
			ok: false,
			packages: [],
			requiresManualInstall: true,
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("reports bun failures without throwing", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-fail-");
		const fake = createFakeExec({ failCommands: true });
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const result = await installer.install({ id: "codex-acp" });

		expect(result.ok).toBe(false);
		expect(result.message).toContain("install failed");
	});

	test("serializes concurrent package operations", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-install-lock-");
		const fake = createFakeExec({ delayMs: 20 });
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const results = await Promise.all([
			installer.install({ id: "codex-acp" }),
			installer.install({ id: "claude-agent-acp" }),
		]);

		expect(results.every((result) => result.ok)).toBe(true);
		expect(fake.maxConcurrency()).toBe(1);
		expect(fake.calls).toHaveLength(2);
	});
});

describe("AcpRuntimeInstaller.uninstall", () => {
	test("removes bun-managed presets and custom packages", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-uninstall-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const presetResult = await installer.uninstall({ id: "codex-acp" });
		const customResult = await installer.uninstall({ packageName: "left-pad" });

		expect(presetResult.ok).toBe(true);
		expect(customResult.ok).toBe(true);
		expect(fake.calls.map((call) => call.args)).toEqual([
			["remove", "@agentclientprotocol/codex-acp"],
			["remove", "left-pad"],
		]);
	});

	test("refuses to uninstall system runtimes and unknown ids", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-uninstall-system-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const systemResult = await installer.uninstall({ id: "antigravity-cli" });
		const unknownResult = await installer.uninstall({ id: "missing-runtime" });

		expect(systemResult).toMatchObject({ ok: false, requiresManualInstall: true });
		expect(systemResult.message).toContain("OS package manager");
		expect(unknownResult.ok).toBe(false);
		expect(fake.calls).toHaveLength(0);
	});
});

describe("AcpRuntimeInstaller audit", () => {
	test("records successful, manual, and rejected operations", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-audit-");
		const entries: AuditEntry[] = [];
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			audit: {
				record: async (entry) => {
					entries.push(entry);
				},
			},
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		await installer.install({ id: "codex-acp" });
		await installer.install({ id: "antigravity-cli" });
		await installer.install({ packageName: "--save-dev" });

		expect(entries).toHaveLength(3);
		expect(entries[0]).toMatchObject({
			action: "acp.runtime.install",
			actorKind: "user",
			result: "ok",
			targetId: "codex-acp",
			targetKind: "acp-runtime",
		});
		expect(entries[1]).toMatchObject({ result: "failed", targetId: "antigravity-cli" });
		expect(entries[1]?.payload).toMatchObject({ requiresManualInstall: true });
		expect(entries[2]).toMatchObject({ result: "failed", targetId: "--save-dev" });
	});

	test("keeps operations working when audit recording throws", async () => {
		const toolsRootDir = await tempDir("tsukaima-acp-audit-fail-");
		const fake = createFakeExec();
		const installer = new AcpRuntimeInstaller({
			audit: {
				record: async () => {
					throw new Error("audit unavailable");
				},
			},
			exec: fake.exec,
			pathEnv: "",
			toolsRootDir,
		});

		const result = await installer.install({ id: "codex-acp" });

		expect(result.ok).toBe(true);
	});
});
