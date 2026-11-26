import type { RunRound, RunStep, RunToolCall } from "@tsukaima/contracts";
import type { LiveRunSnapshot } from "@tsukaima/core";

/** Cap for a model retry error shown in the live timeline. */
const MAX_STEP_TEXT_CHARS = 2_000;
/** Cap for the tool output retained in a committed step. */
export const LIVE_RUN_TOOL_OUTPUT_MAX_CHARS = 4_000;
/** Cap for the compact tool arguments retained in a committed step. */
export const LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS = 1_000;

function clip(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

interface DraftTool {
	argumentsText: string | undefined;
	callId: string;
	roundIndex: number;
	toolName: string;
}

interface MutableRunRound {
	failure: string | undefined;
	intermediateText: string;
	model: { readonly modelId: string; readonly providerId: string } | undefined;
	readonly roundIndex: number;
	readonly startedAtMs: number;
	stopReason: RunRound["stopReason"];
	thinking: string;
	durationMs: number | undefined;
	toolCalls: RunToolCall[];
}

function joinedText(current: string, next: string): string {
	const left = current.trim();
	const right = next.trim();
	if (right.length === 0) return left;
	if (left.length === 0) return right;
	return `${left}\n${right}`;
}

/**
 * Drop text a snapshot repeats from a round that already committed it.
 *
 * Partials are cumulative within one model request, but after a tool round commits its content
 * the next poll can still carry the previous round's partial. Merging that whole value again
 * would show the same reasoning under the next model call. Matching only at a word boundary
 * keeps a genuinely new round that starts with a shared prefix from being truncated mid-word.
 */
function uncommittedRemainder(value: string, committed: readonly (string | undefined)[]): string {
	const right = value.trim();
	if (right.length === 0) return "";
	let remainder = right;
	for (const text of committed) {
		const left = text?.trim() ?? "";
		if (left.length === 0 || !remainder.startsWith(left)) continue;
		if (remainder.length === left.length) return "";
		const next = remainder.charAt(left.length);
		if (!/\s/u.test(next)) continue;
		const candidate = remainder.slice(left.length).trim();
		if (candidate.length < remainder.length) remainder = candidate;
	}
	return remainder;
}

/**
 * Accumulates one run's complete call flow from successive `LiveRunSnapshot`s.
 *
 * `pi.live` only shows the current round: when a tool round starts, the model's reasoning and
 * the tool-call arguments it streamed are gone, and when the next model request starts, the
 * finished tool slots are gone too. The timeline turns those transitions into immutable
 * `RunStep`s, so a browser sees every model call and every tool call of the run in order.
 *
 * Current-round partials stay out of `steps`: the client renders `partialThinking`,
 * `draftTools`, and `tools` live, while `steps` holds what already finished. That keeps the
 * high-frequency text commit small and the activity chain complete.
 */
export class LiveRunTimeline {
	readonly startedAtMs: number;
	#steps: RunStep[] = [];
	#callCount = 0;
	#modelIndex: number | undefined;
	#currentAttempt: number | undefined;
	#turns = 0;
	#thinking = "";
	#text = "";
	#drafts = new Map<string, DraftTool>();
	#tools: LiveRunSnapshot["tools"] = [];
	/** Structured rounds of this segment; a steer replaces the timeline instance entirely. */
	#rounds: MutableRunRound[] = [];
	#currentRoundIndex: number | undefined;
	/** Whether the current round has finished, so it can be exposed as a closed round. */
	#currentRoundClosed = false;
	/** Set when a failed/interrupted run closes with its last text still in `partialText`. */
	#settled = false;
	/** Tool calls already committed as steps, so a repeated snapshot cannot duplicate them. */
	#committedToolCalls = new Set<string>();

	constructor(startedAtMs: number) {
		this.startedAtMs = startedAtMs;
	}

	/** Steps accumulated so far, as a snapshot the caller can store without later mutation. */
	get steps(): RunStep[] {
		return [...this.#steps];
	}

	/**
	 * Closed rounds of the current segment. The round still being streamed is deliberately
	 * excluded: `partialText`, `partialThinking`, `tools`, and `draftTools` carry it, and a
	 * reader that also rendered it here would show the same round twice. Once a round ends, it
	 * moves into this list and stays readable while the next round streams.
	 */
	get rounds(): RunRound[] {
		return this.#renderRounds(false);
	}

	/**
	 * Every round, including the one still streaming. Persistence and a steer/interrupt freeze
	 * must keep the in-progress round, so those callers use this view rather than `rounds`.
	 */
	get allRounds(): RunRound[] {
		return this.#renderRounds(true);
	}

	#currentRound(): MutableRunRound | undefined {
		const index = this.#currentRoundIndex;
		return index === undefined ? undefined : this.#rounds[index];
	}

	#renderRounds(includeOpenRound: boolean): RunRound[] {
		const rounds: RunRound[] = [];
		for (const [index, round] of this.#rounds.entries()) {
			const current = index === this.#currentRoundIndex;
			if (current && !includeOpenRound && !this.#currentRoundClosed) continue;
			const live =
				includeOpenRound && index === this.#currentRoundIndex && !this.#currentRoundClosed;
			const thinking = joinedText(round.thinking, live ? this.#thinking : "");
			const text = joinedText(round.intermediateText, live ? this.#text : "");
			rounds.push({
				...(round.failure === undefined ? {} : { failure: round.failure }),
				...(round.durationMs === undefined ? {} : { durationMs: round.durationMs }),
				...(text.length === 0 || round.toolCalls.length === 0 ? {} : { intermediateText: text }),
				...(round.model === undefined ? {} : { model: round.model }),
				roundIndex: round.roundIndex,
				...(round.stopReason === undefined ? {} : { stopReason: round.stopReason }),
				...(thinking.length === 0 ? {} : { thinking }),
				toolCalls: round.toolCalls.map((tool) => ({ ...tool })),
			});
		}
		return rounds;
	}

	/** Reasoning of the current round that has not been committed to `steps` yet. */
	get currentThinking(): string {
		if (this.#currentRoundClosed) return "";
		return joinedText(this.#currentRound()?.thinking ?? "", this.#thinking);
	}

	/** Answer text of the current round that has not been committed to `steps` yet. */
	get currentText(): string {
		const round = this.#currentRound();
		if (this.#currentRoundClosed) {
			// A failed or interrupted run keeps its last answer in the bubble. A closed round
			// without tools has no other body that would show that answer, so returning it here
			// keeps the text visible without duplicating it inside the round.
			return this.#settled && round !== undefined && round.toolCalls.length === 0
				? round.intermediateText
				: "";
		}
		return joinedText(round?.intermediateText ?? "", this.#text);
	}

	/** Fold one observation of the run and return the completed steps, in run order. */
	observe(snapshot: LiveRunSnapshot, now = Date.now()): RunStep[] {
		this.#settled = snapshot.settled;
		const runningTools = snapshot.tools.length > 0;
		const hasGeneration = snapshot.attempt !== undefined;
		const newRound = snapshot.turns > this.#turns;
		// A fast tool round can start and finish between two polls. `turns` is the durable
		// signal that a round completed even when the poll never saw its tools, so commit the
		// previous round here instead of letting the next partial overwrite its thinking.
		if (newRound) {
			this.#finishModel("done", undefined, now);
			// While the tool round is visible, its call rows stay in `tools` until they finish.
			// Only a missed round has to fall back to the streamed draft arguments.
			this.#commitRoundContent({ keepDrafts: runningTools || this.#tools.length > 0 });
			if (this.#tools.length > 0) this.#commitTools();
			this.#modelIndex = undefined;
			this.#currentAttempt = undefined;
			this.#currentRoundClosed = true;
		}

		// A tool round ended: either the next model request started, or the run is over.
		if (this.#tools.length > 0 && !runningTools && (hasGeneration || snapshot.settled)) {
			this.#commitTools();
		}

		if (runningTools) {
			// Tools belong to the round that produced them: keep that round live so its reasoning
			// and tool rows render together, and so it is not also exposed as a closed round.
			this.#currentRoundClosed = false;
			// At a round boundary the snapshot's partial still describes the round just
			// committed; merging it again would duplicate that reasoning.
			if (!newRound) this.#mergeCurrent(snapshot);
			if (this.#modelIndex !== undefined) {
				this.#finishModel("done", undefined, now);
				this.#commitRoundContent({ keepDrafts: true });
				this.#modelIndex = undefined;
				this.#currentAttempt = undefined;
			} else if (this.#thinking.length > 0 || this.#text.length > 0) {
				// Joining a run after its tool round started still keeps the reasoning that
				// produced those calls, even though no model row was opened for this round.
				this.#commitRoundContent({ keepDrafts: true });
			}
			this.#tools = snapshot.tools;
			this.#rememberDrafts(snapshot.draftTools);
		} else {
			this.#observeGeneration(snapshot, now);
			if (snapshot.attempt !== undefined || !snapshot.settled) {
				this.#mergeCurrent(snapshot);
			}
			this.#rememberDrafts(snapshot.draftTools);
			if (snapshot.retry !== undefined && this.#modelIndex !== undefined) {
				this.#finishModel("retry", snapshot.retry.error, now);
				this.#commitRoundContent();
			}
		}

		if (snapshot.settled) {
			if (this.#modelIndex !== undefined) {
				this.#finishModel(
					snapshot.failure === undefined ? "done" : "failed",
					snapshot.failure,
					now,
				);
				this.#commitRoundContent();
				this.#modelIndex = undefined;
				this.#currentAttempt = undefined;
			}
			if (this.#tools.length > 0) this.#commitTools();
			this.#currentRoundClosed = true;
		}

		this.#syncRoundTools(snapshot);
		this.#turns = snapshot.turns;
		return this.steps;
	}

	/**
	 * Keep the longer partial for the current round. Partials are cumulative, but a poll can
	 * land while the provider has committed none of the current block yet; replacing the stored
	 * value with that empty snapshot would erase reasoning the round already emitted.
	 */
	#mergeCurrent(snapshot: LiveRunSnapshot): void {
		// The provider's partial is cumulative for the whole turn, so it can still start with
		// content that a previous round already committed after a tool call. Strip those
		// prefixes before adding the value: keeping them would repeat the earlier reasoning.
		const committedThinking: string[] = [];
		const committedText: string[] = [];
		for (const [index, round] of this.#rounds.entries()) {
			if (index !== this.#currentRoundIndex) {
				if (round.thinking.length > 0) committedThinking.push(round.thinking);
				if (round.intermediateText.length > 0) committedText.push(round.intermediateText);
			}
		}
		const round = this.#currentRound();
		if (round !== undefined) {
			if (round.thinking.length > 0) committedThinking.push(round.thinking);
			if (round.intermediateText.length > 0) committedText.push(round.intermediateText);
		}
		const thinking = uncommittedRemainder(snapshot.partialThinking ?? "", committedThinking);
		if (thinking.length >= this.#thinking.length) this.#thinking = thinking;
		const text = uncommittedRemainder(snapshot.partialText ?? "", committedText);
		if (text.length >= this.#text.length) this.#text = text;
	}

	#observeGeneration(snapshot: LiveRunSnapshot, now: number): void {
		if (snapshot.settled) return;
		const attempt = snapshot.attempt;
		if (attempt === undefined) {
			// The run is admitted but the scheduler has not started its first request yet. A
			// provisional model row is what turns "waiting for model" into a visible call.
			if (this.#modelIndex === undefined) {
				this.#startModel(1, snapshot.startedAtMs, snapshot.model, now);
			}
			return;
		}

		if (this.#modelIndex === undefined) {
			this.#drafts.clear();
			this.#startModel(attempt, snapshot.generationStartedAtMs ?? now, snapshot.model, now);
		} else if (this.#currentAttempt !== attempt) {
			// A retry after backoff is a new attempt: keep the failed one, then start a new row.
			this.#finishModel("retry", snapshot.retry?.error, now);
			this.#commitRoundContent();
			this.#drafts.clear();
			this.#startModel(attempt, snapshot.generationStartedAtMs ?? now, snapshot.model, now);
		} else {
			this.#updateModel(snapshot.model, snapshot.generationStartedAtMs);
		}
	}

	#startModel(
		attempt: number,
		startedAtMs: number,
		model: LiveRunSnapshot["model"],
		now: number,
	): void {
		this.#callCount += 1;
		this.#rounds.push({
			durationMs: undefined,
			failure: undefined,
			intermediateText: "",
			model:
				model === undefined ? undefined : { modelId: model.modelId, providerId: model.providerId },
			roundIndex: this.#rounds.length,
			startedAtMs: Math.max(0, Math.min(startedAtMs, now)),
			stopReason: undefined,
			thinking: "",
			toolCalls: [],
		});
		this.#currentRoundIndex = this.#rounds.length - 1;
		this.#currentRoundClosed = false;
		const step: RunStep = {
			attempt,
			call: this.#callCount,
			kind: "model",
			startedAtMs: Math.max(0, Math.min(startedAtMs, now)),
			status: "running",
			...(model === undefined ? {} : { modelId: model.modelId, providerId: model.providerId }),
		};
		this.#steps.push(step);
		this.#modelIndex = this.#steps.length - 1;
		this.#currentAttempt = attempt;
	}

	#updateModel(model: LiveRunSnapshot["model"], startedAtMs: number | undefined): void {
		const index = this.#modelIndex;
		if (index === undefined) return;
		const step = this.#steps[index];
		if (step === undefined || step.kind !== "model") return;
		const start =
			startedAtMs === undefined ? step.startedAtMs : Math.max(0, Math.floor(startedAtMs));
		if (
			start === step.startedAtMs &&
			(model === undefined ||
				(step.modelId === model.modelId && step.providerId === model.providerId))
		) {
			return;
		}
		this.#steps[index] = {
			...step,
			startedAtMs: start,
			...(model === undefined ? {} : { modelId: model.modelId, providerId: model.providerId }),
		};
		const round =
			this.#currentRoundIndex === undefined ? undefined : this.#rounds[this.#currentRoundIndex];
		if (round !== undefined && model !== undefined) {
			round.model = { modelId: model.modelId, providerId: model.providerId };
		}
	}

	#finishModel(status: "retry" | "done" | "failed", error: string | undefined, now: number): void {
		const index = this.#modelIndex;
		if (index === undefined) return;
		const step = this.#steps[index];
		if (step === undefined || step.kind !== "model") return;
		if (step.status !== "running" && step.status !== "retry" && status !== "failed") return;
		const endedAtMs = Math.max(step.startedAtMs, Math.floor(now));
		this.#steps[index] = {
			...step,
			endedAtMs,
			status,
			...(error === undefined ? {} : { error: clip(error, MAX_STEP_TEXT_CHARS) }),
		};
		const round =
			this.#currentRoundIndex === undefined ? undefined : this.#rounds[this.#currentRoundIndex];
		if (round !== undefined) {
			round.durationMs = Math.max(0, endedAtMs - round.startedAtMs);
			if (error !== undefined) round.failure = clip(error, MAX_STEP_TEXT_CHARS);
			round.stopReason =
				status === "retry" || status === "failed"
					? "error"
					: this.#tools.length > 0 || this.#drafts.size > 0
						? "toolUse"
						: "stop";
		}
	}

	#rememberDrafts(drafts: LiveRunSnapshot["draftTools"]): void {
		if (drafts.length === 0) return;
		for (const draft of drafts) {
			this.#drafts.set(draft.callId, {
				argumentsText: draft.argumentsText,
				callId: draft.callId,
				roundIndex: this.#currentRoundIndex ?? Math.max(0, this.#rounds.length - 1),
				toolName: draft.toolName,
			});
		}
	}

	/**
	 * Commit what the finished model round produced before its tool calls start. `keepDrafts`
	 * leaves the tool-call arguments for `#commitTools`, which pairs them with the tool output.
	 */
	#commitRoundContent(options: { keepDrafts?: boolean } = {}): void {
		const round =
			this.#currentRoundIndex === undefined ? undefined : this.#rounds[this.#currentRoundIndex];
		if (this.#thinking.trim().length > 0) {
			this.#steps.push({ kind: "thinking", text: this.#thinking });
			if (round !== undefined) round.thinking = joinedText(round.thinking, this.#thinking);
		}
		if (this.#text.trim().length > 0) {
			this.#steps.push({ kind: "text", text: this.#text });
			if (round !== undefined)
				round.intermediateText = joinedText(round.intermediateText, this.#text);
		}
		this.#thinking = "";
		this.#text = "";
		if (options.keepDrafts === true) return;
		for (const draft of this.#drafts.values()) {
			if (this.#committedToolCalls.has(draft.callId)) continue;
			this.#committedToolCalls.add(draft.callId);
			this.#steps.push({
				argumentsText: clip(draft.argumentsText ?? "", LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS),
				isError: false,
				kind: "tool",
				output: "",
				toolName: draft.toolName,
			});
		}
		this.#drafts.clear();
	}

	#commitTools(): void {
		const round =
			this.#currentRoundIndex === undefined ? undefined : this.#rounds[this.#currentRoundIndex];
		if (round !== undefined) {
			for (const tool of this.#tools) {
				this.#upsertRoundTool(round, {
					argumentsText: clip(
						tool.argumentsText ?? this.#drafts.get(tool.callId)?.argumentsText ?? "",
						LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS,
					),
					callId: tool.callId,
					isError: false,
					output: clip(tool.output ?? "", LIVE_RUN_TOOL_OUTPUT_MAX_CHARS),
					status: "done",
					toolName: tool.toolName,
				});
			}
			if (round.toolCalls.length > 0) round.stopReason = "toolUse";
		}
		for (const tool of this.#tools) {
			if (this.#committedToolCalls.has(tool.callId)) continue;
			this.#committedToolCalls.add(tool.callId);
			const argumentsText = clip(
				tool.argumentsText ?? this.#drafts.get(tool.callId)?.argumentsText ?? "",
				LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS,
			);
			this.#steps.push({
				argumentsText,
				isError: false,
				kind: "tool",
				output: clip(tool.output ?? "", LIVE_RUN_TOOL_OUTPUT_MAX_CHARS),
				toolName: tool.toolName,
			});
		}
		this.#tools = [];
		this.#drafts.clear();
	}

	/** Keep each structured round's tool calls in sync with the live snapshot. */
	#syncRoundTools(snapshot: LiveRunSnapshot): void {
		const roundIndex = this.#currentRoundIndex ?? Math.max(0, this.#rounds.length - 1);
		const round = this.#rounds[roundIndex];
		if (round === undefined) return;
		for (const draft of snapshot.draftTools) {
			if (this.#committedToolCalls.has(draft.callId)) continue;
			if (snapshot.tools.some((tool) => tool.callId === draft.callId)) continue;
			this.#upsertRoundTool(round, {
				argumentsText: clip(draft.argumentsText ?? "", LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS),
				callId: draft.callId,
				isError: false,
				output: "",
				status: "pending",
				toolName: draft.toolName,
			});
		}
		for (const tool of snapshot.tools) {
			if (this.#committedToolCalls.has(tool.callId)) continue;
			this.#upsertRoundTool(round, {
				argumentsText: clip(
					tool.argumentsText ?? this.#drafts.get(tool.callId)?.argumentsText ?? "",
					LIVE_RUN_TOOL_ARGUMENTS_MAX_CHARS,
				),
				callId: tool.callId,
				isError: false,
				output: clip(tool.output ?? "", LIVE_RUN_TOOL_OUTPUT_MAX_CHARS),
				status: tool.status,
				toolName: tool.toolName,
			});
		}
	}

	#upsertRoundTool(round: MutableRunRound, call: RunToolCall): void {
		const index = round.toolCalls.findIndex((tool) => tool.callId === call.callId);
		if (index === -1) round.toolCalls.push(call);
		else round.toolCalls[index] = call;
	}
}
