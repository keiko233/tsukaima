import type { RunStep } from "@tsukaima/contracts";
import type { LiveRunSnapshot } from "@tsukaima/core";

/** Cap for a single argument line, matching the durable run-steps panel. */
const MAX_ARGUMENTS_CHARS = 400;
/** Cap for one model's thinking block or text. */
const MAX_STEP_TEXT_CHARS = 2_000;
/** Cap for a tool's retained output tail. */
const MAX_OUTPUT_CHARS = 2_000;

function clip(value: string, max: number): string {
	const trimmed = value.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

interface DraftTool {
	argumentsText: string | undefined;
	callId: string;
	toolName: string;
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

	constructor(startedAtMs: number) {
		this.startedAtMs = startedAtMs;
	}

	/** Steps accumulated so far, as a snapshot the caller can store without later mutation. */
	get steps(): RunStep[] {
		return [...this.#steps];
	}

	/** Reasoning of the current round that has not been committed to `steps` yet. */
	get currentThinking(): string {
		return this.#thinking;
	}

	/** Answer text of the current round that has not been committed to `steps` yet. */
	get currentText(): string {
		return this.#text;
	}

	/** Fold one observation of the run and return the completed steps, in run order. */
	observe(snapshot: LiveRunSnapshot, now = Date.now()): RunStep[] {
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
		}

		// A tool round ended: either the next model request started, or the run is over.
		if (this.#tools.length > 0 && !runningTools && (hasGeneration || snapshot.settled)) {
			this.#commitTools();
		}

		if (runningTools) {
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
		}

		this.#turns = snapshot.turns;
		return this.steps;
	}

	/**
	 * Keep the longer partial for the current round. Partials are cumulative, but a poll can
	 * land while the provider has committed none of the current block yet; replacing the stored
	 * value with that empty snapshot would erase reasoning the round already emitted.
	 */
	#mergeCurrent(snapshot: LiveRunSnapshot): void {
		const thinking = snapshot.partialThinking ?? "";
		if (thinking.length >= this.#thinking.length) this.#thinking = thinking;
		const text = snapshot.partialText ?? "";
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
	}

	#finishModel(status: "retry" | "done" | "failed", error: string | undefined, now: number): void {
		const index = this.#modelIndex;
		if (index === undefined) return;
		const step = this.#steps[index];
		if (step === undefined || step.kind !== "model") return;
		if (step.status !== "running" && step.status !== "retry" && status !== "failed") return;
		this.#steps[index] = {
			...step,
			endedAtMs: Math.max(step.startedAtMs, Math.floor(now)),
			status,
			...(error === undefined ? {} : { error: clip(error, MAX_STEP_TEXT_CHARS) }),
		};
	}

	#rememberDrafts(drafts: LiveRunSnapshot["draftTools"]): void {
		if (drafts.length === 0) return;
		for (const draft of drafts) {
			this.#drafts.set(draft.callId, {
				argumentsText: draft.argumentsText,
				callId: draft.callId,
				toolName: draft.toolName,
			});
		}
	}

	/**
	 * Commit what the finished model round produced before its tool calls start. `keepDrafts`
	 * leaves the tool-call arguments for `#commitTools`, which pairs them with the tool output.
	 */
	#commitRoundContent(options: { keepDrafts?: boolean } = {}): void {
		if (this.#thinking.trim().length > 0) {
			this.#steps.push({ kind: "thinking", text: clip(this.#thinking, MAX_STEP_TEXT_CHARS) });
		}
		if (this.#text.trim().length > 0) {
			this.#steps.push({ kind: "text", text: clip(this.#text, MAX_STEP_TEXT_CHARS) });
		}
		this.#thinking = "";
		this.#text = "";
		if (options.keepDrafts === true) return;
		for (const draft of this.#drafts.values()) {
			this.#steps.push({
				argumentsText: clip(draft.argumentsText ?? "", MAX_ARGUMENTS_CHARS),
				isError: false,
				kind: "tool",
				output: "",
				toolName: draft.toolName,
			});
		}
		this.#drafts.clear();
	}

	#commitTools(): void {
		for (const tool of this.#tools) {
			const argumentsText =
				tool.argumentsText ?? this.#drafts.get(tool.callId)?.argumentsText ?? "";
			this.#steps.push({
				argumentsText: clip(argumentsText, MAX_ARGUMENTS_CHARS),
				isError: false,
				kind: "tool",
				output: clip(tool.output ?? "", MAX_OUTPUT_CHARS),
				toolName: tool.toolName,
			});
		}
		this.#tools = [];
		this.#drafts.clear();
	}
}
