"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Pause, Play, X } from "lucide-react";
import type { ScheduleSummary } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { formatDateTime } from "../../_modules/lib/format";

function statusLabel(status: ScheduleSummary["status"]): string {
	switch (status) {
		case "active":
			return m.tasks_status_active();
		case "paused":
			return m.tasks_status_paused();
		case "completed":
			return m.tasks_status_completed();
		case "cancelled":
			return m.tasks_status_cancelled();
		case "failed":
			return m.tasks_status_failed();
	}
}

export function SessionSchedulesView({ sessionId }: { readonly sessionId: string }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const schedules = useQuery(
		orpc.admin.schedules.list.queryOptions({ input: { limit: 100, sessionId } }),
	);
	const invalidate = async () => {
		await queryClient.invalidateQueries({ queryKey: orpc.admin.schedules.key() });
	};
	const pause = useMutation(
		orpc.admin.schedules.pause.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.tasks_paused());
				await invalidate();
			},
		}),
	);
	const resume = useMutation(
		orpc.admin.schedules.resume.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.tasks_resumed());
				await invalidate();
			},
		}),
	);
	const cancel = useMutation(
		orpc.admin.schedules.cancel.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.tasks_cancelled());
				await invalidate();
			},
		}),
	);
	const rows = schedules.data?.schedules ?? [];
	return (
		<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pt-2.5 pb-3">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">
					<h3 className="text-[11.5px] font-semibold">{m.tasks_inspector_tab()}</h3>
					<p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
						{m.tasks_sidebar_description()}
					</p>
				</div>
				<Link
					className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
					search={{ sessionId }}
					to="/tasks"
				>
					{m.tasks_view_all()}
				</Link>
			</div>
			{schedules.isPending ? (
				<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
			) : schedules.isError ? (
				<p className="text-[11px] text-destructive">{schedules.error.message}</p>
			) : rows.length === 0 ? (
				<div className="rounded-md border border-dashed border-border px-2.5 py-4 text-center">
					<CalendarClock className="mx-auto size-4 text-muted-foreground" />
					<p className="mt-1 text-[11px] text-muted-foreground">{m.tasks_linked_empty()}</p>
				</div>
			) : (
				rows.map((schedule) => (
					<div key={schedule.id} className="rounded-md border border-border/70 bg-background/50 p-2.5">
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<p className="truncate text-[11.5px] font-medium">{schedule.title}</p>
								<p className="mt-0.5 text-[10px] text-muted-foreground">
									{statusLabel(schedule.status)} ·{" "}
									{schedule.nextRunAt === null ? "—" : formatDateTime(schedule.nextRunAt)}
								</p>
							</div>
							<div className="flex shrink-0 gap-0.5">
								{schedule.status === "active" ? (
									<Button
										size="iconSm"
										variant="ghost"
										aria-label={m.tasks_pause()}
										onClick={() => pause.mutate({ scheduleId: schedule.id })}
									>
										<Pause className="size-3" />
									</Button>
								) : null}
								{schedule.status === "paused" ? (
									<Button
										size="iconSm"
										variant="ghost"
										aria-label={m.tasks_resume()}
										onClick={() => resume.mutate({ scheduleId: schedule.id })}
									>
										<Play className="size-3" />
									</Button>
								) : null}
								{schedule.status !== "cancelled" ? (
									<Button
										size="iconSm"
										variant="ghost"
										aria-label={m.tasks_cancel()}
										onClick={() => cancel.mutate({ confirm: true, scheduleId: schedule.id })}
									>
										<X className="size-3" />
									</Button>
								) : null}
							</div>
						</div>
						<Link
							className="mt-1.5 inline-block text-[10.5px] text-primary hover:underline"
							params={{ scheduleId: schedule.id }}
							to="/tasks/$scheduleId"
						>
							{m.tasks_title()}
						</Link>
					</div>
				))
			)}
		</div>
	);
}

