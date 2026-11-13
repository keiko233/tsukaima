"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
	Archive,
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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { Input } from "@elaina/ui/components/motion/input";
import {
	MorphPopover,
	MorphPopoverContent,
	MorphPopoverTrigger,
} from "@elaina/ui/components/motion/popover-morph";
import { orpc, type ChatSummary, type SessionSummary } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { cn } from "@elaina/ui/lib/utils";
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
			className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
					className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<MoreHorizontal className="size-4" />
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
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const seenChats = useRef(new Set<string>());
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [newChatTitle, setNewChatTitle] = useState("");
	const [newChatSessionTitle, setNewChatSessionTitle] = useState("");
	const [newSessionChat, setNewSessionChat] = useState<ChatSummary | null>(null);
	const [newSessionTitle, setNewSessionTitle] = useState("");
	const [renameSession, setRenameSession] = useState<SessionSummary | null>(null);
	const [renameTitle, setRenameTitle] = useState("");

	const chats = useQuery(orpc.admin.chats.list.queryOptions({ input: { status: "all" } }));

	useEffect(() => {
		if (!chats.data) return;
		setExpanded((current) => {
			const next = new Set(current);
			for (const chat of chats.data) {
				if (seenChats.current.has(chat.id)) continue;
				seenChats.current.add(chat.id);
				next.add(chat.id);
			}
			return next;
		});
	}, [chats.data]);

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
			<div className="flex items-center justify-between px-3 pb-2 pt-1">
				<span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					{m.tab_chats()}
				</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setNewChatOpen(true)}
					className="h-7 gap-1 rounded-full px-2.5 text-xs"
				>
					<Plus className="size-3.5" />
					{m.new_chat()}
				</Button>
			</div>
			<div
				role="tree"
				aria-label={m.tab_chats()}
				className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
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
							<div key={chat.id} role="treeitem" aria-expanded={expandedNow} className="mb-1">
								<div
									className={cn(
										"group flex min-h-11 items-center rounded-xl pr-1 text-muted-foreground transition-colors",
										"hover:bg-muted/70 hover:text-foreground",
									)}
								>
									<button
										type="button"
										onClick={() => toggleExpanded(chat.id)}
										className="flex min-w-0 flex-1 items-center gap-2 rounded-l-xl py-1.5 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<ChevronRight
											aria-hidden="true"
											className={cn(
												"size-3.5 shrink-0 transition-transform duration-200",
												expandedNow && "rotate-90",
											)}
										/>
										<Avatar
											kind={
												chat.kind === "group" ? "group" : chat.kind === "webui" ? "webui" : "human"
											}
											name={chat.title}
										/>
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-1.5">
												<span className="truncate text-sm font-medium text-foreground">
													{chat.title}
												</span>
												<span className="shrink-0 text-[10px] text-muted-foreground">
													{chat.sessions.length}
												</span>
											</span>
											<span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px]">
												<span className="shrink-0 whitespace-nowrap">
													<ChatKindHint chat={chat} />
												</span>
												{latest?.contentText ? (
													<>
														<span aria-hidden="true">·</span>
														<span className="truncate">{previewText(latest.contentText, "")}</span>
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
										className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-60 outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
									>
										<Plus className="size-3.5" />
									</button>
								</div>
								{expandedNow ? (
									<div
										role="group"
										className="relative ml-[1.35rem] border-l border-border pl-2 pt-0.5"
									>
										{chat.sessions.map((session) => {
											const active = activeSessionId === session.id;
											const message = session.latestMessage;
											return (
												<div
													key={session.id}
													className={cn(
														"group/session flex min-h-10 items-center rounded-xl pr-1 transition-colors",
														active
															? "bg-muted text-foreground"
															: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
													)}
												>
													<button
														type="button"
														onClick={() => void openSession(session.id)}
														aria-current={active ? "page" : undefined}
														className="flex min-w-0 flex-1 items-center gap-2 rounded-l-xl py-1.5 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
													>
														<span
															aria-hidden="true"
															className={cn(
																"size-1.5 shrink-0 rounded-full",
																session.isReceiving
																	? "bg-primary"
																	: session.status === "archived"
																		? "bg-border-strong"
																		: "bg-muted-foreground/35",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="flex min-w-0 items-center gap-1.5">
																<span className="truncate text-[13px] font-medium">
																	{session.title}
																</span>
																{session.isReceiving &&
																(chat.kind === "private" || chat.kind === "group") ? (
																	<span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
																		{m.receiving()}
																	</span>
																) : null}
																{session.status === "archived" ? (
																	<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px]">
																		{m.archived()}
																	</span>
																) : null}
															</span>
															<span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
																<span className="truncate">
																	{previewText(message?.contentText, m.messages_empty())}
																</span>
																<span className="ml-auto shrink-0">
																	{formatTimestamp(message?.occurredAt ?? session.updatedAt)}
																</span>
															</span>
														</span>
													</button>
													{openSessionMenu(chat, session)}
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
