"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Circle, MessageCircle, PanelRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc, type DeliveryStatus } from "@/lib/api";
import { messageListOptions, upsertMessagesInCache } from "@/lib/message-cache";
import { errorMessage, useToast } from "@/lib/toast";
import { useLiveRun } from "@/lib/live-run-store";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { useMediaQuery } from "../../_modules/hooks/use-media-query";
import { useShellNavigation } from "../../_modules/shell/admin-shell";
import { Avatar, InlineError } from "../../_modules/shell/primitives";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";
import {
	SessionInspectorSidebar,
	storedInspectorTab,
	type InspectorTab,
} from "./session-inspector-sidebar";

const CONTEXT_PANEL_KEY = "tsukaima.webui.context-panel";
const INSPECTOR_TAB_KEY = "tsukaima.webui.inspector-tab";

function storedContextOpen(): boolean {
	try {
		return localStorage.getItem(CONTEXT_PANEL_KEY) !== "closed";
	} catch {
		return true;
	}
}

function deliveryNotice(status: DeliveryStatus): string {
	switch (status) {
		case "received":
			return m.delivery_received();
		case "pending":
			return m.delivery_pending();
		case "accepted":
			return m.delivery_accepted();
		case "sent":
			return m.delivery_sent();
		case "failed":
			return m.delivery_failed();
		case "uncertain":
			return m.delivery_uncertain();
	}
}

function chatKindLabel(kind: "private" | "group" | "webui" | "task" | "plugin"): string {
	if (kind === "group") return m.external_group_chat();
	if (kind === "private") return m.external_private_chat();
	return m.local_chat();
}

export function ChatPage({ sessionId }: { sessionId: string }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const { mobile, showSidebar } = useShellNavigation();
	const wideContextPane = useMediaQuery("(min-width: 1024px)");
	const [desktopContextOpen, setDesktopContextOpen] = useState<boolean>(() => storedContextOpen());
	const [drawerContextOpen, setDrawerContextOpen] = useState(false);
	const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => storedInspectorTab());
	const liveRun = useLiveRun(sessionId);
	// The live run's elapsed label is a wall clock, not the render time of a message. Tick it only
	// while a run is active so an idle transcript never re-renders.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (liveRun === undefined) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [liveRun === undefined]);
	useEffect(() => {
		try {
			localStorage.setItem(CONTEXT_PANEL_KEY, desktopContextOpen ? "open" : "closed");
		} catch {
			// Ignore storage errors in restricted environments.
		}
	}, [desktopContextOpen]);
	useEffect(() => {
		try {
			localStorage.setItem(INSPECTOR_TAB_KEY, inspectorTab);
		} catch {
			// Ignore storage errors in restricted environments.
		}
	}, [inspectorTab]);
	useEffect(() => {
		setDrawerContextOpen(false);
	}, [sessionId, wideContextPane]);

	const contextOpen = wideContextPane ? desktopContextOpen : drawerContextOpen;
	const toggleContextPanel = () => {
		if (wideContextPane) {
			setDesktopContextOpen((current) => !current);
		} else {
			setDrawerContextOpen((current) => !current);
		}
	};

	const session = useQuery(orpc.admin.sessions.get.queryOptions({ input: { sessionId } }));
	const messages = useInfiniteQuery(messageListOptions(sessionId));
	const transcript = useMemo(
		() =>
			messages.data === undefined
				? []
				: messages.data.pages.toReversed().flatMap((page) => page.messages),
		[messages.data],
	);
	const diagnostics = useQuery(orpc.admin.diagnostics.status.queryOptions());
	const send = useMutation(
		orpc.admin.sessions.send.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_message_send_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async (message) => {
				const notice = deliveryNotice(message.deliveryStatus);
				if (message.deliveryStatus === "failed") toast.error(notice);
				else if (
					message.deliveryStatus === "accepted" ||
					message.deliveryStatus === "sent" ||
					message.deliveryStatus === "received"
				) {
					toast.success(notice);
				} else {
					toast.info(notice);
				}
				upsertMessagesInCache(queryClient, sessionId, [message]);
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.contextStats.key({ input: { sessionId } }),
					}),
					queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
				]);
			},
		}),
	);

	const detail = session.data;
	const externalEligible =
		detail !== null &&
		detail !== undefined &&
		(detail.chat.kind === "private" || detail.chat.kind === "group") &&
		detail.chat.platformConversationId !== null;
	const channelConnected =
		diagnostics.data?.channels.some(
			(channel) => channel.id === detail?.channelId && channel.connected,
		) ?? false;
	const archived = detail?.status === "archived";

	if (session.isPending) {
		return (
			<div className="grid h-full place-items-center text-[12px] text-muted-foreground">
				{m.loading()}
			</div>
		);
	}
	if (session.isError) {
		return (
			<div className="grid h-full place-items-center">
				<InlineError
					message={session.error.message}
					onRetry={() => void session.refetch()}
					retryLabel={m.retry()}
				/>
			</div>
		);
	}
	if (detail === null || detail === undefined) {
		return (
			<div className="grid h-full place-items-center px-6 text-center text-[12px] text-muted-foreground">
				{m.session_not_found()}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex h-12 min-h-12 shrink-0 items-center gap-2 border-b border-border px-2.5 sm:px-3.5">
				{mobile ? (
					<Button
						variant="ghost"
						size="icon"
						onClick={showSidebar}
						aria-label={m.topbar_back_to_sidebar()}
						className="size-7 rounded-md"
					>
						<ChevronLeft className="size-4" />
					</Button>
				) : null}
				<Avatar
					className="size-7 [&_svg]:size-3.5 text-[11px]"
					kind={
						detail.chat.kind === "group"
							? "group"
							: detail.chat.kind === "webui"
								? "webui"
								: "human"
					}
					name={detail.title}
				/>
				<div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
					<h1 className="min-w-0 shrink truncate text-[13px] font-semibold text-foreground">
						{detail.title}
					</h1>
					{detail.isReceiving &&
					(detail.chat.kind === "private" || detail.chat.kind === "group") ? (
						<span className="shrink-0 rounded bg-primary/10 px-1.5 text-[9.5px] leading-4 font-medium text-primary">
							{m.receiving()}
						</span>
					) : null}
					{archived ? (
						<span className="shrink-0 rounded bg-muted px-1.5 text-[9.5px] leading-4 text-muted-foreground">
							{m.archived()}
						</span>
					) : null}
					<span aria-hidden="true" className="hidden text-muted-foreground/45 sm:inline">
						·
					</span>
					<span className="hidden min-w-0 truncate sm:inline">{detail.chat.title}</span>
					<span aria-hidden="true" className="hidden text-muted-foreground/45 md:inline">
						·
					</span>
					<span className="hidden shrink-0 md:inline">{chatKindLabel(detail.chat.kind)}</span>
					{detail.channelId ? (
						<>
							<span
								aria-hidden="true"
								className="hidden text-muted-foreground/45 xl:inline"
							>
								·
							</span>
							<span className="hidden min-w-0 truncate xl:inline">{detail.channelId}</span>
						</>
					) : null}
					{externalEligible ? (
						<span
							className={cn(
								"ml-1 inline-flex shrink-0 items-center gap-1 text-[10.5px]",
								channelConnected ? "text-(--color-success)" : "text-destructive",
							)}
						>
							<Circle className="size-1.5 fill-current" />
							<span className="hidden sm:inline">
								{channelConnected ? m.connect_connected() : m.connect_disconnected()}
							</span>
						</span>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						type="button"
						variant={contextOpen ? "secondary" : "ghost"}
						size="xs"
						className="h-7 shrink-0 gap-1 rounded-md px-1.5"
						aria-pressed={contextOpen}
						aria-label={m.inspector_action()}
						title={m.inspector_action()}
						onClick={toggleContextPanel}
					>
						<PanelRight className="size-3.5" />
						{liveRun !== undefined ? (
							<span
								aria-hidden="true"
								className="size-1.5 animate-pulse rounded-full bg-amber-500"
							/>
						) : null}
					</Button>
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col">
					{archived ? (
						<div className="border-b border-border bg-muted/40 px-3.5 py-1.5 text-[11px] text-muted-foreground">
							{m.session_archived_notice()}
						</div>
					) : null}

					<div className="relative min-h-0 flex-1">
						{messages.isPending ? (
							<div className="grid h-full place-items-center text-sm text-muted-foreground">
								{m.loading()}
							</div>
						) : messages.isError ? (
							<div className="grid h-full place-items-center">
								<InlineError
									message={messages.error.message}
									onRetry={() => void messages.refetch()}
									retryLabel={m.retry()}
								/>
							</div>
						) : (
							<MessageList
								key={sessionId}
								hasOlder={messages.hasNextPage}
								liveRun={liveRun}
								loadingOlder={messages.isFetchingNextPage}
								messages={transcript}
								now={now}
								onLoadOlder={() => void messages.fetchNextPage()}
								sessionId={sessionId}
							/>
						)}
					</div>

					{archived ? null : (
						<MessageComposer
							key={detail.id}
							channelConnected={channelConnected}
							disabled={detail.chat.status !== "active"}
							externalEligible={externalEligible}
							onSend={(input) => send.mutateAsync({ ...input, sessionId })}
							sending={send.isPending}
							sessionId={detail.id}
						/>
					)}
				</div>

				{wideContextPane && desktopContextOpen ? (
					<aside
						aria-label={m.inspector_title()}
						className="w-[280px] shrink-0 border-l border-border bg-sidebar/60 xl:w-[300px]"
					>
						<SessionInspectorSidebar
							activeTab={inspectorTab}
							isRunning={liveRun !== undefined}
							onClose={() => setDesktopContextOpen(false)}
							onTabChange={setInspectorTab}
							session={detail}
						/>
					</aside>
				) : null}
			</div>

			{!wideContextPane && drawerContextOpen ? (
				<div className="fixed inset-0 z-40 flex justify-end">
					<button
						type="button"
						aria-label={m.inspector_close()}
						onClick={() => setDrawerContextOpen(false)}
						className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
					/>
					<aside
						aria-label={m.inspector_title()}
						className="relative z-10 h-full w-[320px] max-w-[90vw] border-l border-border bg-background shadow-xl"
					>
						<SessionInspectorSidebar
							activeTab={inspectorTab}
							isRunning={liveRun !== undefined}
							onClose={() => setDrawerContextOpen(false)}
							onTabChange={setInspectorTab}
							session={detail}
						/>
					</aside>
				</div>
			) : null}
		</div>
	);
}

export function ChatEmptyState() {
	const { mobile, showSidebar } = useShellNavigation();
	return (
		<div className="grid h-full place-items-center px-6">
			<div className="flex max-w-xs flex-col items-center text-center">
				<span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
					<MessageCircle className="size-5" />
				</span>
				<h1 className="mt-3 text-[14px] font-semibold tracking-tight">{m.welcome_title()}</h1>
				<p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
					{m.welcome_description()}
				</p>
				{mobile ? (
					<Button variant="outline" size="sm" className="mt-4" onClick={showSidebar}>
						{m.topbar_back_to_sidebar()}
					</Button>
				) : null}
			</div>
		</div>
	);
}
