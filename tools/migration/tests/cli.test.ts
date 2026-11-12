import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const root = "<repo-root>/tools/migration";
const cli = join(root, "src/cli.ts");

describe("migration CLI", () => {
	test("shows help and defaults import to dry-run", async () => {
		const help = Bun.spawnSync(["bun", "run", cli, "--help"], { cwd: root });
		expect(help.exitCode).toBe(0);
		expect(JSON.parse(help.stdout.toString()).commands).toContain("import");

		const directory = await fs.mkdtemp(join(root, "tests/cli-"));
		try {
			await fs.writeFile(join(directory, "session.jsonl"), "");
			const result = Bun.spawnSync(
				["bun", "run", cli, "import", "--source", join(directory, "session.jsonl"), "--dry-run"],
				{ cwd: root },
			);
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toHaveProperty("messages");
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});
});
