"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Circle, MessageCircle, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { orpc, type DeliveryStatus } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { useLiveRun } from "@/lib/live-run-store";
import { cn } from "@elaina/ui/lib/utils";
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

const CONTEXT_PANEL_KEY = "elaina.webui.context-panel";
const INSPECTOR_TAB_KEY = "elaina.webui.inspector-tab";

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
	const messages = useQuery(orpc.admin.sessions.messages.queryOptions({ input: { sessionId } }));
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
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.messages.key({ input: { sessionId } }),
					}),
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
			<div className="grid h-full place-items-center text-sm text-muted-foreground">
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
			<div className="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
				{m.session_not_found()}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
				{mobile ? (
					<Button
						variant="ghost"
						size="icon"
						onClick={showSidebar}
						aria-label={m.topbar_back_to_sidebar()}
						className="size-9 rounded-lg"
					>
						<ChevronLeft className="size-4" />
					</Button>
				) : null}
				<Avatar
					className="size-9"
					kind={
						detail.chat.kind === "group"
							? "group"
							: detail.chat.kind === "webui"
								? "webui"
								: "human"
					}
					name={detail.title}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<h1 className="truncate text-sm font-semibold">{detail.title}</h1>
						{detail.isReceiving &&
						(detail.chat.kind === "private" || detail.chat.kind === "group") ? (
							<span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
								{m.receiving()}
							</span>
						) : null}
						{archived ? (
							<span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
								{m.archived()}
							</span>
						) : null}
					</div>
					<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="truncate">{detail.chat.title}</span>
						<span aria-hidden="true">·</span>
						<span>{chatKindLabel(detail.chat.kind)}</span>
						{detail.channelId ? (
							<>
								<span aria-hidden="true">·</span>
								<span className="truncate">{detail.channelId}</span>
							</>
						) : null}
						{externalEligible ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex items-center gap-1",
										channelConnected ? "text-(--color-success)" : "text-destructive",
									)}
								>
									<Circle className="size-1.5 fill-current" />
									{channelConnected ? m.connect_connected() : m.connect_disconnected()}
								</span>
							</>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						type="button"
						variant={contextOpen ? "secondary" : "outline"}
						size="sm"
						className="shrink-0"
						aria-pressed={contextOpen}
						onClick={toggleContextPanel}
					>
						<PanelRight className="size-4" />
						<span className="hidden sm:inline">{m.inspector_action()}</span>
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
						<div className="border-b border-border bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
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
								liveRun={liveRun}
								messages={messages.data ?? []}
								now={now}
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
						className="w-[320px] shrink-0 border-l border-border bg-card/35 xl:w-[350px] dark:bg-[#181818]"
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
						className="relative z-10 h-full w-[340px] max-w-[90vw] border-l border-border bg-background shadow-xl dark:bg-[#181818]"
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
			<div className="flex max-w-sm flex-col items-center text-center">
				<span className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
					<MessageCircle className="size-6" />
				</span>
				<h1 className="mt-4 text-lg font-semibold tracking-tight">{m.welcome_title()}</h1>
				<p className="mt-1.5 text-sm leading-6 text-muted-foreground">{m.welcome_description()}</p>
				{mobile ? (
					<Button variant="outline" size="sm" className="mt-5" onClick={showSidebar}>
						{m.topbar_back_to_sidebar()}
					</Button>
				) : null}
			</div>
		</div>
	);
}
