"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { ChatTree } from "./chat-tree";

type ChatFilter = "active" | "archived" | "all";

const FILTERS: readonly ChatFilter[] = ["active", "archived", "all"];

function filterLabel(filter: ChatFilter): string {
	if (filter === "active") return m.active();
	if (filter === "archived") return m.filter_archived();
	return m.filter_all();
}

export function ChatSidebar({ onNavigate }: { onNavigate: () => void }) {
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<ChatFilter>("active");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-3 pt-3 pb-1">
				<div className="flex items-center gap-1.5 border-b border-border pb-1.5 transition-colors focus-within:border-[var(--accent-ink)]">
					<Search className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
					<input
						type="search"
						aria-label={m.search_chats()}
						placeholder={m.search_chats()}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-faint"
					/>
				</div>
				<div className="mt-1.5 flex items-center gap-3">
					{FILTERS.map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={filter === value}
							onClick={() => setFilter(value)}
							className={cn(
								"-mb-px border-b-2 pb-1 text-[11px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
								filter === value
									? "border-[var(--accent-ink)] text-ink"
									: "border-transparent text-muted-foreground hover:text-ink",
							)}
						>
							{filterLabel(value)}
						</button>
					))}
				</div>
			</div>
			<ChatTree filter={filter} onNavigate={onNavigate} search={search} />
		</div>
	);
}
