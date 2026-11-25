"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MessageCircle, UserRoundX, Users } from "lucide-react";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";
import { Avatar, InlineError } from "../shell/primitives";
import {
	DetailField,
	DetailSection,
	DirectoryDetailPage,
	DirectoryEmptyState,
} from "./directory-page";

export function UserDetailPage({ userId }: { userId: string }) {
	const detail = useQuery(orpc.admin.users.get.queryOptions({ input: { userId } }));

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
	const user = detail.data;
	if (user === null || user === undefined) {
		return (
			<DirectoryEmptyState
				description={m.users_select_description()}
				icon={UserRoundX}
				title={m.user_not_found()}
			/>
		);
	}

	return (
		<DirectoryDetailPage
			leading={<Avatar className="size-10 text-sm" name={user.displayName} />}
			subtitle={user.preferredName ?? user.identities[0]?.externalId ?? user.id}
			title={user.displayName}
			trailing={
				user.kind === "bot" ? (
					<span className="shrink-0 font-mono text-[10px] tracking-[0.14em] text-accent-ink uppercase">
						BOT
					</span>
				) : undefined
			}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<DetailSection title={m.user_identities()}>
					{user.identities.length === 0 ? (
						<p className="text-xs text-muted-foreground">-</p>
					) : (
						<ul className="divide-y divide-border/60">
							{user.identities.map((identity) => (
								<li key={identity.id} className="py-2 text-[11px] first:pt-0 last:pb-0">
									<div className="text-ink">{identity.displayName ?? identity.externalId}</div>
									<div className="mt-0.5 font-mono break-all text-muted-foreground">
										{identity.platform} · {identity.externalId}
									</div>
								</li>
							))}
						</ul>
					)}
				</DetailSection>
				<DetailSection title={m.user_trust()}>
					<DetailField label={m.user_trust()} value={user.trustLevel} />
					{user.notes ? <DetailField label={m.user_notes()} value={user.notes} /> : null}
					<DetailField label="ID" mono value={user.id} />
				</DetailSection>
			</div>

			<DetailSection title={m.user_aliases()}>
				{user.aliases.length === 0 ? (
					<span className="text-xs text-muted-foreground">-</span>
				) : (
					<div className="flex flex-wrap gap-1.5">
						{user.aliases.map((alias) => (
							<span
								key={alias}
								className="border-b border-border pb-0.5 font-mono text-[11px] text-ink"
							>
								{alias}
							</span>
						))}
					</div>
				)}
			</DetailSection>

			<DetailSection title={m.user_chats()}>
				{user.chats.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.user_no_chat()}</p>
				) : (
					<ul className="divide-y divide-border/60">
						{user.chats.map((chat) => {
							const session =
								chat.sessions.find(
									(entry) => entry.isReceiving === 1 && entry.status === "active",
								) ??
								chat.sessions.find((entry) => entry.status === "active") ??
								chat.sessions[0];
							const content = (
								<>
									<MessageCircle className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-xs font-medium text-ink">
											{chat.title}
										</span>
										<span className="block truncate font-mono text-[11px] text-muted-foreground">
											{session?.title ?? m.chat_object_not_found()}
										</span>
									</span>
									<ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
								</>
							);
							return session === undefined ? (
								<li key={chat.id} className="flex items-center gap-2 py-2 opacity-50">
									{content}
								</li>
							) : (
								<li key={chat.id}>
									<Link
										to="/chat/$sessionId"
										params={{ sessionId: session.id }}
										className="flex items-center gap-2 py-2 text-left outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-ring"
									>
										{content}
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</DetailSection>

			<DetailSection title={m.user_groups()}>
				{user.groups.length === 0 ? (
					<p className="text-xs text-muted-foreground">{m.user_no_groups()}</p>
				) : (
					<ul className="divide-y divide-border/60">
						{user.groups.map((group) => (
							<li key={group.id} className="flex items-center gap-1.5 py-1.5 text-[11px] text-ink">
								<Users className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
								<span className="truncate">{group.title}</span>
							</li>
						))}
					</ul>
				)}
			</DetailSection>
		</DirectoryDetailPage>
	);
}
