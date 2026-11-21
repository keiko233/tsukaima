import type { ReactNode } from "react";
import type { RunStep } from "@tsukaima/contracts";
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
