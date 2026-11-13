import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { memories, openDomainDatabase } from "@tsukaima/db";
import { createPipeline, inspectDshSnapshot, normalizeSnapshot } from "./index.ts";

const testRoot = join(import.meta.dir, "../../../.test-data/migration-kit");
let snapshotRoot: string;

beforeEach(async () => {
	await fs.rm(testRoot, { force: true, recursive: true });
	snapshotRoot = join(testRoot, "snapshot");
	await fs.mkdir(join(snapshotRoot, "sessions"), { recursive: true });
	await fs.mkdir(join(snapshotRoot, "personas"), { recursive: true });
	await fs.mkdir(join(snapshotRoot, "memory"), { recursive: true });
	await fs.mkdir(join(snapshotRoot, "stickers"), { recursive: true });
	await fs.mkdir(join(snapshotRoot, "settings"), { recursive: true });
	await fs.writeFile(
		join(snapshotRoot, "sessions/napcat-private-10001.jsonl"),
		[
			JSON.stringify({
				id: "napcat-private-10001",
				title: "Private chat",
				type: "private",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:01:00.000Z",
				messages: [
					{ id: "m1", role: "user", content: "Hello", timestamp: 1767225600000 },
					{ id: "m2", role: "assistant", content: "Hi there", timestamp: 1767225660000 },
				],
			}),
		].join("\n"),
	);
	await fs.writeFile(
		join(snapshotRoot, "personas/personas.json"),
		JSON.stringify([
			{
				id: "tsukaima",
				name: "Tsukaima",
				summary: "Primary persona",
				prompt: "Be friendly",
				behavior: { reply: "concise" },
				conversationIds: ["napcat-private-10001"],
			},
		]),
	);
	await fs.writeFile(
		join(snapshotRoot, "memory/memories.json"),
		JSON.stringify([
			{
				id: "fact-1",
				content: "The user likes tea",
				summary: "Tea preference",
				conversationId: "napcat-private-10001",
				confidence: 0.9,
			},
		]),
	);
	await fs.writeFile(
		join(snapshotRoot, "stickers/stickers.json"),
		JSON.stringify([{ id: "wave", name: "Wave", mimeType: "image/webp", sizeBytes: 128 }]),
	);
	await fs.writeFile(
		join(snapshotRoot, "settings/settings.json"),
		JSON.stringify({
			enableReply: true,
		}),
	);
});

afterEach(async () => {
	await fs.rm(testRoot, { force: true, recursive: true });
});

describe("DSH migration kit", () => {
	test("inspects and normalizes a complete snapshot", async () => {
		const inventory = await inspectDshSnapshot([[snapshotRoot, "snapshot"]]);
		expect(inventory.sessions).toHaveLength(1);
		const result = await normalizeSnapshot([[snapshotRoot, "snapshot"]]);
		expect(result.plan.users).toBe(2);
		expect(result.plan.conversations).toBe(1);
		expect(result.plan.messages).toBe(2);
		expect(result.plan.personas).toBe(1);
		expect(result.plan.memories).toBe(1);
		expect(result.plan.stickers).toBe(1);
	});

	test("does not classify structural key fields as settings secrets", async () => {
		await fs.writeFile(
			join(snapshotRoot, "settings/settings.json"),
			JSON.stringify({
				chatKey: "group_1",
				dayKey: "2026-01-01",
				sessionKey: "session-1",
				primaryKey: "id",
				cacheKey: "cache",
				sortKey: "name",
				foreignKey: "other",
				accessToken: "synthetic-secret-value",
			}),
		);
		const result = await normalizeSnapshot([[snapshotRoot, "snapshot"]]);
		expect(result.database.settings[0]?.secretsDetected).toEqual(["$.accessToken"]);
	});

	test("imports, verifies, and rolls back through the domain database", async () => {
		const source: [[string, string]] = [[snapshotRoot, "snapshot"]];
		const pipeline = createPipeline(`sqlite:${join(testRoot, "domain.sqlite")}`);
		const plan = await pipeline.dryRun(source);
		expect(plan.messages).toBe(2);

		const imported = await pipeline.import(source, { dryRunPlan: plan });
		expect(imported.messages).toBe(2);
		expect(imported.memories).toBe(2);
		const importedDatabase = await openDomainDatabase(join(testRoot, "domain.sqlite"));
		try {
			const memoryRows = await importedDatabase.select().from(memories);
			expect(memoryRows).toHaveLength(2);
			expect(memoryRows.every((row) => row.status === "active")).toBe(true);
			expect(memoryRows.every((row) => row.pinned === 0)).toBe(true);
			expect(memoryRows.every((row) => row.extractionPromptVersion === "dsh-migration-v1")).toBe(
				true,
			);
		} finally {
			importedDatabase.$client.close();
		}
		const verified = await pipeline.verify(source);
		expect(verified.ok).toBe(true);

		await pipeline.rollback(imported.runId);
		const afterRollback = await pipeline.verify(source);
		expect(afterRollback.ok).toBe(false);
		expect(afterRollback.actualCounts.messages).toBe(0);
	});
});
