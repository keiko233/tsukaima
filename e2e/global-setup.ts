import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	removeStackRuntime,
	repositoryRoot,
	storageStateFile,
	writeStackRuntime,
	type E2eStackRuntime,
} from "./stack.ts";

const START_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a free port"));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

function minimalEnvironment(extra: Record<string, string>): Record<string, string> {
	const keep = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "USER"] as const;
	const env: Record<string, string> = {};
	for (const key of keep) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...extra };
}

function pipeLogs(child: ChildProcess, name: string): { text: () => string } {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 200_000) output = output.slice(-200_000);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > 200_000) output = output.slice(-200_000);
	});
	child.once("exit", (code, signal) => {
		output += `\n[${name}] exited code=${String(code)} signal=${String(signal)}\n`;
	});
	return { text: () => output };
}

async function waitForUrl(
	url: string,
	options: { readonly expectedStatus?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
	let lastError = "not started";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url, { redirect: "manual" });
			if (options.expectedStatus === undefined || response.status === options.expectedStatus) {
				return;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(250);
	}
	throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function writeSignedInStorageState(input: {
	readonly password: string;
	readonly serverUrl: string;
	readonly username: string;
	readonly webUrl: string;
}): Promise<void> {
	const response = await fetch(`${input.serverUrl}/api/auth/sign-in/username`, {
		body: JSON.stringify({ password: input.password, username: input.username }),
		headers: {
			"content-type": "application/json",
			origin: input.webUrl,
		},
		method: "POST",
	});
	if (!response.ok) {
		throw new Error(`E2E administrator sign-in failed with HTTP ${response.status}`);
	}
	const setCookie =
		response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
	const pair = setCookie.split(";")[0] ?? "";
	const separator = pair.indexOf("=");
	if (separator <= 0) throw new Error("E2E sign-in did not return a session cookie");
	const cookie = {
		domain: "127.0.0.1",
		expires: Math.floor(Date.now() / 1000) + 60 * 60,
		httpOnly: true,
		name: pair.slice(0, separator),
		path: "/",
		sameSite: "Lax" as const,
		secure: false,
		value: pair.slice(separator + 1),
	};
	await fs.mkdir(dirname(storageStateFile), { recursive: true });
	await fs.writeFile(
		storageStateFile,
		`${JSON.stringify({ cookies: [cookie], origins: [] }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

async function runScript(
	name: string,
	command: string[],
	cwd: string,
	env: Record<string, string>,
): Promise<void> {
	const child = spawn(command[0] ?? "", command.slice(1), {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const logs = pipeLogs(child, name);
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	if (code !== 0) {
		throw new Error(`${name} failed with exit code ${String(code)}\n${logs.text()}`);
	}
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (child === undefined || child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
		sleep(3_000).then(() => false),
	]);
	if (!exited) child.kill("SIGKILL");
}

export default async function globalSetup(): Promise<void> {
	const dataDir = await fs.mkdtemp(join(tmpdir(), "tsukaima-e2e-"));
	const serverPort = await freePort();
	let webPort = await freePort();
	while (webPort === serverPort) webPort = await freePort();
	const serverUrl = `http://127.0.0.1:${serverPort}`;
	const webUrl = `http://127.0.0.1:${webPort}`;
	const username = `e2e_admin_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const password = randomBytes(18).toString("base64url");
	const authSecret = randomBytes(48).toString("base64url");
	let server: ChildProcess | undefined;
	let web: ChildProcess | undefined;
	const serverLogs = { text: () => "" };
	const webLogs = { text: () => "" };

	try {
		const serverEnv = minimalEnvironment({
			TSUKAIMA_ADMIN_PASSWORD: password,
			TSUKAIMA_ADMIN_USERNAME: username,
			TSUKAIMA_AUTH_SECRET: authSecret,
			TSUKAIMA_DATA_DIR: join(dataDir, "data"),
			TSUKAIMA_HOST: "127.0.0.1",
			TSUKAIMA_LOG_LEVEL: "warn",
			TSUKAIMA_PORT: String(serverPort),
			TSUKAIMA_PUBLIC_URL: serverUrl,
			TSUKAIMA_TRUSTED_ORIGINS: `${webUrl},http://localhost:${webPort}`,
			TSUKAIMA_WEB_ORIGIN: webUrl,
			NODE_ENV: "test",
		});
		server = spawn("bun", ["apps/server/src/main.ts"], {
			cwd: repositoryRoot,
			env: serverEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		serverLogs.text = pipeLogs(server, "server").text;
		await waitForUrl(`${serverUrl}/healthz`, { expectedStatus: 200 });
		await waitForUrl(`${serverUrl}/readyz`, { expectedStatus: 204 });
		await writeSignedInStorageState({ password, serverUrl, username, webUrl });

		await runScript(
			"web-i18n",
			["bun", "run", "scripts/compile-plugin-i18n.ts"],
			join(repositoryRoot, "apps", "web"),
			minimalEnvironment({ NODE_ENV: "test" }),
		);
		const webEnv = minimalEnvironment({
			TSUKAIMA_SERVER_URL: serverUrl,
			NODE_ENV: "test",
		});
		web = spawn(
			"bun",
			[
				join(repositoryRoot, "apps", "web", "node_modules", ".bin", "vite"),
				"--host",
				"127.0.0.1",
				"--port",
				String(webPort),
				"--strictPort",
			],
			{
				cwd: join(repositoryRoot, "apps", "web"),
				env: webEnv,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		webLogs.text = pipeLogs(web, "web").text;
		await waitForUrl(`${webUrl}/login`, { expectedStatus: 200 });

		const runtime: E2eStackRuntime = {
			dataDir,
			password,
			serverPid: server.pid ?? 0,
			serverUrl,
			username,
			webPid: web.pid ?? 0,
			webUrl,
		};
		await writeStackRuntime(runtime);
	} catch (error) {
		await stopChild(web);
		await stopChild(server);
		await fs.rm(dataDir, { force: true, recursive: true }).catch(() => undefined);
		await removeStackRuntime();
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n--- server ---\n${serverLogs.text()}\n--- web ---\n${webLogs.text()}`,
			{ cause: error },
		);
	}
}
