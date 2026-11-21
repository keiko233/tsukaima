import { randomUUID } from "node:crypto";
import type { MessagePart } from "@tsukaima/contracts";

/**
 * Every kind of outbound content one turn can show before its final answer. Turns are tracked
 * separately so a sticker, image, or file send does not look like chat text: only text sends
 * suppress a later preamble or a repeated final answer.
 */
export type TurnEmissionKind = "narration" | "text" | "sticker" | "media" | "file" | "stream-line";

export interface TurnEmission {
	readonly kind: TurnEmissionKind;
	/** Stable dedupe key; a repeated record with the same id is ignored. */
	readonly id: string;
	readonly text?: string;
	/** Text a channel send tool posted itself, so the final answer may treat it as shown. */
	readonly shown?: boolean;
}

export interface TurnEmissionSnapshot {
	/** Narration and streamed lines already shown, used to strip a repeated final prefix. */
	readonly narrated: readonly string[];
	/** Chat text a tool already posted, used to drop it from the final answer. */
	readonly sentTexts: readonly string[];
	/** The turn already delivered something the reader has seen. */
	readonly substantiveOutbound: boolean;
}

const SUBSTANTIVE = /[\s\p{P}\p{S}]/gu;

const isSubstantive = (text: string): boolean => [...text.replace(SUBSTANTIVE, "")].length > 0;

/**
 * Process-local, per-turn record of outbound emissions. Deliberately not durable: recovery
 * only replays the expected final answer, and the outbound unique key bounds any post-restart
 * duplicate to one message.
 */
export class TurnEmissionTracker {
	readonly #turns = new Map<string, TurnEmission[]>();

	begin(conversationId: string): void {
		this.#turns.delete(conversationId);
	}

	end(conversationId: string): void {
		this.#turns.delete(conversationId);
	}

	record(conversationId: string, emission: TurnEmission): void {
		const existing = this.#turns.get(conversationId) ?? [];
		if (existing.some((entry) => entry.id === emission.id)) return;
		existing.push(emission);
		this.#turns.set(conversationId, existing);
	}

	/** Record a send's non-text parts by kind; chat text is recorded separately. */
	recordParts(conversationId: string, parts: readonly MessagePart[]): void {
		for (const part of parts) {
			const kind = emissionKindForPart(part);
			if (kind === undefined) continue;
			this.record(conversationId, { id: randomUUID(), kind });
		}
	}

	remove(conversationId: string, id: string): void {
		const existing = this.#turns.get(conversationId);
		if (existing === undefined) return;
		const index = existing.findIndex((entry) => entry.id === id);
		if (index < 0) return;
		existing.splice(index, 1);
		if (existing.length === 0) this.#turns.delete(conversationId);
	}

	/** True when a tool already posted chat text during the turn, which suppresses narration. */
	hasTextEmitted(conversationId: string): boolean {
		return (this.#turns.get(conversationId) ?? []).some((entry) => entry.kind === "text");
	}

	/** Narrated and streamed lines, optionally excluding one id still being decided. */
	narratedTexts(conversationId: string, excludeId?: string): string[] {
		const texts: string[] = [];
		for (const entry of this.#turns.get(conversationId) ?? []) {
			if (excludeId !== undefined && entry.id === excludeId) continue;
			if (entry.kind !== "narration" && entry.kind !== "stream-line") continue;
			const text = entry.text?.trim() ?? "";
			if (text.length > 0) texts.push(text);
		}
		return texts;
	}

	/** Capture the turn's emissions before an await can admit a newer turn. */
	capture(conversationId: string): TurnEmissionSnapshot {
		const emissions = this.#turns.get(conversationId) ?? [];
		const narrated: string[] = [];
		const sentTexts: string[] = [];
		let substantiveOutbound = false;
		for (const entry of emissions) {
			const text = entry.text?.trim() ?? "";
			if (text.length > 0 && isSubstantive(text)) substantiveOutbound = true;
			if (text.length === 0) {
				if (entry.kind !== "narration" && entry.kind !== "stream-line") substantiveOutbound = true;
				continue;
			}
			if (entry.kind === "narration" || entry.kind === "stream-line") narrated.push(text);
			if (entry.kind === "text") {
				sentTexts.push(text);
				if (entry.shown === true) narrated.push(text);
			}
		}
		return { narrated, sentTexts, substantiveOutbound };
	}
}

/** The tracker category for a non-text part; text is its own category. */
export function emissionKindForPart(part: MessagePart): TurnEmissionKind | undefined {
	switch (part.type) {
		case "sticker":
			return "sticker";
		case "image":
		case "audio":
		case "video":
			return "media";
		case "file":
			return "file";
		default:
			return undefined;
	}
}
