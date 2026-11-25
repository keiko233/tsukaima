"use client";

import { ChevronRight, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import type { SessionContextStats } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { InlineError } from "../../_modules/shell/primitives";

export function formatCompactTokens(tokens: number): string {
	const safe = Math.max(0, Math.round(tokens));
	if (safe >= 1_000_000) {
		return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
	}
	if (safe >= 1_000) {
		return `${(safe / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
	}
	return String(safe);
}

export function formatCategoryPercent(tokens: number, contextWindow: number): string {
	if (contextWindow <= 0) return "—";
	return `${((Math.max(0, tokens) / contextWindow) * 100).toFixed(1)}%`;
}

export function formatHeadlinePercent(usedPercent: number, contextWindow: number): string {
	if (contextWindow <= 0) return "—";
	if (usedPercent > 0 && usedPercent < 1) {
		return `${usedPercent.toFixed(1)}%`;
	}
	return `${Math.round(usedPercent)}%`;
}

function localizedSectionLabel(key: string, fallback: string): string {
	if (key === "tsukaima-system") return m.context_section_system();
	switch (key) {
		case "tsukaima-persona":
			return m.context_section_persona();
		case "tsukaima-policy":
			return m.context_section_policy();
		case "tsukaima-memory":
		case "turn-context/memories":
			return m.context_section_memories();
		case "instructions":
			return m.context_section_instructions();
		case "system":
			return m.context_section_system();
		default:
			return key.startsWith("turn-context/")
				? m.context_section_turn_context({ name: key.slice("turn-context/".length) })
				: fallback;
	}
}

function memoryTierLabel(tier: "recent" | "warm" | "long-term"): string {
	switch (tier) {
		case "warm":
			return m.context_memories_warm();
		case "long-term":
			return m.context_memories_long_term();
		case "recent":
			return m.context_memories_recent();
	}
}

interface BreakdownRowProps {
	colorClass: string;
	dotted?: boolean;
	label: string;
	percentText: string;
	title?: string;
	tokens: number;
}

function BreakdownRow({
	colorClass,
	dotted = false,
	label,
	percentText,
	title,
	tokens,
}: BreakdownRowProps) {
	return (
		<div className="grid grid-cols-[auto_1fr_auto_2.6rem] items-center gap-2 border-b border-border/40 py-1 text-[11px] leading-4 last:border-b-0">
			<span className={cn("size-2 shrink-0", colorClass)} aria-hidden="true" />
			<span
				title={title}
				className={cn(
					"min-w-0 truncate text-ink",
					dotted && "underline decoration-muted-foreground/45 decoration-dotted underline-offset-4",
				)}
			>
				{label}
			</span>
			<span className="font-mono tabular-nums text-right text-ink">
				{formatCompactTokens(tokens)}
			</span>
			<span className="font-mono tabular-nums text-right text-muted-foreground">{percentText}</span>
		</div>
	);
}

interface AccordionGroupProps {
	children: React.ReactNode;
	count: number;
	label: string;
	open: boolean;
	onToggle: () => void;
}

function AccordionGroup({ children, count, label, open, onToggle }: AccordionGroupProps) {
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				className="flex w-full items-center gap-1.5 border-b border-border/40 py-1.5 text-left text-[11px] text-muted-foreground transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronRight
					className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
				/>
				<span className="min-w-0 flex-1 truncate text-ink">{label}</span>
				<span className="font-mono tabular-nums text-muted-foreground">{count}</span>
			</button>
			{open ? <div className="mt-1 space-y-1.5 pl-5 pr-1 pb-2">{children}</div> : null}
		</div>
	);
}

export interface ContextPanelContentProps {
	embedded?: boolean;
	errorMessage?: string;
	isError?: boolean;
	isFetching?: boolean;
	isPending?: boolean;
	onClose?: () => void;
	onRefresh?: () => void;
	onRetry?: () => void;
	stats: SessionContextStats | null | undefined;
}

export function ContextPanelContent({
	embedded = false,
	errorMessage,
	isError = false,
	isFetching = false,
	isPending = false,
	onClose,
	onRefresh,
	onRetry,
	stats,
}: ContextPanelContentProps) {
	const [openSection, setOpenSection] = useState<"memories" | "tools" | "sections" | null>(null);
	const toggle = (key: "memories" | "tools" | "sections") =>
		setOpenSection((current) => (current === key ? null : key));

	const sortedTools =
		stats === null || stats === undefined
			? []
			: [...stats.tools].toSorted((left, right) => {
					if (left.deferred !== right.deferred) return left.deferred ? 1 : -1;
					return right.tokens - left.tokens;
				});

	const segments =
		stats === null || stats === undefined || stats.contextWindow <= 0
			? []
			: [
					{
						colorClass: "bg-chart-messages",
						key: "messages",
						tokens: stats.categories.messagesTokens,
					},
					{
						colorClass: "bg-chart-tools",
						key: "tools",
						tokens: stats.categories.toolsTokens,
					},
					{
						colorClass: "bg-chart-persona",
						key: "persona",
						tokens: stats.categories.personaTokens,
					},
					{
						colorClass: "bg-chart-policy",
						key: "policy",
						tokens: stats.categories.policyTokens,
					},
					{
						colorClass: "bg-chart-memories",
						key: "memories",
						tokens: stats.categories.memoriesTokens,
					},
					{
						colorClass: "bg-chart-turn",
						key: "turnContext",
						tokens: stats.categories.turnContextTokens,
					},
					{
						colorClass: "bg-chart-other",
						key: "otherSystem",
						tokens: stats.categories.otherSystemTokens,
					},
					{
						colorClass: "bg-chart-buffer",
						key: "buffer",
						tokens: stats.autocompact.bufferTokens,
					},
				].filter((segment) => segment.tokens > 0);

	const refreshButton = onRefresh ? (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			onClick={onRefresh}
			aria-label={m.context_refresh()}
			title={m.context_refresh()}
			className="size-7 rounded-md text-muted-foreground hover:text-foreground"
		>
			<RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
		</Button>
	) : null;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{embedded ? null : (
				<div className="flex h-9 items-center justify-between gap-2 border-b border-border px-3">
					<h2 className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
						{m.context_title()}
					</h2>
					<div className="flex items-center gap-0.5">
						{refreshButton}
						{onClose ? (
							<Button
								type="button"
								variant="ghost"
								size="iconSm"
								onClick={onClose}
								aria-label={m.context_close()}
								title={m.context_close()}
								className="size-6 rounded-md text-muted-foreground hover:text-foreground"
							>
								<X className="size-3" />
							</Button>
						) : null}
					</div>
				</div>
			)}

			<div className={cn("min-h-0 flex-1 overflow-y-auto px-3 pb-3", embedded && "pt-2.5")}>
				{isPending ? (
					<div className="py-8 text-center text-xs text-muted-foreground">{m.loading()}</div>
				) : isError ? (
					<div className="py-6">
						<InlineError
							message={errorMessage ?? m.error_generic()}
							onRetry={onRetry ?? (() => {})}
							retryLabel={m.retry()}
						/>
					</div>
				) : stats === null || stats === undefined ? (
					<div className="py-8 text-center text-xs text-muted-foreground">{m.context_empty()}</div>
				) : (
					<div>
						<div className="flex items-center justify-between gap-2">
							<span className="font-serif text-[15px] tabular-nums text-ink">
								{m.context_used_headline({
									percent: formatHeadlinePercent(stats.usedPercent, stats.contextWindow),
								})}
							</span>
							<div className="flex items-center gap-1">
								<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
									{formatCompactTokens(stats.usedTokens)} /{" "}
									{stats.contextWindow > 0 ? formatCompactTokens(stats.contextWindow) : "—"}
								</span>
								{embedded ? refreshButton : null}
							</div>
						</div>

						<div
							className="mt-2 flex h-1.5 w-full overflow-hidden bg-chart-free"
							role="progressbar"
							aria-valuenow={Math.round(stats.usedPercent)}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							{segments.map((segment) => {
								const widthPercent = Math.min(100, (segment.tokens / stats.contextWindow) * 100);
								return (
									<div
										key={segment.key}
										className={cn(
											"h-full min-w-[2px] shrink-0 border-e border-background/60 last:border-e-0",
											segment.colorClass,
										)}
										style={{ width: `${widthPercent}%` }}
									/>
								);
							})}
						</div>

						<div className="mt-3 border-t border-border/60">
							<BreakdownRow
								colorClass="bg-chart-messages"
								label={m.context_category_messages()}
								tokens={stats.categories.messagesTokens}
								percentText={formatCategoryPercent(
									stats.categories.messagesTokens,
									stats.contextWindow,
								)}
							/>
							<BreakdownRow
								colorClass="bg-chart-tools"
								label={m.context_category_tools()}
								tokens={stats.categories.toolsTokens}
								percentText={formatCategoryPercent(
									stats.categories.toolsTokens,
									stats.contextWindow,
								)}
							/>
							<BreakdownRow
								colorClass="bg-chart-persona"
								label={m.context_category_persona()}
								title={stats.personaName ?? undefined}
								tokens={stats.categories.personaTokens}
								percentText={formatCategoryPercent(
									stats.categories.personaTokens,
									stats.contextWindow,
								)}
							/>
							<BreakdownRow
								colorClass="bg-chart-policy"
								dotted
								label={m.context_category_policy()}
								tokens={stats.categories.policyTokens}
								percentText={formatCategoryPercent(
									stats.categories.policyTokens,
									stats.contextWindow,
								)}
							/>
							<BreakdownRow
								colorClass="bg-chart-memories"
								dotted
								label={m.context_category_memories()}
								tokens={stats.categories.memoriesTokens}
								percentText={formatCategoryPercent(
									stats.categories.memoriesTokens,
									stats.contextWindow,
								)}
							/>
							{stats.categories.turnContextTokens > 0 ? (
								<BreakdownRow
									colorClass="bg-chart-turn"
									dotted
									label={m.context_category_turn_context()}
									tokens={stats.categories.turnContextTokens}
									percentText={formatCategoryPercent(
										stats.categories.turnContextTokens,
										stats.contextWindow,
									)}
								/>
							) : null}
							{stats.categories.otherSystemTokens > 0 ? (
								<BreakdownRow
									colorClass="bg-chart-other"
									dotted
									label={m.context_category_other_system()}
									tokens={stats.categories.otherSystemTokens}
									percentText={formatCategoryPercent(
										stats.categories.otherSystemTokens,
										stats.contextWindow,
									)}
								/>
							) : null}
						</div>

						<div className="border-t border-border/60">
							{stats.autocompact.enabled || stats.autocompact.bufferTokens > 0 ? (
								<BreakdownRow
									colorClass="bg-chart-buffer"
									label={m.context_autocompact_buffer()}
									tokens={stats.autocompact.bufferTokens}
									percentText={formatCategoryPercent(
										stats.autocompact.bufferTokens,
										stats.contextWindow,
									)}
								/>
							) : null}
							{stats.autocompact.enabled && stats.contextWindow > 0 ? (
								<p className="py-1 pl-4 text-[11px] leading-4 text-muted-foreground">
									{m.context_autocompact_threshold({
										tokens: formatCompactTokens(
											Math.max(0, stats.contextWindow - stats.autocompact.bufferTokens),
										),
									})}
								</p>
							) : null}
							<BreakdownRow
								colorClass="bg-chart-free"
								label={m.context_free_space()}
								tokens={stats.freeSpaceTokens}
								percentText={formatCategoryPercent(stats.freeSpaceTokens, stats.contextWindow)}
							/>
							{stats.deferredToolsTokens > 0 ? (
								<BreakdownRow
									colorClass="bg-chart-deferred"
									label={m.context_category_tools_deferred()}
									tokens={stats.deferredToolsTokens}
									percentText="—"
								/>
							) : null}
						</div>

						<div className="mt-3 border-t border-border/60">
							<AccordionGroup
								count={stats.memories.items.length}
								label={m.context_group_memories()}
								open={openSection === "memories"}
								onToggle={() => toggle("memories")}
							>
								{!stats.memories.enabled ? (
									<p className="text-[11px] text-muted-foreground">
										{m.context_memories_disabled()}
									</p>
								) : stats.memories.items.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">{m.context_memories_empty()}</p>
								) : (
									<>
										{stats.memories.warmTopics.length > 0 ? (
											<p className="text-[11px] text-muted-foreground">
												{m.context_memories_warm_topics({
													topics: stats.memories.warmTopics.join(", "),
												})}
											</p>
										) : null}
										{stats.memories.items.map((item, index) => (
											<div
												key={item.id ?? `${item.tier}-${index}`}
												className="border-s-2 border-border py-0.5 ps-2 text-[11px]"
											>
												<div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
													<span className="font-medium text-ink">{memoryTierLabel(item.tier)}</span>
													<span aria-hidden="true">·</span>
													<span className="truncate">
														{item.scope}/{item.kind}
													</span>
												</div>
												<p className="mt-0.5 line-clamp-2 text-ink">{item.summary}</p>
											</div>
										))}
									</>
								)}
							</AccordionGroup>

							<AccordionGroup
								count={stats.tools.length}
								label={m.context_group_tools()}
								open={openSection === "tools"}
								onToggle={() => toggle("tools")}
							>
								{sortedTools.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">{m.context_tools_empty()}</p>
								) : (
									sortedTools.map((tool) => (
										<div
											key={tool.name}
											title={tool.description}
											className="flex items-center justify-between gap-2 text-[11px]"
										>
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate font-mono text-[11px] text-ink">{tool.name}</span>
												{tool.deferred ? (
													<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
														· {m.context_tool_deferred_badge()}
													</span>
												) : null}
											</span>
											<span className="shrink-0 font-mono tabular-nums text-muted-foreground">
												{formatCompactTokens(tool.tokens)}
											</span>
										</div>
									))
								)}
							</AccordionGroup>

							<AccordionGroup
								count={stats.sections.length}
								label={m.context_group_sections()}
								open={openSection === "sections"}
								onToggle={() => toggle("sections")}
							>
								{stats.sections.map((section) => (
									<div key={section.key} className="space-y-1 text-[11px]">
										<div className="flex items-center justify-between gap-2">
											<span className="truncate text-ink">
												{localizedSectionLabel(section.key, section.label)}
											</span>
											<span className="shrink-0 font-mono tabular-nums text-muted-foreground">
												{formatCompactTokens(section.tokens)}
											</span>
										</div>
										{section.text && (
											<pre className="max-h-64 overflow-auto rounded-sm border border-line bg-muted/50 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
												{section.text}
											</pre>
										)}
									</div>
								))}
							</AccordionGroup>
						</div>

						<div className="mt-3 space-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
							<div
								className="truncate font-mono text-[11px]"
								title={`${stats.model.providerId}/${stats.model.modelId}`}
							>
								{stats.model.providerId}/{stats.model.modelId}
							</div>
							<div className="flex flex-wrap items-center gap-1.5">
								<span>
									{stats.tokenSource === "usage"
										? m.context_source_usage()
										: m.context_source_estimated()}
								</span>
								<span aria-hidden="true">·</span>
								<span>{m.context_message_count({ count: String(stats.messageCount) })}</span>
								{stats.compacted ? (
									<>
										<span aria-hidden="true">·</span>
										<span className="font-mono text-[11px] text-accent-ink">
											{m.context_compacted_badge()}
										</span>
									</>
								) : null}
								{stats.contextWindow <= 0 ? (
									<>
										<span aria-hidden="true">·</span>
										<span>{m.context_window_unknown()}</span>
									</>
								) : null}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
