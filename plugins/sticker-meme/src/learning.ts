import type {
	AuditEntry,
	PluginConfig,
	PluginLogger,
	PluginMediaApi,
	PluginSettingsApi,
} from "@elaina/sdk";
import { decodeBase64 } from "./archive.ts";
import {
	inferMimeType,
	normalizeLabels,
	normalizeText,
	recordValue,
	sha256Bytes,
	stableId,
	type StickerItem,
} from "./domain.ts";
import type { StickerItemInput, StickerRepository } from "./repository.ts";

export interface LearningSettings {
	readonly allowGenerated: boolean;
	readonly dailyCap: number;
	readonly duplicateThreshold: number;
	readonly enabled: boolean;
	readonly retentionDays: number;
}

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
	allowGenerated: false,
	dailyCap: 20,
	duplicateThreshold: 1,
	enabled: true,
	retentionDays: 30,
};

export interface LearningServiceOptions {
	readonly audit?: { record(entry: AuditEntry): Promise<void> };
	readonly config?: PluginConfig;
	readonly logger?: PluginLogger;
	readonly media: PluginMediaApi;
	readonly now?: () => number;
	readonly repository: StickerRepository;
	readonly settings?: PluginSettingsApi;
}

export interface LearnInput {
	readonly bytesBase64?: string;
	readonly description?: string;
	readonly emotions?: readonly string[] | string;
	readonly keywords?: readonly string[] | string;
	readonly mediaId?: string;
	readonly mimeType?: string;
	readonly name?: string;
	readonly packId?: string;
	readonly source?: "admin" | "generated" | "learned";
	readonly sourceConversationId?: string;
}

export interface LearnedCandidate {
	readonly item: StickerItem;
	readonly reason?: "daily_cap" | "duplicate" | "disabled" | "missing_media" | "policy";
}

function readNumber(value: unknown, fallback: number, min: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(min, Math.floor(value))
		: fallback;
}

function asLearning(value: unknown): LearningSettings {
	const record = recordValue(value);
	return {
		allowGenerated:
			typeof record.allowGenerated === "boolean"
				? record.allowGenerated
				: DEFAULT_LEARNING_SETTINGS.allowGenerated,
		dailyCap: readNumber(record.dailyCap, DEFAULT_LEARNING_SETTINGS.dailyCap, 0),
		duplicateThreshold: readNumber(
			record.duplicateThreshold,
			DEFAULT_LEARNING_SETTINGS.duplicateThreshold,
			1,
		),
		enabled:
			typeof record.enabled === "boolean" ? record.enabled : DEFAULT_LEARNING_SETTINGS.enabled,
		retentionDays: readNumber(record.retentionDays, DEFAULT_LEARNING_SETTINGS.retentionDays, 1),
	};
}

function decodeMediaRef(value: string): Uint8Array | undefined {
	if (!value.startsWith("base64://") && !value.startsWith("data:")) return undefined;
	try {
		return decodeBase64(value);
	} catch {
		return undefined;
	}
}

function startOfDay(now: number): string {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.toISOString();
}

/** Captures learnable inbound stickers, admin uploads, and policy-gated generated images. */
export class LearningService {
	readonly #audit: LearningServiceOptions["audit"];
	readonly #config: PluginConfig | undefined;
	readonly #logger: PluginLogger | undefined;
	readonly #media: PluginMediaApi;
	readonly #now: () => number;
	readonly #repository: StickerRepository;
	readonly #settings: PluginSettingsApi | undefined;

	constructor(options: LearningServiceOptions) {
		this.#audit = options.audit;
		this.#config = options.config;
		this.#logger = options.logger;
		this.#media = options.media;
		this.#now = options.now ?? Date.now;
		this.#repository = options.repository;
		this.#settings = options.settings;
	}

	async settings(): Promise<LearningSettings> {
		const full = await this.#settings?.get();
		const fromSettings = recordValue(full).learning;
		if (fromSettings !== undefined) return asLearning(fromSettings);
		return asLearning(await this.#config?.get("learning"));
	}

	async learn(input: LearnInput): Promise<LearnedCandidate> {
		const settings = await this.settings();
		const source = input.source ?? "learned";
		if (!settings.enabled && source === "learned") {
			return { item: placeholderItem(input, "learned"), reason: "disabled" };
		}
		if (source === "generated" && !settings.allowGenerated) {
			return { item: placeholderItem(input, "generated"), reason: "policy" };
		}
		let bytes: Uint8Array | undefined;
		if (input.bytesBase64 !== undefined) {
			try {
				bytes = decodeBase64(input.bytesBase64);
			} catch {
				bytes = undefined;
			}
		}
		if (bytes === undefined && input.mediaId !== undefined) {
			try {
				bytes = await this.#media.readBytes(input.mediaId);
			} catch {
				bytes = undefined;
			}
		}
		if (bytes === undefined || bytes.byteLength === 0) {
			return { item: placeholderItem(input, source), reason: "missing_media" };
		}
		await this.#purge(settings);
		const hash = sha256Bytes(bytes);
		const duplicates = await this.#repository.findItemsByHash(hash);
		if (duplicates.length >= settings.duplicateThreshold) {
			return { item: duplicates[0] ?? placeholderItem(input, source), reason: "duplicate" };
		}
		const since = startOfDay(this.#now());
		if ((await this.#repository.countItemsSince(since)) >= settings.dailyCap) {
			return { item: placeholderItem(input, source), reason: "daily_cap" };
		}
		const pack = await this.#learnedPack(input.packId);
		const name = normalizeText(input.name, `learned-${hash.slice(0, 8)}`);
		const fileName = `${name}.png`;
		const keywordResult = normalizeLabels(input.keywords);
		const emotionResult = normalizeLabels(input.emotions);
		const stored = await this.#media.store({
			bytes,
			kind: "sticker",
			mimeType: normalizeText(input.mimeType, inferMimeType(fileName)),
			source: source === "generated" ? "generated" : source === "admin" ? "webui" : "channel",
		});
		const itemInput: StickerItemInput = {
			description: normalizeText(input.description),
			emotions: emotionResult.values,
			hash,
			keywords: keywordResult.values,
			mediaId: stored.id,
			mimeType: stored.mimeType,
			name,
			packId: pack.id,
			reviewStatus: "pending",
			sourceConversationId: input.sourceConversationId ?? null,
		};
		const item = await this.#repository.upsertItem(itemInput);
		await this.#audit?.record({
			action: "sticker.candidate.created",
			actorKind: source === "learned" ? "plugin" : "user",
			payload: { itemId: item.id, packId: pack.id, source },
			result: "ok",
			targetId: item.id,
			targetKind: "sticker-item",
		});
		this.#logger?.debug("sticker candidate learned", { itemId: item.id, source });
		return { item };
	}

	async learnFromEnvelope(payload: unknown): Promise<LearnedCandidate | undefined> {
		const record = recordValue(payload);
		const envelope = recordValue(record.envelope);
		const parts = Array.isArray(envelope.parts) ? envelope.parts : [];
		const sessionId = normalizeText(record.sessionId ?? record.chatObjectId);
		for (const rawPart of parts) {
			const part = recordValue(rawPart);
			if (part.type !== "sticker" && part.type !== "image") continue;
			const learnable = part.modelReadable === true || part.learnable === true;
			if (!learnable) continue;
			let bytes: Uint8Array | undefined;
			const channelRef = normalizeText(part.channelRef);
			if (channelRef.length > 0) bytes = decodeMediaRef(channelRef);
			const mediaId = normalizeText(part.mediaId);
			if (bytes === undefined && mediaId.length > 0) {
				try {
					bytes = await this.#media.readBytes(mediaId);
				} catch {
					bytes = undefined;
				}
			}
			const sha256 = normalizeText(part.sha256);
			if (bytes === undefined && sha256.length > 0) {
				const stored = await this.#media.findBySha(sha256);
				if (stored !== undefined) {
					try {
						bytes = await this.#media.readBytes(stored.id);
					} catch {
						bytes = undefined;
					}
				}
			}
			if (bytes === undefined) continue;
			return await this.learn({
				bytesBase64: Buffer.from(bytes).toString("base64"),
				...(normalizeText(part.previewText).length === 0
					? {}
					: {
							description: normalizeText(part.previewText),
							name: normalizeText(part.previewText),
						}),
				...(normalizeText(part.mimeType).length === 0
					? {}
					: { mimeType: normalizeText(part.mimeType) }),
				...(mediaId.length === 0 ? {} : { mediaId }),
				source: "learned",
				...(sessionId.length === 0 ? {} : { sourceConversationId: sessionId }),
			});
		}
		return undefined;
	}

	async #learnedPack(packId: string | undefined): Promise<{ id: string }> {
		if (packId !== undefined) {
			const existing = await this.#repository.getPack(packId);
			if (existing !== undefined) return existing;
		}
		const id = stableId("pack", `learned:${packId ?? "default"}`);
		return await this.#repository.savePack({
			id,
			name: packId ?? "Learned stickers",
			source: "learned",
			tags: ["learned"],
		});
	}

	async #purge(settings: LearningSettings): Promise<void> {
		const cutoff = new Date(this.#now() - settings.retentionDays * 86_400_000).toISOString();
		const purged = await this.#repository.purgeExpiredCandidates(cutoff);
		if (purged > 0) this.#logger?.debug("purged expired sticker candidates", { purged });
	}
}

function placeholderItem(
	input: LearnInput,
	source: "admin" | "generated" | "learned",
): StickerItem {
	const now = new Date(0).toISOString();
	return {
		createdAt: now,
		description: normalizeText(input.description),
		emotions: [],
		enabled: false,
		hash: "",
		height: null,
		id: "",
		keywords: [],
		lastUsedAt: null,
		mediaId: "",
		mimeType: normalizeText(input.mimeType, "image/png"),
		name: normalizeText(input.name, `${source}-candidate`),
		packId: normalizeText(input.packId),
		reviewStatus: "pending",
		revokedAt: null,
		score: 0,
		sourceConversationId: input.sourceConversationId ?? null,
		updatedAt: now,
		useCount: 0,
		width: null,
	};
}
