import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
	createPluginContext,
	type PluginContext,
	type PluginDatabaseApi,
	type PluginMediaApi,
	type PluginMediaRecord,
	type PluginMediaStoreInput,
} from "@tsukaima/sdk";
import { StickerRepository } from "./repository.ts";
import { StickerSelectionService } from "./selection.ts";
import { stickerMemeManifest } from "./manifest.ts";
import { registerStickerTools } from "./tools.ts";

const MIGRATIONS = readdirSync(new URL("../migrations", import.meta.url))
	.filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
	.toSorted()
	.map((file) => ({
		file,
		sql: readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
	}));

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

class MemoryMedia implements PluginMediaApi {
	readonly bytes = new Map<string, Uint8Array>();
	readonly records = new Map<string, PluginMediaRecord>();
	readonly sha = new Map<string, string>();
	#nextId = 0;

	async store(input: PluginMediaStoreInput): Promise<PluginMediaRecord> {
		const hash = createHash("sha256").update(input.bytes).digest("hex");
		const existing = this.sha.get(hash);
		if (existing !== undefined) {
			const record = this.records.get(existing);
			if (record !== undefined) return record;
		}
		const id = `media-${(this.#nextId += 1)}`;
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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

interface ItemInput {
	readonly id: string;
	readonly bytes?: Uint8Array;
	readonly enabled?: boolean;
	readonly keywords?: readonly string[];
	readonly mimeType?: string;
	readonly reviewStatus?: "approved" | "pending" | "rejected";
	readonly revokedAt?: string | null;
	readonly dropMedia?: boolean;
}

async function seedItem(repository: StickerRepository, media: MemoryMedia, input: ItemInput) {
	const mimeType = input.mimeType ?? "image/png";
	const fileBytes = input.bytes ?? PNG_BYTES;
	const stored = await media.store({ bytes: fileBytes, kind: "sticker", mimeType });
	if (input.dropMedia === true) media.remove(stored.id);
	const item = await repository.upsertItem({
		description: `synthetic ${input.id}`,
		emotions: ["joy"],
		enabled: input.enabled ?? true,
		hash: stored.sha256,
		id: input.id,
		keywords: [...(input.keywords ?? ["synthetic"])],
		mediaId: stored.id,
		mimeType,
		name: input.id,
		packId: "pack-main",
		reviewStatus: input.reviewStatus ?? "approved",
		score: 1,
	});
	await repository.updateItem(item.id, { revokedAt: input.revokedAt ?? null });
	return {
		item: (await repository.getItem(item.id)) ?? item,
		stored,
	};
}

async function setup(items: readonly ItemInput[]) {
	const database = createDatabase();
	const media = new MemoryMedia();
	const repository = new StickerRepository(database);
	await repository.savePack({ id: "pack-main", name: "Main", tags: ["synthetic"] });
	await repository.savePack({ enabled: false, id: "pack-off", name: "Off" });
	const selection = new StickerSelectionService({ media, repository });
	const seeded = new Map<string, { itemId: string; mediaId: string }>();
	for (const item of items) {
		const { item: seededItem, stored } = await seedItem(repository, media, item);
		seeded.set(item.id, { itemId: seededItem.id, mediaId: stored.id });
	}
	const context = createPluginContext({
		grantedPermissions: stickerMemeManifest.permissions,
		manifest: stickerMemeManifest,
		media,
		pluginId: "sticker-meme",
	});
	registerStickerTools(context, selection);
	return { context, media, repository, seeded, selection };
}

async function invokeView(context: PluginContext, input: Record<string, unknown>) {
	const outcome = await context.tools.invoke("sticker-meme.view", input, {
		conversationId: "conversation-1",
	});
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) throw new Error(`sticker-meme.view failed: ${outcome.reason}`);
	return outcome.result;
}

function textPayload(result: { content: readonly { readonly text: string }[] }) {
	return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("sticker-meme.view", () => {
	test("registers an eager chat tool with the media-read policy", async () => {
		const { context } = await setup([{ id: "fresh" }]);
		const tool = context.tools.list().find((entry) => entry.name === "sticker-meme.view");
		expect(tool).toBeDefined();
		expect(tool?.policy?.lazy).toBe(false);
		expect(tool?.policy?.surface).toBe("chat");
		expect(tool?.policy?.timeoutMs).toBe(15_000);
		expect(tool?.requiredPermissions).toEqual(["media.read"]);
	});

	test("returns metadata and the static image for an exact itemId", async () => {
		const { context, seeded } = await setup([{ id: "fresh", keywords: ["happy"] }]);
		const result = await invokeView(context, { itemId: "fresh" });
		const payload = textPayload(result);
		expect(payload).toMatchObject({
			animated: false,
			emotions: ["joy"],
			itemId: "fresh",
			keywords: ["happy"],
			labels: [],
			mimeType: "image/png",
			name: "fresh",
			packId: "pack-main",
			packName: "Main",
		});
		expect(payload).not.toHaveProperty("frameSheetCount");
		expect(payload).not.toHaveProperty("note");
		expect(result.images).toEqual([
			{
				data: Buffer.from(PNG_BYTES).toString("base64"),
				mimeType: "image/png",
			},
		]);
		expect(seeded.get("fresh")?.mediaId).toMatch(/^media-/u);
	});

	test("falls back to the top search match by query when itemId is omitted", async () => {
		const { context } = await setup([
			{ id: "runner", keywords: ["sprint", "race"] },
			{ id: "sleeper", keywords: ["nap"] },
		]);
		const result = await invokeView(context, { query: "sprint" });
		expect(textPayload(result)).toMatchObject({ itemId: "runner" });
		expect(result.images?.[0]?.mimeType).toBe("image/png");
	});

	test("rejects unknown item ids and filtered-out stickers with a clear reason", async () => {
		const { context } = await setup([
			{ dropMedia: true, id: "no-media" },
			{ enabled: false, id: "disabled" },
			{ id: "pending", reviewStatus: "pending" },
			{ id: "revoked", revokedAt: "2026-01-01T00:00:00.000Z" },
		]);
		const notFound = await invokeView(context, { itemId: "missing" });
		expect(notFound.images).toBeUndefined();
		expect(notFound.content[0]?.text).toBe("No sticker candidate matched");

		for (const [id, denial] of [
			["no-media", "media_missing"],
			["disabled", "item_disabled"],
			["pending", "item_not_approved"],
			["revoked", "item_revoked"],
		] as const) {
			const result = await invokeView(context, { itemId: id });
			expect(result.images).toBeUndefined();
			expect(result.content[0]?.text).toBe(`Sticker is not viewable: ${denial}`);
		}
	});

	test("rejects media above the inspection size cap before encoding it", async () => {
		const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
		const { context } = await setup([{ bytes: oversized, id: "oversized" }]);
		const result = await invokeView(context, { itemId: "oversized" });
		expect(result.images).toBeUndefined();
		expect(result.content[0]?.text).toContain("too large to inspect");
		expect(result.content[0]?.text).toContain("5242880");
	});

	test("keeps animated GIF bytes when no frame sheet can be built", async () => {
		const { context } = await setup([{ bytes: GIF_BYTES, id: "animated", mimeType: "image/gif" }]);
		const result = await invokeView(context, { itemId: "animated" });
		const payload = textPayload(result);
		expect(payload).toMatchObject({ animated: true, itemId: "animated", mimeType: "image/gif" });
		expect(payload).not.toHaveProperty("frameSheetCount");
		expect(payload).not.toHaveProperty("note");
		expect(result.images).toEqual([
			{
				data: Buffer.from(GIF_BYTES).toString("base64"),
				mimeType: "image/gif",
			},
		]);
	});
});
