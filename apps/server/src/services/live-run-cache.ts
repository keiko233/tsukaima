import type { LiveRunPatch, LiveRunPhase, LiveRunState, RunStep } from "@tsukaima/contracts";
import type { KeyvCache } from "@tsukaima/cache";
import type { LiveRunSnapshot } from "@tsukaima/core";
import { LiveRunTimeline } from "./live-run-timeline.ts";

/** An active run is readable across a browser reload and a short host restart. */
const STATE_TTL_MS = 30 * 60_000;
/** The final state of one answer, used to keep its process chain readable after `pi.live` clears. */
const FINAL_TTL_MS = 7 * 24 * 60 * 60_000;
const STREAM_TTL_MS = STATE_TTL_MS;
const STREAM_MAX_EVENTS = 500;
const STATE_PREFIX = "run.state.";
const FINAL_PREFIX = "run.final.";
const CHANNEL = "run";

export interface LiveRunUpdate {
	readonly patch: LiveRunPatch;
	readonly revision: number;
	readonly sessionId: string;
	readonly state: LiveRunState;
}

export interface LiveRunFinal {
	readonly durationSeconds?: number;
	readonly entryId: string;
	readonly sessionId: string;
	readonly steps: readonly RunStep[];
}

function phaseOf(
	state: LiveRunSnapshot,
	settled: boolean,
	thinking: string,
	text: string,
): LiveRunPhase {
	if (settled) return "settled";
	if (state.tools.some((tool) => tool.status !== "done")) return "tools";
	if (state.retry !== undefined) return "retry";
	if (text.length > 0) return "writing";
	if (thinking.length > 0) return "thinking";
	if (state.draftTools.length > 0) return "tool_calls";
	return "queued";
}

interface ToolView {
	readonly argumentsText?: string | undefined;
	readonly callId: string;
	readonly output?: string | undefined;
	readonly status: "pending" | "running" | "done";
	readonly toolName: string;
}

function sameTools(a: readonly ToolView[], b: readonly ToolView[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((tool, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			tool.argumentsText === other.argumentsText &&
			tool.callId === other.callId &&
			tool.output === other.output &&
			tool.status === other.status &&
			tool.toolName === other.toolName
		);
	});
}

function sameSteps(a: readonly RunStep[] | undefined, b: readonly RunStep[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

function sameDrafts(
	a: LiveRunState["draftTools"] | undefined,
	b: LiveRunState["draftTools"] | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

function sameModel(a: LiveRunState["model"], b: LiveRunState["model"]): boolean {
	return a?.modelId === b?.modelId && a?.providerId === b?.providerId;
}

function sameRetry(a: LiveRunState["retry"], b: LiveRunState["retry"]): boolean {
	return a?.at === b?.at && a?.error === b?.error;
}

function plainTools(state: LiveRunSnapshot): LiveRunState["tools"] {
	return state.tools.map((tool) => ({
		...(tool.argumentsText === undefined ? {} : { argumentsText: tool.argumentsText }),
		callId: tool.callId,
		...(tool.output === undefined ? {} : { output: tool.output }),
		status: tool.status,
		toolName: tool.toolName,
	}));
}

function plainDrafts(state: LiveRunSnapshot): LiveRunState["draftTools"] {
	return state.draftTools.map((tool) => ({
		...(tool.argumentsText === undefined ? {} : { argumentsText: tool.argumentsText }),
		callId: tool.callId,
		toolName: tool.toolName,
	}));
}

function buildPatch(previous: LiveRunState | undefined, next: LiveRunState): LiveRunPatch {
	const patch: LiveRunPatch = { revision: next.revision ?? 0 };
	if (previous === undefined) {
		if (next.attempt !== undefined) patch.attempt = next.attempt;
		patch.draftTools = next.draftTools ?? [];
		patch.partialText = next.partialText ?? "";
		patch.partialThinking = next.partialThinking ?? "";
		patch.phase = next.phase ?? "queued";
		patch.retry = next.retry ?? null;
		patch.settled = next.settled;
		patch.steps = next.steps ?? [];
		patch.tools = next.tools;
		patch.turns = next.turns;
		if (next.model !== undefined) patch.model = next.model;
		if (next.failure === undefined) patch.failure = null;
		else patch.failure = next.failure;
		return patch;
	}
	if (next.attempt !== undefined && next.attempt !== previous.attempt) patch.attempt = next.attempt;
	if (!sameDrafts(next.draftTools, previous.draftTools)) patch.draftTools = next.draftTools ?? [];
	if (next.partialText !== previous.partialText) patch.partialText = next.partialText ?? "";
	if (next.partialThinking !== previous.partialThinking) {
		patch.partialThinking = next.partialThinking ?? "";
	}
	if (next.phase !== previous.phase && next.phase !== undefined) patch.phase = next.phase;
	if (!sameRetry(next.retry, previous.retry)) patch.retry = next.retry ?? null;
	if (!sameModel(next.model, previous.model) && next.model !== undefined) patch.model = next.model;
	if (next.settled !== previous.settled) patch.settled = next.settled;
	if (!sameSteps(next.steps, previous.steps)) patch.steps = next.steps ?? [];
	if (!sameTools(next.tools, previous.tools)) patch.tools = next.tools;
	if (next.turns !== previous.turns) patch.turns = next.turns;
	if (next.failure !== previous.failure) patch.failure = next.failure ?? null;
	return patch;
}

function patchHasChange(patch: LiveRunPatch): boolean {
	return Object.keys(patch).some((key) => key !== "revision");
}

function hasProcess(state: LiveRunState): boolean {
	return (
		(state.steps?.length ?? 0) > 0 ||
		(state.partialText?.length ?? 0) > 0 ||
		(state.partialThinking?.length ?? 0) > 0 ||
		(state.draftTools?.length ?? 0) > 0 ||
		state.tools.length > 0 ||
		state.turns > 0
	);
}

/**
 * Whether an observation begins a new run rather than continuing the one already cached.
 *
 * The watcher start time belongs to the observer, not the run: a steered input or a follow-up
 * window replaces the watcher while the run continues with the same `runId`. Use that identity
 * when either side reports it, and fall back to the start time only while neither does.
 */
function startsNewRun(
	previous: LiveRunState | undefined,
	previousRunId: string | undefined,
	snapshot: LiveRunSnapshot,
): boolean {
	if (previous === undefined) return true;
	if (previous.settled && !snapshot.settled) return true;
	if (snapshot.runId !== undefined) {
		return previousRunId !== undefined && previousRunId !== snapshot.runId;
	}
	return previousRunId === undefined && previous.startedAtMs !== snapshot.startedAtMs;
}

const MAX_STEP_TEXT_CHARS = 2_000;

function clip(value: string, max = MAX_STEP_TEXT_CHARS): string {
	const trimmed = value.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** Current-round fields the timeline had not committed yet when finalization raced ahead. */
function appendCurrentSteps(steps: RunStep[], state: LiveRunState): void {
	const thinking = state.partialThinking?.trim();
	if (thinking !== undefined && thinking.length > 0) {
		const text = clip(thinking);
		const lastThinking = steps.findLast((step) => step.kind === "thinking");
		if (lastThinking?.kind !== "thinking" || lastThinking.text !== text) {
			steps.push({ kind: "thinking", text });
		}
	}
	const answer = state.partialText?.trim();
	if (answer !== undefined && answer.length > 0) {
		const text = clip(answer);
		const lastText = steps.findLast((step) => step.kind === "text");
		if (lastText?.kind !== "text" || lastText.text !== text) {
			steps.push({ kind: "text", text });
		}
	}
	for (const tool of state.tools) {
		steps.push({
			argumentsText: tool.argumentsText ?? "",
			isError: false,
			kind: "tool",
			output: clip(tool.output ?? ""),
			toolName: tool.toolName,
		});
	}
}

/** Turn the final live state into the same step shape the durable transcript produces. */
function stepsOf(state: LiveRunState): RunStep[] {
	if (state.steps !== undefined && state.steps.length > 0) {
		const steps = [...state.steps];
		appendCurrentSteps(steps, state);
		if (state.failure !== undefined && !steps.some((step) => step.kind === "failure")) {
			steps.push({ detail: state.failure, kind: "failure" });
		}
		return steps;
	}
	const steps: RunStep[] = [];
	if (state.failure !== undefined) steps.push({ detail: state.failure, kind: "failure" });
	appendCurrentSteps(steps, state);
	return steps;
}

/**
 * KV-backed home of the in-flight run state.
 *
 * The durable `pi.live` document is the source of truth for a run, but reading it on every
 * SSE tick is wasteful and makes reconnecting clients depend on storage timing. This service
 * takes the committed snapshots the core host already produces, stores the latest state under
 * a TTL key, appends a compact patch to a bounded stream, and publishes one bus event. Every
 * browser connection then reads one snapshot and subscribes, rather than driving its own poll.
 */
export class LiveRunCache {
	readonly #cache: KeyvCache;
	readonly #last = new Map<string, LiveRunState>();
	/**
	 * Last observation that still had a process chain. A clean settle overwrites the cache key
	 * with an empty run before the durable answer callback arrives, so finalizing from `#last`
	 * would store nothing.
	 */
	readonly #process = new Map<string, LiveRunState>();
	readonly #timelines = new Map<string, LiveRunTimeline>();
	/** Stable run identity per session, so a replaced watcher does not restart the timeline. */
	readonly #runIds = new Map<string, string>();
	readonly #queues = new Map<string, Promise<void>>();

	constructor(cache: KeyvCache) {
		this.#cache = cache;
	}

	/** Store one observation, in per-session commit order. Resolves after the event is published. */
	async record(sessionId: string, snapshot: LiveRunSnapshot): Promise<LiveRunUpdate | undefined> {
		const previous = this.#queues.get(sessionId) ?? Promise.resolve();
		const current = previous.then(() => this.#recordNow(sessionId, snapshot));
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(sessionId, tail);
		try {
			return await current;
		} finally {
			if (this.#queues.get(sessionId) === tail) this.#queues.delete(sessionId);
		}
	}

	async snapshot(sessionId: string): Promise<LiveRunState | undefined> {
		const memory = this.#last.get(sessionId);
		if (memory !== undefined) return memory;
		const stored = await this.#cache.get<LiveRunState>(`${STATE_PREFIX}${sessionId}`);
		if (stored !== undefined) this.#last.set(sessionId, stored);
		return stored;
	}

	/** Every run still in flight, for a browser that just connected to the SSE stream. */
	async snapshots(): Promise<readonly LiveRunState[]> {
		const keys = await this.#cache.keys(STATE_PREFIX);
		const states = await Promise.all(keys.map((key) => this.#cache.get<LiveRunState>(key)));
		return states
			.filter((state): state is LiveRunState => state !== undefined && !state.settled)
			.toSorted((a, b) => a.startedAtMs - b.startedAtMs);
	}

	/**
	 * Remember the final process chain of an answer. `entryId` is the durable assistant entry,
	 * which is how the transcript asks for it later; `pi.live` no longer exists by then.
	 */
	async finalizeAnswer(sessionId: string, entryId: string): Promise<LiveRunFinal | undefined> {
		// A live commit can still be queued when the durable answer callback fires. Let it land
		// first: the clean settle keeps the process snapshot, and a failure keeps its reason.
		await this.#queues.get(sessionId);
		const current = await this.snapshot(sessionId);
		const state =
			current?.failure === undefined
				? (this.#process.get(sessionId) ?? current)
				: { ...(this.#process.get(sessionId) ?? current), failure: current.failure };
		if (state === undefined) return undefined;
		const steps = stepsOf(state);
		const final: LiveRunFinal = {
			...(state.startedAtMs > 0
				? { durationSeconds: Math.round(((Date.now() - state.startedAtMs) / 1_000) * 10) / 10 }
				: {}),
			entryId,
			sessionId,
			steps,
		};
		await this.#cache.set(`${FINAL_PREFIX}${entryId}`, final, { ttlMs: FINAL_TTL_MS });
		return final;
	}

	async final(entryId: string): Promise<LiveRunFinal | undefined> {
		return await this.#cache.get<LiveRunFinal>(`${FINAL_PREFIX}${entryId}`);
	}

	/** Events newer than `afterRevision`, for a client that wants to replay what it missed. */
	async history(
		sessionId: string,
		afterRevision = 0,
	): Promise<readonly { patch: LiveRunPatch; revision: number; sessionId: string }[]> {
		const stream = this.#cache.stream(`run.${sessionId}.events`, {
			maxEvents: STREAM_MAX_EVENTS,
			ttlMs: STREAM_TTL_MS,
		});
		const events = await stream.read<{
			patch: LiveRunPatch;
			revision: number;
			sessionId: string;
		}>(afterRevision, STREAM_MAX_EVENTS);
		return events.map((event) => event.value);
	}

	/** One bus event per committed run change. */
	subscribe(handler: (update: LiveRunUpdate) => void): () => void {
		return this.#cache.subscribe<LiveRunUpdate>(CHANNEL, handler);
	}

	stats(): ReturnType<KeyvCache["stats"]> {
		return this.#cache.stats();
	}

	/** Wait for queued commits before the cache handle closes under them. */
	async close(): Promise<void> {
		await Promise.allSettled(this.#queues.values());
	}

	async #recordNow(
		sessionId: string,
		snapshot: LiveRunSnapshot,
	): Promise<LiveRunUpdate | undefined> {
		const previous = await this.snapshot(sessionId);
		const previousRunId = this.#runIds.get(sessionId);
		const newRun = startsNewRun(previous, previousRunId, snapshot);
		let timeline = this.#timelines.get(sessionId);
		if (timeline === undefined || newRun) {
			timeline = new LiveRunTimeline(snapshot.startedAtMs);
			this.#timelines.set(sessionId, timeline);
		}
		if (newRun) {
			this.#runIds.delete(sessionId);
			if (snapshot.runId !== undefined) this.#runIds.set(sessionId, snapshot.runId);
		} else if (snapshot.runId !== undefined) {
			this.#runIds.set(sessionId, snapshot.runId);
		}
		const steps = timeline.observe(snapshot);
		const partialThinking = timeline.currentThinking;
		const partialText = timeline.currentText;
		// Keep the first observation's wall clock for a run that a newer watcher continues.
		const startedAtMs =
			newRun || previous === undefined ? snapshot.startedAtMs : previous.startedAtMs;
		const base = {
			attempt: snapshot.attempt,
			draftTools: plainDrafts(snapshot),
			failure: snapshot.failure,
			model: snapshot.model,
			partialText: partialText.length === 0 ? undefined : partialText,
			partialThinking: partialThinking.length === 0 ? undefined : partialThinking,
			phase: phaseOf(snapshot, snapshot.settled, partialThinking, partialText),
			retry: snapshot.retry,
			settled: snapshot.settled,
			startedAtMs,
			sessionId,
			steps,
			tools: plainTools(snapshot),
			turns: snapshot.turns,
		};
		const next: LiveRunState = {
			...base,
			revision: (previous?.revision ?? 0) + 1,
		};
		if (newRun) this.#process.delete(sessionId);
		if (!next.settled && (newRun || hasProcess(next))) {
			this.#process.set(sessionId, next);
		} else if (next.settled && hasProcess(next)) {
			// A clean settle can still carry the process chain the timeline built. Keep it for
			// `finalizeAnswer`, which runs after the durable answer entry exists.
			this.#process.set(sessionId, next);
		}
		const patch = buildPatch(previous, next);
		if (!patchHasChange(patch)) {
			this.#last.set(sessionId, next);
			return undefined;
		}

		await this.#cache.set(`${STATE_PREFIX}${sessionId}`, next, { ttlMs: STATE_TTL_MS });
		this.#last.set(sessionId, next);
		const stream = this.#cache.stream(`run.${sessionId}.events`, {
			maxEvents: STREAM_MAX_EVENTS,
			ttlMs: STREAM_TTL_MS,
		});
		await stream.append({ patch, revision: next.revision ?? 0, sessionId });
		const update: LiveRunUpdate = {
			patch,
			revision: next.revision ?? 0,
			sessionId,
			state: next,
		};
		await this.#cache.publish(CHANNEL, update);
		return update;
	}
}
