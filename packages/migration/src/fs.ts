import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const hashPrefix = "sha256:";

export function sha256String(value: string): string {
	return hashPrefix + createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
	return (
		hashPrefix +
		createHash("sha256")
			.update(await fs.readFile(path))
			.digest("hex")
	);
}

export async function listFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(path)));
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
	return files;
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}
