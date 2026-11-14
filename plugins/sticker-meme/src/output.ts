import type { MessagePart } from "@elaina/contracts";
import type { AuditEntry, PluginLogger, PluginMediaApi } from "@elaina/sdk";
import { normalizeText, sanitizeModelText } from "./domain.ts";
import { STICKER_MEME_DIRECTIVE_PATTERN } from "./manifest.ts";
import type { StickerRepository } from "./repository.ts";

export type StickerTextPiece =
	| { readonly text: string; readonly type: "text" }
	| { readonly token: string; readonly type: "directive" };

export interface StickerReplyTransformPayload {
	readonly conversationId?: string;
	readonly parts?: readonly MessagePart[];
	readonly sessionId?: string;
	readonly text?: string;
}

export interface StickerReplyTransformResult {
	readonly parts: readonly MessagePart[];
	readonly text: string;
}

export interface StickerOutputOptions {
	readonly audit?: { record(entry: AuditEntry): Promise<void> };
	readonly logger?: PluginLogger;
	readonly media: PluginMediaApi;
	readonly repository: StickerRepository;
}

const normalizeDirectiveText = (text: string): StickerTextPiece[] => {
	const pattern = new RegExp(STICKER_MEME_DIRECTIVE_PATTERN.source, "gu");
	const pieces: StickerTextPiece[] = [];
	let cursor = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > cursor) pieces.push({ text: text.slice(cursor, index), type: "text" });
		const token = match[1] ?? match[2];
		if (token !== undefined) pieces.push({ token, type: "directive" });
		cursor = index + match[0].length;
	}
	if (cursor < text.length) pieces.push({ text: text.slice(cursor), type: "text" });
	return pieces.length === 0 ? [{ text, type: "text" }] : pieces;
};

export function splitStickerDirectives(text: string): StickerTextPiece[] {
	return normalizeDirectiveText(text);
}

/** Replace validated directives with real sticker parts while preserving part order. */
export function createStickerReplyTransform(options: StickerOutputOptions) {
	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.record(entry);
		} catch (error) {
			options.logger?.warn("sticker transform audit failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const reject = async (reason: string, itemId?: string): Promise<void> => {
		await audit({
			action: "sticker.transform.rejected",
			actorKind: "plugin",
			payload: { reason },
			reason,
			result: "denied",
			...(itemId === undefined ? {} : { targetId: itemId }),
			targetKind: "sticker-item",
		});
	};
	return async (payload: unknown): Promise<StickerReplyTransformResult | undefined> => {
		if (typeof payload !== "object" || payload === null) return undefined;
		const input = payload as StickerReplyTransformPayload;
		const conversationId = normalizeText(input.conversationId ?? input.sessionId);
		const parts = Array.isArray(input.parts) ? input.parts : [];
		if (conversationId.length === 0) return undefined;
		const output: MessagePart[] = [];
		for (const part of parts) {
			if (part.type !== "text") {
				output.push(part);
				continue;
			}
			for (const piece of splitStickerDirectives(part.text)) {
				if (piece.type === "text") {
					if (piece.text.length > 0) output.push({ text: piece.text, type: "text" });
					continue;
				}
				const consumed = await options.repository.consumeToken(piece.token, conversationId);
				if (consumed.failure !== undefined) {
					await reject(consumed.failure);
					output.push({ text: "[sticker unavailable]", type: "text" });
					continue;
				}
				const item = await options.repository.getItem(consumed.itemId ?? "");
				if (
					item === undefined ||
					item.mediaId.length === 0 ||
					!item.enabled ||
					item.revokedAt !== null ||
					item.reviewStatus !== "approved"
				) {
					await reject("item_unavailable", consumed.itemId);
					output.push({ text: "[sticker unavailable]", type: "text" });
					continue;
				}
				const pack = await options.repository.getPack(item.packId);
				if (pack === undefined || !pack.enabled) {
					await reject("pack_unavailable", item.id);
					output.push({ text: "[sticker unavailable]", type: "text" });
					continue;
				}
				const media = await options.media.findById(item.mediaId);
				if (media === undefined) {
					await reject("media_missing", item.id);
					output.push({ text: "[sticker unavailable]", type: "text" });
					continue;
				}
				const mediaPart = {
					...(item.height === null ? {} : { height: item.height }),
					mediaId: item.mediaId,
					mimeType: item.mimeType,
					modelReadable: false,
					previewText: sanitizeModelText(item.name),
					sha256: item.hash,
					...(item.width === null ? {} : { width: item.width }),
				} as const;
				output.push(
					item.mimeType.toLowerCase().startsWith("video/")
						? { ...mediaPart, type: "video" }
						: { ...mediaPart, type: "sticker" },
				);
				await audit({
					action: "sticker.transform.sent",
					actorKind: "plugin",
					payload: { conversationId, itemId: item.id, packId: item.packId },
					result: "ok",
					targetId: item.id,
					targetKind: "sticker-item",
				});
			}
		}
		const text = output
			.filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return { parts: output, text };
	};
}
