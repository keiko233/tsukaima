"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { liveEventSchema, type LiveEvent } from "@elaina/contracts";
import { useEffect } from "react";
import { orpc } from "./api";

const EVENT_STREAM_URL = import.meta.env.VITE_EVENT_STREAM_URL ?? "/events/stream";

const EVENT_TYPES = [
	"snapshot",
	"heartbeat",
	"message.received",
	"activity.opened",
	"activity.closed",
	"before.reply",
	"after.reply",
] as const;

function refreshConversation(queryClient: QueryClient, sessionId?: string): void {
	const pending = [
		queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.status.queryKey() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.groups.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.users.key() }),
	];
	if (sessionId !== undefined) {
		pending.push(
			queryClient.invalidateQueries({
				queryKey: orpc.admin.sessions.messages.key({ input: { sessionId } }),
			}),
		);
	}
	void Promise.all(pending);
}

function refreshDiagnostics(queryClient: QueryClient): void {
	void Promise.all([
		queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.status.queryKey() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.logs.queryKey() }),
	]);
}

function refreshSnapshot(queryClient: QueryClient): void {
	void Promise.all([
		queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.status.queryKey() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.requests.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.users.key() }),
		queryClient.invalidateQueries({ queryKey: orpc.admin.groups.key() }),
	]);
}

function applyLiveEvent(queryClient: QueryClient, event: LiveEvent): void {
	switch (event.type) {
		case "snapshot":
			refreshSnapshot(queryClient);
			return;
		case "heartbeat":
			// Channel connection state and the request inbox have no host hook yet; use the
			// existing event channel as a low-frequency resync instead of per-widget polling.
			void Promise.all([
				queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.status.queryKey() }),
				queryClient.invalidateQueries({ queryKey: orpc.admin.requests.key() }),
			]);
			return;
		case "message.received":
			refreshConversation(queryClient, event.sessionId);
			return;
		case "activity.opened":
		case "activity.closed":
			refreshDiagnostics(queryClient);
			return;
		case "before.reply":
		case "after.reply":
			refreshConversation(queryClient, event.sessionId);
			return;
	}
}

function parseEvent(event: Event): LiveEvent | null {
	try {
		const parsed = liveEventSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function createEventHandler(queryClient: QueryClient): (event: Event) => void {
	return (event) => {
		const parsed = parseEvent(event);
		if (parsed !== null) applyLiveEvent(queryClient, parsed);
	};
}

/**
 * One authenticated EventSource for the whole WebUI. EventSource handles reconnect itself; the
 * server sends a fresh snapshot on every connection, which refreshes any state missed while
 * offline. The effect is a no-op on the login screen.
 */
export function useEventStream(enabled: boolean): void {
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!enabled) return;
		const source = new EventSource(EVENT_STREAM_URL, { withCredentials: true });
		const handlers = EVENT_TYPES.map((type) => {
			const handler = createEventHandler(queryClient);
			source.addEventListener(type, handler);
			return [type, handler] as const;
		});
		return () => {
			for (const [type, handler] of handlers) source.removeEventListener(type, handler);
			source.close();
		};
	}, [enabled, queryClient]);
}
