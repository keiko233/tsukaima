"use client";

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Message,
	MessageAvatar,
	MessageBubble,
	MessageBubbleContent,
	MessageContent,
	MessageHeader,
} from "@elaina/ui/components/agents/message";
import type { LiveRunPhase, LiveRunState } from "@elaina/contracts";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { ToolCallRow } from "./tool-call-row";

function elapsedSeconds(startedAtMs: number, now: number): number {
	return Math.max(0, Math.floor((now - startedAtMs) / 1_000));
}

function phaseLabel(phase: LiveRunPhase | undefined, working: boolean): string {
	if (!working) return m.live_run_phase_settled();
	switch (phase) {
		case "thinking":
			return m.live_run_phase_thinking();
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

export interface LiveRunMessageProps {
	run: LiveRunState;
	/** Wall clock at render time, so the elapsed label ticks with the transcript. */
	now: number;
}

/**
 * One in-flight assistant turn, laid out the way a coding agent shows its work: the activity
 * stream above, the answer below it, both inside the message the answer will occupy once it
 * settles.
 *
 * Activity comes first because it is the *process* that produced the text: reading top-down, the
 * steps explain the answer instead of trailing it. The reasoning is streamed, so a slow model
 * looks like a model thinking rather than a hung bot.
 */
export function LiveRunMessage({ run, now }: LiveRunMessageProps) {
	const [collapsed, setCollapsed] = useState(false);
	const working = !run.settled && run.failure === undefined;
	const partial = run.partialText ?? "";
	const thinking = run.partialThinking ?? "";
	const elapsed = elapsedSeconds(run.startedAtMs, now);
	const hasActivity = thinking.length > 0 || run.tools.length > 0;
	const expanded = working || !collapsed;

	const tools = useMemo(() => run.tools, [run.tools]);

	return (
		<Message from="assistant" align="start" className="gap-2.5">
			<MessageAvatar className="border border-primary/20 bg-primary/10 text-primary">
				E
			</MessageAvatar>
			<MessageContent>
				<MessageHeader>
					<span className="font-medium text-foreground">{m.message_sender_elaina()}</span>
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
					<ul className="flex w-full max-w-[min(42rem,88%)] flex-col items-start gap-1.5">
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
						{tools.map((tool) => (
							<li key={tool.callId} className="w-full min-w-0">
								<ToolCallRow
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
					<MessageBubble variant="outline" className="max-w-full">
						<MessageBubbleContent className="max-w-[min(42rem,88%)]">
							<p className="whitespace-pre-wrap break-words">
								{partial}
								{working ? (
									<span
										aria-hidden="true"
										className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-current align-text-bottom"
									/>
								) : null}
							</p>
						</MessageBubbleContent>
					</MessageBubble>
				) : null}
			</MessageContent>
		</Message>
	);
}
