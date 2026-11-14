"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { liveEventSchema, type LiveEvent } from "@tsukaima/contracts";
import type { PluginRow } from "@tsukaima/contracts";
import { useEffect } from "react";
import { orpc } from "./api";
import { applyRunDelta, setLiveRun } from "./live-run-store";
import { runtimeUrl } from "./runtime-url";

const EVENT_STREAM_URL = runtimeUrl("/events/stream");

const EVENT_TYPES = [
	"snapshot",
	"heartbeat",
	"message.received",
	"activity.opened",
	"activity.closed",
	"before.reply",
	"after.reply",
	"plugin.status",
	"run.state",
	"run.delta",
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
		case "plugin.status": {
			const rows = queryClient.getQueryData<PluginRow[]>(orpc.admin.plugins.list.queryKey());
			if (rows === undefined) {
				void queryClient.invalidateQueries({ queryKey: orpc.admin.plugins.key() });
				return;
			}
			queryClient.setQueryData(
				orpc.admin.plugins.list.queryKey(),
				rows.map((row) => (row.id === event.pluginId ? { ...row, status: event.status } : row)),
			);
			return;
		}
		case "run.state": {
			// Snapshot from the KV cache on connect, or the terminal `run: null`. Written to its
			// own store so a 100ms partial does not invalidate the transcript and diagnostics.
			setLiveRun(event.sessionId, event.run);
			if (event.run === null || event.run.settled) {
				refreshConversation(queryClient, event.sessionId);
			}
			return;
		}
		case "run.delta": {
			// Only the fields that moved arrive here. The store merges them and orders them by
			// revision, so a delta that races a reconnect snapshot never rewinds the view.
			applyRunDelta(event.sessionId, event.patch, event.revision);
			if (event.patch.settled === true) refreshConversation(queryClient, event.sessionId);
			return;
		}
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
