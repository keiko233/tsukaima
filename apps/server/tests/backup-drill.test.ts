import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function temporaryDataDirectory(): Promise<string> {
	const path = await fs.mkdtemp(join(tmpdir(), "tsukaima-server-backup-drill-"));
	directories.push(path);
	return path;
}

const envFor = (dataDir: string): Record<string, string> => ({
	TSUKAIMA_DATA_DIR: dataDir,
	TSUKAIMA_LOG_LEVEL: "error",
	TSUKAIMA_PORT: "7420",
	TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
});

describe("scheduled backup drills", () => {
	test("are disabled by default and can be triggered explicitly", async () => {
		const dataDir = await temporaryDataDirectory();
		const { lifecycle } = createApp(envFor(dataDir));
		expect(lifecycle.backupDrills.enabled).toBe(false);
		await lifecycle.start();
		try {
			expect(lifecycle.backupDrills.running).toBe(false);
			const report = await lifecycle.runBackupDrill("manual-drill");
			expect(report.ok).toBe(true);
			expect(report.integrity.domain?.ok).toBe(true);
			expect(report.integrity.durable?.ok).toBe(true);
			expect(await fs.stat(report.reportPath)).toBeTruthy();
		} finally {
			await lifecycle.stop();
		}
	});

	test("parses the scheduled interval from the environment and rejects invalid values", () => {
		expect(
			loadConfig({
				...envFor("/tmp/tsukaima-drill-config"),
				TSUKAIMA_BACKUP_DRILL_INTERVAL_MS: "0",
			}).backupDrillIntervalMs,
		).toBeUndefined();
		expect(
			loadConfig({
				...envFor("/tmp/tsukaima-drill-config"),
				TSUKAIMA_BACKUP_DRILL_INTERVAL_MS: "3600000",
			}).backupDrillIntervalMs,
		).toBe(3_600_000);
		expect(() =>
			loadConfig({
				...envFor("/tmp/tsukaima-drill-config"),
				TSUKAIMA_BACKUP_DRILL_INTERVAL_MS: "not-a-number",
			}),
		).toThrow("TSUKAIMA_BACKUP_DRILL_INTERVAL_MS");
	});

	test("runs on the configured interval and stops with the lifecycle", async () => {
		const dataDir = await temporaryDataDirectory();
		let runs = 0;
		const { lifecycle } = createApp(envFor(dataDir), {
			backupDrill: {
				intervalMs: 10,
				run: async () => {
					runs += 1;
					return { ok: true };
				},
			},
		});
		await lifecycle.start();
		try {
			expect(lifecycle.backupDrills.running).toBe(true);
			await Bun.sleep(55);
			expect(runs).toBeGreaterThan(0);
		} finally {
			await lifecycle.stop();
		}
		expect(lifecycle.backupDrills.running).toBe(false);
	});
});
