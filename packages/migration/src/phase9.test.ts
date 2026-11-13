import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
	buildSnapshotRemoteScript,
	captureSnapshot,
	createPipeline,
	DSH_CONFIG_AREAS,
	importDshMemory,
	importDshSchedulesAndRequests,
	mapDshConfigText,
	parseDshMemePacks,
	parseSessionV4Bytes,
	parseSessionV4File,
	sha256File,
	type SnapshotSource,
} from "./index.ts";

const root = join(import.meta.dir, "../../../.test-data/phase9");
const fixtures = join(import.meta.dir, "../fixtures/dsh-baseline");

function sessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "session",
		version: 4,
		id: "session-synthetic-v4",
		createdAt: "2026-01-01T00:00:00.000Z",
		cwd: "/synthetic/workspace",
		customHeader: "preserved",
		...overrides,
	};
}

function event(
	type: string,
	seq: number,
	data: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { type, seq, time: 1767225600000 + seq, data, ...extra };
}

async function writeMemePack(
	directory: string,
	id: string,
	hashSource: string,
	mediaPath: string,
): Promise<void> {
	await fs.mkdir(join(directory, "memes"), { recursive: true });
	await fs.writeFile(
		join(directory, "manifest.json"),
		JSON.stringify({ id, name: id, version: "1.0.0", tags: ["synthetic"] }),
	);
	await fs.writeFile(join(directory, mediaPath), hashSource);
	const database = new Database(join(directory, "index.db"));
	try {
		database.run(
			"CREATE TABLE memes (path TEXT NOT NULL, tag TEXT, file_name TEXT NOT NULL, caption TEXT, keywords TEXT, mtime INTEGER, captioned_at TEXT)",
		);
		database.run(
			"INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES (?, ?, ?, ?, ?)",
			[
				mediaPath,
				"synthetic",
				mediaPath.split("/").at(-1) ?? mediaPath,
				"Synthetic caption",
				"synthetic,fixture",
			],
		);
	} finally {
		database.close();
	}
}

beforeEach(async () => {
	await fs.rm(root, { force: true, recursive: true });
	await fs.mkdir(root, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { force: true, recursive: true });
});

describe("offline DSH snapshot capture", () => {
	test("writes manifest, file hashes, classifications, and redacted structured text", async () => {
		const source = join(root, "source");
		await fs.mkdir(join(source, "home/.dsh/profiles/web"), { recursive: true });
		await fs.mkdir(join(source, "home/.dsh/browser/Cache"), { recursive: true });
		await fs.writeFile(
			join(source, "home/.dsh/profiles/web/cordis.patch.yml"),
			[
				"plugins:",
				"  dsh-napcat:",
				"    config:",
				"      accessToken: SYNTHETIC-PHASE9-SECRET-DO-NOT-LEAK",
				"      url: ws://synthetic-host:3001",
				"      triggerKeywords:",
				"        - synthetic-trigger",
			].join("\n"),
		);
		await fs.writeFile(join(source, "home/.dsh/browser/Cache/data"), "browser cache");
		await fs.writeFile(join(source, "home/.dsh/id_rsa"), "SYNTHETIC-PRIVATE-KEY");
		const output = join(root, "snapshot");
		const result = await captureSnapshot({
			output,
			sources: [[source, "dsh"]],
		});
		expect(result.manifest.counts.files).toBe(1);
		expect(result.manifest.files[0]?.classification).not.toBe("secret");
		expect(result.manifest.files[0]?.ownership).toBe("home");
		expect(result.manifest.files[0]?.sha256).toBe(
			await sha256File(join(output, result.manifest.files[0]!.capturedPath!)),
		);
		expect(result.manifest.files[0]?.modeString).toMatch(/^\d{4}$/);
		const captured = await fs.readFile(
			join(output, result.manifest.files[0]!.capturedPath!),
			"utf8",
		);
		expect(captured).not.toContain("SYNTHETIC-PHASE9-SECRET-DO-NOT-LEAK");
		expect(captured).not.toContain("ws://synthetic-host:3001");
		expect(captured).toContain("synthetic-trigger");
		expect(captured).toContain("[REDACTED]");
		const files = (await fs.readFile(result.filesPath, "utf8")).trim().split("\n");
		expect(files).toHaveLength(1);
		expect(await fs.readFile(result.errorsPath, "utf8")).toBe("");
	});

	test("builds a read-only remote script from flags without baked-in hosts", () => {
		const script = buildSnapshotRemoteScript({
			container: "synthetic-container",
			host: "synthetic-ssh-host",
			project: "/synthetic/project",
		});
		expect(script).toContain("synthetic-container");
		expect(script).toContain("/synthetic/project");
		expect(script).toContain(":ro");
		expect(script).toContain("docker info");
		expect(script).not.toContain("root@");
	});
});

describe("DSH session v4 streaming parser", () => {
	test("decompresses zstd, resumes after malformed records, and preserves unknown fields", async () => {
		const lines = [
			JSON.stringify(sessionRecord()),
			JSON.stringify(
				event(
					"user/message",
					1,
					{ text: "hello", userId: "qq_10001" },
					{ customEventField: "kept" },
				),
			),
			"{not-json",
			JSON.stringify(
				event(
					"assistant/message",
					2,
					{
						text: "hi",
						attachments: [
							{ path: "media/synthetic.png", mimeType: "image/png", sha256: "a".repeat(64) },
						],
					},
					{ sourceEventSeqs: [1] },
				),
			),
			JSON.stringify(event("tool/call", 3, { name: "napcat_list_targets", arguments: { x: 1 } })),
		];
		const path = join(root, "session.v4.jsonl.zstd");
		await fs.writeFile(path, Bun.zstdCompressSync(Buffer.from(lines.join("\n"))));
		const parsed = await parseSessionV4File(path);
		expect(parsed.session?.version).toBe(4);
		expect(parsed.session?.messages).toHaveLength(3);
		expect(parsed.session?.messages[0]?.source.record.customEventField).toBe("kept");
		expect(parsed.diagnostics.malformedRecords).toBe(1);
		expect(parsed.diagnostics.recordsDropped).toBe(1);
		expect(parsed.session?.attachments[0]?.path).toBe("media/synthetic.png");
		expect(parsed.session?.messages[1]?.references.some((ref) => ref.targetSeq === 1)).toBe(true);
		expect(parsed.session?.unknownHeaderFields).toContain("customHeader");
	});

	test("reports unsupported schema versions explicitly instead of importing them", async () => {
		const parsed = await parseSessionV4Bytes(
			new TextEncoder().encode(JSON.stringify(sessionRecord({ version: 3 }))),
		);
		expect(parsed.session).toBeNull();
		expect(parsed.diagnostics.errors[0]?.code).toBe("unsupported_version");
		expect(parsed.diagnostics.supported).toBe(false);
	});
});

describe("DSH config mapper", () => {
	test("covers all ten areas, redacts credentials/URLs, and marks review entries", async () => {
		const text = await fs.readFile(
			join(fixtures, "home/.dsh/profiles/web/cordis.patch.yml"),
			"utf8",
		);
		const mapped = mapDshConfigText(text, "cordis.patch.yml");
		expect(mapped.entries.length).toBeGreaterThan(0);
		expect(Object.keys(mapped.areas)).toEqual([...DSH_CONFIG_AREAS]);
		expect(new Set(mapped.entries.map((entry) => entry.area))).toEqual(new Set(DSH_CONFIG_AREAS));
		expect(mapped.report.counts.remap).toBeGreaterThan(0);
		expect(mapped.report.counts.discard).toBeGreaterThan(0);
		const serialized = JSON.stringify({ entries: mapped.entries, settings: mapped.settings });
		expect(serialized).not.toContain("SYNTHETIC-TEST-SECRET-DO-NOT-LEAK");
		expect(serialized).not.toContain("ws://napcat-synthetic:3001");
		expect(mapped.settings.every((setting) => setting.category !== "unknown")).toBe(true);
	});
});

describe("DSH memory, meme, schedule, and request importers", () => {
	test("maps Mnemon rows, human profiles, and shared memory with provenance", async () => {
		const source = join(root, "memory-source");
		const memoryDir = join(source, "workspace/memory/.mnemon/data/napcat-group-group_20001");
		await fs.mkdir(memoryDir, { recursive: true });
		const memoryDatabase = new Database(join(memoryDir, "mnemon.db"));
		try {
			memoryDatabase.run(
				"CREATE TABLE insights (id TEXT PRIMARY KEY, content TEXT, category TEXT, importance REAL, confidence REAL, created_at TEXT, updated_at TEXT)",
			);
			memoryDatabase.run(
				"INSERT INTO insights VALUES ('memory-1', 'Synthetic group memory', 'fact', 0.8, 0.9, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
			);
		} finally {
			memoryDatabase.close();
		}
		await fs.mkdir(join(source, "workspace/memory/.mnemon/runtime"), { recursive: true });
		await fs.writeFile(
			join(source, "workspace/memory/.mnemon/runtime/memories.json"),
			JSON.stringify({ entries: [{ id: "runtime-1", content: "Synthetic runtime memory" }] }),
		);
		await fs.writeFile(
			join(source, "workspace/memory/shared-memory.md"),
			"Synthetic shared memory\n",
		);
		await fs.mkdir(join(source, "workspace/napcat"), { recursive: true });
		await fs.writeFile(
			join(source, "workspace/napcat/human-profiles.json"),
			JSON.stringify({
				profiles: {
					group_20001: {
						updatedAt: "2026-01-01T00:00:00.000Z",
						interactions: 7,
						proactiveToday: 2,
						dayKey: "2026-01-01",
						unansweredStreak: 1,
						refusedCount: 2,
						activeHours: [9, 11],
						openers: ["hello"],
						warm: true,
					},
				},
			}),
		);
		const result = await importDshMemory([[source, "dsh"]] as SnapshotSource);
		expect(result.memories.some((memory) => memory.content === "Synthetic group memory")).toBe(
			true,
		);
		expect(
			result.memories.find((memory) => memory.content === "Synthetic group memory")?.confidence,
		).toBe(0.9);
		expect(result.spaces).toContain("napcat-group-<id>");
		expect(result.schedulerStates[0]?.inboundCount).toBe(7);
		expect(result.schedulerStates[0]?.dailyCount).toBe(2);
		expect(result.schedulerStates[0]?.activeHoursHistogram["10"]).toBe(1);
	});

	test("deduplicates meme media by SHA-256 and imports packs disabled until verified", async () => {
		const source = join(root, "meme-source");
		await writeMemePack(
			join(source, "workspace/meme-packs/pack-a"),
			"pack-a",
			"synthetic-image-bytes",
			"memes/one.png",
		);
		await writeMemePack(
			join(source, "workspace/meme-packs/pack-b"),
			"pack-b",
			"synthetic-image-bytes",
			"memes/two.png",
		);
		const result = await parseDshMemePacks([[source, "dsh"]] as SnapshotSource);
		expect(result.packs).toHaveLength(2);
		expect(result.items).toHaveLength(2);
		expect(result.media).toHaveLength(1);
		expect(result.deduped).toBe(1);
		expect(result.packs.every((pack) => pack.enabled === false)).toBe(true);
		expect(
			result.items.every((item) => item.enabled === false && item.reviewStatus === "pending"),
		).toBe(true);
	});

	test("maps schedule tasks, skips expired one-shots, and archives requests without replay", async () => {
		const source = join(root, "schedule-source");
		await fs.mkdir(join(source, "workspace/napcat"), { recursive: true });
		await fs.writeFile(
			join(source, "workspace/napcat/schedule.json"),
			JSON.stringify([
				{
					id: "expired-task",
					status: "pending",
					createdAt: 1,
					dueAt: 2,
					repeatEveryMs: 0,
					kind: "message",
				},
				{
					id: "future-task",
					status: "pending",
					createdAt: 1,
					dueAt: 9_999_999_999_999,
					repeatEveryMs: 60_000,
					kind: "reminder",
					prompt: "Synthetic reminder",
					chatKey: "group_20001",
				},
			]),
		);
		await fs.writeFile(
			join(source, "workspace/napcat/friend-requests.jsonl"),
			JSON.stringify({
				kind: "group",
				flag: "add",
				userId: "qq_10001",
				groupId: "group_20001",
				subType: "invite",
				at: "2026-01-01T00:00:00.000Z",
				seenAt: "2026-01-01T00:01:00.000Z",
				decision: "approved",
			}),
		);
		const result = await importDshSchedulesAndRequests([[source, "dsh"]] as SnapshotSource, {
			now: () => 10_000,
		});
		expect(result.tasks).toHaveLength(1);
		expect(result.skippedExpired).toBe(1);
		expect(result.tasks[0]?.prompt).toBe("Synthetic reminder");
		expect(result.requests[0]?.status).toBe("approved");
		expect(result.requests[0]?.resolutionAction).toBe("approve");
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("send");
	});
});

describe("ordered transactional import, verify, and authoritative rollback", () => {
	test("imports idempotently, verifies checksums/secrets/references, and restores the pre-import snapshot", async () => {
		const source = join(root, "import-source");
		await fs.mkdir(join(source, "sessions"), { recursive: true });
		await fs.writeFile(
			join(source, "sessions/napcat-group-group_20001.jsonl"),
			[
				JSON.stringify(sessionRecord({ id: "napcat-group-group_20001" })),
				JSON.stringify(event("user/message", 1, { text: "hello", userId: "qq_10001" })),
				JSON.stringify(event("assistant/message", 2, { text: "hi" })),
			].join("\n"),
		);
		await fs.mkdir(join(source, "home/.dsh/profiles/web"), { recursive: true });
		await fs.writeFile(
			join(source, "home/.dsh/profiles/web/cordis.patch.yml"),
			[
				"plugins:",
				"  dsh-napcat:",
				"    config:",
				"      accessToken: SYNTHETIC-IMPORT-SECRET-DO-NOT-LEAK",
			].join("\n"),
		);
		const sourcePaths = [[source, "dsh"]] as SnapshotSource;
		const databasePath = join(root, "domain.sqlite");
		const pipeline = createPipeline(`sqlite:${databasePath}`, {
			backupDir: join(root, "backups"),
			mediaDir: join(root, "media"),
		});
		const plan = await pipeline.dryRun(sourcePaths);
		expect(JSON.stringify(plan)).not.toContain("SYNTHETIC-IMPORT-SECRET-DO-NOT-LEAK");
		expect(plan.importOrder[0]).toBe("users");
		const first = await pipeline.import(sourcePaths, { dryRunPlan: plan });
		const second = await pipeline.import(sourcePaths, { dryRunPlan: plan });
		expect(second.runId).toBe(first.runId);
		expect(second.messages).toBe(first.messages);
		expect(first.backupHash).toStartWith("sha256:");
		const verified = await pipeline.verify(sourcePaths);
		expect(verified.ok).toBe(true);
		expect(verified.checks.secrets.ok).toBe(true);
		expect(verified.checks.references.ok).toBe(true);
		expect(verified.checks.pluginConfig.ok).toBe(true);
		expect(verified.rendering?.readOnly).toBe(true);
		expect(verified.smokeTurn.ok).toBe(true);
		const database = new Database(databasePath, { readonly: true });
		try {
			const text = JSON.stringify(database.query("SELECT * FROM policies").all());
			expect(text).not.toContain("SYNTHETIC-IMPORT-SECRET-DO-NOT-LEAK");
		} finally {
			database.close();
		}
		const rolledBack = await pipeline.rollback(first.runId);
		expect(rolledBack.mode).toBe("snapshot");
		expect(rolledBack.backupHash).toBe(first.backupHash);
		const after = await pipeline.verify(sourcePaths);
		expect(after.ok).toBe(false);
		expect(after.actualCounts.messages).toBe(0);
	});
});
