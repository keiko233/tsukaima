"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import { useState } from "react";
import {
	Message,
	MessageAvatar,
	MessageBubble,
	MessageBubbleContent,
	MessageContent,
	MessageHeader,
} from "@tsukaima/ui/components/agents/message";
import type { LiveRunPhase, LiveRunState, RunStep } from "@tsukaima/contracts";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { MessageText } from "./message-text";
import { RunRoundsView } from "./run-step-items";
import { ToolCallRow } from "./tool-call-row";

function elapsedSeconds(startedAtMs: number, now: number): number {
	return Math.max(0, Math.floor((now - startedAtMs) / 1_000));
}

function stepSeconds(startedAtMs: number, endedAtMs: number | undefined, now: number): number {
	return elapsedSeconds(startedAtMs, endedAtMs ?? now);
}

function phaseLabel(phase: LiveRunPhase | undefined, working: boolean): string {
	if (!working) return m.live_run_phase_settled();
	switch (phase) {
		case "retry":
			return m.live_run_phase_retry();
		case "thinking":
			return m.live_run_phase_thinking();
		case "tool_calls":
			return m.live_run_phase_tool_calls();
		case "tools":
			return m.live_run_phase_tools();
		case "writing":
			return m.live_run_phase_writing();
		case "settled":
			return m.live_run_phase_settled();
		case "queued":
		case undefined:
			return m.live_run_phase_queued();
	}
}

function statusLabel(run: LiveRunState, working: boolean): string {
	if (run.failure !== undefined) return m.live_run_failed();
	// A steered or interrupted segment is frozen even when its run continues in another segment.
	if (run.status === "steered") return m.run_segment_status_steered();
	if (run.status === "interrupted") return m.run_segment_status_interrupted();
	if (run.status === "failed") return m.live_run_failed();
	return phaseLabel(run.phase, working);
}

function modelStatusText(
	status: Extract<RunStep, { kind: "model" }>["status"],
): string | undefined {
	switch (status) {
		case "running":
			return m.live_run_model_running();
		case "retry":
			return m.live_run_model_retry();
		case "failed":
			return m.live_run_model_failed();
		case "done":
			return undefined;
	}
}

function ModelCallRow({ step, now }: { step: Extract<RunStep, { kind: "model" }>; now: number }) {
	const status = modelStatusText(step.status);
	const seconds = stepSeconds(step.startedAtMs, step.endedAtMs, now);
	const meta = [
		step.modelId ?? step.providerId,
		status,
		`${seconds}s`,
		step.error === undefined ? undefined : step.error,
	]
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join(" · ");

	return (
		<div
			className={cn(
				"flex min-h-5 w-full min-w-0 items-start gap-1.5 rounded text-left text-[11px] leading-5",
				step.status === "failed" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			<Sparkles aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
			<span className="shrink-0 font-medium text-foreground/85">
				{m.live_run_model_call({ call: step.call })}
			</span>
			<span className="min-w-0 truncate text-muted-foreground/75" title={meta}>
				{meta}
			</span>
			{step.status === "running" ? (
				<span
					aria-hidden="true"
					className="mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
				/>
			) : null}
		</div>
	);
}

function StepRow({ step, now, markdown }: { step: RunStep; now: number; markdown: boolean }) {
	switch (step.kind) {
		case "model":
			return <ModelCallRow now={now} step={step} />;
		case "thinking":
			return (
				<>
					<span className="text-[11px] leading-5 text-muted-foreground">
						{m.run_step_thinking()}
					</span>
					<p className="max-w-full whitespace-pre-wrap break-words text-left text-[11px] leading-5 text-muted-foreground/80">
						{step.text}
					</p>
				</>
			);
		case "tool":
			return (
				<ToolCallRow
					argumentsText={step.argumentsText}
					isError={step.isError}
					output={step.output}
					toolName={step.toolName}
				/>
			);
		case "failure":
			return <p className="text-left text-[11px] leading-5 text-destructive">{step.detail}</p>;
		case "text":
			return (
				<>
					<span className="text-[11px] leading-5 text-muted-foreground">{m.run_step_text()}</span>
					<MessageText
						className="max-w-full text-left text-[11px] leading-5 text-muted-foreground/80"
						markdown={markdown}
						text={step.text}
					/>
				</>
			);
	}
}

/**
 * Hide text that already arrived as its own transcript bubble from the live preview.
 *
 * A mid-turn narration, an immediate sticker caption, or a flushed stream line is persisted and
 * rendered before the run settles; the same text still sits in `partialText`, so the preview
 * would show it twice. Only whole-line prefixes are removed, never an arbitrary substring.
 */
export function stripDeliveredPreview(partial: string, delivered: readonly string[]): string {
	let remaining = partial;
	let changed = true;
	while (changed) {
		changed = false;
		const candidateText = remaining.trimStart();
		for (const text of delivered) {
			const candidate = text.trim();
			if (candidate.length === 0) continue;
			if (candidateText === candidate) {
				remaining = "";
				changed = true;
				break;
			}
			if (!candidateText.startsWith(candidate)) continue;
			const next = candidateText.charAt(candidate.length);
			if (next !== "" && !/\s/u.test(next)) continue;
			remaining = candidateText.slice(candidate.length).replace(/^\s+/u, "");
			changed = true;
			break;
		}
	}
	return remaining;
}

export interface LiveRunMessageProps {
	run: LiveRunState;
	markdown?: boolean;
	/** Wall clock at render time, so the elapsed label ticks with the transcript. */
	now: number;
	/** Text already delivered as its own bubble during this run, hidden from the preview. */
	deliveredTexts?: readonly string[];
}

/**
 * One in-flight assistant turn, laid out the way a coding agent shows its work: the activity
 * stream above, the answer below it, both inside the message the answer will occupy once it
 * settles.
 *
 * Activity comes first because it is the *process* that produced the text: reading top-down, the
 * steps explain the answer instead of trailing it. `run.rounds` groups each model call with its
 * reasoning, tools, and intermediate text; older snapshots without rounds fall back to `steps`.
 * A slow model therefore reads as model call #1 working, not a hung bot.
 */
export function LiveRunMessage({
	run,
	now,
	markdown = false,
	deliveredTexts = [],
}: LiveRunMessageProps) {
	const [collapsed, setCollapsed] = useState(false);
	const working = !run.settled && run.failure === undefined;
	const rawPartial = run.partialText ?? "";
	// Mid-turn narration, stickers, and streamed lines already render as transcript bubbles.
	// Strip that delivered prefix so the live preview never repeats what the reader just read.
	const partial = stripDeliveredPreview(rawPartial, deliveredTexts);
	const thinking = run.partialThinking ?? "";
	const elapsed = elapsedSeconds(run.startedAtMs, now);
	const structured = run.rounds !== undefined;
	const rounds = run.rounds ?? [];
	const activeRound = structured
		? {
				...(run.model === undefined ? {} : { model: run.model }),
				...(thinking.length === 0 ? {} : { thinking }),
				tools: run.tools,
				draftTools: run.draftTools ?? [],
				...(partial.length === 0 ? {} : { text: partial }),
				working,
			}
		: undefined;
	const activeHasBody =
		thinking.length > 0 ||
		partial.length > 0 ||
		run.tools.length > 0 ||
		(run.draftTools?.length ?? 0) > 0;
	const steps = run.steps ?? [];
	const draftTools = run.draftTools ?? [];
	const tools = run.tools;
	// A failed run keeps the partial in the bubble. The timeline also records it as the final
	// round's text step, so hide that duplicate while keeping earlier rounds' preambles.
	const visibleSteps = steps.filter((step) => step.kind !== "text" || step.text !== rawPartial);
	const hasLegacyActivity =
		visibleSteps.length > 0 || thinking.length > 0 || draftTools.length > 0 || tools.length > 0;
	const hasActivity = structured
		? rounds.length > 0 || activeHasBody
		: hasLegacyActivity;
	const expanded = working || !collapsed;
	// Structured rounds own the partial answer inside the active round. The legacy view keeps it
	// in a ghost bubble below the step list, and a settled/failed structured run still needs the
	// final partial visible even though it has no active round.
	const showPartialBubble = !structured ? partial.length > 0 : !working && partial.length > 0;

	return (
		<Message from="assistant" align="start" className="gap-2">
			<MessageAvatar className="size-6 text-[10px] border border-primary/20 bg-primary/10 text-primary">
				E
			</MessageAvatar>
			<MessageContent>
				<MessageHeader>
					<span className="font-medium text-foreground">{m.message_sender_tsukaima()}</span>
					<span aria-hidden="true">·</span>
					<span className={cn(working ? "text-primary" : "text-destructive")}>
						{statusLabel(run, working)}
					</span>
					{hasActivity ? (
						<>
							<span aria-hidden="true">·</span>
							<button
								type="button"
								onClick={() => setCollapsed((value) => !value)}
								aria-expanded={expanded}
								disabled={working}
								className="inline-flex items-center gap-1 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
							>
								<span>{expanded ? m.run_steps_summary() : m.run_steps_show()}</span>
								<ChevronDown
									aria-hidden="true"
									className={cn("size-3 transition-transform", expanded && "rotate-180")}
								/>
							</button>
							<span className="tabular-nums text-muted-foreground/60">{elapsed}s</span>
						</>
					) : (
						<span className="tabular-nums text-muted-foreground/60">{elapsed}s</span>
					)}
				</MessageHeader>
				{expanded && structured && hasActivity ? (
					<RunRoundsView
						activeRound={working ? activeRound : undefined}
						className="max-w-[46rem]"
						markdown={markdown}
						rounds={rounds}
					/>
				) : null}
				{expanded && !structured && hasLegacyActivity ? (
					<ul className="flex w-full max-w-[46rem] flex-col items-start gap-1.5">
						{visibleSteps.map((step, index) => (
							<li
								key={`step-${index}-${step.kind}`}
								className="flex w-full min-w-0 flex-col items-start gap-0.5"
							>
								<StepRow markdown={markdown} now={now} step={step} />
							</li>
						))}
						{thinking.length > 0 ? (
							<li className="flex w-full min-w-0 flex-col items-start gap-0.5">
								<span className="text-[11px] leading-5 text-muted-foreground">
									{m.run_step_thinking()}
								</span>
								<p className="max-w-full whitespace-pre-wrap break-words text-left text-[11px] leading-5 text-muted-foreground/80">
									{thinking}
									{working ? (
										<span
											aria-hidden="true"
											className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-current align-text-bottom"
										/>
									) : null}
								</p>
							</li>
						) : null}
						{draftTools.map((tool) => (
							<li key={`draft-${tool.callId}`} className="w-full min-w-0">
								<ToolCallRow
									argumentsText={tool.argumentsText}
									badge={
										<span className="shrink-0 text-primary">{m.live_run_tool_preparing()}</span>
									}
									toolName={tool.toolName}
								/>
							</li>
						))}
						{tools.map((tool) => (
							<li key={tool.callId} className="w-full min-w-0">
								<ToolCallRow
									argumentsText={tool.argumentsText}
									badge={
										tool.status === "done" ? null : (
											<span className="shrink-0 text-primary">{m.live_run_working()}</span>
										)
									}
									output={tool.output}
									toolName={tool.toolName}
								/>
							</li>
						))}
					</ul>
				) : null}
				{run.failure === undefined ? null : (
					<p className="text-left text-[11px] text-destructive">{run.failure}</p>
				)}
				{showPartialBubble ? (
					<MessageBubble variant="ghost" className="max-w-full">
						<MessageBubbleContent className="max-w-[46rem]">
							<div>
								<MessageText
									className={markdown ? "" : "inline"}
									markdown={markdown}
									text={partial}
								/>
								{working ? (
									<span
										aria-hidden="true"
										className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-current align-text-bottom"
									/>
								) : null}
							</div>
						</MessageBubbleContent>
					</MessageBubble>
				) : null}
			</MessageContent>
		</Message>
	);
}
