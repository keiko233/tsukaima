import type { InfiniteData } from "@tanstack/react-query";
import type { MessagePage, MessageSummary } from "@elaina/contracts";

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

/**
 * Transcript order: oldest first, with the id as the tie-breaker for rows written in the same
 * millisecond. Mirrors the server's `(occurred_at, id)` ordering, so a page merged in from a
 * live event lands exactly where the next cursor page expects it.
 */
export function compareMessageOrder(a: MessageSummary, b: MessageSummary): number {
	if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
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
