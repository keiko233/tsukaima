"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, RefreshCw, Rocket, Square } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup } from "@tsukaima/ui";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";

export function RuntimeMaintenanceCard() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const restart = useQuery({
		...orpc.admin.runtime.restartStatus.queryOptions(),
		refetchInterval: (query) =>
			query.state.data?.status === "scheduled" || query.state.data?.status === "executing"
				? 5_000
				: false,
	});
	const schedule = useMutation(
		orpc.admin.runtime.scheduleRestart.mutationOptions({
			onError: (error) =>
				toast.error(m.runtime_action_failed(), { description: errorMessage(error) }),
			onSuccess: async (status) => {
				toast.success(
					status.mode === "update" ? m.runtime_update_scheduled() : m.runtime_restart_scheduled(),
				);
				await queryClient.invalidateQueries({ queryKey: orpc.admin.runtime.key() });
			},
		}),
	);
	const cancel = useMutation(
		orpc.admin.runtime.cancelRestart.mutationOptions({
			onError: (error) =>
				toast.error(m.runtime_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.runtime_restart_cancelled());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.runtime.key() });
			},
		}),
	);
	const status = restart.data;
	const active = status?.status === "scheduled" || status?.status === "executing";
	return (
		<EditorialGroup
			title={m.runtime_maintenance_title()}
			description={m.runtime_maintenance_description()}
		>
			{active ? (
				<div className="border-b border-border/70 py-3 last:border-b-0">
					<div className="border-s-2 border-warning ps-3">
						<div className="text-sm font-medium text-ink">
							{status.mode === "update" ? m.runtime_update_pending() : m.runtime_restart_pending()}
						</div>
						<div className="mt-1 text-xs text-muted-foreground tabular-nums">
							{m.runtime_scheduled_for({ time: new Date(status.executeAt).toLocaleString() })}
						</div>
						<div className="mt-1 text-xs text-muted-foreground">{status.reason}</div>
					</div>
				</div>
			) : (
				<p className="border-b border-border/70 py-3 text-xs text-muted-foreground">
					{m.runtime_no_restart()}
				</p>
			)}
			<div className="flex flex-wrap gap-2 pt-3">
				<Button
					disabled={schedule.isPending || active}
					leadingIcon={<Power />}
					size="sm"
					variant="secondary"
					onClick={() =>
						schedule.mutate({
							delaySeconds: 60,
							mode: "restart",
							reason: "restart requested from WebUI",
						})
					}
				>
					{m.runtime_restart_in_minute()}
				</Button>
				<Button
					disabled={schedule.isPending || active}
					leadingIcon={<Rocket />}
					size="sm"
					onClick={() =>
						schedule.mutate({
							delaySeconds: 60,
							mode: "update",
							reason: "update requested from WebUI",
						})
					}
				>
					{m.runtime_update_in_minute()}
				</Button>
				{active ? (
					<Button
						disabled={cancel.isPending}
						leadingIcon={cancel.isPending ? <RefreshCw className="animate-spin" /> : <Square />}
						size="sm"
						variant="danger"
						onClick={() => cancel.mutate()}
					>
						{m.runtime_cancel_restart()}
					</Button>
				) : null}
			</div>
		</EditorialGroup>
	);
}
