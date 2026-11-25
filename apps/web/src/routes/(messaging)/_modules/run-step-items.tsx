import type { ReactNode } from "react";
import type {
	LiveDraftToolCall,
	LiveRunModel,
	LiveToolCall,
	RunRound,
	RunSegmentStatus,
	RunSegmentTriggerKind,
	RunStep,
	RunToolCall,
} from "@tsukaima/contracts";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { MessageText } from "./message-text";
import { ToolCallRow } from "./tool-call-row";

/**
 * One display row of a completed turn.
 *
 * Deliberately a plain model rather than `AgentActivityItem`: the shared activity component lays
 * its rows out left-aligned inside a full-width block, which cannot be overridden from outside.
 * This transcript is right-aligned, so the rows are rendered directly.
 */
export interface RunStepRow {
	readonly body?: string;
	readonly id: string;
	/** Marks the row and its body as a failure. */
	readonly isError?: boolean;
	readonly label: ReactNode;
	readonly markdown?: boolean;
	/** Full-width interactive content rendered instead of the label/body pair (tool calls). */
	readonly node?: ReactNode;
}

/** A tool call as one expandable row: header preview, full arguments and output in a card. */
function toolRows(step: Extract<RunStep, { kind: "tool" }>, index: number): RunStepRow[] {
	return [
		{
			id: `tool-${index}`,
			isError: step.isError,
			label: null,
			node: (
				<ToolCallRow
					argumentsText={step.argumentsText}
					isError={step.isError}
					output={step.output}
					toolName={step.toolName}
				/>
			),
		},
	];
}

/**
 * Flatten a turn's steps into display rows.
 *
 * The answer text is skipped: it renders in the message bubble, and repeating it here would show
 * the same sentence twice.
 */
export function toStepRows(steps: readonly RunStep[], answerText?: string): RunStepRow[] {
	const rows: RunStepRow[] = [];
	const lastText = steps.findLastIndex((step) => step.kind === "text");
	// A plain answer is not a process worth expanding. Model-call rows only add value when the
	// turn also reasoned, ran a tool, or failed.
	const showModelCalls = steps.some(
		(step) => step.kind === "thinking" || step.kind === "tool" || step.kind === "failure",
	);
	steps.forEach((step, index) => {
		switch (step.kind) {
			case "model": {
				if (!showModelCalls) return;
				const status =
					step.status === "running"
						? m.live_run_model_running()
						: step.status === "retry"
							? m.live_run_model_retry()
							: step.status === "failed"
								? m.live_run_model_failed()
								: undefined;
				const meta = [step.modelId ?? step.providerId, status, step.error]
					.filter((part): part is string => part !== undefined && part.length > 0)
					.join(" · ");
				rows.push({
					...(meta.length === 0 ? {} : { body: meta }),
					id: `model-${index}`,
					label: m.run_step_model({ call: step.call }),
				});
				return;
			}
			case "thinking":
				rows.push({ id: `thinking-${index}`, label: m.run_step_thinking() });
				rows.push({ body: step.text, id: `thinking-body-${index}`, label: null });
				return;
			case "tool":
				rows.push(...toolRows(step, index));
				return;
			case "failure":
				rows.push({
					id: `failure-${index}`,
					isError: true,
					label: m.run_step_failed(),
				});
				rows.push({ body: step.detail, id: `failure-body-${index}`, isError: true, label: null });
				return;
			case "text":
				if (index !== lastText || (answerText !== undefined && step.text !== answerText)) {
					rows.push({
						body: step.text,
						id: `text-${index}`,
						label: m.run_step_text(),
						markdown: true,
					});
				}
				return;
		}
	});
	return rows;
}


/** Human label for a persisted run segment's lifecycle. */
export function runSegmentStatusLabel(status: RunSegmentStatus): string {
	switch (status) {
		case "running":
			return m.run_segment_status_running();
		case "steered":
			return m.run_segment_status_steered();
		case "completed":
			return m.run_segment_status_completed();
		case "interrupted":
			return m.run_segment_status_interrupted();
		case "suppressed":
			return m.run_segment_status_suppressed();
		case "failed":
			return m.run_segment_status_failed();
	}
}

/** Why a segment exists: the initial turn, a steer, or a queued follow-up. */
export function runSegmentTriggerLabel(kind: RunSegmentTriggerKind): string {
	switch (kind) {
		case "initial":
			return m.run_segment_trigger_initial();
		case "steer":
			return m.run_segment_trigger_steer();
		case "follow-up":
			return m.run_segment_trigger_follow_up();
	}
}

export interface ActiveLiveRound {
	readonly draftTools?: readonly LiveDraftToolCall[];
	readonly model?: LiveRunModel;
	readonly text?: string;
	readonly thinking?: string;
	readonly tools?: readonly LiveToolCall[];
	readonly working?: boolean;
}

export interface RunRoundsViewProps {
	readonly rounds: readonly RunRound[];
	/** The round currently streaming; rendered after every completed round. */
	readonly activeRound?: ActiveLiveRound;
	readonly markdown?: boolean;
	readonly className?: string;
}

function durationLabel(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	const seconds = durationMs / 1_000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function stopReasonLabel(stopReason: RunRound["stopReason"]): string | undefined {
	if (stopReason === "aborted") return m.run_round_stop_aborted();
	if (stopReason === "error") return m.run_round_stop_error();
	return undefined;
}

function RoundHeader({
	model,
	duration,
	roundNumber,
	stopReason,
}: {
	model?: LiveRunModel | undefined;
	duration?: number | undefined;
	roundNumber: number;
	stopReason?: RunRound["stopReason"] | undefined;
}) {
	const meta = [model?.modelId ?? model?.providerId, durationLabel(duration)].filter(
		(part): part is string => part !== undefined && part.length > 0,
	);
	const stop = stopReasonLabel(stopReason);
	return (
		<div className="flex flex-wrap items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/70">
			<span className="font-medium text-foreground/70">
				{m.run_round_label({ n: roundNumber })}
			</span>
			{meta.length > 0 ? <span>· {meta.join(" · ")}</span> : null}
			{stop === undefined ? null : (
				<span
					className={cn(
						"rounded px-1.5 py-0 text-[9.5px] font-medium",
						stopReason === "error"
							? "bg-destructive/10 text-destructive"
							: "bg-warning/15 text-warning",
					)}
				>
					{stop}
				</span>
			)}
		</div>
	);
}

function ThinkingBlock({ text, working }: { text: string; working?: boolean }) {
	if (text.trim().length === 0) return null;
	return (
		<>
			<span className="text-[11px] leading-5 text-muted-foreground">
				{m.run_step_thinking()}
			</span>
			<p className="max-w-full whitespace-pre-wrap break-words text-left text-[11px] leading-5 text-muted-foreground/80">
				{text}
				{working ? (
					<span
						aria-hidden="true"
						className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-current align-text-bottom"
					/>
				) : null}
			</p>
		</>
	);
}

function OutputBlock({
	markdown,
	text,
	working,
}: {
	markdown: boolean;
	text: string;
	working?: boolean;
}) {
	if (text.trim().length === 0) return null;
	return (
		<>
			<span className="text-[11px] leading-5 text-muted-foreground">{m.run_step_text()}</span>
			<div className="max-w-full text-left text-[11px] leading-5 text-muted-foreground/80">
				<MessageText className={markdown ? "" : "inline"} markdown={markdown} text={text} />
				{working ? (
					<span
						aria-hidden="true"
						className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-current align-text-bottom"
					/>
				) : null}
			</div>
		</>
	);
}

function toolBadge(tool: RunToolCall | LiveToolCall | LiveDraftToolCall): ReactNode {
	if (!("status" in tool) || tool.status === undefined) {
		if ("callId" in tool && !("output" in tool)) {
			return <span className="shrink-0 text-primary">{m.live_run_tool_preparing()}</span>;
		}
		return null;
	}
	if (tool.status === "done") return null;
	return <span className="shrink-0 text-primary">{m.live_run_working()}</span>;
}

function ToolBlocks({
	tools,
}: {
	tools: readonly (RunToolCall | LiveToolCall | LiveDraftToolCall)[];
}) {
	if (tools.length === 0) return null;
	return (
		<>
			<span className="text-[11px] leading-5 text-muted-foreground">{m.run_round_tools()}</span>
			{tools.map((tool, index) => (
				<ToolCallRow
					key={`${tool.callId ?? tool.toolName}-${index}`}
					argumentsText={tool.argumentsText ?? ""}
					badge={toolBadge(tool)}
					isError={"isError" in tool ? tool.isError : false}
					output={"output" in tool ? (tool.output ?? "") : ""}
					toolName={tool.toolName}
				/>
			))}
		</>
	);
}

function RoundBody({
	markdown,
	round,
	roundNumber,
	totalRounds,
}: {
	markdown: boolean;
	round: RunRound;
	roundNumber: number;
	totalRounds: number;
}) {
	const showHeader =
		totalRounds > 1 ||
		round.model !== undefined ||
		round.durationMs !== undefined ||
		round.stopReason === "aborted" ||
		round.stopReason === "error";
	return (
		<div className="flex w-full min-w-0 flex-col items-start gap-1">
			{showHeader ? (
				<RoundHeader
					duration={round.durationMs}
					model={round.model}
					roundNumber={roundNumber}
					stopReason={round.stopReason}
				/>
			) : null}
			{round.thinking === undefined ? null : <ThinkingBlock text={round.thinking} />}
			<ToolBlocks tools={round.toolCalls} />
			{round.intermediateText === undefined ? null : (
				<OutputBlock markdown={markdown} text={round.intermediateText} />
			)}
			{round.failure === undefined ? null : (
				<p className="max-w-full text-left text-[11px] leading-5 text-destructive">
					{round.failure}
				</p>
			)}
		</div>
	);
}

function ActiveRoundBody({
	activeRound,
	markdown,
	roundNumber,
	totalRounds,
}: {
	activeRound: ActiveLiveRound;
	markdown: boolean;
	roundNumber: number;
	totalRounds: number;
}) {
	const thinking = activeRound.thinking ?? "";
	const text = activeRound.text ?? "";
	const draftTools = activeRound.draftTools ?? [];
	const tools = activeRound.tools ?? [];
	const working = activeRound.working === true;
	const hasBody =
		thinking.trim().length > 0 ||
		text.trim().length > 0 ||
		draftTools.length > 0 ||
		tools.length > 0;
	if (!hasBody) return null;
	return (
		<div className="flex w-full min-w-0 flex-col items-start gap-1">
			{totalRounds > 1 || activeRound.model !== undefined ? (
				<RoundHeader
					model={activeRound.model}
					roundNumber={roundNumber}
					stopReason={undefined}
				/>
			) : null}
			<ThinkingBlock text={thinking} working={working} />
			<ToolBlocks tools={[...draftTools, ...tools]} />
			<OutputBlock markdown={markdown} text={text} working={working} />
		</div>
	);
}

/**
 * Shared round-grouped activity view for a persisted segment and a live run.
 *
 * A round is the unit the model actually produced: one call's reasoning, its tools, and any text
 * before the next call. Grouping by round keeps a steered or multi-tool turn readable and lets
 * the same renderer show a completed segment from `MessagePage.runSegments` and the streaming
 * `LiveRunState` without a second visual language.
 */
export function RunRoundsView({
	rounds,
	activeRound,
	markdown = false,
	className,
}: RunRoundsViewProps) {
	const ordered = [...rounds].toSorted((a, b) => a.roundIndex - b.roundIndex);
	const totalRounds = ordered.length + (activeRound === undefined ? 0 : 1);
	if (totalRounds === 0) return null;
	return (
		<div className={cn("flex w-full min-w-0 flex-col items-start gap-2", className)}>
			{ordered.map((round) => (
				<RoundBody
					key={`round-${round.roundIndex}`}
					markdown={markdown}
					round={round}
					roundNumber={round.roundIndex + 1}
					totalRounds={totalRounds}
				/>
			))}
			{activeRound === undefined ? null : (
				<ActiveRoundBody
					activeRound={activeRound}
					markdown={markdown}
					roundNumber={ordered.length + 1}
					totalRounds={totalRounds}
				/>
			)}
		</div>
	);
}
