"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MessageCircle, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import { orpc } from "@/lib/api";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { InlineError, SidebarEmpty, Avatar } from "./primitives";

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
	return (
		<section className="border-b border-border px-4 py-4 last:border-b-0">
			<h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
				{title}
			</h3>
			{children}
		</section>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-3 py-1 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 text-right text-foreground">{value}</span>
		</div>
	);
}

export function UsersSidebar({ onNavigate, search }: { onNavigate: () => void; search: string }) {
	const navigate = useNavigate();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const users = useQuery(orpc.admin.users.list.queryOptions({ refetchInterval: 30_000 }));
	const detail = useQuery(
		orpc.admin.users.get.queryOptions({
			enabled: selectedId !== null,
			input: { userId: selectedId ?? "" },
		}),
	);
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

	const openSession = async (sessionId: string) => {
		onNavigate();
		await navigate({ params: { sessionId }, to: "/chat/$sessionId" });
	};

	if (selectedId !== null) {
		const user = detail.data;
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
						{m.user_detail()}
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
					) : user === null || user === undefined ? (
						<InlineError message={m.error_generic()} retryLabel={m.retry()} />
					) : (
						<>
							<div className="flex items-center gap-3 px-4 py-4">
								<Avatar className="size-11" name={user.displayName} />
								<div className="min-w-0">
									<h2 className="truncate text-sm font-semibold">{user.displayName}</h2>
									<p className="truncate text-xs text-muted-foreground">
										{user.preferredName ?? user.identities[0]?.externalId ?? user.id}
									</p>
								</div>
							</div>
							<DetailSection title={m.user_identities()}>
								{user.identities.length === 0 ? (
									<p className="text-xs text-muted-foreground">{m.error_generic()}</p>
								) : (
									user.identities.map((identity) => (
										<div
											key={identity.id}
											className="rounded-xl border border-border px-3 py-2 text-xs"
										>
											<div className="font-medium text-foreground">
												{identity.displayName ?? identity.externalId}
											</div>
											<div className="mt-0.5 break-all text-muted-foreground">
												{identity.platform} · {identity.externalId}
											</div>
										</div>
									))
								)}
							</DetailSection>
							<DetailSection title={m.user_aliases()}>
								{user.aliases.length === 0 ? (
									<span className="text-xs text-muted-foreground">-</span>
								) : (
									<div className="flex flex-wrap gap-1.5">
										{user.aliases.map((alias) => (
											<span
												key={alias}
												className="rounded-full bg-muted px-2 py-1 text-[11px] text-foreground"
											>
												{alias}
											</span>
										))}
									</div>
								)}
							</DetailSection>
							<DetailSection title={m.user_trust()}>
								<Field label={m.user_trust()} value={user.trustLevel} />
								{user.notes ? <Field label={m.user_notes()} value={user.notes} /> : null}
							</DetailSection>
							<DetailSection title={m.user_chats()}>
								{user.chats.length === 0 ? (
									<p className="text-xs text-muted-foreground">{m.user_no_chat()}</p>
								) : (
									<div className="space-y-2">
										{user.chats.map((chat) => {
											const session =
												chat.sessions.find(
													(entry) => entry.isReceiving === 1 && entry.status === "active",
												) ??
												chat.sessions.find((entry) => entry.status === "active") ??
												chat.sessions[0];
											return (
												<button
													key={chat.id}
													type="button"
													disabled={session === undefined}
													onClick={() => {
														if (session !== undefined) void openSession(session.id);
													}}
													className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
												>
													<MessageCircle className="size-4 text-muted-foreground" />
													<span className="min-w-0 flex-1">
														<span className="block truncate text-xs font-medium">{chat.title}</span>
														<span className="block text-[11px] text-muted-foreground">
															{session?.title ?? m.chat_object_not_found()}
														</span>
													</span>
													<ChevronRight className="size-3.5 text-muted-foreground" />
												</button>
											);
										})}
									</div>
								)}
							</DetailSection>
							<DetailSection title={m.user_groups()}>
								{user.groups.length === 0 ? (
									<p className="text-xs text-muted-foreground">{m.user_no_groups()}</p>
								) : (
									<div className="space-y-1">
										{user.groups.map((group) => (
											<div
												key={group.id}
												className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-xs"
											>
												<Users className="size-3.5 text-muted-foreground" />
												<span className="truncate">{group.title}</span>
											</div>
										))}
									</div>
								)}
							</DetailSection>
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			role="list"
			aria-label={m.tab_users()}
			className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
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
				filtered.map((user) => (
					<button
						key={user.id}
						type="button"
						onClick={() => setSelectedId(user.id)}
						className={cn(
							"flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors",
							"hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
						)}
					>
						<Avatar name={user.displayName} />
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-1.5">
								<span className="truncate text-sm font-medium">{user.displayName}</span>
								{user.kind === "bot" ? (
									<span className="rounded-full bg-violet/10 px-1.5 py-0.5 text-[9px] text-violet">
										BOT
									</span>
								) : null}
							</span>
							<span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
								{user.identities[0]?.externalId ?? user.id}
							</span>
						</span>
						<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
					</button>
				))
			)}
		</div>
	);
}
