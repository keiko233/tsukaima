import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runGlobalSnapshotDrill } from "./global-snapshot.ts";

const blobHash = new Bun.CryptoHasher("sha256").update("synthetic-png-bytes").digest("hex");

async function syntheticDataDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(join(tmpdir(), prefix));
	// Domain store with one conversation and one media row.
	const domain = new Database(join(dir, "domain.sqlite"));
	domain.exec(`
		CREATE TABLE conversations (
			id TEXT PRIMARY KEY,
			durable_conversation_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active'
		);
		CREATE TABLE media (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, kind TEXT NOT NULL);
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
		);
		INSERT INTO conversations VALUES ('session-1', '9001', 'private', 'active');
		INSERT INTO media VALUES ('blob-1', '${blobHash}', 'image');
		INSERT INTO messages VALUES ('msg-1', 'session-1');
	`);
	domain.close();
	// Durable store that agrees with the domain pointer.
	const durable = new Database(join(dir, "durable.sqlite"));
	durable.exec("CREATE TABLE tsukaima_conversations (id INTEGER PRIMARY KEY)");
	durable.exec("INSERT INTO tsukaima_conversations VALUES (9001)");
	durable.close();
	// Plugin store plus the referenced blob.
	const plugins = join(dir, "plugins");
	await fs.mkdir(plugins, { recursive: true });
	const plugin = new Database(join(plugins, "proactive_scheduler.sqlite"));
	plugin.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY)");
	plugin.close();
	const blobs = join(dir, "blobs");
	await fs.mkdir(blobs, { recursive: true });
	await fs.writeFile(join(blobs, blobHash), "synthetic-png-bytes");
	return dir;
}

describe("global snapshot drill", () => {
	test("captures all stores, verifies cross-store consistency, and rehearses cutover", async () => {
		const dataDir = await syntheticDataDir("tsukaima-global-ok-");
		try {
			const report = await runGlobalSnapshotDrill({
				dataDir,
				runId: "global-ok-1",
			});
			expect(report.ok).toBe(true);
			expect(report.sqlite.stores).toEqual([
				"domain.sqlite",
				"durable.sqlite",
				"plugins/proactive_scheduler.sqlite",
			]);
			expect(report.sqlite.integrity["domain.sqlite"]?.ok).toBe(true);
			expect(report.sqlite.foreignKeys["durable.sqlite"]?.ok).toBe(true);
			expect(report.crossStore.durableConversationsKnownToDomain.ok).toBe(true);
			expect(report.crossStore.mediaBlobsPresent).toMatchObject({ ok: true });
			expect(report.files).toBe(4);
			expect(report.cutover).toMatchObject({ rehearsed: true, rolledBack: true });
			expect(report.cutover.journalPath !== null).toBe(true);
			// The captured generation really contains everything.
			const generation = report.snapshotGeneration;
			if (generation === null) throw new Error("generation missing");
			await fs.access(join(generation, "domain.sqlite"));
			await fs.access(join(generation, "blobs", blobHash));
			await fs.access(join(generation, "plugins", "proactive_scheduler.sqlite"));
		} finally {
			await fs.rm(dataDir, { force: true, recursive: true });
		}
	});

	test("fails closed when a referenced blob is missing or a durable id is unknown", async () => {
		const dataDir = await syntheticDataDir("tsukaima-global-bad-");
		try {
			// Remove the referenced blob: completeness must fail, not silently pass.
			await fs.rm(join(dataDir, "blobs", blobHash));
			const report = await runGlobalSnapshotDrill({ dataDir, runId: "global-bad-1" });
			expect(report.ok).toBe(false);
			expect(report.crossStore.mediaBlobsPresent.ok).toBe(false);
			expect(report.crossStore.mediaBlobsPresent.detail).toContain("1 media row");

			// Restore the blob but drop both rows: with no durable id left, the domain media row
			// still has no conversation, and the pair must fail the aggregate gate via blob checks.
			await fs.writeFile(join(dataDir, "blobs", blobHash), "synthetic-png-bytes");
			const durable = new Database(join(dataDir, "durable.sqlite"));
			durable.exec("DELETE FROM tsukaima_conversations WHERE id = 9001");
			durable.close();
			const desynced = await runGlobalSnapshotDrill({ dataDir, runId: "global-bad-2" });
			expect(desynced.ok).toBe(false);
			// Domain still points at 9001 while the durable store no longer knows it.
			expect(desynced.crossStore.durableConversationsKnownToDomain.ok).toBe(false);
			expect(desynced.crossStore.durableConversationsKnownToDomain.detail).toContain(
				"1 domain pointer",
			);
		} finally {
			await fs.rm(dataDir, { force: true, recursive: true });
		}
	});

	test("invokes the coordinated writer stop and fails on a non-data directory", async () => {
		const dataDir = await syntheticDataDir("tsukaima-global-stop-");
		try {
			let stopped = false;
			const report = await runGlobalSnapshotDrill({
				dataDir,
				runId: "global-stop-1",
				stopWriters: () => {
					stopped = true;
				},
			});
			expect(report.ok).toBe(true);
			expect(stopped).toBe(true);

			const empty = await fs.mkdtemp(join(tmpdir(), "tsukaima-global-empty-"));
			try {
				const failed = await runGlobalSnapshotDrill({ dataDir: empty, runId: "global-empty-1" });
				expect(failed.ok).toBe(false);
				expect(failed.error).toContain("Both domain.sqlite and durable.sqlite are required");
			} finally {
				await fs.rm(empty, { force: true, recursive: true });
			}
		} finally {
			await fs.rm(dataDir, { force: true, recursive: true });
		}
	});
});
