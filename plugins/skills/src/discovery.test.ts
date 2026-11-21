import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillsConfig } from "./config.ts";
import { scanSkillRoots } from "./discovery.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function fixture(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-skills-scan-"));
	directories.push(directory);
	return directory;
}

async function writeSkill(
	root: string,
	directory: string,
	name: string,
	description: string,
	body = "Body",
): Promise<void> {
	const target = join(root, directory);
	await fs.mkdir(target, { recursive: true });
	await fs.writeFile(
		join(target, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
	);
}

function codes(result: Awaited<ReturnType<typeof scanSkillRoots>>): string[] {
	return result.diagnostics.map((entry) => entry.code).toSorted();
}

describe("scanSkillRoots", () => {
	test("loads valid skills, respects disabled names, and reports diagnostics without paths", async () => {
		const root = await fixture();
		const outside = await fixture();
		await writeSkill(root, "alpha", "alpha", "Alpha skill");
		await writeSkill(root, "beta", "beta", "Beta skill");
		await writeSkill(root, "alpha-copy", "alpha", "Duplicate alpha");
		await writeSkill(root, "mismatch-dir", "document-name", "Mismatched name");
		await writeSkill(outside, "escaped", "escaped", "Escaped skill");
		await fs.mkdir(join(root, "missing"));
		await fs.mkdir(join(root, "bad"));
		await fs.writeFile(join(root, "bad", "SKILL.md"), "---\nname: [unclosed\n---\nBody");
		await fs.mkdir(join(root, "binary"));
		await fs.writeFile(join(root, "binary", "SKILL.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		await fs.mkdir(join(root, ".hidden"));
		await fs.mkdir(join(root, "node_modules"));
		await fs.symlink(join(outside, "escaped"), join(root, "escape-link"));

		const config = parseSkillsConfig({ disabled: ["beta"], paths: [root] });
		const result = await scanSkillRoots(config);
		expect(result.skills.map((skill) => skill.name).toSorted()).toEqual([
			"alpha",
			"beta",
			"document-name",
		]);
		expect(result.skills.find((skill) => skill.name === "alpha")?.enabled).toBe(true);
		const beta = result.skills.find((skill) => skill.name === "beta");
		expect(beta?.enabled).toBe(false);
		expect(codes(result)).toEqual([
			"duplicate_name",
			"escapes_root",
			"invalid_frontmatter",
			"missing_skill_md",
			"name_directory_mismatch",
			"name_directory_mismatch",
			"not_utf8",
		]);
		expect(JSON.stringify(result.diagnostics)).not.toContain(root);
	});

	test("caps the catalog and emits one limit diagnostic", async () => {
		const root = await fixture();
		await writeSkill(root, "alpha", "alpha", "Alpha skill");
		await writeSkill(root, "beta", "beta", "Beta skill");
		const result = await scanSkillRoots(parseSkillsConfig({ paths: [root] }), { maxSkills: 1 });
		expect(result.skills).toHaveLength(1);
		expect(result.diagnostics.filter((entry) => entry.code === "limit_reached")).toHaveLength(1);
	});

	test("reports missing and non-directory roots", async () => {
		const root = await fixture();
		const file = join(root, "file.txt");
		await fs.writeFile(file, "not a root");
		const result = await scanSkillRoots(
			parseSkillsConfig({ paths: [join(root, "missing"), file] }),
		);
		expect(result.roots).toBe(2);
		expect(codes(result)).toEqual(["root_missing", "root_not_directory"]);
		expect(JSON.stringify(result.diagnostics)).not.toContain(root);
	});
});
