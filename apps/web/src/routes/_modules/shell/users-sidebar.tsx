"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Search, Users } from "lucide-react";
import { useState } from "react";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { Avatar, InlineError, SidebarEmpty } from "./primitives";

export function UsersSidebar({
	onNavigate,
	selectedId,
}: {
	onNavigate: () => void;
	selectedId?: string;
}) {
	const [search, setSearch] = useState("");
	const users = useQuery(orpc.admin.users.list.queryOptions());
	const query = search.trim().toLowerCase();
	const filtered = (users.data ?? []).filter((user) => {
		if (query.length === 0) return true;
		return (
			user.displayName.toLowerCase().includes(query) ||
			user.preferredName?.toLowerCase().includes(query) ||
			user.identities.some(
				(identity) =>
					identity.externalId.toLowerCase().includes(query) ||
					identity.displayName?.toLowerCase().includes(query),
			)
		);
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b border-border px-3 pt-2.5 pb-2">
				<div className="flex items-baseline justify-between gap-2">
					<h1 className="text-[13px] font-semibold tracking-tight">{m.tab_users()}</h1>
					<span className="text-[10px] tabular-nums text-muted-foreground">{filtered.length}</span>
				</div>
				<Input
					aria-label={m.search_users()}
					placeholder={m.search_users()}
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
				aria-label={m.tab_users()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 pb-3"
			>
				{users.isPending ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">{m.loading()}</div>
				) : users.isError ? (
					<InlineError
						message={users.error.message}
						onRetry={() => void users.refetch()}
						retryLabel={m.retry()}
					/>
				) : filtered.length === 0 ? (
					<SidebarEmpty
						description={query.length > 0 ? m.users_no_results() : m.users_empty()}
						icon={Users}
						title={query.length > 0 ? m.users_no_results() : m.users_empty_title()}
					/>
				) : (
					filtered.map((user) => {
						const selected = user.id === selectedId;
						return (
							<Link
								key={user.id}
								to="/users/$userId"
								params={{ userId: user.id }}
								aria-current={selected ? "page" : undefined}
								onClick={onNavigate}
								className={cn(
									"flex min-h-10 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
									"hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
									selected && "bg-muted text-foreground",
								)}
							>
								<Avatar className="size-7 text-[10px] [&_svg]:size-3" name={user.displayName} />
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-1.5">
										<span className="truncate text-[12.5px] font-medium">{user.displayName}</span>
										{user.kind === "bot" ? (
											<span className="rounded-full bg-violet/10 px-1.5 py-0.5 text-[9px] text-violet">
												BOT
											</span>
										) : null}
									</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{user.identities[0]?.externalId ?? user.id}
									</span>
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
