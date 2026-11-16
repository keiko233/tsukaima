"use client";

import type { LogEntry, LogSnapshot } from "@tsukaima/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { runtimeUrl } from "./runtime-url";

const LOG_STREAM_URL = runtimeUrl("/events/logs");

export type LogStreamState = "connecting" | "live" | "reconnecting";

function parseStreamData<T>(event: Event): T | null {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as T;
	} catch {
		return null;
	}
}

/**
 * One log EventSource per mounted consumer. Pass `enabled: false` to disconnect when a
 * panel is closed; the server sends a fresh snapshot on the next connection.
 */
export function useLogStream(enabled = true) {
	const [entries, setEntries] = useState<LogEntry[]>([]);
	const [capacity, setCapacity] = useState(5_000);
	const [streamState, setStreamState] = useState<LogStreamState>("connecting");
	const capacityRef = useRef(5_000);

	useEffect(() => {
		if (!enabled) return;
		setStreamState("connecting");
		const source = new EventSource(LOG_STREAM_URL, { withCredentials: true });
		const handleSnapshot = (event: Event) => {
			const snapshot = parseStreamData<LogSnapshot>(event);
			if (snapshot === null) return;
			capacityRef.current = snapshot.capacity;
			setCapacity(snapshot.capacity);
			setEntries([...snapshot.entries]);
			setStreamState("live");
		};
		const handleLog = (event: Event) => {
			const entry = parseStreamData<LogEntry>(event);
			if (entry === null) return;
			setEntries((previous) => {
				if (previous.some((item) => item.id === entry.id)) return previous;
				return [...previous, entry].slice(-Math.max(1, capacityRef.current));
			});
		};
		source.addEventListener("open", () => setStreamState("live"));
		source.addEventListener("snapshot", handleSnapshot);
		source.addEventListener("log", handleLog);
		source.addEventListener("error", () => setStreamState("reconnecting"));
		return () => {
			source.close();
		};
	}, [enabled]);

	const clearLocal = useCallback(() => setEntries([]), []);

	return { capacity, clearLocal, entries, streamState };
}
