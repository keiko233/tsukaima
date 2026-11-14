"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { orpc } from "@/lib/api";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { toStepRows } from "./run-step-items";

/**
 * Expandable record of how one assistant answer was produced.
 *
 * The live `pi.live` document is cleared the moment a run settles, so the streaming activity view
 * disappears with it. The durable transcript keeps the steps, and this reads them back so a
 * completed answer still shows its tool calls and reasoning.
 *
 * Rendered as its own rows rather than through the shared `AgentActivity`: that component lays
 * rows out left-aligned inside a full-width block, and this transcript is right-aligned.
 */
export function RunSteps({ entryId, sessionId }: { entryId: string; sessionId: string }) {
	const [open, setOpen] = useState(false);
	const query = useQuery({
		...orpc.admin.sessions.runSteps.queryOptions({ input: { entryId, sessionId } }),
		enabled: open,
	});

	const rows = toStepRows(query.data?.steps ?? []);
	const duration = query.data?.durationSeconds;

	// Nothing to expand for a plain answer with no tool rounds and no reasoning: a disclosure
	// that opens onto an empty list is noise. Until the first fetch settles there is no way to
	// know, so the trigger stays.
	if (!open && query.isFetched && rows.length === 0) return null;

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
						{duration === undefined ? null : (
							<span className="tabular-nums text-muted-foreground/60">{duration}s</span>
						)}
						<ChevronDown
							aria-hidden="true"
							className={cn("size-3 transition-transform", open && "rotate-180")}
						/>
					</>
				)}
			</button>
			{open && rows.length > 0 ? (
				<ul className="mt-1.5 flex w-full max-w-[min(42rem,88%)] flex-col items-start gap-1.5">
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
										<p
											className={cn(
												"max-w-full whitespace-pre-wrap break-words text-left text-[11px] leading-5",
												row.isError ? "text-destructive" : "text-muted-foreground/80",
											)}
										>
											{row.body}
										</p>
									)}
								</>
							)}
						</li>
					))}
				</ul>
			) : null}
			{open && query.isFetched && rows.length === 0 ? (
				<p className="mt-1 text-left text-[11px] text-muted-foreground">{m.run_steps_empty()}</p>
			) : null}
		</div>
	);
}
