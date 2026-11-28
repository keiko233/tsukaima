import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AcpAuthService,
	parseAuthOutput,
	parseAuthStatusOutput,
	type AcpAuthLoginProcess,
} from "./auth.ts";

const createdDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function createFakeLoginProcess(): {
	readonly emitExit: (code: number | null) => void;
	readonly emitOutput: (chunk: string) => void;
	readonly killed: () => boolean;
	readonly process: AcpAuthLoginProcess;
} {
	let exitCode: number | null = null;
	let isKilled = false;
	const outputListeners: Array<(chunk: string) => void> = [];
	const exitListeners: Array<(code: number | null) => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	return {
		emitExit: (code) => {
			exitCode = code;
			for (const listener of exitListeners) listener(code);
		},
		emitOutput: (chunk) => {
			for (const listener of outputListeners) listener(chunk);
		},
		killed: () => isKilled,
		process: {
			get exitCode() {
				return exitCode;
			},
			kill: () => {
				isKilled = true;
			},
			onError: (listener) => {
				errorListeners.push(listener);
			},
			onExit: (listener) => {
				exitListeners.push(listener);
			},
			onOutput: (listener) => {
				outputListeners.push(listener);
			},
		},
	};
}

afterEach(async () => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir !== undefined) await rm(dir, { force: true, recursive: true });
	}
});

describe("ACP auth helpers", () => {
	test("parseAuthOutput extracts URL and device code", () => {
		const parsed = parseAuthOutput(
			"Open this URL: https://auth.openai.com/codex/device\nEnter code: ABCD-1234\n",
		);
		expect(parsed.verificationUri).toBe("https://auth.openai.com/codex/device");
		expect(parsed.userCode).toBe("ABCD-1234");
	});

	test("parseAuthStatusOutput parses claude JSON status", () => {
		const parsed = parseAuthStatusOutput("claude-code", {
			exitCode: 0,
			stderr: "",
			stdout: JSON.stringify({ authMethod: "claudeai", email: "user@example.com", loggedIn: true }),
		});
		expect(parsed.authenticated).toBe(true);
		expect(parsed.detail).toBe("user@example.com · claudeai");
	});
});

describe("AcpAuthService", () => {
	test("starts device login, polls until authorized, and supports cancellation", async () => {
		const root = await tempDir("tsukaima-acp-auth-");
		const binDir = join(root, "bin");
		await mkdir(binDir, { recursive: true });
		await writeFile(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");

		const fakeProc = createFakeLoginProcess();
		const service = new AcpAuthService({
			exec: async () => ({ exitCode: 0, stderr: "", stdout: "Logged in using ChatGPT\n" }),
			initialWaitMs: 50,
			resolvePathBinary: () => undefined,
			spawnLogin: () => {
				queueMicrotask(() => {
					fakeProc.emitOutput(
						"Open https://auth.openai.com/codex/device and enter code: WXYZ-9876\n",
					);
				});
				return fakeProc.process;
			},
			toolsRootDir: root,
		});

		try {
			const status = await service.status("codex");
			expect(status.providers).toHaveLength(1);
			expect(status.providers[0]?.available).toBe(true);
			expect(status.providers[0]?.authenticated).toBe(true);

			const started = await service.startLogin("codex");
			expect(started.status).toBe("pending");
			expect(started.verificationUri).toBe("https://auth.openai.com/codex/device");
			expect(started.userCode).toBe("WXYZ-9876");

			fakeProc.emitExit(0);
			const polled = service.pollLogin("codex");
			expect(polled.status).toBe("authorized");
			expect(service.pollLogin("codex").status).toBe("idle");
		} finally {
			service.dispose();
		}
	});

	test("returns failed when binary is not installed", async () => {
		const root = await tempDir("tsukaima-acp-auth-missing-");
		const service = new AcpAuthService({
			resolvePathBinary: () => undefined,
			toolsRootDir: root,
		});
		const result = await service.startLogin("claude-code");
		expect(result.status).toBe("failed");
		expect(result.message).toContain("not installed");
	});
});
