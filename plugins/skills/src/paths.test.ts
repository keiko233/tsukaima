import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, normalizeRelative, readFileInside, resolveInside } from "./paths.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function fixture(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-skill-paths-"));
	directories.push(directory);
	return directory;
}

function reason(result: ReturnType<typeof normalizeRelative>): string | undefined {
	return result.ok ? undefined : result.reason;
}

describe("normalizeRelative", () => {
	test("accepts plain relative paths and normalizes separators and empty segments", () => {
		expect(normalizeRelative("docs/readme.md")).toEqual({
			ok: true,
			value: { path: "docs/readme.md", segments: ["docs", "readme.md"] },
		});
		expect(normalizeRelative("docs\\nested//file.txt")).toEqual({
			ok: true,
			value: { path: "docs/nested/file.txt", segments: ["docs", "nested", "file.txt"] },
		});
		expect(normalizeRelative("a/./b")).toEqual({
			ok: true,
			value: { path: "a/b", segments: ["a", "b"] },
		});
	});

	test("rejects invalid, absolute, traversal, hidden, and oversized paths", () => {
		expect(reason(normalizeRelative(undefined))).toBe("invalid_path");
		expect(reason(normalizeRelative(""))).toBe("invalid_path");
		expect(reason(normalizeRelative("a".repeat(513)))).toBe("invalid_path");
		expect(reason(normalizeRelative("a\0b"))).toBe("invalid_path");
		expect(reason(normalizeRelative("/etc/passwd"))).toBe("absolute_path");
		expect(reason(normalizeRelative("C:/Windows/win.ini"))).toBe("absolute_path");
		expect(reason(normalizeRelative("//server/share"))).toBe("absolute_path");
		expect(reason(normalizeRelative("../secret.txt"))).toBe("traversal");
		expect(reason(normalizeRelative("docs/../../secret.txt"))).toBe("traversal");
		expect(reason(normalizeRelative(".hidden"))).toBe("invalid_path");
		expect(reason(normalizeRelative("docs/.hidden"))).toBe("invalid_path");
		expect(reason(normalizeRelative("./"))).toBe("invalid_path");
	});
});

describe("resolveInside and readFileInside", () => {
	test("resolves and reads a file below the root", async () => {
		const root = await fixture();
		await fs.writeFile(join(root, "file.txt"), "hello");
		const resolved = await resolveInside(root, "file.txt");
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(isInside(root, resolved.value.real)).toBe(true);
		expect(resolved.value.bytes).toBe(5);
		expect(await readFileInside(root, "file.txt", 10)).toEqual({
			ok: true,
			value: { bytes: 5, text: "hello" },
		});
	});

	test("reports not_found, not_file, and escapes_root", async () => {
		const root = await fixture();
		const outside = await fixture();
		await fs.mkdir(join(root, "folder"));
		await fs.writeFile(join(outside, "secret.txt"), "synthetic");
		await fs.symlink(join(outside, "secret.txt"), join(root, "link.txt"));

		expect(await resolveInside(root, "missing.txt")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await resolveInside(root, "folder")).toEqual({ ok: false, reason: "not_file" });
		expect(await resolveInside(root, "link.txt")).toEqual({
			ok: false,
			reason: "escapes_root",
		});
	});

	test("rejects oversize files, NUL bytes, and invalid UTF-8", async () => {
		const root = await fixture();
		await fs.writeFile(join(root, "large.txt"), "1234567890");
		await fs.writeFile(join(root, "nul.txt"), Buffer.from("a\0b"));
		await fs.writeFile(join(root, "binary.txt"), Buffer.from([0xff, 0xfe, 0xfd]));

		expect(await readFileInside(root, "large.txt", 5)).toEqual({
			ok: false,
			reason: "too_large",
		});
		expect(await readFileInside(root, "nul.txt", 100)).toEqual({ ok: false, reason: "not_text" });
		expect(await readFileInside(root, "binary.txt", 100)).toEqual({
			ok: false,
			reason: "not_text",
		});
	});
});
