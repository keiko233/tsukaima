"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Inbox, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { InlineError, SidebarEmpty } from "./primitives";
import {
	requestIcon,
	requestKindLabel,
	requestStatusClass,
	requestStatusLabel,
} from "./request-meta";

export function RequestsSidebar({
	onNavigate,
	selectedId,
}: {
	onNavigate: () => void;
	selectedId?: string;
}) {
	const [view, setView] = useState<"pending" | "processed">("pending");
	const [search, setSearch] = useState("");
	const requests = useQuery(orpc.admin.requests.list.queryOptions({ input: { status: "all" } }));
	const query = search.trim().toLowerCase();
	const pendingCount = requests.data?.filter((request) => request.status === "pending").length ?? 0;
	const filtered = (requests.data ?? []).filter((request) => {
		const inView = view === "pending" ? request.status === "pending" : request.status !== "pending";
		if (!inView) return false;
		if (query.length === 0) return true;
		return (
			request.requesterExternalId.toLowerCase().includes(query) ||
			request.requesterDisplayName?.toLowerCase().includes(query) ||
			request.comment?.toLowerCase().includes(query) ||
			request.groupExternalId?.toLowerCase().includes(query)
		);
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b border-border px-3 pt-2.5 pb-2">
				<div className="flex items-baseline justify-between gap-2">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[13px] font-semibold tracking-tight">{m.tab_requests()}</h1>
						{pendingCount > 0 ? (
							<span className="grid min-w-3.5 place-items-center rounded-full bg-primary px-1 text-[9px] leading-3.5 text-primary-foreground">
								{pendingCount > 99 ? "99+" : pendingCount}
							</span>
						) : null}
					</div>
					<span className="text-[10px] tabular-nums text-muted-foreground">{filtered.length}</span>
				</div>
				<Input
					aria-label={m.search_requests()}
					placeholder={m.search_requests()}
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
				<div className="mt-1.5 flex gap-0.5">
					<Button
						size="sm"
						variant={view === "pending" ? "secondary" : "ghost"}
						onClick={() => setView("pending")}
						className="h-6 rounded-md px-2 text-[11px]"
					>
						{m.pending_requests()}
					</Button>
					<Button
						size="sm"
						variant={view === "processed" ? "secondary" : "ghost"}
						onClick={() => setView("processed")}
						className="h-6 rounded-md px-2 text-[11px]"
					>
						{m.processed_requests()}
					</Button>
				</div>
			</div>
			<div
				role="list"
				aria-label={m.tab_requests()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 pb-3"
			>
				{requests.isPending ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">{m.loading()}</div>
				) : requests.isError ? (
					<InlineError
						message={requests.error.message}
						onRetry={() => void requests.refetch()}
						retryLabel={m.retry()}
					/>
				) : filtered.length === 0 ? (
					<SidebarEmpty
						description={m.requests_empty()}
						icon={Inbox}
						title={m.requests_empty_title()}
					/>
				) : (
					filtered.map((request) => {
						const Icon = requestIcon(request.kind);
						const selected = request.id === selectedId;
						return (
							<Link
								key={request.id}
								to="/requests/$requestId"
								params={{ requestId: request.id }}
								aria-current={selected ? "page" : undefined}
								onClick={onNavigate}
								className={cn(
									"flex min-h-11 w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors",
									"hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
									selected && "bg-muted text-foreground",
								)}
							>
								<span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
									<Icon className="size-3.5" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2">
										<span className="truncate text-[12.5px] font-medium">
											{request.requesterDisplayName ?? request.requesterExternalId}
										</span>
										<span
											className={cn(
												"ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px]",
												requestStatusClass(request.status),
											)}
										>
											{requestStatusLabel(request.status)}
										</span>
									</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{requestKindLabel(request.kind)}
										{request.groupExternalId ? ` · ${request.groupExternalId}` : ""}
									</span>
									{request.comment ? (
										<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
											{request.comment}
										</span>
									) : null}
								</span>
								<ChevronRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
							</Link>
						);
					})
				)}
			</div>
		</div>
	);
}
