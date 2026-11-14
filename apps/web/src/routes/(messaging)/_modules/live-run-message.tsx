"use client";

import { useMemo } from "react";
import { AgentActivity, type AgentActivityItem } from "@elaina/ui/components/agents/agent-activity";
import {
	Message,
	MessageAvatar,
	MessageBubble,
	MessageBubbleContent,
	MessageContent,
	MessageHeader,
} from "@elaina/ui/components/agents/message";
import type { LiveRunState } from "@elaina/contracts";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";

function elapsedSeconds(startedAtMs: number, now: number): number {
	return Math.max(0, Math.floor((now - startedAtMs) / 1_000));
}

/**
 * Turn a live run into the activity rows the shared component renders. Tool calls and streamed
 * text are the two things worth showing; a run that has produced neither yet still renders an
 * empty activity view, which is the "working" state the user asked to see.
 */
function activityItems(run: LiveRunState): AgentActivityItem[] {
	const items: AgentActivityItem[] = [];
	for (const tool of run.tools) {
		items.push({
			id: tool.callId,
			status:
				tool.status === "done" ? "complete" : tool.status === "running" ? "active" : "pending",
			type: "step",
			label: tool.toolName,
			...(tool.output === undefined ? {} : { meta: tool.output.split("\n").at(-1) ?? "" }),
		});
	}
	return items;
}

export interface LiveRunMessageProps {
	run: LiveRunState;
	/** Wall clock at render time, so the elapsed label ticks with the transcript. */
	now: number;
}

/**
 * One in-flight assistant turn, rendered in the same bubble vocabulary as a persisted message so
 * the transcript does not change shape when the answer settles.
 *
 * Two signals are shown together, which is what the transcript was missing: the agent's activity
 * (tool rounds, elapsed time, failure) and the answer text as it streams. Before this, a run was
 * invisible until it had fully completed, so a slow model looked like a hung bot.
 */
export function LiveRunMessage({ run, now }: LiveRunMessageProps) {
	const items = useMemo(() => activityItems(run), [run]);
	const working = run.failure === undefined;
	const partial = run.partialText ?? "";
	const elapsed = elapsedSeconds(run.startedAtMs, now);
	// A run that answered shows its text; a run with only tool calls shows just the activity.
	const showActivity = items.length > 0 || working;

	return (
		<Message from="assistant" className="gap-2.5">
			<MessageAvatar className="border border-primary/20 bg-primary/10 text-primary">E</MessageAvatar>
			<MessageContent>
				<MessageHeader>
					<span className="font-medium text-foreground">{m.message_sender_elaina()}</span>
					<span aria-hidden="true">·</span>
					<span className={cn(run.failure === undefined ? "text-primary" : "text-destructive")}>
						{run.failure === undefined ? m.live_run_working() : m.live_run_failed()}
					</span>
				</MessageHeader>
				{showActivity ? (
					<AgentActivity
						items={items}
						status={working ? "working" : "complete"}
						duration={elapsed}
						collapseOnComplete={false}
						activeLabel={m.live_run_active_label()}
						className="max-w-[min(42rem,88%)]"
					/>
				) : null}
				{run.failure === undefined ? null : (
					<p className="text-xs text-destructive">{run.failure}</p>
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
