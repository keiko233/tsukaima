"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Search, Users } from "lucide-react";
import { useState } from "react";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { formatTimestamp } from "../lib/format";
import { Avatar, InlineError, SidebarEmpty } from "./primitives";

export function GroupsSidebar({
	onNavigate,
	selectedId,
}: {
	onNavigate: () => void;
	selectedId?: string;
}) {
	const [search, setSearch] = useState("");
	const groups = useQuery(orpc.admin.groups.list.queryOptions());
	const query = search.trim().toLowerCase();
	const filtered = (groups.data ?? []).filter(
		(group) =>
			query.length === 0 ||
			group.title.toLowerCase().includes(query) ||
			group.platformConversationId?.toLowerCase().includes(query),
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b border-border px-3 pt-2.5 pb-2">
				<div className="flex items-baseline justify-between gap-2">
					<h1 className="text-[13px] font-semibold tracking-tight">{m.tab_groups()}</h1>
					<span className="text-[10px] tabular-nums text-muted-foreground">{filtered.length}</span>
				</div>
				<Input
					aria-label={m.search_groups()}
					placeholder={m.search_groups()}
					value={search}
					onChange={setSearch}
					leftIcon={<Search />}
					classNames={{
						field: "mt-2 h-8 rounded-md bg-background/70",
						input: "text-xs",
						leftIcon: "[&_svg]:size-3.5",
						root: "gap-0",
					}}
				/>
			</div>
			<div
				role="list"
				aria-label={m.tab_groups()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 pb-3"
			>
				{groups.isPending ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">{m.loading()}</div>
				) : groups.isError ? (
					<InlineError
						message={groups.error.message}
						onRetry={() => void groups.refetch()}
						retryLabel={m.retry()}
					/>
				) : filtered.length === 0 ? (
					<SidebarEmpty
						description={query.length > 0 ? m.groups_no_results() : m.groups_empty()}
						icon={Users}
						title={query.length > 0 ? m.groups_no_results() : m.groups_empty_title()}
					/>
				) : (
					filtered.map((group) => {
						const selected = group.id === selectedId;
						return (
							<Link
								key={group.id}
								to="/groups/$groupId"
								params={{ groupId: group.id }}
								aria-current={selected ? "page" : undefined}
								onClick={onNavigate}
								className={cn(
									"flex min-h-10 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
									"hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
									selected && "bg-muted text-foreground",
								)}
							>
								<Avatar className="size-7 [&_svg]:size-3" kind="group" name={group.title} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] font-medium">{group.title}</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{group.platformConversationId ?? group.id} · {group.memberCount}{" "}
										{m.group_members()}
									</span>
								</span>
								<span className="shrink-0 text-[10px] text-muted-foreground">
									{formatTimestamp(group.updatedAt)}
								</span>
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							</Link>
						);
					})
				)}
			</div>
		</div>
	);
}
