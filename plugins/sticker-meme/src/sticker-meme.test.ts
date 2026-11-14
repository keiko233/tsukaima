import { afterEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LocalModelRegistry,
	pluginManifestSchema,
	type AuditEntry,
	type PluginContext,
	type PluginDatabaseApi,
	type PluginLogger,
	type PluginMediaApi,
	type PluginMediaRecord,
	type PluginMediaStoreInput,
} from "@elaina/sdk";
import { readZipEntries } from "./archive.ts";
import { createAnimatedConverter, tgsToGif, webmToGif } from "./animated.ts";
import {
	normalizeLabels,
	safeRelativePath,
	type StickerItem,
	type StickerSemanticProfile,
} from "./domain.ts";
import { StickerImportService } from "./import-service.ts";
import { LearningService, type LearningSettings } from "./learning.ts";
import { stickerMemeManifest } from "./manifest.ts";

const MIGRATIONS = readdirSync(new URL("../migrations", import.meta.url))
	.filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
	.toSorted()
	.map((file) => ({
		file,
		sql: readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
	}));
import { createStickerReplyTransform } from "./output.ts";
import { StickerProgressTracker } from "./progress.ts";
import { StickerRepository } from "./repository.ts";
import { registerStickerRpc } from "./rpc.ts";
import { StickerSelectionService } from "./selection.ts";
import {
	classifyStickerSemantics,
	createSemanticClassifier,
	extractEmojis,
	resolveSemanticClassifier,
	VisionSemanticClassifier,
} from "./semantic.ts";
import {
	parseTelegramStickerSetReference,
	TelegramStickerClient,
	type TelegramStickerSource,
} from "./telegram.ts";
import { TelegramStickerImportService, type TelegramImportProgress } from "./telegram-import.ts";
import { registerStickerTools } from "./tools.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

class MemoryMedia implements PluginMediaApi {
	readonly bytes = new Map<string, Uint8Array>();
	readonly records = new Map<string, PluginMediaRecord>();
	readonly sha = new Map<string, string>();
	storeCalls = 0;

	async store(input: PluginMediaStoreInput): Promise<PluginMediaRecord> {
		this.storeCalls += 1;
		const hash = createHash("sha256").update(input.bytes).digest("hex");
		const existing = this.sha.get(hash);
		if (existing !== undefined) {
			const record = this.records.get(existing);
			if (record !== undefined) return record;
		}
		const id = `media-${this.records.size + 1}`;
		const record: PluginMediaRecord = {
			createdAt: new Date(0).toISOString(),
			durationMs: input.durationMs ?? null,
			expiresAt: input.expiresAt ?? null,
			height: input.height ?? null,
			id,
			kind: input.kind,
			mimeType: input.mimeType ?? "image/png",
			sha256: hash,
			sizeBytes: input.bytes.byteLength,
			source: input.source ?? "webui",
			width: input.width ?? null,
		};
		this.records.set(id, record);
		this.bytes.set(id, input.bytes);
		this.sha.set(hash, id);
		return record;
	}

	async findById(mediaId: string): Promise<PluginMediaRecord | undefined> {
		return this.records.get(mediaId);
	}

	async findBySha(hash: string): Promise<PluginMediaRecord | undefined> {
		const id = this.sha.get(hash);
		return id === undefined ? undefined : this.records.get(id);
	}

	async readBytes(mediaId: string): Promise<Uint8Array> {
		const bytes = this.bytes.get(mediaId);
		if (bytes === undefined) throw new Error("missing media");
		return bytes;
	}

	remove(mediaId: string): void {
		const record = this.records.get(mediaId);
		if (record !== undefined) this.sha.delete(record.sha256);
		this.records.delete(mediaId);
		this.bytes.delete(mediaId);
	}
}

function createDatabase(): PluginDatabaseApi {
	const database = new Database(":memory:");
	database.run("PRAGMA foreign_keys = ON");
	for (const migration of MIGRATIONS) database.run(migration.sql);
	return {
		async exec(sql) {
			database.run(sql);
		},
		prefix: "plugin_sticker_meme_",
		async query<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
			return database.query(sql).all(...(params as never[])) as T[];
		},
	};
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const b64 = (value: string): string => Buffer.from(value).toString("base64");

type LogLevel = "debug" | "error" | "info" | "trace" | "warn";

interface CapturedLog {
	readonly details: unknown;
	readonly level: LogLevel;
	readonly message: string;
}

function createLogCapture(): { entries: CapturedLog[]; logger: PluginLogger } {
	const entries: CapturedLog[] = [];
	const build = (
		target: string | undefined,
		fields: Record<string, unknown> | undefined,
	): PluginLogger => {
		const write = (level: LogLevel) => (message: string, details?: unknown) => {
			const merged =
				fields === undefined
					? details
					: {
							...fields,
							...(typeof details === "object" && details !== null ? details : {}),
						};
			entries.push({
				details: merged,
				level,
				message: target === undefined ? message : `[${target}] ${message}`,
			});
		};
		return {
			child: (nestedTarget, nestedFields) =>
				build(
					target === undefined ? nestedTarget : `${target}.${nestedTarget}`,
					fields === undefined ? nestedFields : { ...fields, ...nestedFields },
				),
			debug: write("debug"),
			error: write("error"),
			info: write("info"),
			trace: write("trace"),
			warn: write("warn"),
		};
	};
	return { entries, logger: build(undefined, undefined) };
}

function baseFixture() {
	const database = createDatabase();
	const media = new MemoryMedia();
	const repository = new StickerRepository(database);
	const audits: AuditEntry[] = [];
	return { audits, database, media, repository };
}

async function seedItem(
	repository: StickerRepository,
	media: MemoryMedia,
	input: {
		readonly id: string;
		readonly packId?: string;
		readonly score?: number;
		readonly keywords?: string[];
		readonly emotions?: string[];
		readonly enabled?: boolean;
		readonly mimeType?: string;
		readonly reviewStatus?: "approved" | "pending" | "rejected";
		readonly revokedAt?: string | null;
		readonly lastUsedAt?: string | null;
		readonly useCount?: number;
		readonly bytes?: Uint8Array;
	},
): Promise<StickerItem> {
	const mimeType = input.mimeType ?? "image/png";
	const stored = await media.store({
		bytes: input.bytes ?? bytes(input.id),
		kind: "sticker",
		mimeType,
		source: "webui",
	});
	const item = await repository.upsertItem({
		description: `description ${input.id}`,
		emotions: input.emotions ?? ["joy"],
		enabled: input.enabled ?? true,
		hash: stored.sha256,
		id: input.id,
		keywords: input.keywords ?? ["happy"],
		mediaId: stored.id,
		mimeType,
		name: input.id,
		packId: input.packId ?? "pack-main",
		reviewStatus: input.reviewStatus ?? "approved",
		score: input.score ?? 1,
	});
	await repository.updateItem(item.id, {
		revokedAt: input.revokedAt ?? null,
	});
	return (await repository.getItem(item.id)) ?? item;
}

describe("sticker-meme schema and manifest", () => {
	test("manifest matches the packaged plugin manifest and migrations create namespaced tables", async () => {
		const packaged = (await Bun.file(
			new URL("../elaina.plugin.json", import.meta.url),
		).json()) as unknown;
		const parsed = pluginManifestSchema.parse(packaged);
		expect(bundledManifestEquality(parsed, stickerMemeManifest)).toBe(true);
		const database = createDatabase();
		const tables = await database.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_sticker_meme_%'",
		);
		expect(tables.map((table) => table.name).toSorted()).toEqual([
			"plugin_sticker_meme_items",
			"plugin_sticker_meme_packs",
			"plugin_sticker_meme_send_tokens",
		]);
	});

	test("normalizes tags safely and rejects traversal paths", () => {
		expect(normalizeLabels([" Joy ", "joy", "a/b", "ok_tag"]).values).toEqual(["joy", "ok_tag"]);
		expect(normalizeLabels(["a/b"]).invalid).toEqual(["a/b"]);
		expect(safeRelativePath("../secret.png")).toBeUndefined();
		expect(safeRelativePath("/tmp/secret.png")).toBeUndefined();
		expect(safeRelativePath("./images/a.png")).toBe("images/a.png");
	});
});

function bundledManifestEquality(
	left: ReturnType<typeof pluginManifestSchema.parse>,
	right: ReturnType<typeof pluginManifestSchema.parse>,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

describe("sticker import and export", () => {
	test("imports bundles, dedupes SHA-256 media, disables missing media, and exports only safe manifest data", async () => {
		const { media, repository } = baseFixture();
		const service = new StickerImportService({ media, repository });
		const report = await service.importBundle({
			files: [
				{ bytes: bytes("same-image"), path: "images/a.png" },
				{ bytes: bytes("same-image"), path: "images/b.png" },
			],
			manifest: {
				id: "pack-import",
				items: [
					{
						emotions: ["happy"],
						file: "images/a.png",
						id: "item-a",
						keywords: ["hello"],
						name: "A",
					},
					{
						file: "images/b.png",
						id: "item-b",
						name: "B",
					},
					{
						file: "images/missing.png",
						id: "item-missing",
						name: "Missing",
					},
				],
				name: "Imported",
				personaIds: ["elaina"],
				source: "imported",
				tags: ["greeting"],
			},
		});
		expect(report).toMatchObject({ deduped: 1, items: 3, missingMedia: 1, packs: 1 });
		expect(media.storeCalls).toBe(1);
		expect(report.warnings.length).toBeGreaterThan(0);
		const items = await repository.listItems("pack-import");
		expect(items.find((item) => item.id === "item-a")).toMatchObject({
			enabled: true,
			mediaId: expect.stringContaining("media-"),
			reviewStatus: "approved",
		});
		expect(items.find((item) => item.id === "item-missing")).toMatchObject({
			enabled: false,
			mediaId: "",
		});

		const source = await repository.getItem("item-a");
		if (source !== undefined) {
			await repository.updateItem(source.id, {});
		}
		// Simulate internal provenance that must never be exported.
		await repository.upsertItem({
			description: "portable description",
			hash: source?.hash ?? "hash",
			id: "item-extra",
			keywords: ["safe"],
			mediaId: source?.mediaId ?? "",
			mimeType: "image/png",
			name: "Portable extra",
			packId: "pack-import",
			reviewStatus: "approved",
			sourceConversationId: "conversation-private-id",
		});
		const exported = await service.exportPacks("pack-import");
		expect(exported.files.length).toBe(1);
		const serialized = JSON.stringify(exported.manifest);
		expect(serialized).not.toContain("sourceConversationId");
		expect(serialized).not.toContain("conversation-private-id");
		expect(serialized).not.toContain("secret");
		expect(exported.manifest.packs[0]).toMatchObject({
			id: "pack-import",
			name: "Imported",
			personaIds: ["elaina"],
		});
	});

	test("supports dry-run and directory/ZIP imports without writing media", async () => {
		const { media, repository } = baseFixture();
		const service = new StickerImportService({ media, repository });
		const manifest = {
			items: [{ file: "a.png", id: "a", name: "A" }],
			name: "Bundle",
		};
		const dryRun = await service.importBundle({
			dryRun: true,
			files: [{ bytes: bytes("dry"), path: "a.png" }],
			manifest,
		});
		expect(dryRun).toMatchObject({ deduped: 0, dryRun: true, items: 1 });
		expect(media.storeCalls).toBe(0);
		expect(await repository.listPacks()).toHaveLength(0);

		const directory = await mkdtemp(join(tmpdir(), "elaina-sticker-dir-"));
		directories.push(directory);
		await mkdir(join(directory, "images"), { recursive: true });
		await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
		await writeFile(join(directory, "images", "a.png"), bytes("dir-bytes"));
		const directoryReport = await service.importDirectory({ directory });
		expect(directoryReport.items).toBe(1);

		const zipBytes = storedZip({
			"manifest.json": JSON.stringify({
				items: [{ file: "z.png", id: "z", name: "Z" }],
				name: "Zip",
			}),
			"z.png": new Uint8Array(bytes("zip-bytes")),
		});
		expect(readZipEntries(zipBytes).map((file) => file.path)).toEqual(["manifest.json", "z.png"]);
		const zipReport = await service.importZip({ bytes: zipBytes });
		expect(zipReport).toMatchObject({ items: 1, packs: 1 });
	});

	test("imports a DSH meme-packs directory with a sqlite memes table", async () => {
		const { media, repository } = baseFixture();
		const service = new StickerImportService({ media, repository });
		const root = await mkdtemp(join(tmpdir(), "elaina-dsh-meme-"));
		directories.push(root);
		const packDir = join(root, "meme-packs", "dsh-pack");
		await mkdir(packDir, { recursive: true });
		await writeFile(
			join(packDir, "manifest.json"),
			JSON.stringify({ name: "DSH Pack", tags: ["dsh"] }),
		);
		await writeFile(join(packDir, "smile.png"), bytes("dsh-smile"));
		const sqlite = new Database(join(packDir, "index.db"));
		sqlite.run(
			"CREATE TABLE memes (path TEXT NOT NULL, tag TEXT, file_name TEXT NOT NULL, caption TEXT, keywords TEXT, mtime INTEGER, captioned_at TEXT)",
		);
		sqlite.run(
			"INSERT INTO memes (path, tag, file_name, caption, keywords) VALUES ('smile.png', 'happy', 'smile.png', 'Smiling meme', 'smile,happy')",
		);
		sqlite.close();
		const report = await service.importDshDirectory({ directory: root });
		expect(report).toMatchObject({ items: 1, missingMedia: 0, packs: 1 });
		const packs = await repository.listPacks();
		const items = await repository.listItems(packs[0]?.id);
		expect(items[0]).toMatchObject({
			emotions: ["happy"],
			keywords: ["smile", "happy"],
			name: "Smiling meme",
			reviewStatus: "approved",
		});
	});
});

function storedZip(files: Record<string, string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(files)) {
		const data = typeof value === "string" ? encoder.encode(value) : value;
		const nameBytes = encoder.encode(name);
		const local = new Uint8Array(30 + nameBytes.length + data.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(8, 0, true);
		localView.setUint16(10, 0, true);
		localView.setUint32(18, data.length, true);
		localView.setUint32(22, data.length, true);
		localView.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		local.set(data, 30 + nameBytes.length);
		locals.push(local);
		const central = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(10, 0, true);
		centralView.setUint32(20, data.length, true);
		centralView.setUint32(24, data.length, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);
		offset += local.length;
	}
	const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(8, files ? Object.keys(files).length : 0, true);
	endView.setUint16(10, Object.keys(files).length, true);
	endView.setUint32(12, centralSize, true);
	endView.setUint32(16, offset, true);
	const total = offset + centralSize + end.length;
	const result = new Uint8Array(total);
	let cursor = 0;
	for (const part of [...locals, ...centrals, end]) {
		result.set(part, cursor);
		cursor += part.length;
	}
	return result;
}

describe("sticker selection and send tokens", () => {
	// oxlint-disable-next-line unicorn/consistent-function-scoping
	async function setupSelection() {
		const fixture = baseFixture();
		let current = Date.parse("2026-01-01T00:00:00.000Z");
		const now = () => current;
		const repository = new StickerRepository(fixture.database, { now });
		const media = fixture.media;
		const selection = new StickerSelectionService({
			audit: { record: async (entry) => void fixture.audits.push(entry) },
			media,
			now,
			repository,
			tokenTtlMs: 60_000,
		});
		await repository.savePack({
			id: "pack-main",
			name: "Main",
			personaIds: ["elaina"],
			tags: ["greeting"],
		});
		await repository.savePack({ enabled: false, id: "pack-off", name: "Off" });
		const fresh = await seedItem(repository, media, {
			id: "fresh",
			score: 1,
			keywords: ["happy"],
			emotions: ["joy"],
		});
		const spammed = await seedItem(repository, media, {
			id: "spammed",
			score: 10,
			keywords: ["happy"],
			emotions: ["joy"],
		});
		await fixture.database.query(
			"UPDATE plugin_sticker_meme_items SET last_used_at = ?, use_count = 6 WHERE id = ?",
			[new Date(current).toISOString(), "spammed"],
		);
		await seedItem(repository, media, {
			id: "pending",
			reviewStatus: "pending",
		});
		await seedItem(repository, media, {
			id: "disabled",
			enabled: false,
		});
		await seedItem(repository, media, {
			id: "revoked",
			revokedAt: new Date(current).toISOString(),
		});
		await seedItem(repository, media, {
			id: "off-pack",
			packId: "pack-off",
		});
		return {
			...fixture,
			advance: (ms: number) => {
				current += ms;
			},
			fresh,
			now,
			repository,
			selection,
			spammed,
		};
	}

	test("ranks exact keyword matches and cooldown above a recently spammed high score", async () => {
		const setup = await setupSelection();
		const results = await setup.selection.search({
			emotion: "joy",
			personaId: "elaina",
			query: "happy",
			tags: ["greeting"],
		});
		expect(results.map((candidate) => candidate.itemId)).toEqual(["fresh", "spammed"]);
		expect(results[0]?.itemId).toBe(setup.fresh.id);
		expect(results.some((candidate) => candidate.itemId === "pending")).toBe(false);
		expect(results.some((candidate) => candidate.itemId === "disabled")).toBe(false);
		expect(results.some((candidate) => candidate.itemId === "revoked")).toBe(false);
		expect(results.some((candidate) => candidate.itemId === "off-pack")).toBe(false);
		expect(JSON.stringify(results)).not.toContain("media-");
		expect(JSON.stringify(results)).not.toContain("/tmp/");
	});

	test("finds a freshly imported pack by name, tag, and localized emotion", async () => {
		const setup = await setupSelection();
		await setup.repository.savePack({
			id: "pack-sakiko",
			name: "丰川祥子1.0b@muzimi2",
			tags: ["telegram", "regular"],
		});
		const item = await seedItem(setup.repository, setup.media, {
			emotions: ["happy"],
			id: "sakiko-hug",
			keywords: ["hug"],
			packId: "pack-sakiko",
		});
		const byName = await setup.selection.search({ query: "丰川祥子1.0b@muzimi2" });
		expect(byName.map((candidate) => candidate.itemId)).toContain(item.id);
		expect(byName.find((candidate) => candidate.itemId === item.id)?.packName).toBe(
			"丰川祥子1.0b@muzimi2",
		);
		// Models send several aliases at once; every term is an alternative, not a phrase.
		const byAliases = await setup.selection.search({
			query: "祥子 丰川祥子 soyorin tsumugi alice",
		});
		expect(byAliases.map((candidate) => candidate.itemId)).toContain(item.id);
		const bySynonyms = await setup.selection.search({ query: "抱抱 拥抱 hug" });
		expect(bySynonyms.map((candidate) => candidate.itemId)).toContain(item.id);
		// Taxonomy terms also translate: a Chinese query reaches items labelled in English.
		const confused = await seedItem(setup.repository, setup.media, {
			id: "confused",
			keywords: ["confused"],
		});
		const byTranslatedTerm = await setup.selection.search({ query: "疑惑" });
		expect(byTranslatedTerm.map((candidate) => candidate.itemId)).toContain(confused.id);
		expect(await setup.selection.search({ query: "不存在的词 另一个词" })).toEqual([]);
		for (const input of [
			{ packId: "丰川祥子1.0b@muzimi2" },
			{ packId: "telegram" },
			{ emotion: "开心" },
			{ emotion: "joy" },
		]) {
			const results = await setup.selection.search(input);
			expect(results.map((candidate) => candidate.itemId)).toContain(item.id);
		}
	});

	test("issues single-use, conversation-bound, short-TTL tokens and audits them", async () => {
		const setup = await setupSelection();
		const choice = await setup.selection.choose({
			conversationId: "conversation-1",
			itemId: "fresh",
		});
		expect(choice.directive).toBe(`[[sticker:${choice.sendToken}]]`);
		expect((await setup.repository.getToken(choice.sendToken))?.conversationId).toBe(
			"conversation-1",
		);
		expect(setup.audits.some((entry) => entry.action === "sticker.token.issued")).toBe(true);
		expect(await setup.repository.consumeToken(choice.sendToken, "conversation-other")).toEqual({
			failure: "wrong_conversation",
		});
		expect(await setup.repository.consumeToken(choice.sendToken, "conversation-1")).toEqual({
			itemId: "fresh",
		});
		expect(await setup.repository.consumeToken(choice.sendToken, "conversation-1")).toEqual({
			failure: "used",
		});
		const second = await setup.selection.choose({
			conversationId: "conversation-1",
			itemId: "fresh",
		});
		setup.advance(61_000);
		expect(await setup.repository.consumeToken(second.sendToken, "conversation-1")).toEqual({
			failure: "expired",
		});
	});

	test("transforms directives into ordered media parts and downgrades invalid tokens safely", async () => {
		const setup = await setupSelection();
		const choice = await setup.selection.choose({
			conversationId: "conversation-1",
			itemId: "fresh",
		});
		const transform = createStickerReplyTransform({
			audit: { record: async (entry) => void setup.audits.push(entry) },
			media: setup.media,
			repository: setup.repository,
		});
		const transformed = await transform({
			conversationId: "conversation-1",
			parts: [
				{
					text: `before [[sticker:${choice.sendToken}]] after <sticker token="invalid"/>`,
					type: "text",
				},
			],
		});
		expect(transformed?.parts).toEqual([
			{ text: "before ", type: "text" },
			{
				mediaId: expect.stringContaining("media-"),
				mimeType: "image/png",
				modelReadable: false,
				previewText: "fresh",
				sha256: expect.any(String),
				type: "sticker",
			},
			{ text: " after ", type: "text" },
			{ text: "[sticker unavailable]", type: "text" },
		]);
		expect(transformed?.text).toContain("before");
		expect(JSON.stringify(transformed)).not.toContain("[[sticker:");
		expect(JSON.stringify(transformed)).not.toContain("/tmp/");
		expect(setup.audits.some((entry) => entry.action === "sticker.transform.rejected")).toBe(true);
		expect(setup.audits.some((entry) => entry.action === "sticker.transform.sent")).toBe(true);

		const missing = await setup.selection.choose({
			conversationId: "conversation-1",
			itemId: "fresh",
		});
		setup.media.remove(setup.fresh.mediaId);
		const missingResult = await transform({
			conversationId: "conversation-1",
			parts: [{ text: `[[sticker:${missing.sendToken}]]`, type: "text" }],
		});
		expect(missingResult?.parts).toEqual([{ text: "[sticker unavailable]", type: "text" }]);
	});

	test("turns a webm sticker into a video part for OneBot video delivery", async () => {
		const setup = await setupSelection();
		await seedItem(setup.repository, setup.media, {
			id: "video-sticker",
			mimeType: "video/webm",
		});
		const choice = await setup.selection.choose({
			conversationId: "conversation-1",
			itemId: "video-sticker",
		});
		const transform = createStickerReplyTransform({
			media: setup.media,
			repository: setup.repository,
		});
		const transformed = await transform({
			conversationId: "conversation-1",
			parts: [{ text: `[[sticker:${choice.sendToken}]]`, type: "text" }],
		});
		expect(transformed?.parts[0]).toMatchObject({
			mimeType: "video/webm",
			type: "video",
		});
	});
});

describe("sticker learning and review", () => {
	// oxlint-disable-next-line unicorn/consistent-function-scoping
	async function setupLearning(settings: Partial<LearningSettings> = {}) {
		const fixture = baseFixture();
		let current = Date.parse("2026-01-01T00:00:00.000Z");
		const now = () => current;
		const repository = new StickerRepository(fixture.database, { now });
		const learning = new LearningService({
			audit: { record: async (entry) => void fixture.audits.push(entry) },
			media: fixture.media,
			now,
			repository,
			settings: {
				get: async () => ({
					learning: {
						allowGenerated: false,
						dailyCap: 2,
						duplicateThreshold: 1,
						enabled: true,
						retentionDays: 30,
						...settings,
					},
				}),
				onChange: () => () => {},
			},
		});
		const selection = new StickerSelectionService({
			media: fixture.media,
			now,
			repository,
			tokenTtlMs: 60_000,
		});
		return {
			...fixture,
			advance: (ms: number) => {
				current += ms;
			},
			learning,
			repository,
			selection,
		};
	}

	test("captures candidates as pending, enforces duplicate/daily caps, and requires review", async () => {
		const setup = await setupLearning();
		const first = await setup.learning.learn({
			bytesBase64: b64("candidate-one"),
			emotions: "happy",
			keywords: "smile",
			name: "Candidate",
			source: "admin",
		});
		expect(first.item.reviewStatus).toBe("pending");
		expect(await setup.selection.search({ query: "smile" })).toHaveLength(0);
		const duplicate = await setup.learning.learn({
			bytesBase64: b64("candidate-one"),
			name: "Duplicate",
			source: "admin",
		});
		expect(duplicate.reason).toBe("duplicate");
		await setup.learning.learn({ bytesBase64: b64("candidate-two"), name: "Two", source: "admin" });
		const capped = await setup.learning.learn({
			bytesBase64: b64("candidate-three"),
			name: "Three",
			source: "admin",
		});
		expect(capped.reason).toBe("daily_cap");

		await setup.repository.updateItem(first.item.id, { reviewStatus: "approved" });
		const visible = await setup.selection.search({ query: "smile" });
		expect(visible.map((candidate) => candidate.itemId)).toEqual([first.item.id]);
		await setup.repository.updateItem(first.item.id, { reviewStatus: "rejected" });
		expect(await setup.selection.search({ query: "smile" })).toHaveLength(0);
		await setup.repository.deleteItem(first.item.id);
		expect(await setup.repository.getItem(first.item.id)).toBeUndefined();
		expect(setup.audits.some((entry) => entry.action === "sticker.candidate.created")).toBe(true);
	});

	test("learns a marked inbound sticker and honors generated-image policy", async () => {
		const setup = await setupLearning();
		const inbound = await setup.learning.learnFromEnvelope({
			envelope: {
				parts: [
					{
						channelRef: `base64://${b64("inbound-sticker")}`,
						modelReadable: true,
						type: "sticker",
					},
				],
			},
			sessionId: "session-1",
		});
		expect(inbound?.item.reviewStatus).toBe("pending");
		expect(inbound?.item.sourceConversationId).toBe("session-1");
		const generated = await setup.learning.learn({
			bytesBase64: b64("generated"),
			name: "Generated",
			source: "generated",
		});
		expect(generated.reason).toBe("policy");
	});
});

describe("telegram sticker import", () => {
	const providedLink = "https://t.me/addstickers/myadestes_3_hanazono_serena";

	class FakeTelegramClient implements TelegramStickerSource {
		readonly #files: Record<string, Uint8Array>;
		readonly #set: Awaited<ReturnType<TelegramStickerSource["getStickerSet"]>>;
		downloads = 0;

		constructor(
			set: Awaited<ReturnType<TelegramStickerSource["getStickerSet"]>>,
			files: Record<string, Uint8Array>,
		) {
			this.#set = set;
			this.#files = files;
		}

		async getStickerSet(name: string) {
			expect(name).toBe("myadestes_3_hanazono_serena");
			return this.#set;
		}

		async downloadFile(fileId: string) {
			this.downloads += 1;
			const value = this.#files[fileId];
			if (value === undefined) throw new Error(`missing fake file ${fileId}`);
			return { bytes: value, filePath: `${fileId}.webp` };
		}
	}

	function telegramFixture() {
		const client = new FakeTelegramClient(
			{
				isAnimated: true,
				isVideo: true,
				name: "myadestes_3_hanazono_serena",
				stickerType: "regular",
				stickers: [
					{
						emoji: "😭",
						fileId: "file-sad",
						fileUniqueId: "unique-sad",
						height: 512,
						isAnimated: false,
						isVideo: false,
						type: "regular",
						width: 512,
					},
					{
						emoji: "🎉",
						fileId: "file-party",
						fileUniqueId: "unique-party",
						height: 512,
						isAnimated: false,
						isVideo: false,
						type: "regular",
						width: 512,
					},
					{
						emoji: "😊",
						fileId: "file-happy",
						fileUniqueId: "unique-happy",
						height: 512,
						isAnimated: true,
						isVideo: false,
						thumbnailFileId: "thumb-happy",
						type: "regular",
						width: 512,
					},
					{
						fileId: "file-mask",
						fileUniqueId: "unique-mask",
						height: 512,
						isAnimated: false,
						isVideo: false,
						type: "mask",
						width: 512,
					},
					{
						emoji: "👍",
						fileId: "file-praise",
						fileUniqueId: "unique-praise",
						height: 512,
						isAnimated: false,
						isVideo: true,
						thumbnailFileId: "thumb-praise",
						type: "regular",
						width: 512,
					},
				],
				title: "花園セレナ🐱鸫酱 @myadestes",
			},
			{
				"file-happy": bytes("tgs-happy"),
				"file-party": bytes("same-sad-image"),
				"file-praise": bytes("webm-praise"),
				"file-sad": bytes("same-sad-image"),
				"thumb-happy": bytes("happy-thumb"),
				"thumb-praise": bytes("praise-thumb"),
			},
		);
		const fixture = baseFixture();
		const converter = createAnimatedConverter({
			tgs: async () => bytes("gif-happy"),
			webm: async () => bytes("gif-praise"),
		});
		const service = new TelegramStickerImportService({ client, converter, ...fixture });
		return { ...fixture, client, converter, service };
	}

	test("parses the provided t.me link and rejects unrelated URLs", () => {
		expect(parseTelegramStickerSetReference(providedLink)).toEqual({
			setName: "myadestes_3_hanazono_serena",
			sourceUrl: providedLink,
		});
		expect(
			parseTelegramStickerSetReference("tg://addstickers?set=myadestes_3_hanazono_serena").setName,
		).toBe("myadestes_3_hanazono_serena");
		expect(parseTelegramStickerSetReference("myadestes_3_hanazono_serena").setName).toBe(
			"myadestes_3_hanazono_serena",
		);
		expect(() => parseTelegramStickerSetReference("https://example.com/addstickers/nope")).toThrow(
			"Only t.me",
		);
		expect(() => parseTelegramStickerSetReference("https://t.me/addstickers/../etc")).toThrow(
			"Invalid Telegram",
		);
	});

	test("talks to the Bot API through grammY with a custom base URL and fetch", async () => {
		const requests: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			requests.push(url);
			if (url.includes("/getStickerSet")) {
				return Response.json({
					ok: true,
					result: {
						name: "myadestes_3_hanazono_serena",
						sticker_type: "regular",
						stickers: [
							{
								emoji: "😭",
								file_id: "file-1",
								file_unique_id: "unique-1",
								height: 512,
								is_animated: false,
								is_video: false,
								type: "regular",
								width: 512,
							},
						],
						title: "Serena",
					},
				});
			}
			if (url.includes("/getFile")) {
				return Response.json({
					ok: true,
					result: {
						file_id: "file-1",
						file_path: "stickers/file_1.webp",
						file_size: 4,
						file_unique_id: "unique-1",
					},
				});
			}
			if (url.includes("/file/bot")) return new Response(bytes("webp"));
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const client = new TelegramStickerClient({
			apiBaseUrl: "https://api.test",
			fetch: fakeFetch,
			token: "123:abc",
		});
		const set = await client.getStickerSet("myadestes_3_hanazono_serena");
		expect(set).toMatchObject({
			name: "myadestes_3_hanazono_serena",
			stickerType: "regular",
			title: "Serena",
		});
		expect(set.stickers[0]).toMatchObject({ emoji: "😭", fileId: "file-1" });
		const file = await client.downloadFile("file-1");
		expect(new TextDecoder().decode(file.bytes)).toBe("webp");
		expect(file.filePath).toBe("stickers/file_1.webp");
		expect(requests.some((url) => url.includes("/bot123:abc/getStickerSet"))).toBe(true);
		expect(requests.some((url) => url.includes("/file/bot123:abc/stickers/file_1.webp"))).toBe(
			true,
		);
	});

	test("dry-runs without downloading or writing and reports skipped formats", async () => {
		const setup = telegramFixture();
		const report = await setup.service.importReference(providedLink, { dryRun: true });
		expect(report).toMatchObject({
			deduped: 0,
			dryRun: true,
			items: 4,
			missingMedia: 0,
			packs: 1,
			setName: "myadestes_3_hanazono_serena",
			skipped: 1,
		});
		expect(report.warnings.length).toBeGreaterThan(0);
		expect(setup.client.downloads).toBe(0);
		expect(setup.media.storeCalls).toBe(0);
		expect(await setup.repository.listPacks()).toHaveLength(0);
	});

	test("imports static stickers plus animated/video GIFs, dedupes media, and is idempotent", async () => {
		const setup = telegramFixture();
		const first = await setup.service.importReference(providedLink);
		expect(first).toMatchObject({
			deduped: 1,
			dryRun: false,
			items: 4,
			missingMedia: 0,
			packs: 1,
			skipped: 1,
		});
		expect(setup.media.storeCalls).toBe(3);
		const [pack] = await setup.repository.listPacks();
		expect(pack).toMatchObject({
			name: "花園セレナ🐱鸫酱 @myadestes",
			source: "imported",
			tags: ["telegram", "regular"],
		});
		expect(pack?.metadata).toMatchObject({
			provider: "telegram",
			telegram: {
				name: "myadestes_3_hanazono_serena",
				sourceUrl: providedLink,
			},
		});
		const items = await setup.repository.listItems(pack?.id);
		expect(items).toHaveLength(4);
		expect(items.every((item) => item.reviewStatus === "approved")).toBe(true);
		const sad = items.find((item) => item.semantic.emotions.includes("sad"));
		expect(sad?.semantic.labels).toEqual(expect.arrayContaining(["sad", "cry"]));
		expect(sad?.emotions).toEqual(expect.arrayContaining(["sad", "cry"]));
		expect(sad?.keywords).toEqual(expect.arrayContaining(["telegram"]));
		const happy = items.find((item) => item.name.endsWith("-03"));
		expect(happy?.mimeType).toBe("image/gif");
		expect(happy?.keywords).toEqual(expect.arrayContaining(["animated-gif"]));
		expect(happy?.description).toContain("Animated GIF");

		const second = await setup.service.importReference(providedLink);
		expect(second).toMatchObject({ deduped: 4, items: 4, missingMedia: 0 });
		expect(await setup.repository.listItems(pack?.id)).toHaveLength(4);
		expect(setup.media.storeCalls).toBe(3);
	});

	test("supports thumbnail-only and raw webm import modes", async () => {
		const thumbnailSetup = telegramFixture();
		const thumbnailReport = await thumbnailSetup.service.importReference(providedLink, {
			animatedFormat: "thumbnail",
			videoFormat: "thumbnail",
		});
		expect(thumbnailReport).toMatchObject({ items: 4, missingMedia: 0 });
		const thumbnailItems = await thumbnailSetup.repository.listItems();
		const thumbnailHappy = thumbnailItems.find((item) => item.name.endsWith("-03"));
		expect(thumbnailHappy).toMatchObject({ mimeType: "image/webp", enabled: true });
		expect(thumbnailHappy?.keywords).toEqual(expect.arrayContaining(["animated-thumbnail"]));

		const webmSetup = telegramFixture();
		await webmSetup.service.importReference(providedLink, { videoFormat: "webm" });
		const webmItems = await webmSetup.repository.listItems();
		const video = webmItems.find((item) => item.name.endsWith("-05"));
		expect(video).toMatchObject({ mimeType: "video/webm", enabled: true });
		expect(video?.keywords).toEqual(expect.arrayContaining(["video-webm"]));
	});

	test("reports staged import progress and tracks host job snapshots", async () => {
		const setup = telegramFixture();
		const events: TelegramImportProgress[] = [];
		const statuses: Array<{ code: string; progress?: { current: number; total?: number } }> = [];
		let settled = 0;
		const tracker = new StickerProgressTracker({
			context: {
				ui: {
					setStatus: (status: { code: string; progress?: { current: number; total?: number } }) => {
						statuses.push(status);
					},
				},
			} as never,
			onSettled: async () => {
				settled += 1;
			},
		});

		const jobId = tracker.start({ dryRun: false, kind: "telegram.import", stage: "fetching" });
		expect(tracker.current()).toMatchObject({
			current: 0,
			kind: "telegram.import",
			stage: "fetching",
			status: "running",
			total: null,
		});
		expect(statuses[0]?.progress?.total).toBeUndefined();

		const report = await setup.service.importReference(providedLink, {
			onProgress: (progress) => {
				events.push(progress);
				tracker.update(jobId, progress);
			},
		});
		await tracker.complete(jobId, {
			classified: report.classified,
			current: report.items,
			packTitle: report.title,
			skipped: report.skipped,
			total: report.items,
		});

		expect(events[0]?.stage).toBe("fetching");
		expect(events.some((event) => event.stage === "downloading" && event.total === 4)).toBe(true);
		expect(events.some((event) => event.stage === "converting")).toBe(true);
		expect(events.some((event) => event.stage === "classifying")).toBe(true);
		expect(events.some((event) => event.stage === "saving")).toBe(true);
		expect(events.at(-1)).toMatchObject({
			classified: 4,
			current: 4,
			packTitle: "花園セレナ🐱鸫酱 @myadestes",
			skipped: 1,
			total: 4,
		});
		expect(tracker.current()).toMatchObject({
			classified: 4,
			current: 4,
			skipped: 1,
			stage: "done",
			status: "completed",
			total: 4,
		});
		expect(settled).toBe(1);

		const failedJobId = tracker.start({ kind: "telegram.import", stage: "fetching" });
		await tracker.fail(
			failedJobId,
			new Error("request failed https://api.telegram.org/bot123456:SECRET_TOKEN/getFile"),
		);
		expect(tracker.current()).toMatchObject({
			stage: "error",
			status: "failed",
		});
		expect(tracker.current()?.error).toContain("/bot[REDACTED]/getFile");
		expect(tracker.current()?.error).not.toContain("SECRET_TOKEN");
		expect(settled).toBe(2);
	});
});

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

describe("sticker import concurrency", () => {
	// oxlint-disable-next-line unicorn/consistent-function-scoping
	function concurrencyFixture(
		options: { readonly count?: number; readonly delayMs?: number } = {},
	) {
		const count = options.count ?? 6;
		const delayMs = options.delayMs ?? 25;
		const stickers = Array.from({ length: count }, (_, index) => ({
			emoji: "😭",
			fileId: `file-${index}`,
			fileUniqueId: `unique-${index}`,
			height: 512,
			isAnimated: false,
			isVideo: false,
			type: "regular" as const,
			width: 512,
		}));
		const stats = {
			activeDownloads: 0,
			downloaded: 0,
			overlap: false,
			peakClassifiers: 0,
			peakDownloads: 0,
		};
		const client: TelegramStickerSource = {
			async downloadFile(fileId: string) {
				stats.activeDownloads += 1;
				stats.peakDownloads = Math.max(stats.peakDownloads, stats.activeDownloads);
				await delay(delayMs);
				stats.activeDownloads -= 1;
				stats.downloaded += 1;
				return { bytes: bytes(`payload-${fileId}`), filePath: `${fileId}.webp` };
			},
			async getStickerSet() {
				return {
					isAnimated: false,
					isVideo: false,
					name: "concurrency_set",
					stickerType: "regular",
					stickers,
					title: "Concurrency",
				};
			},
		};
		let activeClassifiers = 0;
		const classifier = {
			name: "vision:test",
			async classify(): Promise<StickerSemanticProfile> {
				if (stats.activeDownloads > 0 && stats.downloaded < count) stats.overlap = true;
				activeClassifiers += 1;
				stats.peakClassifiers = Math.max(stats.peakClassifiers, activeClassifiers);
				await delay(delayMs);
				activeClassifiers -= 1;
				return {
					confidence: 0.9,
					description: "delayed vision",
					emotions: ["sad"],
					intents: [],
					keywords: ["vision"],
					labels: ["sad"],
					source: "vision",
					tones: [],
					version: 1,
				};
			},
		};
		const fixture = baseFixture();
		const service = new TelegramStickerImportService({ client, ...fixture });
		return { ...fixture, classifier, count, service, stats };
	}

	test("overlaps parallel imports with parallel semantic classification and honors both bounds", async () => {
		const setup = concurrencyFixture();
		const events: TelegramImportProgress[] = [];
		const report = await setup.service.importReference("concurrency_set", {
			classifier: setup.classifier,
			dryRun: false,
			importConcurrency: 2,
			onProgress: (progress) => events.push(progress),
			semanticConcurrency: 2,
		});
		const items = await setup.repository.listItems();
		expect(report).toMatchObject({ classified: 6, items: 6, missingMedia: 0 });
		expect(items).toHaveLength(6);
		expect(items.every((item) => item.semantic.source === "vision")).toBe(true);
		expect(items.every((item) => item.description.includes("delayed vision"))).toBe(true);
		expect(setup.stats.peakDownloads).toBe(2);
		expect(setup.stats.peakClassifiers).toBe(2);
		expect(setup.stats.overlap).toBe(true);
		expect(events.at(-1)).toMatchObject({ classified: 6, current: 6, total: 6 });
	});

	test("defers semantic classification when asked and keeps heuristic writes single-write", async () => {
		const deferredSetup = concurrencyFixture({ count: 3 });
		const deferredReport = await deferredSetup.service.importReference("concurrency_set", {
			classifier: deferredSetup.classifier,
			deferSemantic: true,
			dryRun: false,
			importConcurrency: 3,
			semanticConcurrency: 1,
		});
		expect(deferredReport).toMatchObject({
			classified: 0,
			items: 3,
			semanticDeferred: true,
		});
		const deferredItems = await deferredSetup.repository.listItems();
		expect(deferredItems.every((item) => item.semantic.source === "heuristic")).toBe(true);
		expect(deferredSetup.stats.peakClassifiers).toBe(0);

		const heuristicSetup = concurrencyFixture({ count: 4, delayMs: 5 });
		let upserts = 0;
		let updates = 0;
		const repository = heuristicSetup.repository;
		const upsertItem = repository.upsertItem.bind(repository);
		const updateItem = repository.updateItem.bind(repository);
		repository.upsertItem = async (input) => {
			upserts += 1;
			return await upsertItem(input);
		};
		repository.updateItem = async (id, patch) => {
			updates += 1;
			return await updateItem(id, patch);
		};
		const heuristicReport = await heuristicSetup.service.importReference("concurrency_set", {
			dryRun: false,
			importConcurrency: 2,
			semanticConcurrency: 2,
		});
		expect(heuristicReport).toMatchObject({ classified: 4, items: 4 });
		expect(upserts).toBe(4);
		expect(updates).toBe(0);
		expect(heuristicSetup.stats.peakDownloads).toBe(2);
	});

	test("tracks telemetry for several concurrent jobs and settles only when all finish", async () => {
		const statuses: Array<{ code: string; summary?: string }> = [];
		let settled = 0;
		const tracker = new StickerProgressTracker({
			context: {
				ui: {
					setStatus: (status: { code: string; summary?: string }) => statuses.push(status),
				},
			} as never,
			onSettled: async () => {
				settled += 1;
			},
		});
		const importJobId = tracker.start({
			kind: "telegram.import",
			stage: "downloading",
			total: 4,
		});
		const semanticJobId = tracker.start({
			kind: "semantic.reclassify",
			stage: "classifying",
			total: 2,
		});
		expect(tracker.jobs().map((job) => job.kind)).toEqual([
			"semantic.reclassify",
			"telegram.import",
		]);
		expect(tracker.current()?.id).toBe(semanticJobId);
		tracker.update(importJobId, { classified: 1, current: 1 });
		tracker.update(semanticJobId, { classified: 1, current: 1 });
		expect(tracker.jobs()).toHaveLength(2);
		await tracker.complete(importJobId, { classified: 4, current: 4, total: 4 });
		expect(settled).toBe(0);
		expect(tracker.current()?.id).toBe(semanticJobId);
		expect(tracker.jobs().find((job) => job.id === importJobId)?.status).toBe("completed");
		expect(statuses.some((status) => status.code === "job_running")).toBe(true);
		await tracker.complete(semanticJobId, { classified: 2, current: 2, total: 2 });
		expect(settled).toBe(1);
		expect(tracker.jobs()).toHaveLength(2);
		expect(tracker.current()?.id).toBe(semanticJobId);
		expect(tracker.current()).toMatchObject({ stage: "done", status: "completed" });
	});
});

describe("animated sticker conversion", () => {
	const lottie = {
		assets: [],
		ddd: 0,
		fr: 30,
		h: 100,
		ip: 0,
		layers: [
			{
				ao: 0,
				bm: 0,
				ddd: 0,
				ind: 1,
				ip: 0,
				ks: {
					a: { a: 0, k: [0, 0, 0] },
					o: { a: 0, k: 100 },
					p: {
						a: 1,
						k: [
							{
								i: { x: 0.667, y: 1 },
								o: { x: 0.333, y: 0 },
								s: [20, 50, 0],
								t: 0,
								ti: [-13.333, 0, 0],
								to: [13.333, 0, 0],
							},
							{ s: [80, 50, 0], t: 30 },
						],
					},
					r: { a: 0, k: 0 },
					s: { a: 0, k: [100, 100, 100] },
				},
				nm: "Shape Layer 1",
				op: 30,
				shapes: [
					{
						d: 1,
						nm: "Rectangle Path 1",
						p: { a: 0, k: [0, 0] },
						r: { a: 0, k: 0 },
						s: { a: 0, k: [20, 20] },
						ty: "rc",
					},
					{
						c: { a: 0, k: [1, 0, 0, 1] },
						nm: "Fill 1",
						o: { a: 0, k: 100 },
						r: 1,
						ty: "fl",
					},
				],
				sr: 1,
				st: 0,
				ty: 4,
			},
		],
		nm: "conversion-test",
		op: 30,
		v: "5.7.4",
		w: 100,
	};

	test("renders a gzipped Lottie TGS to an animated GIF", async () => {
		const tgs = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(lottie))));
		const gif = await tgsToGif(tgs, { fps: 5, maxFrames: 3, width: 32 });
		expect(new TextDecoder().decode(gif.slice(0, 6))).toBe("GIF89a");
		expect(gif.byteLength).toBeGreaterThan(100);
	});

	const ffmpeg = Bun.which("ffmpeg");
	test.skipIf(ffmpeg === undefined)(
		"converts a webm video sticker to GIF with ffmpeg",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "elaina-webm-test-"));
			directories.push(directory);
			const input = join(directory, "input.webm");
			const result = await Bun.spawn([
				ffmpeg as string,
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=red:s=32x32:r=5",
				"-t",
				"0.4",
				"-c:v",
				"libvpx-vp9",
				"-pix_fmt",
				"yuva420p",
				input,
			]).exited;
			expect(result).toBe(0);
			const gif = await webmToGif(new Uint8Array(await Bun.file(input).arrayBuffer()), {
				fps: 5,
				maxFrames: 2,
				width: 32,
			});
			expect(gif).toBeDefined();
			expect(new TextDecoder().decode(gif?.slice(0, 6))).toBe("GIF89a");
		},
	);
});

describe("sticker semantic classification", () => {
	test("maps telegram emoji and multilingual titles to a closed semantic taxonomy", () => {
		expect(extractEmojis("😭 happy 🎉")).toEqual(["😭", "🎉"]);
		const crying = classifyStickerSemantics({
			emoji: "😭",
			title: "花園セレナ🐱鸫酱 @myadestes",
		});
		expect(crying.source).toBe("heuristic");
		expect(crying.emotions).toEqual(expect.arrayContaining(["cry", "sad"]));
		expect(crying.keywords).toEqual(expect.arrayContaining(["cry", "sad"]));
		const praise = classifyStickerSemantics({ emoji: "👍", title: "Anime stickers" });
		expect(praise.labels).toEqual(expect.arrayContaining(["praise", "agree"]));
		const cjk = classifyStickerSemantics({ title: "おやすみ 眠い" });
		expect(cjk.labels).toEqual(expect.arrayContaining(["sleepy"]));
	});

	test("merges a vision response while rejecting labels outside the taxonomy", async () => {
		const classifier = new VisionSemanticClassifier({
			apiKey: "test-key",
			complete: async () =>
				JSON.stringify({
					confidence: 0.9,
					description: "A sad character cries at the viewer.",
					emotions: ["sad", "not-a-real-label"],
					keywords: ["crying", "tears"],
					labels: ["sad", "cry", "made-up"],
				}),
			model: "vision-test",
		});
		const profile = await classifier.classify({
			bytes: bytes("image-bytes"),
			emoji: "😭",
			mimeType: "image/webp",
			title: "Serena",
		});
		expect(profile.source).toBe("merged");
		expect(profile.labels).toEqual(expect.arrayContaining(["sad", "cry"]));
		expect(profile.labels).not.toContain("made-up");
		expect(profile.emotions).not.toContain("not-a-real-label");
		expect(profile.description).toBe("A sad character cries at the viewer.");
		expect(profile.model).toBe("vision-test");
	});

	test("falls back to heuristic when vision is not configured", async () => {
		const classifier = createSemanticClassifier({ semanticMode: "auto" });
		expect(classifier.name).toBe("heuristic");
		expect(() => createSemanticClassifier({ semanticMode: "vision" })).toThrow(
			"requires semanticApiKey",
		);
	});

	test("resolves a specific host provider model, auto-picks vision models, and honors heuristic mode", async () => {
		const registry = new LocalModelRegistry();
		const calls: Array<{
			modelId: string | undefined;
			providerId: string | undefined;
			hasImage: boolean;
		}> = [];
		registry.registerProvider({
			id: "provider-text",
			createPort: () => {
				throw new Error("port not used");
			},
			listModels: () => [
				{
					capabilities: ["basic-chat"],
					id: "chat-only",
					input: ["text"],
				},
			],
			complete: async (request) => {
				const last = request.messages.at(-1);
				const hasImage =
					last !== undefined &&
					typeof last.content !== "string" &&
					last.content.some((part) => part.type === "image");
				calls.push({ hasImage, modelId: request.modelId, providerId: request.providerId });
				return {
					modelId: request.modelId ?? "chat-only",
					providerId: request.providerId ?? "provider-text",
					text: JSON.stringify({
						confidence: 0.85,
						description: "Text provider response",
						emotions: ["calm"],
						keywords: ["calm"],
						labels: ["calm"],
					}),
				};
			},
		});
		registry.registerProvider({
			id: "provider-vision",
			createPort: () => {
				throw new Error("port not used");
			},
			listModels: () => [
				{
					capabilities: ["basic-chat", "vision"],
					id: "vision-a",
					input: ["text", "image"],
				},
				{
					capabilities: ["basic-chat", "vision"],
					id: "vision-b",
					input: ["text", "image"],
				},
			],
			complete: async (request) => {
				const last = request.messages.at(-1);
				const hasImage =
					last !== undefined &&
					typeof last.content !== "string" &&
					last.content.some((part) => part.type === "image");
				calls.push({ hasImage, modelId: request.modelId, providerId: request.providerId });
				return {
					modelId: request.modelId ?? "vision-a",
					providerId: request.providerId ?? "provider-vision",
					text: JSON.stringify({
						confidence: 0.92,
						description: `Classified by ${request.modelId}`,
						emotions: ["happy"],
						keywords: ["smile", "cheerful"],
						labels: ["happy", "cute"],
					}),
				};
			},
		});

		const selected = await resolveSemanticClassifier(
			{
				semanticMode: "vision",
				semanticModel: "vision-b",
				semanticProviderId: "provider-vision",
			},
			{ models: registry },
		);
		expect(selected.name).toBe("vision:provider-vision/vision-b");
		const profile = await selected.classify({
			bytes: bytes("png-bytes"),
			emoji: "😊",
			mimeType: "image/png",
			title: "Happy Pack",
		});
		expect(profile.source).toBe("merged");
		expect(profile.model).toBe("vision-b");
		expect(profile.labels).toEqual(expect.arrayContaining(["happy", "cute"]));
		expect(calls.at(-1)).toEqual({
			hasImage: true,
			modelId: "vision-b",
			providerId: "provider-vision",
		});

		const overrideByModelOnly = await resolveSemanticClassifier(
			{ semanticProviderId: "" },
			{ modelId: "vision-a", models: registry, providerId: "" },
		);
		expect(overrideByModelOnly.name).toBe("vision:provider-vision/vision-a");

		const autoSelected = await resolveSemanticClassifier(
			{ semanticMode: "auto" },
			{ models: registry },
		);
		expect(autoSelected.name).toBe("vision:provider-vision/vision-a");

		const forcedHeuristic = await resolveSemanticClassifier(
			{
				semanticModel: "vision-b",
				semanticProviderId: "provider-vision",
			},
			{ mode: "heuristic", models: registry },
		);
		expect(forcedHeuristic.name).toBe("heuristic");

		await expect(
			resolveSemanticClassifier(
				{ semanticMode: "auto" },
				{ models: registry, modelId: "missing-model", providerId: "provider-vision" },
			),
		).rejects.toThrow('Model "missing-model" is not enabled on provider "provider-vision"');

		const textOnlyRegistry = new LocalModelRegistry();
		textOnlyRegistry.registerProvider({
			id: "text-only",
			createPort: () => {
				throw new Error("port not used");
			},
			listModels: () => [{ capabilities: ["basic-chat"], id: "plain", input: ["text"] }],
		});
		await expect(
			resolveSemanticClassifier({ semanticMode: "vision" }, { models: textOnlyRegistry }),
		).rejects.toThrow("Semantic vision mode requires a configured vision model");
	});
});

describe("sticker debug logging", () => {
	test("emits trace scoring and debug search/choose results", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		await fixture.repository.savePack({ id: "pack-main", name: "Main" });
		await seedItem(fixture.repository, fixture.media, {
			emotions: ["joy"],
			id: "happy",
			keywords: ["happy"],
		});
		const selection = new StickerSelectionService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const results = await selection.search({ emotion: "joy", query: "happy" });
		expect(results.map((candidate) => candidate.itemId)).toEqual(["happy"]);
		const scored = entries.find(
			(entry) => entry.level === "trace" && entry.message === "sticker candidate scored",
		);
		expect(scored?.details).toMatchObject({ itemId: "happy", score: expect.any(Number) });
		const searched = entries.find(
			(entry) => entry.level === "debug" && entry.message === "sticker search completed",
		);
		expect(searched?.details).toMatchObject({
			candidateCount: 1,
			durationMs: expect.any(Number),
		});

		const choice = await selection.choose({ conversationId: "conversation-1", itemId: "happy" });
		expect(choice.itemId).toBe("happy");
		const issued = entries.find(
			(entry) => entry.level === "debug" && entry.message === "sticker send token issued",
		);
		expect(issued?.details).toMatchObject({
			durationMs: expect.any(Number),
			itemId: "happy",
			packId: "pack-main",
			tokenIssued: true,
		});
	});

	test("emits debug candidate capture and trace envelope inspection", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		const learning = new LearningService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const learned = await learning.learn({
			bytesBase64: b64("logged-candidate"),
			name: "Logged candidate",
			source: "admin",
		});
		const captured = entries.find(
			(entry) => entry.level === "debug" && entry.message === "sticker candidate learned",
		);
		expect(captured?.details).toMatchObject({
			durationMs: expect.any(Number),
			itemId: learned.item.id,
			packId: learned.item.packId,
			status: "pending",
		});

		const duplicate = await learning.learn({
			bytesBase64: b64("logged-candidate"),
			name: "Duplicate",
			source: "admin",
		});
		expect(duplicate.reason).toBe("duplicate");
		expect(
			entries.some(
				(entry) =>
					entry.level === "debug" &&
					entry.message === "sticker candidate skipped" &&
					(entry.details as { reason?: string }).reason === "duplicate",
			),
		).toBe(true);

		const inbound = await learning.learnFromEnvelope({
			envelope: {
				parts: [
					{
						channelRef: `base64://${b64("logged-envelope")}`,
						modelReadable: true,
						type: "sticker",
					},
				],
			},
			sessionId: "session-logged",
		});
		expect(inbound?.item.reviewStatus).toBe("pending");
		expect(
			entries.some(
				(entry) => entry.level === "trace" && entry.message === "sticker envelope part inspected",
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) => entry.level === "trace" && entry.message === "sticker envelope part captured",
			),
		).toBe(true);
	});

	test("emits trace directive parsing and debug transform counts", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		await fixture.repository.savePack({ id: "pack-main", name: "Main" });
		await seedItem(fixture.repository, fixture.media, { id: "fresh" });
		const selection = new StickerSelectionService({
			media: fixture.media,
			repository: fixture.repository,
		});
		const choice = await selection.choose({ conversationId: "conversation-1", itemId: "fresh" });
		const transform = createStickerReplyTransform({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const transformed = await transform({
			conversationId: "conversation-1",
			parts: [
				{ text: `before [[sticker:${choice.sendToken}]] after`, type: "text" },
				{ text: "no directive here", type: "text" },
				{ text: "", type: "text" },
			],
		});
		expect(transformed?.parts).toHaveLength(4);
		const parsed = entries.find(
			(entry) => entry.level === "trace" && entry.message === "sticker directive text parsed",
		);
		expect(parsed?.details).toMatchObject({ directiveCount: 1, pieceCount: 3 });
		expect(
			entries.some(
				(entry) => entry.level === "trace" && entry.message === "sticker directive parse fallback",
			),
		).toBe(true);
		const completed = entries.find(
			(entry) => entry.level === "debug" && entry.message === "sticker reply transform completed",
		);
		expect(completed?.details).toMatchObject({
			directiveCount: 1,
			durationMs: expect.any(Number),
			resolvedCount: 1,
			unresolvedCount: 0,
		});
	});

	test("emits info/debug/trace import logs with counts", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		const service = new StickerImportService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const report = await service.importBundle({
			files: [{ bytes: bytes("logged-import"), path: "a.png" }],
			manifest: {
				items: [{ file: "a.png", id: "logged-item", name: "Logged" }],
				name: "Logged pack",
			},
		});
		expect(report.items).toBe(1);
		expect(
			entries.some(
				(entry) => entry.level === "info" && entry.message === "sticker bundle import started",
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) => entry.level === "info" && entry.message === "sticker bundle import completed",
			),
		).toBe(true);
		const completed = entries.find(
			(entry) => entry.level === "debug" && entry.message === "sticker import packs completed",
		);
		expect(completed?.details).toMatchObject({
			durationMs: expect.any(Number),
			itemCount: 1,
			packCount: 1,
		});
		expect(
			entries.some(
				(entry) => entry.level === "trace" && entry.message === "sticker import item prepared",
			),
		).toBe(true);

		const exported = await service.exportPacks();
		expect(exported.files.length).toBe(1);
		expect(
			entries.some(
				(entry) => entry.level === "info" && entry.message === "sticker pack export completed",
			),
		).toBe(true);
	});

	test("never logs telegram bot tokens or semantic api keys", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		const token = "123456789:fake-bot-token-fixture";
		const apiKey = "sk-fake-api-key-fixture";
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/getStickerSet")) {
				return Response.json({
					ok: true,
					result: {
						name: "logged_set",
						sticker_type: "regular",
						stickers: [
							{
								file_id: "file-1",
								file_unique_id: "unique-1",
								height: 512,
								is_animated: false,
								is_video: false,
								type: "regular",
								width: 512,
							},
						],
						title: "Logged set",
					},
				});
			}
			if (url.includes("/getFile")) {
				return Response.json({
					ok: true,
					result: {
						file_id: "file-1",
						file_path: "stickers/file_1.webp",
						file_size: 4,
						file_unique_id: "unique-1",
					},
				});
			}
			return new Response(bytes("webp"));
		}) as typeof fetch;
		const client = new TelegramStickerClient({
			apiBaseUrl: "https://api.test",
			fetch: fakeFetch,
			logger,
			token,
		});
		const set = await client.getStickerSet("logged_set");
		expect(set.stickers).toHaveLength(1);
		const file = await client.downloadFile("file-1");
		expect(file.filePath).toBe("stickers/file_1.webp");

		const failingClient = new TelegramStickerClient({
			apiBaseUrl: "https://api.test",
			fetch: (async (input: string | URL | Request) => {
				if (String(input).includes("/getFile")) {
					return Response.json({
						ok: true,
						result: {
							file_id: "file-1",
							file_path: "stickers/file_1.webp",
							file_size: 4,
							file_unique_id: "unique-1",
						},
					});
				}
				throw new Error(`boom https://api.test/file/bot${token}/stickers/file_1.webp`);
			}) as typeof fetch,
			logger,
			token,
		});
		await expect(failingClient.downloadFile("file-1")).rejects.toThrow(
			"Telegram file download failed",
		);

		const classifier = new VisionSemanticClassifier({
			apiKey,
			complete: async () =>
				JSON.stringify({ description: "calm", labels: ["calm"], confidence: 0.9 }),
			logger,
			model: "vision-logged",
		});
		const profile = await classifier.classify({
			bytes: bytes("image"),
			mimeType: "image/png",
			title: "Logged",
		});
		expect(profile.source).toBe("merged");

		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("SECRET_BOT_TOKEN");
		expect(serialized).not.toContain("SECRET_API_KEY");
		expect(serialized).not.toContain("123456789:");
		expect(
			entries.some(
				(entry) => entry.level === "debug" && entry.message === "telegram getStickerSet completed",
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) =>
					entry.level === "debug" &&
					entry.message.includes("vision sticker classification completed"),
			),
		).toBe(true);
		expect(
			entries.some(
				(entry) =>
					entry.level === "warn" &&
					entry.message === "telegram sticker download failed" &&
					String((entry.details as { error?: string }).error).includes("/bot[REDACTED]/"),
			),
		).toBe(true);
		expect(fixture.repository).toBeDefined();
	});

	test("logs animated conversion format and duration", async () => {
		const { entries, logger } = createLogCapture();
		const converter = createAnimatedConverter({
			logger,
			tgs: async () => bytes("tgs-gif"),
			webm: async () => bytes("webm-gif"),
		});
		await converter.convertTgs(bytes("tgs"));
		await converter.convertWebm(bytes("webm"));
		const completed = entries.filter(
			(entry) =>
				entry.level === "debug" && entry.message === "animated sticker conversion completed",
		);
		expect(completed).toHaveLength(2);
		expect(completed[0]?.details).toMatchObject({
			durationMs: expect.any(Number),
			format: "gif",
			source: "tgs",
		});
		expect(completed[1]?.details).toMatchObject({ format: "gif", source: "webm" });
	});

	test("logs tool invocations with counts", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		await fixture.repository.savePack({ id: "pack-main", name: "Main" });
		await seedItem(fixture.repository, fixture.media, {
			emotions: ["joy"],
			id: "tool-item",
			keywords: ["happy"],
		});
		const selection = new StickerSelectionService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const registered: {
			execute(input: Record<string, unknown>, invocation: unknown): Promise<unknown>;
			name: string;
		}[] = [];
		const context = {
			logger,
			tools: {
				register: (tool: {
					execute(input: Record<string, unknown>, invocation: unknown): Promise<unknown>;
					name: string;
				}) => {
					registered.push(tool);
					return () => {};
				},
			},
		} as unknown as PluginContext;
		registerStickerTools(context, selection, logger);
		const searchTool = registered.find((tool) => tool.name === "sticker-meme.search");
		expect(searchTool).toBeDefined();
		await searchTool?.execute({ query: "happy" }, { conversationId: "conversation-1" });
		const chooseTool = registered.find((tool) => tool.name === "sticker-meme.choose");
		await chooseTool?.execute({ itemId: "tool-item" }, { conversationId: "conversation-1" });
		const calls = entries.filter(
			(entry) => entry.level === "trace" && entry.message === "sticker tool invoked",
		);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const searchCompleted = entries.find(
			(entry) =>
				entry.level === "debug" &&
				entry.message === "sticker tool completed" &&
				(entry.details as { tool?: string }).tool === "sticker-meme.search",
		);
		expect(searchCompleted?.details).toMatchObject({
			candidateCount: 1,
			durationMs: expect.any(Number),
		});
		const chooseCompleted = entries.find(
			(entry) =>
				entry.level === "debug" &&
				entry.message === "sticker tool completed" &&
				(entry.details as { tool?: string }).tool === "sticker-meme.choose",
		);
		expect(chooseCompleted?.details).toMatchObject({
			chosenId: "tool-item",
			durationMs: expect.any(Number),
			tokenIssued: true,
		});
	});

	test("logs rpc invocations with duration and result counts", async () => {
		const fixture = baseFixture();
		const { entries, logger } = createLogCapture();
		const handlers = new Map<string, (input: unknown) => Promise<unknown> | unknown>();
		const context = {
			logger,
			rpc: {
				list: () => [],
				register: (method: string, handler: (input: unknown) => Promise<unknown> | unknown) => {
					handlers.set(method, handler);
					return () => {};
				},
			},
		} as unknown as PluginContext;
		const importService = new StickerImportService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		const learning = new LearningService({
			logger,
			media: fixture.media,
			repository: fixture.repository,
		});
		registerStickerRpc(context, {
			importService,
			learning,
			logger,
			repository: fixture.repository,
		});
		const stats = handlers.get("stats");
		expect(stats).toBeDefined();
		await stats?.({});
		expect(
			entries.some(
				(entry) =>
					entry.level === "trace" &&
					entry.message === "sticker rpc invoked" &&
					(entry.details as { procedure?: string }).procedure === "stats",
			),
		).toBe(true);
		const completed = entries.find(
			(entry) =>
				entry.level === "debug" &&
				entry.message === "sticker rpc completed" &&
				(entry.details as { procedure?: string }).procedure === "stats",
		);
		expect(completed?.details).toMatchObject({ durationMs: expect.any(Number) });
	});
});
