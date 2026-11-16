"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { formatDateTime } from "../lib/format";
import { Avatar, InlineError } from "../shell/primitives";
import { requestKindLabel, requestStatusClass, requestStatusLabel } from "../shell/request-meta";
import { Modal, ModalActions } from "../ui/modal";
import {
	DetailField,
	DetailSection,
	DirectoryDetailPage,
	DirectoryEmptyState,
} from "./directory-page";

export function RequestDetailPage({ requestId }: { requestId: string }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [pendingAction, setPendingAction] = useState<"approve" | "reject" | null>(null);
	const [reason, setReason] = useState("");
	const request = useQuery(orpc.admin.requests.get.queryOptions({ input: { requestId } }));
	const diagnostics = useQuery(orpc.admin.diagnostics.status.queryOptions());
	const respond = useMutation(
		orpc.admin.requests.respond.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_request_action_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async (updated) => {
				if (updated.status === "approved") toast.success(m.toast_request_approved());
				else if (updated.status === "rejected") toast.success(m.toast_request_rejected());
				else if (updated.status === "uncertain") toast.info(m.toast_request_uncertain());
				else {
					toast.error(m.toast_request_action_failed(), {
						description: updated.errorMessage,
					});
				}
				setPendingAction(null);
				setReason("");
				await queryClient.invalidateQueries({ queryKey: orpc.admin.requests.key() });
			},
		}),
	);

	if (request.isPending) {
		return (
			<div className="grid h-full place-items-center text-[12px] text-muted-foreground">
				{m.loading()}
			</div>
		);
	}
	if (request.isError) {
		return (
			<div className="grid h-full place-items-center">
				<InlineError
					message={request.error.message}
					onRetry={() => void request.refetch()}
					retryLabel={m.retry()}
				/>
			</div>
		);
	}
	const selected = request.data;
	if (selected === null || selected === undefined) {
		return (
			<DirectoryEmptyState
				description={m.requests_select_description()}
				icon={Inbox}
				title={m.request_not_found()}
			/>
		);
	}

	const connected = diagnostics.data?.channels.some((channel) => channel.connected) ?? false;
	const displayName = selected.requesterDisplayName ?? selected.requesterExternalId;

	return (
		<DirectoryDetailPage
			leading={<Avatar className="size-10 text-sm" name={displayName} />}
			subtitle={requestKindLabel(selected.kind)}
			title={displayName}
			trailing={
				<span
					className={cn(
						"shrink-0 rounded-full px-2 py-1 text-[9.5px] font-medium",
						requestStatusClass(selected.status),
					)}
				>
					{requestStatusLabel(selected.status)}
				</span>
			}
		>
			<DetailSection title={m.request_detail()}>
				<DetailField label={m.request_requester()} value={selected.requesterExternalId} />
				{selected.groupExternalId ? (
					<DetailField label={m.request_group()} value={selected.groupExternalId} />
				) : null}
				<DetailField label={m.request_time()} value={formatDateTime(selected.createdAt)} />
				{selected.resolvedAt ? (
					<DetailField
						label={m.request_resolved_at()}
						value={formatDateTime(selected.resolvedAt)}
					/>
				) : null}
				{selected.resolutionReason ? (
					<DetailField label={m.request_reason()} value={selected.resolutionReason} />
				) : null}
			</DetailSection>

			{selected.comment ? (
				<DetailSection title={m.request_comment()}>
					<p className="rounded-lg bg-muted px-2.5 py-2 text-[11.5px] leading-5 text-foreground">
						{selected.comment}
					</p>
				</DetailSection>
			) : null}

			{selected.errorMessage ? (
				<div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3.5 py-3 text-[11.5px] leading-5 text-destructive">
					{selected.errorMessage}
				</div>
			) : null}

			{selected.status === "pending" ? (
				<DetailSection title={m.request_confirm_title()}>
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
						<p className="rounded-lg border border-border px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
							{m.request_channel_offline()}
						</p>
					)}
				</DetailSection>
			) : (
				<p className="px-1 text-[11px] text-muted-foreground">{m.request_already_handled()}</p>
			)}

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
						<span>{displayName}</span>
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
		</DirectoryDetailPage>
	);
}
