"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
	Archive,
	CalendarClock,
	ChevronRight,
	CircleDot,
	ExternalLink,
	MessageCirclePlus,
	MoreHorizontal,
	Pencil,
	Plus,
	RotateCcw,
	MessageSquare,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import {
	MorphPopover,
	MorphPopoverContent,
	MorphPopoverTrigger,
} from "@tsukaima/ui/components/motion/popover-morph";
import { orpc, type ChatSummary, type SessionSummary } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { formatTimestamp, previewText } from "../lib/format";
import { Modal, ModalActions } from "../ui/modal";
import { Avatar, InlineError, SidebarEmpty } from "./primitives";

type ChatFilter = "active" | "archived" | "all";

function MenuAction({
	icon: Icon,
	label,
	onSelect,
}: {
	icon: ReactNode;
	label: string;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[11.5px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span
				aria-hidden="true"
				className="grid size-4 place-items-center text-muted-foreground [&_svg]:size-3.5"
			>
				{Icon}
			</span>
			<span className="min-w-0 truncate">{label}</span>
		</button>
	);
}

function RowActions({
	actions,
	label,
}: {
	actions: readonly {
		icon: ReactNode;
		label: string;
		onSelect: () => void;
	}[];
	label: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<MorphPopover open={open} onOpenChange={setOpen}>
			<MorphPopoverTrigger>
				<button
					type="button"
					aria-label={label}
					className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<MoreHorizontal className="size-3.5" />
				</button>
			</MorphPopoverTrigger>
			<MorphPopoverContent
				side="bottom"
				align="end"
				sideOffset={6}
				radius={12}
				className="w-52 p-1.5"
			>
				{actions.map((action) => (
					<MenuAction
						key={action.label}
						icon={action.icon}
						label={action.label}
						onSelect={() => {
							setOpen(false);
							action.onSelect();
						}}
					/>
				))}
			</MorphPopoverContent>
		</MorphPopover>
	);
}

function ChatKindHint({ chat }: { chat: ChatSummary }) {
	if (chat.kind === "group") {
		return <span>{m.external_group_chat()}</span>;
	}
	if (chat.kind === "private") {
		return <span>{m.external_private_chat()}</span>;
	}
	return <span>{m.local_chat()}</span>;
}

export function ChatTree({
	filter,
	onNavigate,
	search,
}: {
	filter: ChatFilter;
	onNavigate: () => void;
	search: string;
}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const activeSessionId = pathname.startsWith("/chat/") ? pathname.slice("/chat/".length) : null;
	// Groups start collapsed; the active chat is expanded on demand below, so a long chat list
	// stays one row per conversation instead of two.
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [newChatTitle, setNewChatTitle] = useState("");
	const [newChatSessionTitle, setNewChatSessionTitle] = useState("");
	const [newSessionChat, setNewSessionChat] = useState<ChatSummary | null>(null);
	const [newSessionTitle, setNewSessionTitle] = useState("");
	const [renameSession, setRenameSession] = useState<SessionSummary | null>(null);
	const [renameTitle, setRenameTitle] = useState("");

	const chats = useQuery(orpc.admin.chats.list.queryOptions({ input: { status: "all" } }));
	const sessionIds = (chats.data ?? []).flatMap((chat) =>
		chat.sessions.map((session) => session.id),
	);
	const scheduleSummary = useQuery(
		orpc.admin.schedules.summary.queryOptions({
			input: sessionIds.length === 0 ? {} : { sessionIds: sessionIds.slice(0, 100) },
		}),
	);
	const scheduleBySession = new Map(
		(scheduleSummary.data?.sessions ?? []).map((entry) => [entry.sessionId, entry]),
	);

	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
		]);
	};

	const createChat = useMutation(
		orpc.admin.chats.createLocal.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_chat_create_failed(), { description: errorMessage(error) }),
			onSuccess: async ({ sessionId }) => {
				setNewChatOpen(false);
				setNewChatTitle("");
				setNewChatSessionTitle("");
				toast.success(m.toast_chat_created());
				await invalidate();
				onNavigate();
				await navigate({ params: { sessionId }, to: "/chat/$sessionId" });
			},
		}),
	);
	const createSession = useMutation(
		orpc.admin.sessions.create.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_session_create_failed(), { description: errorMessage(error) }),
			onSuccess: async ({ id }) => {
				setNewSessionChat(null);
				setNewSessionTitle("");
				toast.success(m.toast_session_created());
				await invalidate();
				onNavigate();
				await navigate({ params: { sessionId: id }, to: "/chat/$sessionId" });
			},
		}),
	);
	const updateSession = useMutation(
		orpc.admin.sessions.update.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_session_update_failed(), { description: errorMessage(error) }),
			onSuccess: async (_, variables) => {
				setRenameSession(null);
				if (variables.title !== undefined) toast.success(m.toast_session_renamed());
				else if (variables.status === "archived") toast.success(m.toast_session_archived());
				else if (variables.status === "active") toast.success(m.toast_session_restored());
				await invalidate();
			},
		}),
	);
	const setReceiving = useMutation(
		orpc.admin.sessions.setReceiving.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_receiving_update_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.toast_receiving_updated());
				await invalidate();
			},
		}),
	);

	const query = search.trim().toLowerCase();
	const visibleChats = (chats.data ?? [])
		.map((chat) => {
			const chatMatches = query.length === 0 || chat.title.toLowerCase().includes(query);
			const sessions = chat.sessions.filter((session) => {
				if (filter === "active" && session.status !== "active") return false;
				if (filter === "archived" && session.status !== "archived") return false;
				if (chatMatches) return true;
				return (
					session.title.toLowerCase().includes(query) ||
					(session.latestMessage?.contentText.toLowerCase().includes(query) ?? false)
				);
			});
			return { ...chat, sessions };
		})
		.filter((chat) => {
			if (filter === "archived" && chat.status !== "archived") {
				return chat.sessions.some((session) => session.status === "archived");
			}
			if (filter === "active" && chat.status !== "active") return false;
			return chat.sessions.length > 0;
		});

	const toggleExpanded = (chatId: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(chatId)) next.delete(chatId);
			else next.add(chatId);
			return next;
		});
	};

	const openSession = async (sessionId: string) => {
		onNavigate();
		await navigate({ params: { sessionId }, to: "/chat/$sessionId" });
	};

	const openSessionMenu = (chat: ChatSummary, session: SessionSummary) => {
		const actions = [
			{
				icon: <ExternalLink />,
				label: m.open_session(),
				onSelect: () => void openSession(session.id),
			},
			{
				icon: <Pencil />,
				label: m.rename(),
				onSelect: () => {
					setRenameSession(session);
					setRenameTitle(session.title);
				},
			},
		];
		if (chat.kind === "private" || chat.kind === "group") {
			actions.push({
				icon: <CircleDot />,
				label: m.set_receiving(),
				onSelect: () => setReceiving.mutate({ sessionId: session.id }),
			});
		}
		if (!session.isReceiving) {
			actions.push(
				session.status === "archived"
					? {
							icon: <RotateCcw />,
							label: m.restore(),
							onSelect: () => updateSession.mutate({ sessionId: session.id, status: "active" }),
						}
					: {
							icon: <Archive />,
							label: m.archive(),
							onSelect: () => updateSession.mutate({ sessionId: session.id, status: "archived" }),
						},
			);
		}
		return (
			<RowActions
				label={m.session_actions({ item: session.title })}
				actions={actions.filter(
					(action) => action.label !== m.set_receiving() || !session.isReceiving,
				)}
			/>
		);
	};

	if (chats.isPending) {
		return <div className="px-3 py-4 text-xs text-muted-foreground">{m.loading()}</div>;
	}
	if (chats.isError) {
		return (
			<InlineError
				message={chats.error.message}
				onRetry={() => void chats.refetch()}
				retryLabel={m.retry()}
			/>
		);
	}
	return (
		<>
			<div className="flex items-center justify-between px-2.5 pb-1 pt-0.5">
				<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
					{m.tab_chats()}
				</span>
				<Button
					variant="ghost"
					size="xs"
					onClick={() => setNewChatOpen(true)}
					className="h-6 gap-0.5 rounded-md px-1.5 text-[11px]"
				>
					<Plus className="size-3" />
					{m.new_chat()}
				</Button>
			</div>
			<div
				role="tree"
				aria-label={m.tab_chats()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
			>
				{visibleChats.length === 0 ? (
					<SidebarEmpty
						action={
							<Button size="sm" variant="outline" onClick={() => setNewChatOpen(true)}>
								<MessageCirclePlus className="size-3.5" />
								{m.new_chat()}
							</Button>
						}
						description={query.length > 0 ? m.chats_no_results() : m.chats_empty()}
						icon={MessageSquare}
						title={query.length > 0 ? m.chats_no_results() : m.chats_empty_title()}
					/>
				) : (
					visibleChats.map((chat) => {
						const expandedNow =
							query.length > 0 ||
							expanded.has(chat.id) ||
							chat.sessions.some((session) => session.id === activeSessionId);
						const latest = chat.sessions
							.map((session) => session.latestMessage)
							.filter((message) => message !== null)
							.toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
						return (
							<div key={chat.id} role="treeitem" aria-expanded={expandedNow} className="mb-0.5">
								<div
									className={cn(
										"group flex min-h-9 items-center rounded-md pr-0.5 text-muted-foreground transition-colors",
										"hover:bg-foreground/[0.045] hover:text-foreground",
									)}
								>
									<button
										type="button"
										onClick={() => toggleExpanded(chat.id)}
										className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<ChevronRight
											aria-hidden="true"
											className={cn(
												"size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
												expandedNow && "rotate-90",
											)}
										/>
										<Avatar
											className="size-6 [&_svg]:size-3 text-[10px]"
											kind={
												chat.kind === "group" ? "group" : chat.kind === "webui" ? "webui" : "human"
											}
											name={chat.title}
										/>
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1.5">
												<span className="truncate text-[12.5px] font-medium text-foreground">
													{chat.title}
												</span>
												<span className="shrink-0 text-[9.5px] tabular-nums text-muted-foreground">
													{chat.sessions.length}
												</span>
											</span>
											<span className="flex min-w-0 items-center gap-1 text-[10.5px] leading-4">
												<span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
													<ChatKindHint chat={chat} />
												</span>
												{latest?.contentText ? (
													<>
														<span aria-hidden="true" className="text-muted-foreground/50">
															·
														</span>
														<span className="truncate text-muted-foreground/80">
															{previewText(latest.contentText, "")}
														</span>
													</>
												) : null}
											</span>
										</span>
									</button>
									<button
										type="button"
										aria-label={m.new_session()}
										title={m.new_session()}
										onClick={() => {
											setNewSessionChat(chat);
											setNewSessionTitle("");
										}}
										className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-[color,background-color,opacity] hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 max-sm:opacity-100"
									>
										<Plus className="size-3.5" />
									</button>
								</div>
								{expandedNow ? (
									<div
										role="group"
										className="relative ml-[0.9rem] border-l border-border/70 pl-1 pt-0"
									>
										{chat.sessions.map((session) => {
											const active = activeSessionId === session.id;
											const message = session.latestMessage;
											const linked = scheduleBySession.get(session.id);
											return (
												<div
													key={session.id}
													className={cn(
														"group/session flex min-h-8 items-center rounded-md pr-0.5 transition-colors",
														active
															? "bg-accent/25 text-foreground"
															: "text-muted-foreground hover:bg-accent/15 hover:text-foreground",
													)}
												>
													<button
														type="button"
														onClick={() => void openSession(session.id)}
														aria-current={active ? "page" : undefined}
														className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
													>
														<span
															aria-hidden="true"
															className={cn(
																"size-1 shrink-0 rounded-full",
																session.isReceiving
																	? "bg-primary"
																	: session.status === "archived"
																		? "bg-border-strong"
																		: "bg-muted-foreground/35",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="flex min-w-0 items-center gap-1">
																<span className="truncate text-[12px] font-medium">
																	{session.title}
																</span>
																{session.isReceiving &&
																(chat.kind === "private" || chat.kind === "group") ? (
																	<span className="shrink-0 rounded bg-primary/10 px-1 text-[8.5px] leading-3.5 font-medium text-primary">
																		{m.receiving()}
																	</span>
																) : null}
																{session.status === "archived" ? (
																	<span className="shrink-0 rounded bg-muted px-1 text-[8.5px] leading-3.5">
																		{m.archived()}
																	</span>
																) : null}
																{linked !== undefined && linked.active > 0 ? (
																	<Link
																		aria-label={m.tasks_linked_badge({ count: linked.active })}
																		className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 text-[8.5px] leading-3.5 font-medium text-primary hover:bg-primary/20"
																		onClick={(event) => event.stopPropagation()}
																		params={{ sessionId: session.id }}
																		search={{ sessionId: session.id }}
																		to="/tasks"
																	>
																		<CalendarClock className="size-2.5" />
																		{linked.active}
																	</Link>
																) : null}
															</span>
															<span className="mt-px flex min-w-0 items-center gap-1 text-[10px] leading-3.5 text-muted-foreground/70">
																<span className="truncate">
																	{previewText(message?.contentText, m.messages_empty())}
																</span>
																<span className="ml-auto shrink-0 tabular-nums">
																	{formatTimestamp(message?.occurredAt ?? session.updatedAt)}
																</span>
															</span>
														</span>
													</button>
													<span className="opacity-0 transition-opacity group-hover/session:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
														{openSessionMenu(chat, session)}
													</span>
												</div>
											);
										})}
									</div>
								) : null}
							</div>
						);
					})
				)}
			</div>

			<Modal
				open={newChatOpen}
				onOpenChange={setNewChatOpen}
				title={m.new_chat_title()}
				description={m.new_chat_description()}
			>
				<div className="space-y-3">
					<Input
						label={m.chat_name_label()}
						value={newChatTitle}
						onChange={setNewChatTitle}
						autoFocus
					/>
					<Input
						label={m.session_name_label()}
						value={newChatSessionTitle}
						onChange={setNewChatSessionTitle}
					/>
				</div>
				<ModalActions>
					<Button variant="ghost" size="sm" onClick={() => setNewChatOpen(false)}>
						{m.cancel()}
					</Button>
					<Button
						size="sm"
						disabled={
							createChat.isPending ||
							newChatTitle.trim().length === 0 ||
							newChatSessionTitle.trim().length === 0
						}
						onClick={() =>
							createChat.mutate({
								sessionTitle: newChatSessionTitle.trim(),
								title: newChatTitle.trim(),
							})
						}
					>
						{m.create()}
					</Button>
				</ModalActions>
			</Modal>

			<Modal
				open={newSessionChat !== null}
				onOpenChange={(open) => {
					if (!open) setNewSessionChat(null);
				}}
				title={m.new_session_title()}
				description={m.new_session_description()}
			>
				<Input
					label={m.session_name_label()}
					value={newSessionTitle}
					onChange={setNewSessionTitle}
					autoFocus
				/>
				<ModalActions>
					<Button variant="ghost" size="sm" onClick={() => setNewSessionChat(null)}>
						{m.cancel()}
					</Button>
					<Button
						size="sm"
						disabled={createSession.isPending || newSessionTitle.trim().length === 0}
						onClick={() => {
							if (newSessionChat === null) return;
							createSession.mutate({
								chatObjectId: newSessionChat.id,
								title: newSessionTitle.trim(),
							});
						}}
					>
						{m.create()}
					</Button>
				</ModalActions>
			</Modal>

			<Modal
				open={renameSession !== null}
				onOpenChange={(open) => {
					if (!open) setRenameSession(null);
				}}
				title={m.rename()}
			>
				<Input
					label={m.session_name_label()}
					value={renameTitle}
					onChange={setRenameTitle}
					autoFocus
				/>
				<ModalActions>
					<Button variant="ghost" size="sm" onClick={() => setRenameSession(null)}>
						{m.cancel()}
					</Button>
					<Button
						size="sm"
						disabled={updateSession.isPending || renameTitle.trim().length === 0}
						onClick={() => {
							if (renameSession === null) return;
							updateSession.mutate({
								sessionId: renameSession.id,
								title: renameTitle.trim(),
							});
						}}
					>
						{m.rename()}
					</Button>
				</ModalActions>
			</Modal>
		</>
	);
}
