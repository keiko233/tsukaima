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

export interface LiveRunMessageProps {
	run: LiveRunState;
	markdown?: boolean;
	/** Wall clock at render time, so the elapsed label ticks with the transcript. */
	now: number;
}

/**
 * One in-flight assistant turn, laid out the way a coding agent shows its work: the activity
 * stream above, the answer below it, both inside the message the answer will occupy once it
 * settles.
 *
 * Activity comes first because it is the *process* that produced the text: reading top-down, the
 * steps explain the answer instead of trailing it. `steps` holds finished model calls, reasoning,
 * and tool calls; the current request adds its partial thinking, draft tool calls, and running
 * tools below them. A slow model therefore reads as model call #1 working, not a hung bot.
 */
export function LiveRunMessage({ run, now, markdown = false }: LiveRunMessageProps) {
	const [collapsed, setCollapsed] = useState(false);
	const working = !run.settled && run.failure === undefined;
	const partial = run.partialText ?? "";
	const thinking = run.partialThinking ?? "";
	const elapsed = elapsedSeconds(run.startedAtMs, now);
	const steps = run.steps ?? [];
	const draftTools = run.draftTools ?? [];
	const tools = run.tools;
	// A failed run keeps the partial in the bubble. The timeline also records it as the final
	// round's text step, so hide that duplicate while keeping earlier rounds' preambles.
	const visibleSteps = steps.filter((step) => step.kind !== "text" || step.text !== partial);
	const hasActivity =
		visibleSteps.length > 0 || thinking.length > 0 || draftTools.length > 0 || tools.length > 0;
	const expanded = working || !collapsed;

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
						{run.failure === undefined ? phaseLabel(run.phase, working) : m.live_run_failed()}
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
				{expanded && hasActivity ? (
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
				{partial.length > 0 ? (
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
