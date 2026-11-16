"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Code2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Input } from "@tsukaima/ui/components/motion/input";
import { cn } from "@tsukaima/ui/lib/utils";
import { orpc, type WorkspaceSummary } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { formatTimestamp, previewText } from "../lib/format";
import { Modal, ModalActions } from "../ui/modal";
import { InlineError, SidebarEmpty } from "./primitives";

const WORKSPACE_MODES = ["analysis", "patch", "proposal"] as const;
type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

function statusClass(status: WorkspaceSummary["taskStatus"]): string {
	switch (status) {
		case "completed":
			return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
		case "failed":
		case "cancelled":
			return "bg-destructive/10 text-destructive";
		case "in_progress":
		case "deploying":
			return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
		default:
			return "bg-muted text-muted-foreground";
	}
}

function modeLabel(mode: WorkspaceSummary["mode"]): string {
	switch (mode) {
		case "analysis":
			return m.workspace_mode_analysis();
		case "proposal":
			return m.workspace_mode_proposal();
		case "patch":
			return m.workspace_mode_patch();
		case "maintenance":
			return m.workspace_mode_maintenance();
	}
}

export function WorkspaceSidebar({ onNavigate }: { onNavigate: () => void }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const activeSessionId = pathname.startsWith("/workspace/")
		? pathname.slice("/workspace/".length).split("/")[0]
		: null;
	const [search, setSearch] = useState("");
	const [createOpen, setCreateOpen] = useState(false);
	const [goal, setGoal] = useState("");
	const [mode, setMode] = useState<WorkspaceMode>("patch");
	const workspaces = useQuery(orpc.admin.workspace.list.queryOptions({ input: {} }));
	const createWorkspace = useMutation(
		orpc.admin.workspace.create.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_workspace_create_failed(), { description: errorMessage(error) }),
			onSuccess: async ({ sessionId }) => {
				setCreateOpen(false);
				setGoal("");
				toast.success(m.toast_workspace_created());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.workspace.key() });
				onNavigate();
				await navigate({ params: { sessionId }, to: "/workspace/$sessionId" });
			},
		}),
	);
	const query = search.trim().toLowerCase();
	const visible =
		workspaces.data?.filter(
			(workspace) =>
				query.length === 0 ||
				workspace.title.toLowerCase().includes(query) ||
				workspace.goal.toLowerCase().includes(query) ||
				workspace.taskId.toLowerCase().includes(query),
		) ?? [];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 px-2.5 pt-2 pb-1.5">
				<Input
					aria-label={m.search_workspaces()}
					placeholder={m.search_workspaces()}
					value={search}
					onChange={setSearch}
					leftIcon={<Search />}
					classNames={{
						field: "h-8 rounded-md bg-background/70",
						input: "text-xs",
						leftIcon: "[&_svg]:size-3.5",
						root: "gap-0",
					}}
				/>
			</div>
			<div className="flex items-center justify-between px-2.5 pb-1 pt-0.5">
				<span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
					{m.tab_workspace()}
				</span>
				<Button
					className="h-6 gap-0.5 rounded-md px-1.5 text-[11px]"
					size="xs"
					variant="ghost"
					onClick={() => setCreateOpen(true)}
				>
					<Plus className="size-3" />
					{m.workspace_new()}
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
				{workspaces.isPending ? (
					<div className="px-2 py-4 text-xs text-muted-foreground">{m.loading()}</div>
				) : workspaces.isError ? (
					<InlineError
						message={workspaces.error.message}
						onRetry={() => void workspaces.refetch()}
						retryLabel={m.retry()}
					/>
				) : visible.length === 0 ? (
					<SidebarEmpty
						action={
							<Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
								<Plus className="size-3.5" />
								{m.workspace_new()}
							</Button>
						}
						description={query.length > 0 ? m.workspaces_no_results() : m.workspaces_empty()}
						icon={Code2}
						title={query.length > 0 ? m.workspaces_no_results() : m.workspaces_empty_title()}
					/>
				) : (
					visible.map((workspace) => {
						const active = activeSessionId === workspace.id;
						return (
							<button
								key={workspace.id}
								type="button"
								aria-current={active ? "page" : undefined}
								onClick={() => {
									onNavigate();
									void navigate({
										params: { sessionId: workspace.id },
										to: "/workspace/$sessionId",
									});
								}}
								className={cn(
									"mb-0.5 flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
									active
										? "bg-foreground/[0.06] text-foreground"
										: "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
								)}
							>
								<span className="flex min-w-0 items-center gap-1.5">
									<Code2 className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
										{workspace.title}
									</span>
									<span
										className={cn(
											"shrink-0 rounded px-1 text-[8.5px] leading-3.5 font-medium",
											statusClass(workspace.taskStatus),
										)}
									>
										{workspace.taskStatus}
									</span>
								</span>
								<span className="flex min-w-0 items-center gap-1.5 pl-5 text-[10px] leading-3.5 text-muted-foreground/75">
									<span className="shrink-0">{modeLabel(workspace.mode)}</span>
									<span aria-hidden="true">·</span>
									<span className="min-w-0 flex-1 truncate">
										{previewText(
											workspace.latestMessage?.contentText,
											m.workspaces_empty_preview(),
										)}
									</span>
									<span className="shrink-0 tabular-nums">
										{formatTimestamp(workspace.updatedAt)}
									</span>
								</span>
							</button>
						);
					})
				)}
			</div>
			<Modal
				description={m.workspace_new_description()}
				onOpenChange={setCreateOpen}
				open={createOpen}
				title={m.workspace_new_title()}
			>
				<div className="space-y-3">
					<label className="block space-y-1.5">
						<span className="px-1 text-[11.5px] font-medium text-foreground">
							{m.workspace_goal_label()}
						</span>
						<textarea
							autoFocus
							value={goal}
							onChange={(event) => setGoal(event.target.value)}
							placeholder={m.workspace_goal_placeholder()}
							rows={4}
							className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring"
						/>
					</label>
					<div className="space-y-1.5">
						<div className="px-1 text-[11.5px] font-medium text-foreground">
							{m.workspace_mode()}
						</div>
						<div className="flex gap-1">
							{WORKSPACE_MODES.map((value) => (
								<Button
									key={value}
									size="xs"
									variant={mode === value ? "secondary" : "ghost"}
									onClick={() => setMode(value)}
								>
									{modeLabel(value)}
								</Button>
							))}
						</div>
					</div>
				</div>
				<ModalActions>
					<Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
						{m.cancel()}
					</Button>
					<Button
						disabled={createWorkspace.isPending || goal.trim().length === 0}
						size="sm"
						onClick={() =>
							createWorkspace.mutate({
								goal: goal.trim(),
								mode,
							})
						}
					>
						{m.create()}
					</Button>
				</ModalActions>
			</Modal>
		</div>
	);
}
