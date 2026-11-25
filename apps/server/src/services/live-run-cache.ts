import type {
	LiveRunPatch,
	LiveRunPhase,
	LiveRunState,
	RunRound,
	RunSegmentStatus,
	RunSegmentTriggerKind,
	RunStep,
} from "@tsukaima/contracts";
import type { KeyvCache } from "@tsukaima/cache";
import { extractLurkMarker, sanitizeOutboundMetaLeaks, type LiveRunSnapshot } from "@tsukaima/core";
import type { ConversationRunAnchor, ConversationRunService } from "./conversation-runs.ts";
import { LiveRunTimeline } from "./live-run-timeline.ts";

/** An active run is readable across a browser reload and a short host restart. */
const STATE_TTL_MS = 30 * 60_000;
/** The final state of one answer, used to keep its process chain readable after `pi.live` clears. */
const FINAL_TTL_MS = 7 * 24 * 60 * 60_000;
const STREAM_TTL_MS = STATE_TTL_MS;
/** Keep replay useful without letting one run's stream value grow without bound. */
const STREAM_MAX_EVENTS = 100;
const STREAM_MAX_BYTES = 256 * 1024;
const STATE_PREFIX = "run.state.";
const FINAL_PREFIX = "run.final.";
const CHANNEL = "run";

export interface LiveRunCacheOptions {
	readonly runs?: ConversationRunService | undefined;
}

export interface LiveRunSegmentAdvance {
	readonly runId: string;
	readonly segmentId: string;
	readonly segmentIndex: number;
	readonly seq: number;
	readonly triggerKind: RunSegmentTriggerKind;
}

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

interface PendingWaiter {
	readonly reject: (error: unknown) => void;
	readonly resolve: (update: LiveRunUpdate | undefined) => void;
}

interface PendingCommit {
	next: LiveRunState;
	patch: LiveRunPatch;
	readonly waiters: PendingWaiter[];
	update: LiveRunUpdate;
}

interface QueuedRecord {
	readonly reject: (error: unknown) => void;
	readonly resolve: (update: LiveRunUpdate | undefined) => void;
	readonly snapshot: LiveRunSnapshot;
}

interface Hydration {
	readonly queued: QueuedRecord[];
	ready: Promise<void>;
}

function sameRounds(
	a: readonly RunRound[] | undefined,
	b: readonly RunRound[] | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

interface LiveRunAnchorFields {
	readonly runId: string;
	readonly segmentId: string;
	readonly segmentIndex: number;
	readonly seq: number;
	readonly status: RunSegmentStatus;
	readonly triggerKind: RunSegmentTriggerKind;
}

function anchorFields(anchor: ConversationRunAnchor): LiveRunAnchorFields {
	return {
		seq: anchor.seq,
		runId: anchor.runId,
		segmentId: anchor.segmentId,
		segmentIndex: anchor.segmentIndex,
		status: anchor.status,
		triggerKind: anchor.triggerKind,
	};
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
		if (next.runId !== undefined) patch.runId = next.runId;
		if (next.segmentId !== undefined) patch.segmentId = next.segmentId;
		if (next.segmentIndex !== undefined) patch.segmentIndex = next.segmentIndex;
		if (next.seq !== undefined) patch.seq = next.seq;
		if (next.status !== undefined) patch.status = next.status;
		if (next.triggerKind !== undefined) patch.triggerKind = next.triggerKind;
		patch.rounds = next.rounds ?? [];
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
	if (next.runId !== undefined && next.runId !== previous.runId) patch.runId = next.runId;
	if (next.segmentId !== undefined && next.segmentId !== previous.segmentId) {
		patch.segmentId = next.segmentId;
	}
	if (next.segmentIndex !== undefined && next.segmentIndex !== previous.segmentIndex) {
		patch.segmentIndex = next.segmentIndex;
	}
	if (next.seq !== undefined && next.seq !== previous.seq) patch.seq = next.seq;
	if (next.status !== undefined && next.status !== previous.status) patch.status = next.status;
	if (next.triggerKind !== undefined && next.triggerKind !== previous.triggerKind) {
		patch.triggerKind = next.triggerKind;
	}
	if (!sameRounds(next.rounds, previous.rounds)) patch.rounds = next.rounds ?? [];
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
		(state.rounds?.length ?? 0) > 0 ||
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

/** Current-round fields the timeline had not committed yet when finalization raced ahead. */
function appendCurrentSteps(steps: RunStep[], state: LiveRunState): void {
	const thinking = state.partialThinking?.trim();
	if (thinking !== undefined && thinking.length > 0) {
		const lastThinking = steps.findLast((step) => step.kind === "thinking");
		if (lastThinking?.kind !== "thinking" || lastThinking.text !== thinking) {
			steps.push({ kind: "thinking", text: thinking });
		}
	}
	const answer = state.partialText?.trim();
	if (answer !== undefined && answer.length > 0) {
		const lastText = steps.findLast((step) => step.kind === "text");
		if (lastText?.kind !== "text" || lastText.text !== answer) {
			steps.push({ kind: "text", text: answer });
		}
	}
	for (const tool of state.tools) {
		steps.push({
			argumentsText: tool.argumentsText ?? "",
			isError: false,
			kind: "tool",
			output: tool.output ?? "",
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
	/** Last state actually persisted, which is the base every streamed patch is relative to. */
	readonly #published = new Map<string, LiveRunState>();
	readonly #timelines = new Map<string, LiveRunTimeline>();
	/** Stable run identity per session, so a replaced watcher does not restart the timeline. */
	readonly #runIds = new Map<string, string>();
	readonly #pending = new Map<string, PendingCommit>();
	readonly #flushing = new Map<string, Promise<void>>();
	readonly #flushScheduled = new Set<string>();
	readonly #hydrated = new Set<string>();
	readonly #hydrations = new Map<string, Hydration>();

	readonly #runs: ConversationRunService | undefined;
	readonly #chains = new Map<string, Promise<unknown>>();
	readonly #anchors = new Map<string, ConversationRunAnchor>();
	/** Recent run ids per session whose live view ended, so a stale settled snapshot cannot revive them. */
	readonly #finishedRunIds = new Map<string, string[]>();
	readonly #roundSignatures = new Map<string, string>();

	constructor(cache: KeyvCache, options: LiveRunCacheOptions = {}) {
		this.#cache = cache;
		this.#runs = options.runs;
	}

	/**
	 * Store one observation. The timeline observes synchronously, so no turn transition or
	 * settle is lost, while SQLite persistence only keeps the latest pending state/patch.
	 */
	record(sessionId: string, snapshot: LiveRunSnapshot): Promise<LiveRunUpdate | undefined> {
		if (this.#hydrated.has(sessionId)) {
			return this.#runs === undefined
				? this.#recordObserved(sessionId, snapshot)
				: this.#enqueueObserved(sessionId, snapshot);
		}
		const hydration = this.#hydrationFor(sessionId);
		return new Promise((resolve, reject) => {
			hydration.queued.push({ reject, resolve, snapshot });
		});
	}

	async snapshot(sessionId: string): Promise<LiveRunState | undefined> {
		const memory = this.#last.get(sessionId);
		if (memory !== undefined) return memory;
		const stored = await this.#cache.get<LiveRunState>(`${STATE_PREFIX}${sessionId}`);
		if (stored !== undefined) {
			this.#last.set(sessionId, stored);
			this.#published.set(sessionId, stored);
			this.#hydrated.add(sessionId);
		}
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
		await this.#drain(sessionId);
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
		const stream = this.#stream(sessionId);
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
		const sessionIds = new Set([
			...this.#pending.keys(),
			...this.#flushing.keys(),
			...this.#hydrations.keys(),
		]);
		await Promise.allSettled([...this.#hydrations.values()].map((hydration) => hydration.ready));
		await Promise.all([...sessionIds].map(async (sessionId) => await this.#drain(sessionId)));
	}

	/** Rounds accumulated for the live segment, for a steer or interrupt to freeze. */
	currentRounds(sessionId: string): RunRound[] {
		return this.#timelines.get(sessionId)?.rounds ?? [];
	}

	segmentAnchor(sessionId: string): ConversationRunAnchor | undefined {
		return this.#anchors.get(sessionId);
	}

	/**
	 * Reset the live timeline when a steer opens the run's next segment.
	 *
	 * The previous segment was frozen durably by the caller; this only pivots the live view, so
	 * the client sees `steered` at the old anchor and `running` at the message's new anchor.
	 */
	async advanceSegment(
		sessionId: string,
		anchor: LiveRunSegmentAdvance,
	): Promise<LiveRunUpdate | undefined> {
		await this.#drain(sessionId);
		await this.#flushRounds(sessionId);
		this.#timelines.set(
			sessionId,
			new LiveRunTimeline(this.#last.get(sessionId)?.startedAtMs ?? Date.now()),
		);
		this.#runIds.set(sessionId, anchor.runId);
		const nextAnchor: ConversationRunAnchor = { ...anchor, status: "running" };
		this.#anchors.set(sessionId, nextAnchor);
		this.#roundSignatures.delete(sessionId);
		const previous = this.#last.get(sessionId);
		if (previous === undefined) return undefined;
		const next: LiveRunState = {
			...previous,
			attempt: undefined,
			draftTools: [],
			failure: undefined,
			model: undefined,
			partialText: undefined,
			partialThinking: undefined,
			phase: "queued",
			retry: undefined,
			revision: (previous.revision ?? 0) + 1,
			rounds: [],
			settled: false,
			steps: [],
			tools: [],
			turns: 0,
			...anchorFields(nextAnchor),
		};
		this.#last.set(sessionId, next);
		this.#process.set(sessionId, next);
		return await this.#commitState(sessionId, next);
	}

	/** Flush partial rounds and close the live view after an interrupt. */
	async markInterrupted(
		sessionId: string,
		status: "interrupted" | "failed" = "interrupted",
	): Promise<LiveRunUpdate | undefined> {
		await this.#drain(sessionId);
		const rounds = await this.#flushRounds(sessionId);
		const anchor = this.#anchors.get(sessionId);
		if (anchor !== undefined) this.#markFinished(sessionId, anchor.runId);
		const previous = this.#last.get(sessionId);
		this.#timelines.delete(sessionId);
		this.#runIds.delete(sessionId);
		this.#anchors.delete(sessionId);
		this.#roundSignatures.delete(sessionId);
		if (previous === undefined) return undefined;
		const next: LiveRunState = {
			...previous,
			...(anchor === undefined ? {} : { ...anchorFields(anchor), status }),
			phase: "settled",
			rounds,
			revision: (previous.revision ?? 0) + 1,
			settled: true,
		};
		this.#last.set(sessionId, next);
		this.#process.set(sessionId, next);
		return await this.#commitState(sessionId, next);
	}

	/** Persist the live segment's current rounds when they changed. */
	async #flushRounds(sessionId: string): Promise<RunRound[]> {
		const timeline = this.#timelines.get(sessionId);
		const anchor = this.#anchors.get(sessionId);
		const rounds = timeline?.rounds ?? [];
		if (timeline === undefined || anchor === undefined || this.#runs === undefined) return rounds;
		const signature = JSON.stringify(rounds);
		if (this.#roundSignatures.get(sessionId) === signature) return rounds;
		this.#roundSignatures.set(sessionId, signature);
		// A frozen segment already carries the rounds the caller captured. An empty live
		// timeline created after a steer or outbound split must not erase them.
		if (rounds.length === 0) return rounds;
		try {
			await this.#runs.syncSegmentRounds(anchor.segmentId, rounds);
		} catch {
			// Live state must survive a storage hiccup; the next observation retries the write.
			this.#roundSignatures.delete(sessionId);
		}
		return rounds;
	}

	#enqueueObserved(
		sessionId: string,
		snapshot: LiveRunSnapshot,
	): Promise<LiveRunUpdate | undefined> {
		const previous = this.#chains.get(sessionId) ?? Promise.resolve();
		const task = previous
			.catch(() => undefined)
			.then(() => this.#recordObserved(sessionId, snapshot));
		this.#chains.set(sessionId, task);
		void task.finally(() => {
			if (this.#chains.get(sessionId) === task) this.#chains.delete(sessionId);
		});
		return task;
	}

	#markFinished(sessionId: string, runId: string): void {
		const finished = this.#finishedRunIds.get(sessionId) ?? [];
		if (!finished.includes(runId)) finished.push(runId);
		this.#finishedRunIds.set(sessionId, finished.slice(-8));
	}

	#stream(sessionId: string) {
		return this.#cache.stream(`run.${sessionId}.events`, {
			maxBytes: STREAM_MAX_BYTES,
			maxEvents: STREAM_MAX_EVENTS,
			ttlMs: STREAM_TTL_MS,
		});
	}

	#hydrationFor(sessionId: string): Hydration {
		const existing = this.#hydrations.get(sessionId);
		if (existing !== undefined) return existing;
		const hydration: Hydration = { queued: [], ready: Promise.resolve() };
		hydration.ready = (async () => {
			try {
				if (!this.#last.has(sessionId)) {
					const stored = await this.#cache.get<LiveRunState>(`${STATE_PREFIX}${sessionId}`);
					if (!this.#last.has(sessionId) && stored !== undefined) {
						this.#last.set(sessionId, stored);
						this.#published.set(sessionId, stored);
					}
				}
				this.#hydrated.add(sessionId);
				// A same-tick burst queues here, then observes in order before one flush.
				for (const queued of hydration.queued.splice(0)) {
					const observed =
						this.#runs === undefined
							? this.#recordObserved(sessionId, queued.snapshot)
							: this.#enqueueObserved(sessionId, queued.snapshot);
					void observed.then(queued.resolve, queued.reject);
				}
			} catch (error) {
				this.#hydrated.add(sessionId);
				for (const queued of hydration.queued.splice(0)) queued.reject(error);
			} finally {
				if (this.#hydrations.get(sessionId) === hydration) {
					this.#hydrations.delete(sessionId);
				}
			}
		})();
		this.#hydrations.set(sessionId, hydration);
		return hydration;
	}

	async #drain(sessionId: string): Promise<void> {
		const hydration = this.#hydrations.get(sessionId);
		if (hydration !== undefined) await hydration.ready.catch(() => undefined);
		for (;;) {
			const chain = this.#chains.get(sessionId);
			if (chain !== undefined) {
				await chain.catch(() => undefined);
				if (this.#chains.get(sessionId) === chain) this.#chains.delete(sessionId);
				continue;
			}
			const active = this.#flushing.get(sessionId);
			if (active !== undefined) {
				await active.catch(() => undefined);
				continue;
			}
			if (this.#pending.has(sessionId)) {
				await this.#startFlush(sessionId).catch(() => undefined);
				continue;
			}
			return;
		}
	}

	async #recordObserved(
		sessionId: string,
		snapshot: LiveRunSnapshot,
	): Promise<LiveRunUpdate | undefined> {
		const previous = this.#last.get(sessionId);
		const previousRunId = this.#runIds.get(sessionId);
		if (
			snapshot.runId !== undefined &&
			this.#finishedRunIds.get(sessionId)?.includes(snapshot.runId) === true &&
			this.#anchors.get(sessionId)?.runId !== snapshot.runId
		) {
			return undefined;
		}
		const newRun = startsNewRun(previous, previousRunId, snapshot);
		const previousAnchor = this.#anchors.get(sessionId);
		let anchor = previousAnchor;
		if (
			this.#runs !== undefined &&
			(snapshot.runId !== undefined || anchor !== undefined) &&
			(snapshot.runId === undefined || anchor?.runId === snapshot.runId)
		) {
			// Same durable run: keep its segment anchor, including a settled one, so a repeated
			// settled snapshot cannot start a phantom continuation run.
		} else if (this.#runs !== undefined && snapshot.runId !== undefined) {
			if (previousAnchor !== undefined && previousAnchor.runId !== snapshot.runId) {
				this.#markFinished(sessionId, previousAnchor.runId);
			}
			const ensured = await this.#runs
				.ensureLiveRun({
					conversationId: sessionId,
					durableRunKey: snapshot.runId,
				})
				.catch(() => undefined);
			if (ensured !== undefined) {
				anchor = ensured;
				this.#anchors.set(sessionId, ensured);
				this.#roundSignatures.delete(sessionId);
			}
		}
		const segmentChanged =
			anchor !== undefined &&
			previousAnchor !== undefined &&
			previousAnchor.segmentId !== anchor.segmentId;
		let timeline = this.#timelines.get(sessionId);
		if (timeline === undefined || newRun || segmentChanged) {
			timeline = new LiveRunTimeline(snapshot.startedAtMs);
			this.#timelines.set(sessionId, timeline);
			this.#roundSignatures.delete(sessionId);
		}
		if (newRun) {
			this.#runIds.delete(sessionId);
			if (snapshot.runId !== undefined) this.#runIds.set(sessionId, snapshot.runId);
		} else if (snapshot.runId !== undefined) {
			this.#runIds.set(sessionId, snapshot.runId);
		}
		const steps = timeline.observe(snapshot);
		const partialThinking = timeline.currentThinking;
		const partialText = extractLurkMarker(
			sanitizeOutboundMetaLeaks(timeline.currentText).text,
		).text;
		// Keep the first observation's wall clock for a run that a newer watcher continues.
		const startedAtMs =
			newRun || previous === undefined ? snapshot.startedAtMs : previous.startedAtMs;
		const rounds = timeline.rounds;
		if (this.#runs !== undefined) await this.#flushRounds(sessionId);
		const settledStatus =
			snapshot.failure === undefined
				? "completed"
				: /abort|interrupt|cancel/iu.test(snapshot.failure)
					? "interrupted"
					: "failed";
		const anchorStatus =
			anchor === undefined ? undefined : snapshot.settled ? settledStatus : anchor.status;
		const base = {
			...(anchor === undefined
				? {}
				: {
						...anchorFields(anchor),
						...(anchorStatus === undefined ? {} : { status: anchorStatus }),
					}),
			attempt: snapshot.attempt,
			draftTools: plainDrafts(snapshot),
			failure: snapshot.failure,
			model: snapshot.model,
			partialText: partialText.length === 0 ? undefined : partialText,
			partialThinking: partialThinking.length === 0 ? undefined : partialThinking,
			phase: phaseOf(snapshot, snapshot.settled, partialThinking, partialText),
			retry: snapshot.retry,
			rounds,
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
		this.#last.set(sessionId, next);

		if (
			snapshot.settled &&
			anchor !== undefined &&
			this.#runs !== undefined &&
			settledStatus !== "completed"
		) {
			// A clean settle still has an answer callback behind it: the reply dispatcher settles
			// the segment with its final message id. Only a run that ended without an answer is
			// terminal here.
			await this.#runs
				.settleRun({
					conversationId: sessionId,
					...(snapshot.failure === undefined ? {} : { failureDetail: snapshot.failure }),
					rounds,
					runId: anchor.runId,
					segmentId: anchor.segmentId,
					status: settledStatus,
				})
				.catch(() => undefined);
			if (anchorStatus !== undefined) {
				this.#anchors.set(sessionId, { ...anchor, status: anchorStatus });
			}
		}
		return await this.#commitState(sessionId, next);
	}

	async #commitState(sessionId: string, next: LiveRunState): Promise<LiveRunUpdate | undefined> {
		// The patch is always relative to the last persisted state. When a burst coalesces
		// several observations, the latest patch therefore carries all of their changes.
		const patch = buildPatch(this.#published.get(sessionId), next);
		if (!patchHasChange(patch)) {
			const pending = this.#pending.get(sessionId);
			if (pending !== undefined) {
				this.#pending.delete(sessionId);
				for (const waiter of pending.waiters.splice(0)) waiter.resolve(undefined);
			}
			return undefined;
		}
		const update: LiveRunUpdate = {
			patch,
			revision: next.revision ?? 0,
			sessionId,
			state: next,
		};
		const pending = this.#pending.get(sessionId);
		if (pending !== undefined) {
			pending.next = next;
			pending.patch = patch;
			pending.update = update;
			return new Promise((resolve, reject) => pending.waiters.push({ reject, resolve }));
		}
		const created: PendingCommit = { next, patch, update, waiters: [] };
		this.#pending.set(sessionId, created);
		const result = new Promise<LiveRunUpdate | undefined>((resolve, reject) =>
			created.waiters.push({ reject, resolve }),
		);
		this.#requestFlush(sessionId);
		return result;
	}

	#requestFlush(sessionId: string): void {
		if (this.#flushScheduled.has(sessionId) || this.#flushing.has(sessionId)) return;
		this.#flushScheduled.add(sessionId);
		queueMicrotask(() => {
			this.#flushScheduled.delete(sessionId);
			if (this.#flushing.has(sessionId) || !this.#pending.has(sessionId)) return;
			void this.#startFlush(sessionId);
		});
	}

	#startFlush(sessionId: string): Promise<void> {
		const existing = this.#flushing.get(sessionId);
		if (existing !== undefined) return existing;
		const task = this.#flushLoop(sessionId);
		this.#flushing.set(sessionId, task);
		void task.then(
			() => {
				if (this.#flushing.get(sessionId) === task) this.#flushing.delete(sessionId);
				if (this.#pending.has(sessionId)) this.#requestFlush(sessionId);
			},
			() => {
				if (this.#flushing.get(sessionId) === task) this.#flushing.delete(sessionId);
				if (this.#pending.has(sessionId)) this.#requestFlush(sessionId);
			},
		);
		return task;
	}

	async #flushLoop(sessionId: string): Promise<void> {
		for (;;) {
			const pending = this.#pending.get(sessionId);
			if (pending === undefined) return;
			this.#pending.delete(sessionId);
			await this.#persist(sessionId, pending);
		}
	}

	async #persist(sessionId: string, pending: PendingCommit): Promise<void> {
		const waiters = pending.waiters.splice(0);
		try {
			await this.#cache.set(`${STATE_PREFIX}${sessionId}`, pending.next, {
				ttlMs: STATE_TTL_MS,
			});
			this.#published.set(sessionId, pending.next);
			await this.#stream(sessionId).append({
				patch: pending.patch,
				revision: pending.next.revision ?? 0,
				sessionId,
			});
			await this.#cache.publish(CHANNEL, pending.update);
			for (const waiter of waiters) waiter.resolve(pending.update);
		} catch (error) {
			for (const waiter of waiters) waiter.reject(error);
			throw error;
		}
	}
}
