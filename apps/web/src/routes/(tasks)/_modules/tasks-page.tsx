"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
	CalendarClock,
	Clock3,
	ExternalLink,
	Pencil,
	Pause,
	Play,
	Plus,
	RotateCcw,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	ScheduleDetail,
	ScheduleOccurrence,
	ScheduleRecurrence,
	ScheduleSummary,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { formatDateTime } from "../../_modules/lib/format";
import { Modal, ModalActions } from "../../_modules/ui/modal";
import { SystemPage } from "../../(system)/_modules/page-header";

const fieldClass =
	"h-8 w-full rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const textareaClass =
	"min-h-20 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

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

function actionLabel(action: ScheduleSummary["actionKind"]): string {
	switch (action) {
		case "agent_turn":
			return m.tasks_action_agent();
		case "workspace_turn":
			return m.tasks_action_workspace();
		case "notify":
			return m.tasks_action_notify();
	}
}

function occurrenceLabel(status: ScheduleOccurrence["status"]): string {
	switch (status) {
		case "pending":
			return m.tasks_occurrence_pending();
		case "claimed":
			return m.tasks_occurrence_claimed();
		case "running":
			return m.tasks_occurrence_running();
		case "succeeded":
			return m.tasks_occurrence_succeeded();
		case "failed":
			return m.tasks_occurrence_failed();
		case "skipped":
			return m.tasks_occurrence_skipped();
		case "uncertain":
			return m.tasks_occurrence_uncertain();
		case "cancelled":
			return m.tasks_occurrence_cancelled();
	}
}

function recurrenceLabel(recurrence: ScheduleRecurrence): string {
	switch (recurrence.kind) {
		case "once":
			return `${m.tasks_recurrence_once()} · ${formatDateTime(recurrence.at)}`;
		case "interval":
			return `${m.tasks_recurrence_interval()} ${Math.round(recurrence.everyMs / 60_000)} min`;
		case "calendar": {
			const days =
				recurrence.daysOfWeek === undefined ? "" : ` · ${recurrence.daysOfWeek.join(", ")}`;
			return `${m.tasks_recurrence_calendar()} ${recurrence.time}${days}`;
		}
	}
}

function statusClass(status: ScheduleSummary["status"]): string {
	switch (status) {
		case "active":
			return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
		case "failed":
		case "cancelled":
			return "bg-destructive/10 text-destructive";
		case "paused":
			return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
		default:
			return "bg-muted text-muted-foreground";
	}
}

function nextRunText(schedule: ScheduleSummary): string {
	return schedule.nextRunAt === null ? "—" : formatDateTime(schedule.nextRunAt);
}

export function TasksSidebar({
	onNavigate,
	selectedId,
}: {
	onNavigate: () => void;
	selectedId?: string;
}) {
	const navigate = useNavigate();
	const [filter, setFilter] = useState<"upcoming" | "overdue" | "paused" | "completed" | "all">(
		"upcoming",
	);
	const [search, setSearch] = useState("");
	const schedules = useQuery(orpc.admin.schedules.list.queryOptions({ input: { limit: 200 } }));
	const query = search.trim().toLowerCase();
	const now = Date.now();
	const visible = (schedules.data?.schedules ?? []).filter((schedule) => {
		if (
			filter === "upcoming" &&
			(schedule.status !== "active" ||
				(schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) < now))
		) {
			return false;
		}
		if (filter === "overdue") {
			return (
				schedule.status === "active" &&
				schedule.nextRunAt !== null &&
				Date.parse(schedule.nextRunAt) < now
			);
		}
		if (filter === "paused" && schedule.status !== "paused") return false;
		if (filter === "completed" && schedule.status !== "completed") return false;
		if (query.length === 0) return true;
		return (
			schedule.title.toLowerCase().includes(query) ||
			schedule.targetSessionTitle.toLowerCase().includes(query)
		);
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 px-2.5 pt-2 pb-1.5">
				<Input
					aria-label={m.tasks_search()}
					placeholder={m.tasks_search()}
					value={search}
					onChange={setSearch}
					leftIcon={<CalendarClock />}
					classNames={{
						field: "h-8 rounded-md bg-background/70",
						input: "text-xs",
						leftIcon: "[&_svg]:size-3.5",
						root: "gap-0",
					}}
				/>
				<div className="flex flex-wrap gap-0.5">
					{(["upcoming", "overdue", "paused", "completed", "all"] as const).map((value) => (
						<Button
							key={value}
							variant={filter === value ? "secondary" : "ghost"}
							size="xs"
							onClick={() => setFilter(value)}
							className="h-5 rounded-md px-1.5 text-[10px]"
						>
							{value === "upcoming"
								? m.tasks_filter_upcoming()
								: value === "overdue"
									? m.tasks_filter_overdue()
									: value === "paused"
										? m.tasks_filter_paused()
										: value === "completed"
											? m.tasks_filter_completed()
											: m.tasks_filter_all()}
						</Button>
					))}
				</div>
			</div>
			<div className="flex items-center justify-between px-2.5 pb-1 pt-0.5">
				<span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
					{m.tab_tasks()}
				</span>
				<Button
					className="h-6 gap-0.5 rounded-md px-1.5 text-[11px]"
					size="xs"
					variant="ghost"
					onClick={() => {
						onNavigate();
						void navigate({ to: "/tasks" });
					}}
				>
					<Plus className="size-3" />
					{m.tasks_new()}
				</Button>
			</div>
			<div
				role="list"
				aria-label={m.tab_tasks()}
				className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
			>
				{schedules.isPending ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">{m.loading()}</div>
				) : schedules.isError ? (
					<div className="px-2 py-4 text-xs text-destructive">{m.tasks_load_failed()}</div>
				) : visible.length === 0 ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">
						{query.length > 0 ? m.tasks_no_results() : m.tasks_empty()}
					</div>
				) : (
					visible.map((schedule) => {
						const active = selectedId === schedule.id;
						return (
							<button
								key={schedule.id}
								type="button"
								aria-current={active ? "page" : undefined}
								onClick={() => {
									onNavigate();
									void navigate({ params: { scheduleId: schedule.id }, to: "/tasks/$scheduleId" });
								}}
								className={cn(
									"mb-0.5 flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
									active
										? "bg-accent/25 text-foreground"
										: "text-muted-foreground hover:bg-accent/15 hover:text-foreground",
								)}
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<Clock3 className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
										{schedule.title}
									</span>
									<span
										className={cn(
											"shrink-0 rounded px-1 text-[8.5px] leading-3.5 font-medium",
											statusClass(schedule.status),
										)}
									>
										{statusLabel(schedule.status)}
									</span>
								</span>
								<span className="flex min-w-0 items-center gap-1 pl-5 text-[10px] leading-3.5 text-muted-foreground/75">
									<span className="truncate">{schedule.targetSessionTitle}</span>
									<span aria-hidden="true">·</span>
									<span className="shrink-0 tabular-nums">{nextRunText(schedule)}</span>
								</span>
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}

function TargetPicker({ onChange, value }: { onChange: (value: string) => void; value: string }) {
	const [search, setSearch] = useState("");
	const sessions = useQuery(
		orpc.admin.sessions.search.queryOptions({ input: { limit: 20, query: search } }),
	);
	return (
		<div className="space-y-1.5">
			<Input
				aria-label={m.tasks_target_placeholder()}
				placeholder={m.tasks_target_placeholder()}
				value={search}
				onChange={setSearch}
			/>
			<div className="max-h-32 overflow-y-auto rounded-md border border-border">
				{(sessions.data ?? []).length === 0 ? (
					<p className="px-2 py-2 text-[11px] text-muted-foreground">{m.tasks_no_targets()}</p>
				) : (
					(sessions.data ?? []).map((session) => (
						<button
							key={session.id}
							type="button"
							onClick={() => onChange(session.id)}
							className={cn(
								"flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] outline-none hover:bg-muted",
								value === session.id && "bg-accent/20",
							)}
						>
							<span className="min-w-0 truncate">{session.title}</span>
							<span className="shrink-0 text-[9px] text-muted-foreground">{session.kind}</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}

function CreateTaskForm({ onCreated }: { onCreated: (schedule: ScheduleDetail) => void }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [targetSessionId, setTargetSessionId] = useState("");
	const [actionKind, setActionKind] = useState<"agent_turn" | "workspace_turn" | "notify">(
		"agent_turn",
	);
	const [recurrenceKind, setRecurrenceKind] = useState<"once" | "interval" | "calendar">("once");
	const [at, setAt] = useState("");
	const [everyMinutes, setEveryMinutes] = useState("60");
	const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
	const [time, setTime] = useState("09:00");
	const [days, setDays] = useState<number[]>([]);
	const [timeZone, setTimeZone] = useState(
		Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	);
	const [catchUp, setCatchUp] = useState<"skip" | "latest" | "all">("latest");
	const [respectQuietHours, setRespectQuietHours] = useState(false);
	const recurrence = useMemo<ScheduleRecurrence>(() => {
		if (recurrenceKind === "once") {
			return {
				at: at === "" ? new Date(Date.now() + 3_600_000).toISOString() : new Date(at).toISOString(),
				kind: "once",
			};
		}
		if (recurrenceKind === "interval") {
			return {
				anchorAt: new Date().toISOString(),
				everyMs: Math.max(1, Number(everyMinutes) || 60) * 60_000,
				kind: "interval",
			};
		}
		return {
			...(days.length === 0 ? {} : { daysOfWeek: days }),
			kind: "calendar",
			startDate,
			time,
		};
	}, [at, days, everyMinutes, recurrenceKind, startDate, time]);
	const preview = useQuery({
		...orpc.admin.schedules.preview.queryOptions({ input: { count: 5, recurrence, timeZone } }),
		enabled: timeZone.trim().length > 0,
	});
	const create = useMutation(
		orpc.admin.schedules.create.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async (schedule) => {
				toast.success(m.tasks_created());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.schedules.key() });
				onCreated(schedule);
			},
		}),
	);
	return (
		<div className="space-y-3">
			<label className="block text-[11px] text-muted-foreground">
				<span className="mb-1 block">{m.tasks_title_label()}</span>
				<input
					className={fieldClass}
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			<label className="block text-[11px] text-muted-foreground">
				<span className="mb-1 block">{m.tasks_target()}</span>
				<TargetPicker value={targetSessionId} onChange={setTargetSessionId} />
			</label>
			<label className="block text-[11px] text-muted-foreground">
				<span className="mb-1 block">{m.tasks_action()}</span>
				<select
					className={fieldClass}
					value={actionKind}
					onChange={(event) => setActionKind(event.target.value as typeof actionKind)}
				>
					<option value="agent_turn">{m.tasks_action_agent()}</option>
					<option value="workspace_turn">{m.tasks_action_workspace()}</option>
					<option value="notify">{m.tasks_action_notify()}</option>
				</select>
			</label>
			<label className="block text-[11px] text-muted-foreground">
				<span className="mb-1 block">{m.tasks_prompt_label()}</span>
				<textarea
					className={textareaClass}
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
				/>
			</label>
			<div className="grid grid-cols-2 gap-2">
				<label className="block text-[11px] text-muted-foreground">
					<span className="mb-1 block">{m.tasks_recurrence()}</span>
					<select
						className={fieldClass}
						value={recurrenceKind}
						onChange={(event) => setRecurrenceKind(event.target.value as typeof recurrenceKind)}
					>
						<option value="once">{m.tasks_recurrence_once()}</option>
						<option value="interval">{m.tasks_recurrence_interval()}</option>
						<option value="calendar">{m.tasks_recurrence_calendar()}</option>
					</select>
				</label>
				<label className="block text-[11px] text-muted-foreground">
					<span className="mb-1 block">{m.tasks_time_zone()}</span>
					<input
						className={fieldClass}
						value={timeZone}
						onChange={(event) => setTimeZone(event.target.value)}
					/>
				</label>
			</div>
			{recurrenceKind === "once" ? (
				<label className="block text-[11px] text-muted-foreground">
					<span className="mb-1 block">{m.tasks_at()}</span>
					<input
						className={fieldClass}
						type="datetime-local"
						value={at}
						onChange={(event) => setAt(event.target.value)}
					/>
				</label>
			) : recurrenceKind === "interval" ? (
				<label className="block text-[11px] text-muted-foreground">
					<span className="mb-1 block">{m.tasks_every_minutes()}</span>
					<input
						className={fieldClass}
						min={1}
						type="number"
						value={everyMinutes}
						onChange={(event) => setEveryMinutes(event.target.value)}
					/>
				</label>
			) : (
				<div className="grid grid-cols-2 gap-2">
					<label className="block text-[11px] text-muted-foreground">
						<span className="mb-1 block">{m.tasks_start_date()}</span>
						<input
							className={fieldClass}
							type="date"
							value={startDate}
							onChange={(event) => setStartDate(event.target.value)}
						/>
					</label>
					<label className="block text-[11px] text-muted-foreground">
						<span className="mb-1 block">{m.tasks_local_time()}</span>
						<input
							className={fieldClass}
							type="time"
							value={time}
							onChange={(event) => setTime(event.target.value)}
						/>
					</label>
				</div>
			)}
			{recurrenceKind === "calendar" ? (
				<fieldset className="space-y-1">
					<legend className="text-[11px] text-muted-foreground">{m.tasks_weekdays()}</legend>
					<div className="flex flex-wrap gap-1">
						{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (
							<label
								key={label}
								className="flex items-center gap-1 rounded border border-border px-1.5 py-1 text-[10px]"
							>
								<input
									checked={days.includes(day)}
									type="checkbox"
									onChange={(event) =>
										setDays((current) =>
											event.target.checked
												? [...current, day].toSorted()
												: current.filter((value) => value !== day),
										)
									}
								/>
								{label}
							</label>
						))}
					</div>
				</fieldset>
			) : null}
			<div className="grid grid-cols-2 gap-2">
				<label className="block text-[11px] text-muted-foreground">
					<span className="mb-1 block">{m.tasks_catch_up()}</span>
					<select
						className={fieldClass}
						value={catchUp}
						onChange={(event) => setCatchUp(event.target.value as typeof catchUp)}
					>
						<option value="skip">{m.tasks_catch_up_skip()}</option>
						<option value="latest">{m.tasks_catch_up_latest()}</option>
						<option value="all">{m.tasks_catch_up_all()}</option>
					</select>
				</label>
				<label className="flex items-end gap-2 pb-1 text-[11px] text-muted-foreground">
					<input
						checked={respectQuietHours}
						type="checkbox"
						onChange={(event) => setRespectQuietHours(event.target.checked)}
					/>
					<span>{m.tasks_respect_quiet_hours()}</span>
				</label>
			</div>
			<div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
				<p className="text-[10px] font-medium text-muted-foreground">{m.tasks_preview()}</p>
				<p className="mt-1 text-[10.5px] leading-4 text-foreground">
					{(preview.data?.nextRuns ?? []).map((run) => formatDateTime(run)).join(" · ") || "—"}
				</p>
			</div>
			<ModalActions>
				<Button
					disabled={
						create.isPending ||
						title.trim().length === 0 ||
						prompt.trim().length === 0 ||
						targetSessionId.length === 0
					}
					size="sm"
					onClick={() =>
						create.mutate({
							actionKind,
							catchUp,
							prompt: prompt.trim(),
							recurrence,
							respectQuietHours,
							targetSessionId,
							timeZone: timeZone.trim(),
							title: title.trim(),
						})
					}
				>
					{m.tasks_create()}
				</Button>
			</ModalActions>
		</div>
	);
}

export function TasksIndexPage() {
	const navigate = useNavigate();
	const search = useSearch({ from: "/(tasks)/tasks/" });
	const [createOpen, setCreateOpen] = useState(false);
	const schedules = useQuery(
		orpc.admin.schedules.list.queryOptions({
			input: {
				limit: 200,
				...(search.sessionId === undefined ? {} : { sessionId: search.sessionId }),
			},
		}),
	);
	const visibleSchedules = schedules.data?.schedules ?? [];
	const active = visibleSchedules.filter((schedule) => schedule.status === "active");
	const overdue = active.filter(
		(schedule) => schedule.nextRunAt !== null && Date.parse(schedule.nextRunAt) < Date.now(),
	);
	return (
		<div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-4 sm:px-5">
			<SystemPage description={m.tasks_description()} title={m.tasks_title()}>
				<div className="mb-3 flex items-center justify-between gap-2">
					<div className="flex gap-2 text-[11px] text-muted-foreground">
						<span>{m.tasks_run_count({ count: active.length })}</span>
						{overdue.length > 0 ? <span className="text-destructive">{overdue.length}</span> : null}
					</div>
					<Button size="sm" onClick={() => setCreateOpen(true)}>
						<Plus className="size-3.5" />
						{m.tasks_new()}
					</Button>
				</div>
				{schedules.isPending ? (
					<p className="text-xs text-muted-foreground">{m.loading()}</p>
				) : schedules.isError ? (
					<p className="text-xs text-destructive">{m.tasks_load_failed()}</p>
				) : visibleSchedules.length === 0 ? (
					<div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
						<CalendarClock className="mx-auto size-5 text-muted-foreground" />
						<p className="mt-2 text-sm font-medium">{m.tasks_empty_title()}</p>
						<p className="mt-1 text-xs text-muted-foreground">{m.tasks_empty()}</p>
					</div>
				) : (
					<div className="divide-y divide-border rounded-lg border border-border">
						{visibleSchedules.map((schedule) => (
							<Link
								key={schedule.id}
								to="/tasks/$scheduleId"
								params={{ scheduleId: schedule.id }}
								className="flex items-center gap-3 px-3 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
							>
								<Clock3 className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2">
										<span className="truncate text-[12.5px] font-medium">{schedule.title}</span>
										<span
											className={cn(
												"rounded px-1 text-[9px] font-medium",
												statusClass(schedule.status),
											)}
										>
											{statusLabel(schedule.status)}
										</span>
									</span>
									<span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
										{schedule.targetSessionTitle} · {actionLabel(schedule.actionKind)} ·{" "}
										{recurrenceLabel(schedule.recurrence)}
									</span>
								</span>
								<span className="shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
									{nextRunText(schedule)}
								</span>
							</Link>
						))}
					</div>
				)}
			</SystemPage>
			<Modal
				open={createOpen}
				onOpenChange={setCreateOpen}
				title={m.tasks_new()}
				description={m.tasks_description()}
				className="max-w-[520px]"
			>
				<CreateTaskForm
					onCreated={(schedule) => {
						setCreateOpen(false);
						void navigate({ params: { scheduleId: schedule.id }, to: "/tasks/$scheduleId" });
					}}
				/>
			</Modal>
		</div>
	);
}

export function TaskDetailPage() {
	const { scheduleId } = useParams({ from: "/(tasks)/tasks/$scheduleId" });
	const toast = useToast();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const detail = useQuery(orpc.admin.schedules.get.queryOptions({ input: { scheduleId } }));
	const [cancelOpen, setCancelOpen] = useState(false);
	const [editOpen, setEditOpen] = useState(false);
	const [editTitle, setEditTitle] = useState("");
	const [editPrompt, setEditPrompt] = useState("");
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
	const runNow = useMutation(
		orpc.admin.schedules.runNow.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.tasks_run_started());
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
				setCancelOpen(false);
				await invalidate();
			},
		}),
	);
	const update = useMutation(
		orpc.admin.schedules.update.mutationOptions({
			onError: (error) =>
				toast.error(m.tasks_action_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.tasks_updated());
				setEditOpen(false);
				await invalidate();
			},
		}),
	);
	useEffect(() => {
		if (detail.data === null) void navigate({ to: "/tasks" });
	}, [detail.data, navigate]);
	if (detail.isPending) {
		return <p className="px-4 py-6 text-xs text-muted-foreground">{m.loading()}</p>;
	}
	if (detail.isError) {
		return <p className="px-4 py-6 text-xs text-destructive">{detail.error.message}</p>;
	}
	if (detail.data === null || detail.data === undefined) return null;
	const schedule = detail.data;
	return (
		<div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-4 sm:px-5">
			<SystemPage description={m.tasks_description()} title={schedule.title}>
				<div className="flex flex-wrap items-center gap-1.5">
					<span
						className={cn(
							"rounded px-1.5 py-0.5 text-[10px] font-medium",
							statusClass(schedule.status),
						)}
					>
						{statusLabel(schedule.status)}
					</span>
					<span className="text-[10.5px] text-muted-foreground">
						{actionLabel(schedule.actionKind)} · {recurrenceLabel(schedule.recurrence)}
					</span>
					<div className="ml-auto flex flex-wrap gap-1">
						{schedule.status === "active" ? (
							<Button size="xs" variant="outline" onClick={() => pause.mutate({ scheduleId })}>
								<Pause className="size-3" />
								{m.tasks_pause()}
							</Button>
						) : null}
						{schedule.status === "paused" ? (
							<Button size="xs" variant="outline" onClick={() => resume.mutate({ scheduleId })}>
								<Play className="size-3" />
								{m.tasks_resume()}
							</Button>
						) : null}
						{schedule.status === "active" || schedule.status === "paused" ? (
							<Button size="xs" variant="outline" onClick={() => runNow.mutate({ scheduleId })}>
								<RotateCcw className="size-3" />
								{m.tasks_run_now()}
							</Button>
						) : null}
						{schedule.status !== "cancelled" ? (
							<Button
								size="xs"
								variant="outline"
								onClick={() => {
									setEditTitle(schedule.title);
									setEditPrompt(schedule.prompt);
									setEditOpen(true);
								}}
							>
								<Pencil className="size-3" />
								{m.tasks_edit()}
							</Button>
						) : null}
						{schedule.status !== "cancelled" ? (
							<Button size="xs" variant="danger" onClick={() => setCancelOpen(true)}>
								<X className="size-3" />
								{m.tasks_cancel()}
							</Button>
						) : null}
						<Link
							to={
								schedule.targetSessionId.startsWith("workspace")
									? "/workspace/$sessionId"
									: "/chat/$sessionId"
							}
							params={{ sessionId: schedule.targetSessionId }}
							className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground"
						>
							<ExternalLink className="size-3" />
							{m.tasks_open_session()}
						</Link>
					</div>
				</div>
				<div className="mt-3 grid gap-3 sm:grid-cols-2">
					<section className="rounded-lg border border-border p-3">
						<h2 className="text-[11px] font-semibold">{m.tasks_prompt_label()}</h2>
						<p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-5 text-muted-foreground">
							{schedule.prompt}
						</p>
					</section>
					<section className="space-y-1.5 rounded-lg border border-border p-3 text-[11px]">
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_target()}</span>
							<span className="truncate text-right">{schedule.targetSessionTitle}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_time_zone()}</span>
							<span>{schedule.timeZone}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_next_run()}</span>
							<span>{nextRunText(schedule)}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_last_run()}</span>
							<span>
								{schedule.lastRunAt === null
									? m.tasks_never_run()
									: formatDateTime(schedule.lastRunAt)}
							</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">
								{m.tasks_run_count({ count: schedule.runCount })}
							</span>
							<span>{m.tasks_revision({ revision: schedule.revision })}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_catch_up()}</span>
							<span>{schedule.catchUp}</span>
						</div>
						<div className="flex justify-between gap-2">
							<span className="text-muted-foreground">{m.tasks_respect_quiet_hours()}</span>
							<span>{schedule.respectQuietHours ? "✓" : "—"}</span>
						</div>
					</section>
				</div>
				<section className="mt-3 rounded-lg border border-border">
					<h2 className="border-b border-border px-3 py-2 text-[11px] font-semibold">
						{m.tasks_occurrences()}
					</h2>
					{schedule.occurrences.length === 0 ? (
						<p className="px-3 py-4 text-[11px] text-muted-foreground">
							{m.tasks_occurrence_empty()}
						</p>
					) : (
						<div className="divide-y divide-border">
							{schedule.occurrences.map((occurrence) => (
								<div key={occurrence.id} className="flex items-center gap-2 px-3 py-2 text-[11px]">
									<span className="w-36 shrink-0 tabular-nums text-muted-foreground">
										{formatDateTime(occurrence.scheduledFor)}
									</span>
									<span className="rounded bg-muted px-1 py-0.5 text-[9.5px]">
										{occurrenceLabel(occurrence.status)}
									</span>
									<span className="min-w-0 flex-1 truncate text-muted-foreground">
										{occurrence.error ?? ""}
									</span>
									<span className="shrink-0 text-[9.5px] text-muted-foreground">
										{occurrence.attempt}
									</span>
								</div>
							))}
						</div>
					)}
				</section>
			</SystemPage>
			<Modal
				open={editOpen}
				onOpenChange={setEditOpen}
				title={m.tasks_edit()}
				description={m.tasks_description()}
			>
				<div className="space-y-3">
					<label className="block text-[11px] text-muted-foreground">
						<span className="mb-1 block">{m.tasks_title_label()}</span>
						<input
							className={fieldClass}
							value={editTitle}
							onChange={(event) => setEditTitle(event.target.value)}
						/>
					</label>
					<label className="block text-[11px] text-muted-foreground">
						<span className="mb-1 block">{m.tasks_prompt_label()}</span>
						<textarea
							className={textareaClass}
							value={editPrompt}
							onChange={(event) => setEditPrompt(event.target.value)}
						/>
					</label>
					<ModalActions>
						<Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>
							{m.cancel()}
						</Button>
						<Button
							size="sm"
							disabled={
								update.isPending || editTitle.trim().length === 0 || editPrompt.trim().length === 0
							}
							onClick={() =>
								update.mutate({
									prompt: editPrompt.trim(),
									scheduleId,
									title: editTitle.trim(),
								})
							}
						>
							{m.tasks_save()}
						</Button>
					</ModalActions>
				</div>
			</Modal>
			<Modal
				open={cancelOpen}
				onOpenChange={setCancelOpen}
				title={m.tasks_cancel()}
				description={m.tasks_cancel_confirm()}
			>
				<ModalActions>
					<Button variant="ghost" size="sm" onClick={() => setCancelOpen(false)}>
						{m.cancel()}
					</Button>
					<Button
						variant="danger"
						size="sm"
						disabled={cancel.isPending}
						onClick={() => cancel.mutate({ confirm: true, scheduleId })}
					>
						{m.tasks_cancel()}
					</Button>
				</ModalActions>
			</Modal>
		</div>
	);
}
