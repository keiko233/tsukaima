"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { AgentActivity } from "@tsukaima/ui/components/agents/agent-activity";
import { orpc } from "@/lib/api";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { toActivityItems } from "./run-step-items";

/**
 * Expandable record of how one assistant answer was produced.
 *
 * The live `pi.live` document is cleared the moment a run settles, so the streaming activity view
 * disappears with it. The durable transcript keeps the steps, and this reads them back so a
 * completed answer still shows its tool calls and reasoning — the way a coding agent's transcript
 * does. Collapsed by default: the answer itself is what a reader usually wants first.
 */
export function RunSteps({ entryId, sessionId }: { entryId: string; sessionId: string }) {
	const [open, setOpen] = useState(false);
	const query = useQuery({
		...orpc.admin.sessions.runSteps.queryOptions({ input: { entryId, sessionId } }),
		enabled: open,
	});

	const steps = query.data?.steps ?? [];
	const items = toActivityItems(steps);

	// Nothing to expand for a plain answer with no tool rounds and no reasoning: showing a
	// disclosure that opens onto an empty list would be noise.
	const hasWork = steps.some((step) => step.kind === "tool" || step.kind === "thinking" || step.kind === "failure");
	if (!open && !hasWork) {
		// Until the first fetch settles we cannot know whether there is work, so the trigger stays
		// available but renders as a quiet affordance.
		if (query.isFetched) return null;
	}

	return (
		<div className="mt-1.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
				{query.isPending && open ? (
					<>
						<Loader2 className="size-3 animate-spin" />
						{m.run_steps_loading()}
					</>
				) : (
					<span>{m.run_steps_show()}</span>
				)}
			</button>
			{open && items.length > 0 ? (
				<AgentActivity
					items={items}
					status="complete"
					collapseOnComplete={false}
					defaultOpen
					className="mt-1.5 max-w-[min(42rem,88%)]"
				/>
			) : null}
			{open && query.isFetched && items.length === 0 ? (
				<p className="mt-1 px-1.5 text-[11px] text-muted-foreground">{m.run_steps_empty()}</p>
			) : null}
		</div>
	);
}
