import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { MessagePage, MessageSummary } from "@elaina/contracts";
import { client, orpc } from "./api";
import { mergeMessagePages, messageListInput, type MessagePageParam } from "./message-pages";

/** Reverse-cursor transcript query: page 0 is the newest page, each next page is older. */
export function messageListOptions(sessionId: string) {
	return orpc.admin.sessions.messages.infiniteOptions({
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		initialPageParam: null as MessagePageParam,
		input: (cursor: MessagePageParam) => messageListInput(sessionId, cursor),
	});
}

/** Exact cache key used by both the transcript and live-event upserts. */
export function messageListKey(sessionId: string) {
	return orpc.admin.sessions.messages.infiniteKey({
		initialPageParam: null as MessagePageParam,
		input: (cursor: MessagePageParam) => messageListInput(sessionId, cursor),
	});
}

export function upsertMessagesInCache(
	queryClient: QueryClient,
	sessionId: string,
	messages: readonly MessageSummary[],
): void {
	if (messages.length === 0) return;
	const queryKey = messageListKey(sessionId);
	const updated = queryClient.setQueryData<InfiniteData<MessagePage, MessagePageParam>>(
		queryKey,
		(data) => (data === undefined ? data : mergeMessagePages(data, messages)),
	);
	// A live row can arrive while the first page is still in flight. There is no page to merge
	// into yet, so mark the query stale and let the in-flight/next fetch include it.
	if (updated === undefined) void queryClient.invalidateQueries({ queryKey });
}

/**
 * Re-read the one row a live event introduced and merge it into the transcript cache.
 *
 * Invalidating the infinite query instead would refetch every page the reader has scrolled
 * back through, once per inbound message. On failure the list falls back to invalidation so a
 * missed event still converges.
 */
export async function refreshMessageInCache(
	queryClient: QueryClient,
	sessionId: string,
	lookup: { durableEntryId: string } | { messageId: string },
): Promise<void> {
	try {
		const message = await client.admin.sessions.message({ sessionId, ...lookup });
		if (message !== null) upsertMessagesInCache(queryClient, sessionId, [message]);
	} catch {
		await queryClient.invalidateQueries({
			queryKey: orpc.admin.sessions.messages.key({ input: { sessionId } }),
		});
	}
}

/** Invalidate one transcript, or every cached transcript when no session is given. */
export function invalidateMessageLists(queryClient: QueryClient, sessionId?: string) {
	return queryClient.invalidateQueries({
		queryKey:
			sessionId === undefined
				? orpc.admin.sessions.messages.key()
				: orpc.admin.sessions.messages.key({ input: { sessionId } }),
	});
}
