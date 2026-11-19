"use client";

import { ChevronDown, CircleAlert, Wrench } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { AgentCode, type AgentCodeLanguage } from "@tsukaima/ui/components/agents/agent-code";
import { AgentDisclosure } from "@tsukaima/ui/components/agents/agent-disclosure";
import { cn } from "@tsukaima/ui/lib/utils";

export interface ToolCallRowProps {
	/** Compact single-line JSON of the call arguments, shown truncated in the header. */
	readonly argumentsText?: string;
	/** Extra header badge, e.g. the live "working" label. */
	readonly badge?: ReactNode;
	readonly isError?: boolean;
	readonly output?: string;
	readonly toolName: string;
}

/** Pretty-print compact argument JSON for the expanded card; non-JSON text passes through. */
function formatArguments(text: string): { code: string; language: AgentCodeLanguage } {
	try {
		return { code: JSON.stringify(JSON.parse(text), null, 2), language: "json" };
	} catch {
		return { code: text, language: "text" };
	}
}

/**
 * One tool call: a compact header (name + truncated arguments) that expands into a card with
 * the full arguments and output. Long payloads stay readable on demand instead of being cut
 * off with no way to see them.
 *
 * Collapsed rows stay compact. Full arguments and output are only visible after expanding the
 * card, so large structured tool results cannot take over the transcript.
 */
export function ToolCallRow({ argumentsText, badge, isError, output, toolName }: ToolCallRowProps) {
	const [open, setOpen] = useState(false);
	const contentId = useId();
	const args = argumentsText ?? "";
	const result = output ?? "";
	const expandable = args.length > 0 || result.length > 0;
	const formattedArgs = useMemo(() => formatArguments(args), [args]);

	const header = (
		<>
			<Wrench className="size-3 shrink-0" />
			<span className="shrink-0 font-mono">{toolName}</span>
			{args.length > 0 ? (
				<span className="min-w-0 truncate text-muted-foreground">{args}</span>
			) : null}
			{badge}
			{isError ? <CircleAlert className="size-3 shrink-0 text-destructive" /> : null}
			{expandable ? (
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-3 shrink-0 text-muted-foreground/60 transition-transform",
						open && "rotate-180",
					)}
				/>
			) : null}
		</>
	);
	const headerClass = cn(
		"inline-flex min-w-0 max-w-full items-center gap-1.5 rounded text-left text-[11px] leading-5",
		isError ? "text-destructive" : "text-muted-foreground",
	);

	return (
		<div className="flex w-full min-w-0 flex-col items-start gap-0.5">
			{expandable ? (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={contentId}
					onClick={() => setOpen((value) => !value)}
					className={cn(
						headerClass,
						"outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
						!isError && "hover:text-foreground",
					)}
				>
					{header}
				</button>
			) : (
				<span className={headerClass}>{header}</span>
			)}
			{expandable ? (
				<AgentDisclosure id={contentId} open={open} className="w-full">
					<div className="mt-0.5 w-full rounded-lg bg-muted/80 px-2.5 py-2 text-left text-[11px] leading-5">
						{args.length > 0 ? (
							<AgentCode
								code={formattedArgs.code}
								language={formattedArgs.language}
								className="whitespace-pre-wrap break-words text-[11px] leading-5"
							/>
						) : null}
						{args.length > 0 && result.length > 0 ? (
							<div className="my-1.5 border-t border-border/60" />
						) : null}
						{result.length > 0 ? (
							<p
								className={cn(
									"whitespace-pre-wrap break-words",
									isError ? "text-destructive" : "text-muted-foreground/80",
								)}
							>
								{result}
							</p>
						) : null}
					</div>
				</AgentDisclosure>
			) : null}
		</div>
	);
}
