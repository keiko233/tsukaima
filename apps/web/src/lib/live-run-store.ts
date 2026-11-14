"use client";

import type { LiveRunPatch, LiveRunState } from "@elaina/contracts";
import { useSyncExternalStore } from "react";

/**
 * In-flight agent runs, keyed by domain session id.
 *
 * Live run state is deliberately kept out of TanStack Query. It is high-frequency (a partial
 * answer commits every ~100ms) and ephemeral: it never appears in a refetch, and a stale entry
 * would show a phantom run. A tiny external store lets the event stream write it without
 * invalidating every conversation query, and lets the transcript subscribe per session.
 *
 * The store is module-scoped rather than React state because the EventSource lives in the
 * app shell while the transcript is mounted much deeper.
 */
type Listener = () => void;

const runs = new Map<string, LiveRunState>();
const listeners = new Set<Listener>();

/** A settled run publishes `run: null`, which clears the entry. */
export function setLiveRun(sessionId: string, run: LiveRunState | null): void {
	const previous = runs.get(sessionId);
	if (run === null || (run.settled && run.failure === undefined)) {
		if (previous === undefined) return;
		runs.delete(sessionId);
	} else {
		// A snapshot read from the KV cache can race a delta that was published just before it.
		// The revision is monotonic per session, so an older snapshot never overwrites a newer run.
		if (
			previous?.revision !== undefined &&
			run.revision !== undefined &&
			run.revision < previous.revision
		) {
			return;
		}
		// Skip a write that changes nothing: `partialText` is the only field that moves during a
		// generation, so comparing the whole object keeps identical commits from re-rendering.
		if (previous !== undefined && sameRun(previous, run)) return;
		runs.set(sessionId, run);
	}
	for (const listener of listeners) listener();
}

/**
 * Apply one incremental run commit. A browser that already renders the run only receives the
 * fields that moved, so a 100ms text commit stays small even when the answer is long.
 */
export function applyRunDelta(sessionId: string, patch: LiveRunPatch, revision: number): void {
	const previous = runs.get(sessionId);
	if (previous?.revision !== undefined && revision <= previous.revision) return;
	const base: LiveRunState =
		previous ??
		({
			draftTools: [],
			sessionId,
			settled: false,
			startedAtMs: Date.now(),
			steps: [],
			tools: [],
			turns: 0,
		} satisfies LiveRunState);
	const { failure, retry, ...fields } = patch;
	const next: LiveRunState = {
		...base,
		...fields,
		...(failure === undefined ? {} : failure === null ? { failure: undefined } : { failure }),
		...(retry === undefined ? {} : retry === null ? { retry: undefined } : { retry }),
		revision,
	};
	if (next.settled && next.failure === undefined) {
		clearLiveRun(sessionId);
		return;
	}
	if (sameRun(base, next)) return;
	runs.set(sessionId, next);
	for (const listener of listeners) listener();
}

export function clearLiveRun(sessionId: string): void {
	setLiveRun(sessionId, null);
}

export function getLiveRun(sessionId: string): LiveRunState | undefined {
	return runs.get(sessionId);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sameRun(a: LiveRunState, b: LiveRunState): boolean {
	return (
		a.attempt === b.attempt &&
		a.failure === b.failure &&
		sameJson(a.model, b.model) &&
		a.partialText === b.partialText &&
		a.partialThinking === b.partialThinking &&
		a.phase === b.phase &&
		a.retry?.at === b.retry?.at &&
		a.retry?.error === b.retry?.error &&
		a.revision === b.revision &&
		a.startedAtMs === b.startedAtMs &&
		sameJson(a.steps ?? [], b.steps ?? []) &&
		sameJson(a.draftTools ?? [], b.draftTools ?? []) &&
		a.turns === b.turns &&
		a.tools.length === b.tools.length &&
		a.tools.every((tool, index) => {
			const other = b.tools[index];
			return (
				other !== undefined &&
				tool.argumentsText === other.argumentsText &&
				tool.callId === other.callId &&
				tool.output === other.output &&
				tool.status === other.status &&
				tool.toolName === other.toolName
			);
		})
	);
}

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Subscribe to any change. Exposed for tests and for non-React readers; components use
 * `useLiveRun`, which wraps this with `useSyncExternalStore`.
 */
export const subscribeLiveRuns = subscribe;

/** The live run of one session, or `undefined` when it is idle. */
export function useLiveRun(sessionId: string): LiveRunState | undefined {
	return useSyncExternalStore(
		subscribe,
		() => runs.get(sessionId),
		// The server never renders this; a stable `undefined` keeps hydration quiet.
		() => undefined,
	);
}
