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
	inspectDshSnapshot,
	mapDshConfigText,
	normalizeSnapshot,
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

describe("captured snapshot ingestion", () => {
	test("remote script extracts each volume as its own tar stream", () => {
		const script = buildSnapshotRemoteScript({
			container: "synthetic-container",
			host: "synthetic-ssh-host",
			project: "/synthetic/project",
		});
		// A tar extractor stops at the first end-of-archive marker, so concatenated volume
		// archives must never share one extractor.
		expect(script).toContain('tar -C / -cf - "${path#/}" | tar -C /out/snapshot -xf -');
		expect(script).not.toContain("done | tar");
	});

	test("reads only files/ from a captured snapshot and never parses its inventory as sessions", async () => {
		const snapshot = join(root, "captured");
		const sessionDir = join(
			snapshot,
			"files/dsh/home/node/.dsh/sessions/--workspace--/session-captured",
		);
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			join(sessionDir, "session.v4.jsonl"),
			[
				JSON.stringify(sessionRecord({ id: "session-captured" })),
				JSON.stringify(event("user/message", 1, { text: "hello", userId: "qq_10001" })),
				JSON.stringify(event("assistant/message", 2, { text: "hi" })),
			].join("\n"),
		);
		await fs.writeFile(join(snapshot, "manifest.json"), JSON.stringify({ version: 1, files: [] }));
		await fs.writeFile(
			join(snapshot, "files.jsonl"),
			`${JSON.stringify({ path: "dsh/home/node/.dsh/sessions/inventory-row", size: 1 })}\n`,
		);
		await fs.writeFile(join(snapshot, "errors.jsonl"), "");
		const source: SnapshotSource = [[snapshot, "snapshot"]];
		const inventory = await inspectDshSnapshot(source);
		expect(inventory.sessions.some((path) => path.endsWith("session.v4.jsonl"))).toBe(true);
		expect(inventory.sessions.some((path) => path.endsWith("files.jsonl"))).toBe(false);
		const normalized = await normalizeSnapshot(source);
		expect(normalized.database.conversations).toHaveLength(1);
		expect(normalized.database.conversations[0]?.sourceId).toBe("session-captured");
		expect(normalized.database.messages.length).toBeGreaterThanOrEqual(2);
	});

	test("excludes browser profile and session projection caches by default", async () => {
		const source = join(root, "source");
		await fs.mkdir(join(source, "home/node/.dsh/chrome-profile/Default"), { recursive: true });
		await fs.mkdir(join(source, "home/node/.dsh/storages/session_projcache"), { recursive: true });
		await fs.mkdir(join(source, "home/node/.dsh/sessions"), { recursive: true });
		await fs.writeFile(join(source, "home/node/.dsh/chrome-profile/Default/Preferences"), "{}");
		await fs.writeFile(
			join(source, "home/node/.dsh/storages/session_projcache/sessions.json"),
			"{}",
		);
		await fs.writeFile(join(source, "home/node/.dsh/sessions/keep.jsonl"), "{}");
		const result = await captureSnapshot({
			output: join(root, "out"),
			sources: [[source, "dsh"]],
		});
		expect(result.manifest.files.map((file) => file.path)).toEqual([
			"dsh/home/node/.dsh/sessions/keep.jsonl",
		]);
	});
});

describe("live-shape DSH data", () => {
	test("maps array-shaped preset configs and redacts their credentials", () => {
		const mapped = mapDshConfigText(
			[
				"- id: preset-dsh-napcat-qq-chat",
				"  name: '@deepseek-ai/dsh-agent-preset'",
				"  config:",
				"    id: qq-chat",
				"    name: QQ 聊天（拟人）",
				"    plugins:",
				"      - id: persona",
				"        config:",
				"          prefix: 你在 QQ 上聊天。",
				"      - id: dsh-napcat",
				"        config:",
				"          groupPolicy: open",
				"          accessToken: SYNTHETIC-TOKEN-DO-NOT-IMPORT",
			].join("\n"),
			"cordis.patch.yml",
		);
		expect(mapped.settings.length).toBeGreaterThan(0);
		expect(mapped.settings.some((setting) => setting.category === "napcat")).toBe(true);
		expect(JSON.stringify(mapped)).not.toContain("SYNTHETIC-TOKEN-DO-NOT-IMPORT");
	});

	test("merges QQ prompt history, keeps visible text, and resolves content-block images", async () => {
		const source = join(root, "qq-source");
		const sessionDir = join(
			source,
			"home/node/.dsh/sessions/--workspace-napcat-group-10001--/napcat-group-10001-s1",
		);
		await fs.mkdir(sessionDir, { recursive: true });
		const sha = "a".repeat(64);
		const prompt = [
			"这个会话来自 QQ（NapCat 渠道），聊天对象是 group:10001。",
			"",
			"【最近群聊（背景，用于理解话题，不要逐条回应）】",
			"11:58 Alice(123456): 你好",
			"",
			"我来补一句",
			"11:59 蓝肥鱼: 我自己说过的",
			"11:59 Alice(123456): [图片:napcat-inbox/imgs/x.png]",
			"",
			"【发图/发表情】",
			"不要照抄这段指令。",
		].join("\n");
		await fs.writeFile(
			join(sessionDir, "session.v4.jsonl"),
			[
				JSON.stringify(
					sessionRecord({
						createdAt: Date.UTC(2026, 0, 1, 12, 0, 0),
						cwd: "/workspace/napcat/group-10001",
						id: "napcat-group-10001-s1",
					}),
				),
				JSON.stringify(
					event("user/message", 1, {
						content: [
							{ text: prompt, type: "text" },
							{
								attachment: {
									attachmentId: `sha256:${sha}`,
									bytes: 11,
									mediaType: "image/png",
									name: "content.png",
								},
								type: "image",
							},
						],
						id: "prompt-1",
						role: "user",
						source: { kind: "plugin:dsh-napcat" },
					}),
				),
				JSON.stringify(
					event("assistant/message", 2, {
						id: "assistant-1",
						message: {
							content: [
								{ text: "SECRET-REASONING", type: "reasoning" },
								{ text: "你好呀", type: "text" },
							],
							role: "assistant",
						},
					}),
				),
			].join("\n"),
		);
		await fs.mkdir(join(source, "workspace/napcat/group-10001/napcat-inbox/imgs"), {
			recursive: true,
		});
		await fs.writeFile(
			join(source, "workspace/napcat/group-10001/napcat-inbox/imgs/x.png"),
			"inline-image",
		);
		await fs.mkdir(join(source, "home/node/.dsh/attachments/v1/objects/aa"), {
			recursive: true,
		});
		await fs.writeFile(
			join(source, `home/node/.dsh/attachments/v1/objects/aa/${sha}`),
			"content-image",
		);
		await fs.writeFile(
			join(source, "workspace/napcat/people-index.jsonl"),
			`${JSON.stringify({ at: 1, chatKey: "group:10001", nick: "Alice", userId: "123456" })}\n`,
		);
		await fs.mkdir(join(source, "home/.dsh/profiles/web"), { recursive: true });
		await fs.writeFile(
			join(source, "home/.dsh/profiles/web/cordis.patch.yml"),
			["plugins:", "  dsh-napcat:", "    config:", '      selfAliases: "蓝肥鱼"'].join("\n"),
		);
		await fs.mkdir(join(source, "workspace/memory/group-10001"), { recursive: true });
		await fs.writeFile(
			join(source, "workspace/memory/group-10001/items.json"),
			JSON.stringify({
				items: [
					{ kind: "fact", score: 0.9, text: "Synthetic memory one" },
					{ kind: "glossary", score: 0.8, text: "Synthetic memory two" },
				],
			}),
		);
		await fs.writeFile(
			join(source, "workspace/memory/group-10001/summary.json"),
			JSON.stringify({ text: "Synthetic group summary" }),
		);
		await fs.mkdir(
			join(
				source,
				"workspace/work/aya-snapshot/backups/archive-sessions-20260101/napcat-archive-group:10001",
			),
			{ recursive: true },
		);
		await fs.writeFile(
			join(
				source,
				"workspace/work/aya-snapshot/backups/archive-sessions-20260101/napcat-archive-group:10001/session.v4.jsonl",
			),
			"{not-a-session",
		);
		const result = await normalizeSnapshot([[source, "snapshot"]]);
		const db = result.database;
		expect(result.diagnostics.errors).toHaveLength(0);
		const conversation = db.conversations.find(
			(candidate) => candidate.sourceId === "napcat-group-10001",
		);
		expect(conversation?.platformConversationId).toBe("10001");
		expect(conversation?.createdAt.startsWith("1970")).toBe(false);
		const messages = db.messages.filter(
			(message) => message.conversationId === conversation?.canonicalId,
		);
		const inbound = messages.filter((message) => message.direction === "inbound");
		expect(inbound.find((message) => message.content.startsWith("你好"))?.content).toContain(
			"我来补一句",
		);
		expect(inbound.some((message) => message.content.includes("我自己说过的"))).toBe(false);
		const hello = inbound.find((message) => message.content.startsWith("你好"));
		expect(hello?.content).toContain("我来补一句");
		expect(hello?.senderExternalId).toBe("123456");
		expect(messages.filter((message) => message.direction === "outbound")).toHaveLength(1);
		expect(messages.some((message) => message.content === "你好呀")).toBe(true);
		expect(JSON.stringify(messages)).not.toContain("SECRET-REASONING");
		expect(inbound.find((message) => message.content === "[图片]")?.attachments.length).toBe(2);
		expect(db.attachments.every((attachment) => attachment.fileHash)).toBe(true);
		const memories = db.memories.filter(
			(memory) => memory.conversationId === conversation?.canonicalId,
		);
		expect(memories.length).toBeGreaterThanOrEqual(3);
		expect(memories.some((memory) => memory.kind === "summary")).toBe(true);
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

	test("parseSessionV4Bytes decompresses zstd frames instead of parsing them as text", async () => {
		const lines = [
			JSON.stringify(sessionRecord({ id: "session-bytes-zstd" })),
			JSON.stringify(event("user/message", 1, { text: "hello", userId: "qq_10001" })),
			JSON.stringify(event("assistant/message", 2, { text: "hi" })),
		];
		const compressed = Bun.zstdCompressSync(Buffer.from(lines.join("\n")));
		const parsed = await parseSessionV4Bytes(compressed, {
			sessionIdFallback: "session-bytes-zstd",
		});
		expect(parsed.session?.version).toBe(4);
		expect(parsed.session?.messages).toHaveLength(2);
		expect(parsed.diagnostics.malformedRecords).toBe(0);
		expect(parsed.diagnostics.errors).toHaveLength(0);
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

	test("keeps memory-space ids unique instead of collapsing live spaces", async () => {
		const source = join(root, "memory-spaces");
		for (const space of ["group-20001", "group-20002"]) {
			await fs.mkdir(join(source, "workspace/memory", space), { recursive: true });
			await fs.writeFile(
				join(source, "workspace/memory", space, "items.json"),
				JSON.stringify({
					items: [{ kind: "fact", score: 0.7, text: `Synthetic memory for ${space}` }],
				}),
			);
			await fs.writeFile(
				join(source, "workspace/memory", space, "summary.json"),
				JSON.stringify({ text: `Synthetic summary for ${space}` }),
			);
		}
		const result = await importDshMemory([[source, "dsh"]] as SnapshotSource);
		expect(result.memories).toHaveLength(4);
		expect(new Set(result.memories.map((memory) => memory.canonicalId)).size).toBe(4);
		expect(
			result.memories.some(
				(memory) => memory.conversationId === "dsh_conversation_napcat-group-20001",
			),
		).toBe(true);
		expect(
			result.memories.some(
				(memory) => memory.conversationId === "dsh_conversation_napcat-group-20002",
			),
		).toBe(true);
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
