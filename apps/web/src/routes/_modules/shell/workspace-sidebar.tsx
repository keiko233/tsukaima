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
import { InlineError, SidebarEmpty } from "./primitives";

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
	const workspaces = useQuery(orpc.admin.workspace.list.queryOptions({ input: {} }));
	const createWorkspace = useMutation(
		orpc.admin.workspace.create.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_workspace_create_failed(), { description: errorMessage(error) }),
			onSuccess: async ({ sessionId }) => {
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
				(workspace.goal?.toLowerCase().includes(query) ?? false) ||
				(workspace.taskId?.toLowerCase().includes(query) ?? false) ||
				workspace.tags.some((tag) => tag.toLowerCase().includes(query)),
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
					disabled={createWorkspace.isPending}
					onClick={() => createWorkspace.mutate({})}
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
							<Button
								size="sm"
								variant="outline"
								disabled={createWorkspace.isPending}
								onClick={() => createWorkspace.mutate({})}
							>
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
										{workspace.taskStatus ?? m.workspace_status_draft()}
									</span>
								</span>
								<span className="flex min-w-0 items-center gap-1.5 pl-5 text-[10px] leading-3.5 text-muted-foreground/75">
									<span className="shrink-0">
										{workspace.tags.length > 0
											? workspace.tags.slice(0, 2).join(" · ")
											: modeLabel(workspace.mode)}
									</span>
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
		</div>
	);
}
