import { CircleAlert, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { RunStep } from "@tsukaima/contracts";
import { m } from "@/paraglide/messages";

/**
 * One display row of a completed turn.
 *
 * Deliberately a plain model rather than `AgentActivityItem`: the shared activity component lays
 * its rows out left-aligned inside a full-width block, which cannot be overridden from outside.
 * This transcript is right-aligned, so the rows are rendered directly.
 */
export interface RunStepRow {
	readonly body?: ReactNode;
	readonly id: string;
	/** Marks the row and its body as a failure. */
	readonly isError?: boolean;
	readonly label: ReactNode;
}

/** A tool call as one row: the name, its arguments, and (as a separate row) its output. */
function toolRows(step: Extract<RunStep, { kind: "tool" }>, index: number): RunStepRow[] {
	const rows: RunStepRow[] = [
		{
			id: `tool-${index}`,
			isError: step.isError,
			label: (
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<Wrench className="size-3 shrink-0" />
					<span className="shrink-0 font-mono">{step.toolName}</span>
					{step.argumentsText.length > 0 ? (
						<span className="truncate text-muted-foreground">{step.argumentsText}</span>
					) : null}
					{step.isError ? <CircleAlert className="size-3 shrink-0 text-destructive" /> : null}
				</span>
			),
		},
	];
	if (step.output.length > 0) {
		rows.push({
			body: step.output,
			id: `tool-output-${index}`,
			isError: step.isError,
			label: null,
		});
	}
	return rows;
}

/**
 * Flatten a turn's steps into display rows.
 *
 * The answer text is skipped: it renders in the message bubble, and repeating it here would show
 * the same sentence twice.
 */
export function toStepRows(steps: readonly RunStep[]): RunStepRow[] {
	const rows: RunStepRow[] = [];
	steps.forEach((step, index) => {
		switch (step.kind) {
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
				return;
		}
	});
	return rows;
}
