"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, UserPlus, UserRoundCheck, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { orpc, type RequestRow } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { formatDateTime } from "../lib/format";
import { Modal, ModalActions } from "../ui/modal";
import { Avatar, InlineError, SidebarEmpty } from "./primitives";

function requestKindLabel(kind: RequestRow["kind"]): string {
	switch (kind) {
		case "friend":
			return m.friend_request();
		case "group-add":
			return m.group_add_request();
		case "group-invite":
			return m.group_invite_request();
	}
}

function requestStatusLabel(status: RequestRow["status"]): string {
	switch (status) {
		case "pending":
			return m.request_pending();
		case "approved":
			return m.request_approved();
		case "rejected":
			return m.request_rejected();
		case "failed":
			return m.request_failed();
		case "uncertain":
			return m.request_uncertain();
	}
}

function statusClass(status: RequestRow["status"]): string {
	switch (status) {
		case "pending":
			return "bg-warning/10 text-warning";
		case "approved":
			return "bg-success/10 text-success";
		case "rejected":
			return "bg-muted text-muted-foreground";
		case "failed":
			return "bg-destructive/10 text-destructive";
		case "uncertain":
			return "bg-warning/10 text-warning";
	}
}

function requestIcon(kind: RequestRow["kind"]) {
	switch (kind) {
		case "friend":
			return UserPlus;
		case "group-add":
			return UserRoundCheck;
		case "group-invite":
			return Users;
	}
}

export function RequestsSidebar({ search }: { search: string }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [view, setView] = useState<"pending" | "processed">("pending");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<"approve" | "reject" | null>(null);
	const [reason, setReason] = useState("");
	const requests = useQuery(orpc.admin.requests.list.queryOptions({ input: { status: "all" } }));
	const diagnostics = useQuery(orpc.admin.diagnostics.status.queryOptions());
	const respond = useMutation(
		orpc.admin.requests.respond.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_request_action_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async (request) => {
				if (request.status === "approved") toast.success(m.toast_request_approved());
				else if (request.status === "rejected") toast.success(m.toast_request_rejected());
				else if (request.status === "uncertain") toast.info(m.toast_request_uncertain());
				else {
					toast.error(m.toast_request_action_failed(), {
						description: request.errorMessage,
					});
				}
				setPendingAction(null);
				setReason("");
				await queryClient.invalidateQueries({ queryKey: orpc.admin.requests.key() });
			},
		}),
	);
	const query = search.trim().toLowerCase();
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
	const selected = requests.data?.find((request) => request.id === selectedId) ?? null;
	const connected =
		diagnostics.data?.channels.some((channel) => channel.connected) ?? false;

	if (selected !== null) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setSelectedId(null)}
						className="h-6 gap-0.5 rounded-md px-1.5 text-[11px]"
					>
						<ChevronLeft className="size-3.5" />
						{m.back()}
					</Button>
					<span className="truncate text-[11px] font-medium text-muted-foreground">
						{m.request_detail()}
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="flex items-center gap-2.5 px-3 py-3">
						<Avatar className="size-8 text-[11px]" name={selected.requesterDisplayName ?? selected.requesterExternalId} />
						<div className="min-w-0 flex-1">
							<h2 className="truncate text-[13px] font-semibold">
								{selected.requesterDisplayName ?? selected.requesterExternalId}
							</h2>
							<p className="text-[11px] text-muted-foreground">{requestKindLabel(selected.kind)}</p>
						</div>
						<span
							className={cn(
								"shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-medium",
								statusClass(selected.status),
							)}
						>
							{requestStatusLabel(selected.status)}
						</span>
					</div>
					<div className="space-y-1.5 border-y border-border px-3 py-2.5 text-[11px]">
						<div className="flex justify-between gap-3">
							<span className="text-muted-foreground">{m.request_requester()}</span>
							<span className="break-all text-right">{selected.requesterExternalId}</span>
						</div>
						{selected.groupExternalId ? (
							<div className="flex justify-between gap-3">
								<span className="text-muted-foreground">{m.request_group()}</span>
								<span className="break-all text-right">{selected.groupExternalId}</span>
							</div>
						) : null}
						<div className="flex justify-between gap-3">
							<span className="text-muted-foreground">{m.request_time()}</span>
							<span className="text-right">{formatDateTime(selected.createdAt)}</span>
						</div>
						{selected.comment ? (
							<div>
								<div className="mb-1 text-muted-foreground">{m.request_comment()}</div>
								<p className="rounded-md bg-muted px-2 py-1.5 leading-4 text-foreground">
									{selected.comment}
								</p>
							</div>
						) : null}
						{selected.errorMessage ? (
							<p className="rounded-md bg-destructive/5 px-2 py-1.5 leading-4 text-destructive">
								{selected.errorMessage}
							</p>
						) : null}
					</div>
					{selected.status === "pending" ? (
						<div className="px-3 py-3">
							{connected ? (
								<div className="flex gap-2">
									<Button
										size="sm"
										className="flex-1"
										onClick={() => {
											setPendingAction("approve");
										}}
									>
										{m.request_approve()}
									</Button>
									<Button
										size="sm"
										variant="outline"
										className="flex-1"
										onClick={() => {
											setPendingAction("reject");
										}}
									>
										{m.request_reject()}
									</Button>
								</div>
							) : (
								<p className="rounded-md border border-border px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
									{m.request_channel_offline()}
								</p>
							)}
						</div>
					) : (
						<p className="px-3 py-3 text-[11px] text-muted-foreground">{m.request_already_handled()}</p>
					)}
				</div>

				<Modal
					open={pendingAction !== null}
					onOpenChange={(open) => {
						if (!open) setPendingAction(null);
					}}
					title={m.request_confirm_title()}
					description={m.request_confirm_description()}
				>
					<div className="mb-3 space-y-1 rounded-md bg-muted px-2.5 py-1.5 text-[11px]">
						<div className="flex justify-between gap-3">
							<span className="text-muted-foreground">{m.request_requester()}</span>
							<span>{selected.requesterDisplayName ?? selected.requesterExternalId}</span>
						</div>
						{selected.groupExternalId ? (
							<div className="flex justify-between gap-3">
								<span className="text-muted-foreground">{m.request_group()}</span>
								<span>{selected.groupExternalId}</span>
							</div>
						) : null}
					</div>
					<Input label={m.request_reason()} value={reason} onChange={setReason} maxLength={300} />
					<ModalActions>
						<Button variant="ghost" size="sm" onClick={() => setPendingAction(null)}>
							{m.cancel()}
						</Button>
						<Button
							size="sm"
							variant={pendingAction === "reject" ? "outline" : "primary"}
							disabled={respond.isPending || pendingAction === null}
							onClick={() => {
								if (pendingAction === null) return;
								respond.mutate({
									action: pendingAction,
									requestId: selected.id,
									...(reason.trim().length === 0 ? {} : { reason: reason.trim() }),
								});
							}}
						>
							{respond.isPending
								? m.request_in_flight()
								: pendingAction === "reject"
									? m.request_reject()
									: m.request_approve()}
						</Button>
					</ModalActions>
				</Modal>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex gap-0.5 px-2.5 pb-1.5 pt-0.5">
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
					className="h-7 rounded-full px-3 text-xs"
				>
					{m.processed_requests()}
				</Button>
			</div>
			<div
				role="list"
				aria-label={m.tab_requests()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
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
						return (
							<button
								key={request.id}
								type="button"
								onClick={() => {
									setSelectedId(request.id);
								}}
								className="flex min-h-11 w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
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
												statusClass(request.status),
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
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}
