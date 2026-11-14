import type { ReactNode } from "react";
import type { RunStep } from "@elaina/contracts";
import { m } from "@/paraglide/messages";
import { ToolCallRow } from "./tool-call-row";

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
