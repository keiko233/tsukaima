import { CircleAlert, Wrench } from "lucide-react";
import type { RunStep } from "@elaina/contracts";
import type { AgentActivityItem } from "@elaina/ui/components/agents/agent-activity";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";

/**
 * One tool call as an activity row: the name, its arguments, and what came back. A tool row is a
 * single step rather than a call plus a result, because that is how a reader thinks about it.
 */
function toolItem(step: Extract<RunStep, { kind: "tool" }>, index: number): AgentActivityItem {
	return {
		id: `tool-${index}`,
		label: (
			<span className="inline-flex items-center gap-1.5">
				<Wrench className="size-3" />
				<span className="font-mono">{step.toolName}</span>
				{step.argumentsText.length > 0 ? (
					<span className="truncate text-muted-foreground">{step.argumentsText}</span>
				) : null}
				{step.isError ? <CircleAlert className="size-3 text-destructive" /> : null}
			</span>
		),
		meta:
			step.output.length === 0 ? undefined : (
				<span className={cn("whitespace-pre-wrap", step.isError && "text-destructive")}>
					{step.output}
				</span>
			),
		status: "complete",
		type: "step",
	};
}

export function toActivityItems(steps: readonly RunStep[]): AgentActivityItem[] {
	const items: AgentActivityItem[] = [];
	steps.forEach((step, index) => {
		switch (step.kind) {
			case "thinking":
				items.push({
					id: `thinking-${index}`,
					label: m.run_step_thinking(),
					meta: <span className="whitespace-pre-wrap">{step.text}</span>,
					status: "complete",
					type: "step",
				});
				return;
			case "tool":
				items.push(toolItem(step, index));
				return;
			case "failure":
				items.push({
					id: `failure-${index}`,
					label: <span className="text-destructive">{m.run_step_failed()}</span>,
					meta: <span className="text-destructive">{step.detail}</span>,
					status: "complete",
					type: "step",
				});
				return;
			case "text":
				// The answer text is already in the message bubble below, so repeating it as a step
				// would duplicate it. Only the work that produced it is worth expanding.
				return;
		}
	});
	return items;
}
