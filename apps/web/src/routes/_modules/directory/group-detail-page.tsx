"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MessageCircle, ShieldAlert, UsersRound } from "lucide-react";
import { KpiStrip } from "@tsukaima/ui";
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
			<KpiStrip
				items={[
					{ label: m.group_members(), value: group.memberCount },
					{ label: m.group_sessions(), value: group.sessionCount },
				]}
			/>

			<DetailSection title={m.group_sessions()}>
				{group.sessions.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.error_generic()}</p>
				) : (
					<ul className="divide-y divide-border/60">
						{group.sessions.map((session) => (
							<li key={session.id}>
								<Link
									to="/chat/$sessionId"
									params={{ sessionId: session.id }}
									className="flex items-center gap-2 py-2 text-left outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
								>
									<MessageCircle className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-xs font-medium text-ink">
											{session.title ?? session.id}
										</span>
										<span className="block truncate font-mono text-[11px] text-muted-foreground">
											{session.status}
										</span>
									</span>
									<ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
								</Link>
							</li>
						))}
					</ul>
				)}
			</DetailSection>

			<DetailSection title={m.group_members()}>
				{group.members.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.group_no_members()}</p>
				) : (
					<ul className="divide-y divide-border/60">
						{group.members.map((member) => (
							<li key={member.userId} className="flex items-center gap-2 py-2">
								<Avatar className="size-6 text-[10px] [&_svg]:size-3" name={member.displayName} />
								<span className="min-w-0 flex-1 truncate text-xs text-ink">
									{member.displayName}
								</span>
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground">
									{member.platformRole ?? member.role}
								</span>
							</li>
						))}
					</ul>
				)}
			</DetailSection>

			<div className="flex items-start gap-2 border-s-2 border-border ps-3 text-[11px] leading-5 text-muted-foreground">
				<ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
				<span>{m.group_management_unavailable()}</span>
			</div>
		</DirectoryDetailPage>
	);
}
