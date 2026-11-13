"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MessageCircle, ShieldAlert, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { formatTimestamp } from "../lib/format";
import { Avatar, InlineError, SidebarEmpty } from "./primitives";

export function GroupsSidebar({ onNavigate, search }: { onNavigate: () => void; search: string }) {
	const navigate = useNavigate();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const groups = useQuery(orpc.admin.groups.list.queryOptions());
	const detail = useQuery(
		orpc.admin.groups.get.queryOptions({
			enabled: selectedId !== null,
			input: { groupId: selectedId ?? "" },
		}),
	);
	const query = search.trim().toLowerCase();
	const filtered = (groups.data ?? []).filter(
		(group) =>
			query.length === 0 ||
			group.title.toLowerCase().includes(query) ||
			group.platformConversationId?.toLowerCase().includes(query),
	);

	const openSession = async (sessionId: string) => {
		onNavigate();
		await navigate({ params: { sessionId }, to: "/chat/$sessionId" });
	};

	if (selectedId !== null) {
		const group = detail.data;
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex items-center gap-2 border-b border-border px-3 py-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setSelectedId(null)}
						className="h-8 gap-1 rounded-full px-2.5 text-xs"
					>
						<ChevronLeft className="size-3.5" />
						{m.back()}
					</Button>
					<span className="truncate text-xs font-medium text-muted-foreground">
						{m.group_detail()}
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{detail.isPending ? (
						<div className="p-4 text-xs text-muted-foreground">{m.loading()}</div>
					) : detail.isError ? (
						<InlineError
							message={detail.error.message}
							onRetry={() => void detail.refetch()}
							retryLabel={m.retry()}
						/>
					) : group === null || group === undefined ? (
						<InlineError message={m.error_generic()} retryLabel={m.retry()} />
					) : (
						<>
							<div className="flex items-center gap-3 px-4 py-4">
								<Avatar className="size-11" kind="group" name={group.title} />
								<div className="min-w-0">
									<h2 className="truncate text-sm font-semibold">{group.title}</h2>
									<p className="truncate text-xs text-muted-foreground">
										{group.platformConversationId ?? group.id}
									</p>
								</div>
							</div>
							<section className="border-b border-border px-4 py-4">
								<div className="grid grid-cols-2 gap-2 text-xs">
									<div className="rounded-xl bg-muted px-3 py-2">
										<div className="text-muted-foreground">{m.group_members()}</div>
										<div className="mt-0.5 text-base font-semibold">{group.memberCount}</div>
									</div>
									<div className="rounded-xl bg-muted px-3 py-2">
										<div className="text-muted-foreground">{m.group_sessions()}</div>
										<div className="mt-0.5 text-base font-semibold">{group.sessionCount}</div>
									</div>
								</div>
							</section>
							<section className="border-b border-border px-4 py-4">
								<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
									{m.group_sessions()}
								</h3>
								<div className="space-y-1.5">
									{group.sessions.map((session) => (
										<button
											key={session.id}
											type="button"
											onClick={() => void openSession(session.id)}
											className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
										>
											<MessageCircle className="size-4 text-muted-foreground" />
											<span className="min-w-0 flex-1 truncate text-xs font-medium">
												{session.title ?? session.id}
											</span>
											<ChevronRight className="size-3.5 text-muted-foreground" />
										</button>
									))}
								</div>
							</section>
							<section className="border-b border-border px-4 py-4">
								<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
									{m.group_members()}
								</h3>
								{group.members.length === 0 ? (
									<p className="text-xs text-muted-foreground">{m.group_no_members()}</p>
								) : (
									<div className="space-y-1">
										{group.members.map((member) => (
											<div
												key={member.userId}
												className="flex items-center gap-2 rounded-lg px-1 py-1.5"
											>
												<Avatar className="size-7" name={member.displayName} />
												<span className="min-w-0 flex-1 truncate text-xs">
													{member.displayName}
												</span>
												<span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
													{member.platformRole ?? member.role}
												</span>
											</div>
										))}
									</div>
								)}
							</section>
							<div className="flex items-start gap-2 px-4 py-4 text-[11px] leading-5 text-muted-foreground">
								<ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
								<span>{m.group_management_unavailable()}</span>
							</div>
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			role="list"
			aria-label={m.tab_groups()}
			className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
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
				filtered.map((group) => (
					<button
						key={group.id}
						type="button"
						onClick={() => setSelectedId(group.id)}
						className="flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					>
						<Avatar kind="group" name={group.title} />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm font-medium">{group.title}</span>
							<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
								{group.platformConversationId ?? group.id} · {group.memberCount} {m.group_members()}
							</span>
						</span>
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{formatTimestamp(group.updatedAt)}
						</span>
						<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
					</button>
				))
			)}
		</div>
	);
}
