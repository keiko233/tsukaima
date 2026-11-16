"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, RefreshCw, Rocket, Square } from "lucide-react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
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
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{m.runtime_maintenance_title()}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.runtime_maintenance_description()}
				</p>
				{active ? (
					<div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-muted-foreground">
						<div className="font-medium text-foreground">
							{status.mode === "update" ? m.runtime_update_pending() : m.runtime_restart_pending()}
						</div>
						<div className="mt-0.5">
							{m.runtime_scheduled_for({ time: new Date(status.executeAt).toLocaleString() })}
						</div>
						<div className="mt-0.5">{status.reason}</div>
					</div>
				) : (
					<p className="text-[11px] text-muted-foreground">{m.runtime_no_restart()}</p>
				)}
				<div className="flex flex-wrap gap-1.5">
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
			</CardContent>
		</Card>
	);
}
