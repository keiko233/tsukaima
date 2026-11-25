"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import type { LiveRunState, RunSegmentSummary } from "@tsukaima/contracts";
import { orpc } from "@/lib/api";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { MessageText } from "./message-text";
import {
	RunRoundsView,
	runSegmentStatusLabel,
	runSegmentTriggerLabel,
	toStepRows,
} from "./run-step-items";

/**
 * Expandable record of how one assistant answer was produced.
 *
 * The live `pi.live` document is cleared the moment a run settles, so the streaming activity view
 * disappears with it. A persisted segment carries the same rounds on its assistant row, so the
 * answer can show its reasoning and tools without another request. Segments from an older server
 * or a page that did not include the rounds still fall back to `sessions.runSteps`.
 *
 * Rendered as its own rows rather than through the shared `AgentActivity`: that component lays
 * rows out left-aligned inside a full-width block, and this transcript is right-aligned.
 */
export function RunSteps({
	answerText,
	entryId,
	markdown = false,
	runId,
	segment,
	sessionId,
}: {
	answerText?: string;
	entryId?: string;
	markdown?: boolean;
	runId?: string;
	/** Segment already attached to this answer, with its rounds when the page carried them. */
	segment?: RunSegmentSummary;
	sessionId: string;
}) {
	const [open, setOpen] = useState(false);
	const preloadedRounds = segment?.rounds ?? [];
	const interrupted =
		segment?.status === "interrupted" || segment?.status === "failed";
	const hasKnownActivity = preloadedRounds.length > 0 || interrupted;
	const input =
		segment !== undefined
			? { runSegmentId: segment.id, sessionId }
			: runId !== undefined
				? { runId, sessionId }
				: entryId !== undefined
					? { entryId, sessionId }
					: undefined;
	const query = useQuery({
		...orpc.admin.sessions.runSteps.queryOptions({ input: input ?? { sessionId } }),
		enabled: open && input !== undefined && preloadedRounds.length === 0,
	});

	const rounds = preloadedRounds.length > 0 ? preloadedRounds : (query.data?.rounds ?? []);
	const rows = toStepRows(query.data?.steps ?? [], answerText);
	const durationMs = segment?.durationMs ?? undefined;
	const durationSeconds =
		durationMs === undefined
			? query.data?.durationSeconds
			: Math.round((durationMs / 1_000) * 10) / 10;

	// Never render a disclosure that can only open onto an empty list: narration, stream lines,
	// and legacy rows with no segment simply have no process to show.
	if (!hasKnownActivity) return null;

	return (
		<div className="mb-1.5 flex w-full flex-col items-start">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				{query.isPending && open ? (
					<>
						<Loader2 className="size-3 animate-spin" />
						{m.run_steps_loading()}
					</>
				) : (
					<>
						<span>{open ? m.run_steps_summary() : m.run_steps_show()}</span>
						{durationSeconds === undefined ? null : (
							<span className="tabular-nums text-muted-foreground/60">{durationSeconds}s</span>
						)}
						<ChevronDown
							aria-hidden="true"
							className={cn("size-3 transition-transform", open && "rotate-180")}
						/>
					</>
				)}
			</button>
			{open && rounds.length > 0 ? (
				<RunRoundsView className="mt-1.5 max-w-[46rem]" markdown={markdown} rounds={rounds} />
			) : null}
			{open && rounds.length === 0 && rows.length > 0 ? (
				<ul className="mt-1.5 flex w-full max-w-[46rem] flex-col items-start gap-1.5">
					{rows.map((row) => (
						<li key={row.id} className="flex w-full min-w-0 flex-col items-start gap-0.5">
							{row.node ?? (
								<>
									{row.label === null ? null : (
										<span
											className={cn(
												"inline-flex min-w-0 max-w-full items-center gap-1.5 text-[11px] leading-5",
												row.isError ? "text-destructive" : "text-muted-foreground",
											)}
										>
											{row.label}
										</span>
									)}
									{row.body === undefined ? null : (
										<MessageText
											className={cn(
												"max-w-full text-left text-[11px] leading-5",
												row.isError ? "text-destructive" : "text-muted-foreground/80",
											)}
											markdown={markdown && row.markdown === true}
											text={row.body}
										/>
									)}
								</>
							)}
						</li>
					))}
				</ul>
			) : null}
			{open && rounds.length === 0 && rows.length === 0 && query.isFetched ? (
				<p className="mt-1 text-left text-[11px] text-muted-foreground">{m.run_steps_empty()}</p>
			) : null}
		</div>
	);
}


function segmentStatusClass(status: RunSegmentSummary["status"]): string {
	switch (status) {
		case "running":
			return "bg-primary/10 text-primary";
		case "steered":
			return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
		case "completed":
			return "bg-muted text-muted-foreground";
		case "interrupted":
			return "bg-warning/15 text-warning";
		case "failed":
			return "bg-destructive/10 text-destructive";
		case "suppressed":
			return "bg-muted text-muted-foreground";
	}
}

/**
 * A segment with no final assistant row: steered away, interrupted, suppressed, failed, or still
 * streaming. It stays at its own `seq` so the steer/interrupt message that follows it reads in
 * the same order it happened, and its preserved rounds stay available on demand.
 */
export function RunSegmentCard({
	segment,
	liveRun,
	markdown = false,
	now,
}: {
	segment: RunSegmentSummary;
	liveRun?: LiveRunState | undefined;
	markdown?: boolean;
	now?: number;
}) {
	const [open, setOpen] = useState(
		() =>
			segment.status === "running" ||
			segment.status === "interrupted" ||
			segment.status === "failed",
	);
	const working = liveRun !== undefined && !liveRun.settled;
	const status = liveRun?.status ?? segment.status;
	const rounds = liveRun?.rounds ?? segment.rounds;
	const failure = segment.failureDetail ?? liveRun?.failure;
	const activeRound = working
		? {
				...(liveRun.model === undefined ? {} : { model: liveRun.model }),
				thinking: liveRun.partialThinking,
				tools: liveRun.tools,
				draftTools: liveRun.draftTools,
				text: liveRun.partialText,
				working: true,
			}
		: undefined;
	const hasActivity =
		rounds.length > 0 ||
		failure !== undefined ||
		status === "running" ||
		status === "interrupted" ||
		status === "failed" ||
		liveRun !== undefined;
	const elapsed =
		working && now !== undefined
			? Math.max(0, Math.floor((now - liveRun.startedAtMs) / 1_000))
			: undefined;
	const durationSeconds =
		elapsed ??
		(segment.durationMs === null ? undefined : Math.round((segment.durationMs / 1_000) * 10) / 10);
	return (
		<div className="flex w-full max-w-[46rem] flex-col items-start gap-1 rounded-lg border border-dashed border-border/70 bg-muted/20 px-2.5 py-1.5">
			<div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[11px] leading-5 text-muted-foreground">
				<Activity aria-hidden="true" className="size-3 shrink-0" />
				<span className="font-medium text-foreground/80">{m.run_segment_title()}</span>
				<span className="rounded bg-background/70 px-1.5 text-[10px] text-muted-foreground">
					{runSegmentTriggerLabel(segment.triggerKind)}
				</span>
				<span
					className={cn(
						"rounded px-1.5 text-[10px] font-medium",
						segmentStatusClass(status),
					)}
				>
					{runSegmentStatusLabel(status)}
				</span>
				{durationSeconds === undefined ? null : (
					<span className="tabular-nums text-muted-foreground/60">{durationSeconds}s</span>
				)}
				{hasActivity ? (
					<button
						type="button"
						onClick={() => setOpen((value) => !value)}
						aria-expanded={open}
						className="ms-auto inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span>{open ? m.run_steps_summary() : m.run_steps_show()}</span>
						<ChevronDown
							aria-hidden="true"
							className={cn("size-3 transition-transform", open && "rotate-180")}
						/>
					</button>
				) : null}
			</div>
			{failure === undefined ? null : (
				<p className="max-w-full text-left text-[11px] leading-5 text-destructive">{failure}</p>
			)}
			{open && (rounds.length > 0 || activeRound !== undefined) ? (
				<RunRoundsView
					activeRound={activeRound}
					markdown={markdown}
					rounds={rounds}
				/>
			) : null}
		</div>
	);
}
