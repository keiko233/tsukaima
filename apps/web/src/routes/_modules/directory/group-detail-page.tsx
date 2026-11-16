"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MessageCircle, ShieldAlert, UsersRound } from "lucide-react";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { Avatar, InlineError } from "../shell/primitives";
import { DetailSection, DirectoryDetailPage, DirectoryEmptyState } from "./directory-page";

export function GroupDetailPage({ groupId }: { groupId: string }) {
	const detail = useQuery(orpc.admin.groups.get.queryOptions({ input: { groupId } }));

	if (detail.isPending) {
		return (
			<div className="grid h-full place-items-center text-[12px] text-muted-foreground">
				{m.loading()}
			</div>
		);
	}
	if (detail.isError) {
		return (
			<div className="grid h-full place-items-center">
				<InlineError
					message={detail.error.message}
					onRetry={() => void detail.refetch()}
					retryLabel={m.retry()}
				/>
			</div>
		);
	}
	const group = detail.data;
	if (group === null || group === undefined) {
		return (
			<DirectoryEmptyState
				description={m.groups_select_description()}
				icon={UsersRound}
				title={m.group_not_found()}
			/>
		);
	}

	return (
		<DirectoryDetailPage
			leading={<Avatar className="size-10 text-sm" kind="group" name={group.title} />}
			subtitle={group.platformConversationId ?? group.id}
			title={group.title}
		>
			<div className="grid grid-cols-2 gap-3">
				<div className="rounded-xl border border-border bg-card/40 px-3.5 py-3">
					<div className="text-[10px] tracking-wider text-muted-foreground uppercase">
						{m.group_members()}
					</div>
					<div className="mt-1 text-xl font-semibold tabular-nums">{group.memberCount}</div>
				</div>
				<div className="rounded-xl border border-border bg-card/40 px-3.5 py-3">
					<div className="text-[10px] tracking-wider text-muted-foreground uppercase">
						{m.group_sessions()}
					</div>
					<div className="mt-1 text-xl font-semibold tabular-nums">{group.sessionCount}</div>
				</div>
			</div>

			<DetailSection title={m.group_sessions()}>
				{group.sessions.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.error_generic()}</p>
				) : (
					<div className="grid gap-1.5 sm:grid-cols-2">
						{group.sessions.map((session) => (
							<Link
								key={session.id}
								to="/chat/$sessionId"
								params={{ sessionId: session.id }}
								className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							>
								<MessageCircle className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs font-medium">
										{session.title ?? session.id}
									</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{session.status}
									</span>
								</span>
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							</Link>
						))}
					</div>
				)}
			</DetailSection>

			<DetailSection title={m.group_members()}>
				{group.members.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.group_no_members()}</p>
				) : (
					<div className="grid gap-1 sm:grid-cols-2">
						{group.members.map((member) => (
							<div key={member.userId} className="flex items-center gap-2 rounded-lg px-1 py-1">
								<Avatar className="size-6 text-[10px] [&_svg]:size-3" name={member.displayName} />
								<span className="min-w-0 flex-1 truncate text-xs">{member.displayName}</span>
								<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
									{member.platformRole ?? member.role}
								</span>
							</div>
						))}
					</div>
				)}
			</DetailSection>

			<div className="flex items-start gap-2 rounded-xl border border-border px-3.5 py-3 text-[10.5px] leading-4 text-muted-foreground">
				<ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
				<span>{m.group_management_unavailable()}</span>
			</div>
		</DirectoryDetailPage>
	);
}
