import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface E2eStackRuntime {
	readonly dataDir: string;
	readonly password: string;
	readonly serverPid: number;
	readonly serverUrl: string;
	readonly username: string;
	readonly webPid: number;
	readonly webUrl: string;
}

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const runtimeFile = join(repositoryRoot, ".test-data", "e2e", "stack.json");
export const storageStateFile = join(repositoryRoot, ".test-data", "e2e", "storage-state.json");

export async function readStackRuntime(): Promise<E2eStackRuntime> {
	return JSON.parse(await fs.readFile(runtimeFile, "utf8")) as E2eStackRuntime;
}

export async function writeStackRuntime(runtime: E2eStackRuntime): Promise<void> {
	await fs.mkdir(dirname(runtimeFile), { recursive: true });
	await fs.writeFile(runtimeFile, `${JSON.stringify(runtime, null, "\t")}\n`, { mode: 0o600 });
}

export async function removeStackRuntime(): Promise<void> {
	await Promise.all([
		fs.rm(runtimeFile, { force: true }),
		fs.rm(storageStateFile, { force: true }),
	]);
}
