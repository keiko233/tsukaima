import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PATH_ALLOWLIST,
	scanContent,
	scanRepository,
	type PathAllowlistEntry,
} from "./secret-scan.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-secret-scan-"));
	directories.push(directory);
	return directory;
}

/** Build fake values at runtime so this test file itself never contains a scannable literal. */
function fixture(...parts: readonly string[]): string {
	return parts.join("");
}

describe("secret scanner", () => {
	test("passes the real repository without findings", async () => {
		const result = await scanRepository({
			pathAllowlist: DEFAULT_PATH_ALLOWLIST,
			root: join(import.meta.dir, "../.."),
		});
		expect(result.filesScanned).toBeGreaterThan(0);
		expect(result.findings).toEqual([]);
	});

	test("detects private keys, cloud tokens, JWTs, credentials, and connection strings", () => {
		const content = [
			fixture("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
			fixture("AKIA", "IOSFODNN7EXAMPLE"),
			fixture("ghp_", "A".repeat(36)),
			fixture("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".signature-0123456789"),
			`apiKey: "${fixture("Ab9", "xY7", "Q2m", "N4p", "R8t", "V6w")}"`,
			fixture("postgres://app:", "S3cretPassw0rd!", "@db.internal:5432/app"),
		].join("\n");
		const rules = scanContent("deployment/secrets.ts", content).map((finding) => finding.rule);
		expect(rules).toContain("private-key");
		expect(rules).toContain("aws-access-key");
		expect(rules).toContain("github-token");
		expect(rules).toContain("jwt");
		expect(rules).toContain("credential-assignment");
		expect(rules).toContain("connection-string-with-password");
	});

	test("detects deployment SSH targets and known secret env values regardless of entropy", () => {
		const target = fixture("root@", "203.0.113.10");
		const weakEnv = fixture("TSUKAIMA_ADMIN_PASSWORD=", "12345687");
		const rules = scanContent("ops/deploy/example.sh", `${target}\n${weakEnv}\n`).map(
			(finding) => finding.rule,
		);
		expect(rules).toContain("deployment-ssh-target");
		expect(rules).toContain("known-secret-env-assignment");
		expect(scanContent("deploy/runtime.env.example", "TSUKAIMA_ADMIN_PASSWORD=\n")).toEqual([]);
	});

	test("ignores placeholders and accepts explicit inline allow markers", () => {
		const placeholder = 'password: "change-me-please"';
		expect(scanContent("docs/example.md", placeholder)).toEqual([]);
		expect(
			scanContent("ops/deploy/bootstrap-host.sh", "TSUKAIMA_ADMIN_PASSWORD=$ADMIN_PASSWORD\n"),
		).toEqual([]);
		const allowed = `apiKey = "${fixture("Ab9", "xY7", "Q2m", "N4p", "R8t", "V6w")}" // secret-scan:allow test fixture`;
		expect(scanContent("tools/fixture.ts", allowed)).toEqual([]);
	});

	test("supports a documented path allowlist for fixture directories", () => {
		const allowlist: PathAllowlistEntry[] = [
			{ path: "tests/fixtures/*.json", reason: "Synthetic test fixtures are generated, not live." },
		];
		const content = `const token = "${fixture("Ab9", "xY7", "Q2m", "N4p", "R8t", "V6w")}";`;
		expect(scanContent("tests/fixtures/login.json", content, allowlist)).toEqual([]);
		expect(scanContent("apps/server/config.json", content, allowlist)).not.toEqual([]);
	});

	test("flags forbidden sensitive files but permits the documented env template", () => {
		expect(scanContent(".env", "LOG_LEVEL=info\n")[0]?.rule).toBe("forbidden-sensitive-file:.env");
		expect(scanContent("deploy/tls/server.pem", "irrelevant\n")[0]?.rule).toBe(
			"forbidden-sensitive-file:key-or-database",
		);
		expect(scanContent(".env.example", "TSUKAIMA_AUTH_SECRET=\n")).toEqual([]);
	});

	test("reports clean and leaking repository trees", async () => {
		const root = await temporaryDirectory();
		await fs.writeFile(join(root, "README.md"), "# Safe example\nNo credentials here.\n");
		const clean = await scanRepository({ files: ["README.md"], root });
		expect(clean).toEqual({ filesScanned: 1, findings: [] });

		await fs.mkdir(join(root, "config"), { recursive: true });
		await fs.writeFile(
			join(root, "config", "leak.ts"),
			`const token = "${fixture("ghp_", "B".repeat(40))}";\n`,
		);
		const leaking = await scanRepository({ files: ["README.md", "config/leak.ts"], root });
		expect(leaking.findings).toHaveLength(2);
		expect(leaking.findings.map((finding) => finding.path)).toEqual([
			"config/leak.ts",
			"config/leak.ts",
		]);
		expect(leaking.findings.map((finding) => finding.rule)).toContain("github-token");
	});
});
