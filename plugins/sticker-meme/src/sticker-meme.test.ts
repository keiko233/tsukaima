import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	pluginManifestSchema,
	type AuditEntry,
	type PluginDatabaseApi,
	type PluginMediaApi,
	type PluginMediaRecord,
	type PluginMediaStoreInput,
} from "@tsukaima/sdk";
import { readZipEntries } from "./archive.ts";
import { normalizeLabels, safeRelativePath, type StickerItem } from "./domain.ts";
import { StickerImportService } from "./import-service.ts";
import { LearningService, type LearningSettings } from "./learning.ts";
import { stickerMemeManifest } from "./manifest.ts";
import { createStickerReplyTransform } from "./output.ts";
import { StickerRepository } from "./repository.ts";
import { StickerSelectionService } from "./selection.ts";

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
	for (const migration of stickerMemeManifest.migrations) database.run(migration.sql);
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
		readonly reviewStatus?: "approved" | "pending" | "rejected";
		readonly revokedAt?: string | null;
		readonly lastUsedAt?: string | null;
		readonly useCount?: number;
		readonly bytes?: Uint8Array;
	},
): Promise<StickerItem> {
	const stored = await media.store({
		bytes: input.bytes ?? bytes(input.id),
		kind: "sticker",
		mimeType: "image/png",
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
		mimeType: "image/png",
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
			new URL("../tsukaima.plugin.json", import.meta.url),
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
				personaIds: ["tsukaima"],
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
			personaIds: ["tsukaima"],
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

		const directory = await mkdtemp(join(tmpdir(), "tsukaima-sticker-dir-"));
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
		const root = await mkdtemp(join(tmpdir(), "tsukaima-dsh-meme-"));
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
			personaIds: ["tsukaima"],
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
			personaId: "tsukaima",
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
