import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildRemoteAuditCommand, buildRemoteAuditScript } from "../src/remote-baseline.ts";

const root = join(import.meta.dir, "..");
const repoRoot = join(import.meta.dir, "../../..");
const cli = join(root, "src/cli.ts");
const baselineFixture = join(repoRoot, "packages/migration/fixtures/dsh-baseline");
const baselineConfig = join(baselineFixture, "home/.dsh/profiles/web/cordis.patch.yml");

async function fixtureSecretValues(): Promise<string[]> {
	const config = await fs.readFile(baselineConfig, "utf8");
	return [...config.matchAll(/SYNTHETIC-[A-Z0-9-]+/g)].map((match) => match[0]);
}

function auditEnvironment(
	overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	for (const key of ["DSH_AUDIT_HOST", "DSH_AUDIT_PROJECT", "DSH_AUDIT_CONTAINER"]) {
		delete environment[key];
	}
	return { ...environment, ...overrides };
}

describe("migration CLI", () => {
	test("shows help and defaults import to dry-run", async () => {
		const help = Bun.spawnSync(["bun", "run", cli, "--help"], { cwd: root });
		expect(help.exitCode).toBe(0);
		expect(JSON.parse(help.stdout.toString()).commands).toContain("import");
		expect(JSON.parse(help.stdout.toString()).commands).toContain("baseline");

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

	test("emits the ten-part baseline from a local snapshot with CLI target flags", async () => {
		const result = Bun.spawnSync(
			[
				"bun",
				"run",
				cli,
				"baseline",
				"--source",
				baselineFixture,
				"--host",
				"flag-host",
				"--project",
				"/flag/project",
				"--container",
				"flag-container",
			],
			{ cwd: root, env: auditEnvironment() },
		);
		expect(result.exitCode).toBe(0);
		const output = result.stdout.toString();
		const baseline = JSON.parse(output);
		expect(Object.keys(baseline.inventory)).toEqual([
			"versions",
			"profile",
			"plugins",
			"configuration",
			"tools",
			"memory",
			"memePacks",
			"schedules",
			"sessions",
			"ledgers",
		]);
		expect(baseline.target).toEqual({
			host: "flag-host",
			project: "/flag/project",
			container: "flag-container",
		});
		for (const secret of await fixtureSecretValues()) {
			expect(output).not.toContain(secret);
		}
	});

	test("builds a remote audit command from the supplied target without a baked-in host", () => {
		expect(
			buildRemoteAuditCommand({
				host: "synthetic-ssh-host",
				project: "/synthetic/project",
				container: "synthetic-container",
			}),
		).toEqual(["ssh", "synthetic-ssh-host", "bash", "-s"]);
	});

	test("targets the live DSH paths and inspects them inside the container with Node", () => {
		const script = buildRemoteAuditScript({
			host: "synthetic-ssh-host",
			project: "/synthetic/project",
			container: "synthetic-container",
		});
		expect(script).toContain("/workspace/.dsh/meme-packs");
		expect(script).toContain("/workspace/.mnemon");
		expect(script).toContain(
			'docker exec -i -e DSH_IMAGE="$image" "$container" node --experimental-sqlite --no-warnings -',
		);
		expect(script).not.toContain('docker exec "$container" cat');
	});

	test("reads the audit target from environment variables and has no baked-in defaults", () => {
		const fromEnvironment = Bun.spawnSync(
			["bun", "run", cli, "baseline", "--source", baselineFixture],
			{
				cwd: root,
				env: auditEnvironment({
					DSH_AUDIT_HOST: "env-host",
					DSH_AUDIT_PROJECT: "/env/project",
					DSH_AUDIT_CONTAINER: "env-container",
				}),
			},
		);
		expect(fromEnvironment.exitCode).toBe(0);
		expect(JSON.parse(fromEnvironment.stdout.toString()).target).toEqual({
			host: "env-host",
			project: "/env/project",
			container: "env-container",
		});

		const noTarget = Bun.spawnSync(["bun", "run", cli, "baseline", "--source", baselineFixture], {
			cwd: root,
			env: auditEnvironment(),
		});
		expect(noTarget.exitCode).toBe(0);
		expect(JSON.parse(noTarget.stdout.toString()).target).toEqual({
			host: null,
			project: null,
			container: null,
		});
	});
});
