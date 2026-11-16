"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { ChatTree } from "./chat-tree";

type ChatFilter = "active" | "archived" | "all";

export function ChatSidebar({ onNavigate }: { onNavigate: () => void }) {
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState<ChatFilter>("active");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 px-2.5 pt-2 pb-1.5">
				<Input
					aria-label={m.search_chats()}
					placeholder={m.search_chats()}
					value={search}
					onChange={setSearch}
					leftIcon={<Search />}
					classNames={{
						field: "h-8 rounded-md bg-background/70",
						input: "text-xs",
						leftIcon: "[&_svg]:size-3.5",
						root: "gap-0",
					}}
				/>
				<div className="flex items-center gap-0.5">
					{(["active", "archived", "all"] as const).map((value) => (
						<Button
							key={value}
							variant={filter === value ? "secondary" : "ghost"}
							size="xs"
							onClick={() => setFilter(value)}
							className={cn(
								"h-5 rounded-md px-1.5 text-[10px]",
								filter === value && "border-border-strong",
							)}
						>
							{value === "active"
								? m.active()
								: value === "archived"
									? m.filter_archived()
									: m.filter_all()}
						</Button>
					))}
				</div>
			</div>
			<ChatTree filter={filter} onNavigate={onNavigate} search={search} />
		</div>
	);
}
