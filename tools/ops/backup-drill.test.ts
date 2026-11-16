import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackupDrill } from "@tsukaima/migration";
import { BackupDrillScheduler } from "../../apps/server/src/services/backup-drill-scheduler.ts";
import { createLogger } from "../../apps/server/src/logging.ts";
import { drillOptionsFromEnv, parseBackupDrillArgs } from "./backup-drill.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function dataDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-backup-drill-"));
	directories.push(directory);
	await fs.mkdir(join(directory, "blobs"), { recursive: true });
	for (const name of ["domain.sqlite", "durable.sqlite"]) {
		const database = new Database(join(directory, name), { create: true });
		database.run("PRAGMA journal_mode = WAL");
		database.run(`CREATE TABLE ${name === "domain.sqlite" ? "messages" : "entries"} (id TEXT)`);
		database.run(
			`INSERT INTO ${name === "domain.sqlite" ? "messages" : "entries"} VALUES ('row-1')`,
		);
		database.close();
	}
	await fs.writeFile(join(directory, "blobs", "sticker-one.bin"), "sticker-bytes");
	await fs.mkdir(join(directory, "blobs", "nested"));
	await fs.writeFile(join(directory, "blobs", "nested", "image-two.bin"), "image-bytes");
	return directory;
}

const quietLogger = () =>
	createLogger({ level: "error", sink: () => undefined, target: "tsukaima::test" });

describe("backup drill", () => {
	test("backs up, restores into staging, and verifies SQLite and blob hashes", async () => {
		const dataDir = await dataDirectory();
		const report = await runBackupDrill({
			dataDir,
			now: () => Date.parse("2026-11-14T00:00:00.000Z"),
			runId: "drill-pass",
		});
		expect(report.ok).toBe(true);
		expect(report.backup.databaseFiles).toEqual(["domain.sqlite", "durable.sqlite"]);
		expect(report.manifest.ok).toBe(true);
		expect(report.integrity.domain).toEqual({ ok: true, result: "ok" });
		expect(report.integrity.durable).toEqual({ ok: true, result: "ok" });
		expect(report.blobs).toMatchObject({
			actualFileCount: 2,
			expectedFileCount: 2,
			mediaPresent: true,
			ok: true,
		});
		expect(report.blobs.actualHash).toBe(report.blobs.expectedHash);
		expect(report.restore.restoredFiles).toEqual([
			"domain.sqlite",
			"durable.sqlite",
			"media/nested/image-two.bin",
			"media/sticker-one.bin",
		]);
		const written = JSON.parse(await fs.readFile(report.reportPath, "utf8")) as typeof report;
		expect(written).toEqual(report);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("sticker-bytes");
		expect(serialized).not.toContain("image-bytes");
	});

	test("emits a failing report instead of throwing when a database is missing", async () => {
		const dataDir = await dataDirectory();
		await fs.rm(join(dataDir, "durable.sqlite"));
		const report = await runBackupDrill({ dataDir, runId: "drill-missing" });
		expect(report.ok).toBe(false);
		expect(report.manifest.ok).toBe(true);
		expect(report.integrity.domain?.ok).toBe(true);
		expect(report.integrity.durable).toBeNull();
		expect(await fs.stat(report.reportPath)).toBeTruthy();
	});

	test("scheduler is disabled by default and runs only when enabled or triggered", async () => {
		let runs = 0;
		const disabled = new BackupDrillScheduler({
			intervalMs: 0,
			logger: quietLogger(),
			run: async () => {
				runs += 1;
				return { ok: true };
			},
		});
		disabled.start();
		expect(disabled.running).toBe(false);
		await disabled.trigger();
		expect(runs).toBe(1);

		const enabled = new BackupDrillScheduler({
			intervalMs: 10,
			logger: quietLogger(),
			run: async () => {
				runs += 1;
				return { ok: true };
			},
		});
		enabled.start();
		expect(enabled.running).toBe(true);
		await Bun.sleep(45);
		enabled.stop();
		expect(runs).toBeGreaterThan(1);
		expect(enabled.lastResult?.ok).toBe(true);
		expect(enabled.lastRunAtMs).toBeGreaterThan(0);
	});

	test("CLI parser and environment defaults are data-only and avoid fixed hosts", () => {
		const parsed = parseBackupDrillArgs([
			"--data-dir",
			"/tmp/tsukaima-data",
			"--run-id",
			"cli-run",
			"--keep-staging",
		]);
		expect(parsed).toMatchObject({
			dataDir: "/tmp/tsukaima-data",
			keepStaging: true,
			runId: "cli-run",
		});
		const options = drillOptionsFromEnv(
			{ TSUKAIMA_DATA_DIR: "/tmp/env-data" },
			{
				help: false,
				keepStaging: false,
			},
		);
		expect(options).toEqual({ dataDir: "/tmp/env-data" });
	});
});
