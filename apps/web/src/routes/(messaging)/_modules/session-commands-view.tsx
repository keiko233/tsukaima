"use client";

import { Archive, Brain, Minimize2, Pencil, Radio, RotateCcw, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { cn } from "@elaina/ui/lib/utils";
import { m } from "@/paraglide/messages";

const inputClass =
	"h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const textareaClass =
	"min-h-14 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export interface CommandFeedback {
	message: string;
	tone: "neutral" | "ok";
}

export interface SessionCommandsViewProps {
	abortResult?: string;
	aborting?: boolean;
	archived: boolean;
	compactResult?: CommandFeedback;
	compacting?: boolean;
	compactingMemories?: boolean;
	isExternal: boolean;
	isReceiving: boolean;
	isRunning: boolean;
	memoryCompactResult?: CommandFeedback;
	onAbort: () => void;
	onCompact: (instructions?: string) => void;
	onCompactMemories: () => void;
	onRename: (title: string) => void;
	onResetContext: (handoff?: string) => void;
	onSetReceiving: () => void;
	onToggleArchive: () => void;
	resetResult?: string;
	resetting?: boolean;
	sessionTitle: string;
	updatingSession?: boolean;
}

function ResultBanner({ message, tone = "ok" }: { message: string; tone?: "neutral" | "ok" }) {
	return (
		<p
			className={cn(
				"rounded-md px-2.5 py-1.5 text-[11px] leading-4",
				tone === "ok"
					? "bg-primary/10 text-primary"
					: "bg-muted text-muted-foreground",
			)}
		>
			{message}
		</p>
	);
}

export function SessionCommandsView({
	abortResult,
	aborting = false,
	archived,
	compactResult,
	compacting = false,
	compactingMemories = false,
	isExternal,
	isReceiving,
	isRunning,
	memoryCompactResult,
	onAbort,
	onCompact,
	onCompactMemories,
	onRename,
	onResetContext,
	onSetReceiving,
	onToggleArchive,
	resetResult,
	resetting = false,
	sessionTitle,
	updatingSession = false,
}: SessionCommandsViewProps) {
	const [compactInstructions, setCompactInstructions] = useState("");
	const [resetHandoff, setResetHandoff] = useState("");
	const [confirmReset, setConfirmReset] = useState(false);
	const [titleDraft, setTitleDraft] = useState(sessionTitle);

	useEffect(() => {
		setTitleDraft(sessionTitle);
	}, [sessionTitle]);

	const trimmedTitle = titleDraft.trim();
	const canRename = trimmedTitle.length > 0 && trimmedTitle !== sessionTitle && !updatingSession;
	const archiveBlockedByReceiving = !archived && isExternal && isReceiving;

	return (
		<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-3 pb-4">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h3 className="text-xs font-semibold text-foreground">{m.command_section_title()}</h3>
					<p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
						{m.command_section_hint()}
					</p>
				</div>
				<span
					className={cn(
						"inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
						isRunning
							? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
							: "bg-muted text-muted-foreground",
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							isRunning ? "animate-pulse bg-amber-500" : "bg-muted-foreground/60",
						)}
					/>
					{isRunning ? m.command_status_active() : m.command_status_idle()}
				</span>
			</div>

			<section className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
				<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<Minimize2 className="size-3.5 text-muted-foreground" />
					<span>{m.command_compact_title()}</span>
				</div>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.command_compact_description()}
				</p>
				<textarea
					rows={2}
					className={textareaClass}
					placeholder={m.command_compact_instructions_placeholder()}
					value={compactInstructions}
					disabled={archived || compacting}
					onChange={(event) => setCompactInstructions(event.target.value)}
				/>
				<Button
					type="button"
					size="sm"
					fullWidth
					disabled={archived || compacting}
					onClick={() => onCompact(compactInstructions)}
				>
					{compacting ? m.command_compact_running() : m.command_compact_action()}
				</Button>
				{compactResult ? (
					<ResultBanner message={compactResult.message} tone={compactResult.tone} />
				) : null}
			</section>

			<section className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
				<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<Brain className="size-3.5 text-muted-foreground" />
					<span>{m.command_memory_compact_title()}</span>
				</div>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.command_memory_compact_description()}
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					fullWidth
					disabled={archived || compactingMemories}
					onClick={onCompactMemories}
				>
					{compactingMemories ? m.command_memory_compact_running() : m.command_memory_compact_action()}
				</Button>
				{memoryCompactResult ? (
					<ResultBanner message={memoryCompactResult.message} tone={memoryCompactResult.tone} />
				) : null}
			</section>

			<section className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
				<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<Square className="size-3.5 text-muted-foreground" />
					<span>{m.command_abort_title()}</span>
				</div>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.command_abort_description()}
				</p>
				<Button
					type="button"
					variant={isRunning ? "danger" : "outline"}
					size="sm"
					fullWidth
					disabled={aborting}
					onClick={onAbort}
				>
					{aborting ? m.command_abort_running() : m.command_abort_action()}
				</Button>
				{abortResult ? <ResultBanner message={abortResult} /> : null}
			</section>

			<section className="space-y-2 rounded-lg border border-border/70 bg-background/50 p-3">
				<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<RotateCcw className="size-3.5 text-muted-foreground" />
					<span>{m.command_reset_title()}</span>
				</div>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.command_reset_description()}
				</p>
				<textarea
					rows={2}
					className={textareaClass}
					placeholder={m.command_reset_handoff_placeholder()}
					value={resetHandoff}
					disabled={archived || resetting}
					onChange={(event) => setResetHandoff(event.target.value)}
				/>
				{confirmReset ? (
					<div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
						<p className="text-[11px] leading-4 text-destructive">
							{m.command_reset_confirm_prompt()}
						</p>
						<div className="flex items-center gap-1.5">
							<Button
								type="button"
								variant="danger"
								size="sm"
								className="flex-1"
								disabled={archived || resetting}
								onClick={() => {
									onResetContext(resetHandoff);
									setConfirmReset(false);
									setResetHandoff("");
								}}
							>
								{resetting ? m.command_reset_running() : m.command_reset_confirm_action()}
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={resetting}
								onClick={() => setConfirmReset(false)}
							>
								{m.cancel()}
							</Button>
						</div>
					</div>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						fullWidth
						disabled={archived || resetting}
						onClick={() => setConfirmReset(true)}
					>
						{resetting ? m.command_reset_running() : m.command_reset_action()}
					</Button>
				)}
				{resetResult ? <ResultBanner message={resetResult} /> : null}
			</section>

			<section className="space-y-2.5 rounded-lg border border-border/70 bg-background/50 p-3">
				<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
					<Pencil className="size-3.5 text-muted-foreground" />
					<span>{m.command_session_title()}</span>
				</div>
				<label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
					<span>{m.command_rename_label()}</span>
					<div className="flex items-center gap-1.5">
						<input
							type="text"
							className={inputClass}
							value={titleDraft}
							disabled={updatingSession}
							onChange={(event) => setTitleDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && canRename) {
									event.preventDefault();
									onRename(trimmedTitle);
								}
							}}
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={!canRename}
							onClick={() => onRename(trimmedTitle)}
						>
							{m.command_rename_action()}
						</Button>
					</div>
				</label>

				{isExternal && !archived && !isReceiving ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						fullWidth
						leadingIcon={<Radio className="size-3.5" />}
						disabled={updatingSession}
						onClick={onSetReceiving}
					>
						{m.set_receiving()}
					</Button>
				) : null}

				<Button
					type="button"
					variant="outline"
					size="sm"
					fullWidth
					leadingIcon={
						archived ? <RotateCcw className="size-3.5" /> : <Archive className="size-3.5" />
					}
					disabled={updatingSession || archiveBlockedByReceiving}
					onClick={onToggleArchive}
				>
					{archived ? m.restore() : m.archive()}
				</Button>
				{archiveBlockedByReceiving ? (
					<p className="text-[11px] leading-4 text-muted-foreground">
						{m.command_archive_receiving_hint()}
					</p>
				) : null}
			</section>
		</div>
	);
}
