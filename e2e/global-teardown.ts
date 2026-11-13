import { promises as fs } from "node:fs";
import { readStackRuntime, removeStackRuntime } from "./stack.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopPid(pid: number): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await sleep(100);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

export default async function globalTeardown(): Promise<void> {
	let runtime;
	try {
		runtime = await readStackRuntime();
	} catch {
		return;
	}
	await Promise.all([stopPid(runtime.webPid), stopPid(runtime.serverPid)]);
	await fs.rm(runtime.dataDir, { force: true, recursive: true }).catch(() => undefined);
	await removeStackRuntime();
}
