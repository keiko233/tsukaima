import type { InfiniteData } from "@tanstack/react-query";
import type { MessagePage, MessageSummary, RunSegmentSummary } from "@tsukaima/contracts";

/** Matches the server's default page size; large enough to fill a desktop viewport. */
export const MESSAGE_PAGE_SIZE = 50;

/** The opaque cursor is `null` for the newest page (TanStack Query's first page param). */
export type MessagePageParam = string | null;

export function messageListInput(sessionId: string, cursor: MessagePageParam = null) {
	return {
		sessionId,
		limit: MESSAGE_PAGE_SIZE,
		...(cursor === null ? {} : { cursor }),
	};
}

function sequenceGroup(seq: number): number {
	return seq > 0 ? 1 : 0;
}

/**
 * Transcript order: sequenced rows first, then legacy rows (`seq === 0`), each ordered by time
 * and id. Mirrors the server comparator so every merged page agrees with the next cursor.
 */
export function compareMessageOrder(a: MessageSummary, b: MessageSummary): number {
	const group = sequenceGroup(a.seq) - sequenceGroup(b.seq);
	if (group !== 0) return group;
	if (a.seq !== b.seq) return a.seq - b.seq;
	if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/** Segment order inside a conversation timeline: seq first, then the segment's own index. */
export function compareRunSegmentOrder(a: RunSegmentSummary, b: RunSegmentSummary): number {
	if (a.seq !== b.seq) return a.seq - b.seq;
	if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

function segmentEndedAtMs(segment: RunSegmentSummary): number | undefined {
	if (segment.endedAt === null) return undefined;
	const parsed = Date.parse(segment.endedAt);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Prefer the row that represents later durable state. A running segment can be repeated by
 * several pages; once one copy has ended, that copy wins even if it arrives before the stale
 * running one when pages are flattened.
 */
function preferSegment(
	current: RunSegmentSummary,
	candidate: RunSegmentSummary,
): RunSegmentSummary {
	const currentEnded = segmentEndedAtMs(current);
	const candidateEnded = segmentEndedAtMs(candidate);
	if (currentEnded === undefined && candidateEnded !== undefined) return candidate;
	if (candidateEnded === undefined && currentEnded !== undefined) return current;
	if (
		currentEnded !== undefined &&
		candidateEnded !== undefined &&
		currentEnded !== candidateEnded
	) {
		return candidateEnded > currentEnded ? candidate : current;
	}
	// Same state: a copied segment with more rounds or a later input is the newer read.
	if (candidate.rounds.length < current.rounds.length) return current;
	return candidate;
}

/**
 * Merge the same segment fetched from more than one cursor page.
 *
 * Pages share their boundary segments deliberately, so keying by id prevents a steer/continuation
 * segment from rendering twice. Newer durable data wins, and a stable seq order keeps the
 * interleaving deterministic after a merge.
 */
export function mergeRunSegments(segments: readonly RunSegmentSummary[]): RunSegmentSummary[] {
	const byId = new Map<string, RunSegmentSummary>();
	for (const segment of segments) {
		const current = byId.get(segment.id);
		byId.set(segment.id, current === undefined ? segment : preferSegment(current, segment));
	}
	return [...byId.values()].toSorted(compareRunSegmentOrder);
}

/**
 * Flatten the segments of a reverse-cursor query. `pages` is newest first, so walking it from the
 * oldest page makes a later duplicate from the newest page win.
 */
export function mergeMessagePageRunSegments(pages: readonly MessagePage[]): RunSegmentSummary[] {
	return mergeRunSegments(pages.toReversed().flatMap((page) => page.runSegments));
}

/**
 * Merge rows fetched for live events into a reverse-cursor cache.
 *
 * Existing rows are replaced in every page (delivery status changes), while a row that is not
 * loaded yet is appended to the newest page only when it cannot belong to an older page. A
 * message older than the newest page's first row is left out: it will arrive with the next
 * cursor page instead of creating an overlap.
 */
export function mergeMessagePages(
	data: InfiniteData<MessagePage, MessagePageParam>,
	incoming: readonly MessageSummary[],
): InfiniteData<MessagePage, MessagePageParam> {
	if (incoming.length === 0) return data;
	const remaining = new Map(incoming.map((message) => [message.id, message]));
	const pages = data.pages.map((page) => {
		let changed = false;
		const messages = page.messages.map((existing) => {
			const update = remaining.get(existing.id);
			if (update === undefined) return existing;
			remaining.delete(existing.id);
			changed = true;
			return update;
		});
		if (!changed) return page;
		return { ...page, messages: messages.toSorted(compareMessageOrder) };
	});

	const first = pages[0];
	if (first !== undefined && remaining.size > 0) {
		const oldestLoaded = first.messages[0];
		const appendable = [...remaining.values()].filter(
			(message) => oldestLoaded === undefined || compareMessageOrder(message, oldestLoaded) >= 0,
		);
		if (appendable.length > 0) {
			pages[0] = {
				...first,
				messages: [...first.messages, ...appendable].toSorted(compareMessageOrder),
			};
		}
	}

	return { ...data, pages };
}
