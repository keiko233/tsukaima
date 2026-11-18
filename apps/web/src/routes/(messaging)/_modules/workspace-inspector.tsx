"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, MessageSquare, ListTodo, X } from "lucide-react";
import { useState } from "react";
import type { SessionDetail, WorkspaceDetail, WorkspaceTodo } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tsukaima/ui/components/motion/tabs";
import { TodoList } from "@tsukaima/ui/components/agents/todo-list";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { ContextPanel } from "./context-panel";
import { SessionModelView } from "./session-model-view";
import type { InspectorTab } from "./session-inspector-sidebar";
import { SessionSchedulesView } from "./session-schedules-view";

const WORKSPACE_TABS = ["context", "model", "todos", "sessions", "data", "schedules"] as const;
type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

function workspaceTab(tab: InspectorTab): WorkspaceTab {
	return tab === "model" ||
		tab === "todos" ||
		tab === "sessions" ||
		tab === "data" ||
		tab === "schedules"
		? tab
		: "context";
}

function todoStatus(
	status: WorkspaceTodo["status"],
): "pending" | "in-progress" | "completed" | "cancelled" {
	return status === "in_progress" ? "in-progress" : status;
}

function TagsEditor({ sessionId, tags }: { sessionId: string; tags: string[] }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [value, setValue] = useState(tags.join(", "));
	const update = useMutation(
		orpc.admin.workspace.update.mutationOptions({
			onError: (error) => toast.error(m.error_generic(), { description: errorMessage(error) }),
			onSuccess: async () => {
				await queryClient.invalidateQueries({ queryKey: orpc.admin.workspace.key() });
			},
		}),
	);
	return (
		<form
			className="flex items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				update.mutate({
					sessionId,
					tags: value
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0),
				});
			}}
		>
			<input
				value={value}
				onChange={(event) => setValue(event.target.value)}
				aria-label={m.workspace_tags()}
				className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			<Button type="submit" size="xs" variant="ghost" disabled={update.isPending}>
				{m.save()}
			</Button>
		</form>
	);
}

export function WorkspaceInspectorTabs({
	activeTab,
	isRunning,
	onClose,
	onTabChange,
	session,
	workspace,
}: {
	activeTab: InspectorTab;
	isRunning: boolean;
	onClose?: () => void;
	onTabChange: (tab: InspectorTab) => void;
	session: SessionDetail;
	workspace?: WorkspaceDetail | null;
}) {
	const selected = workspaceTab(activeTab);
	const todoItems = (workspace?.todos ?? []).map((todo) => ({
		detail: todo.status === "in_progress" ? m.context_title() : undefined,
		id: todo.id,
		status: todoStatus(todo.status),
		title: todo.content,
	}));
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-9 items-center justify-between gap-2 border-b border-border/60 px-3">
				<h2 className="text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase">
					{m.inspector_title()}
				</h2>
				{onClose ? (
					<Button
						type="button"
						variant="ghost"
						size="iconSm"
						onClick={onClose}
						aria-label={m.inspector_close()}
						className="size-6 rounded-md text-muted-foreground hover:text-foreground"
					>
						<X className="size-3" />
					</Button>
				) : null}
			</div>
			<Tabs
				variant="underline"
				value={selected}
				onValueChange={(value) => {
					if (
						value === "context" ||
						value === "model" ||
						value === "todos" ||
						value === "sessions" ||
						value === "data" ||
						value === "schedules"
					) {
						onTabChange(value);
					}
				}}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="shrink-0 border-b border-border/70 px-1.5">
					<TabsList className="w-full justify-between gap-0">
						<TabsTrigger
							value="context"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.workspace_inspector_context()}
						</TabsTrigger>
						<TabsTrigger
							value="model"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.inspector_tab_model()}
						</TabsTrigger>
						<TabsTrigger
							value="todos"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							<span className="inline-flex items-center gap-1">
								{m.workspace_inspector_todos()}
								{isRunning ? (
									<span
										aria-hidden="true"
										className="size-1.5 animate-pulse rounded-full bg-amber-500"
									/>
								) : null}
							</span>
						</TabsTrigger>
						<TabsTrigger
							value="sessions"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.workspace_inspector_sessions()}
						</TabsTrigger>
						<TabsTrigger
							value="data"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.workspace_inspector_data()}
						</TabsTrigger>
						<TabsTrigger
							value="schedules"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.tasks_inspector_tab()}
						</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="context" className="mt-0 flex min-h-0 flex-1 flex-col">
					<div className="border-b border-border/60 px-3 py-2">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate text-[11px] font-medium text-foreground">
								{workspace?.workspace.title ?? session.title}
							</span>
							<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
								{workspace?.workspace.taskStatus ?? m.workspace_status_draft()}
							</span>
						</div>
						<div className="mt-1 line-clamp-2 text-[10.5px] text-muted-foreground">
							{workspace?.workspace.goal ?? m.workspace_goal_missing()}
						</div>
						<div className="mt-1.5">
							<TagsEditor sessionId={session.id} tags={workspace?.workspace.tags ?? []} />
						</div>
						<div className="mt-1.5 text-[10px] text-muted-foreground">
							{m.workspace_rename_hint()}
						</div>
					</div>
					<ContextPanel embedded enabled={selected === "context"} sessionId={session.id} />
				</TabsContent>
				<TabsContent value="model" className="mt-0 flex min-h-0 flex-1 flex-col">
					<SessionModelView sessionId={session.id} surface="workspace" />
				</TabsContent>
				<TabsContent value="todos" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
					{todoItems.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">{m.workspace_todo_empty()}</p>
					) : (
						<TodoList items={todoItems} defaultOpen />
					)}
				</TabsContent>
				<TabsContent value="sessions" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
					{(workspace?.references ?? []).length === 0 ? (
						<p className="text-[11px] text-muted-foreground">{m.workspace_references_empty()}</p>
					) : (
						<div className="space-y-1.5">
							{(workspace?.references ?? []).map((reference) => (
								<div
									key={reference.id}
									className="rounded-md border border-border/50 bg-background/60 px-2 py-1.5"
								>
									<div className="flex items-center gap-1.5">
										<MessageSquare className="size-3 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
											{reference.title}
										</span>
										<span className="shrink-0 text-[9.5px] text-muted-foreground">
											{reference.kind}
										</span>
									</div>
									<div className="mt-1 font-mono text-[9.5px] text-muted-foreground/70">
										{reference.sessionId}
									</div>
								</div>
							))}
						</div>
					)}
				</TabsContent>
				<TabsContent value="data" className="mt-0 min-h-0 flex-1 overflow-y-auto p-3">
					<div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
						<Database className="size-3.5 text-muted-foreground" />
						{m.workspace_sql_readonly()}
					</div>
					<p className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">
						{m.workspace_sql_empty()}
					</p>
					<div className="mt-3 flex items-center gap-1.5 text-[10.5px] font-medium text-foreground">
						<ListTodo className="size-3.5 text-muted-foreground" />
						{m.workspace_sql_tables()}
					</div>
					<div className="mt-1.5 space-y-1 font-mono text-[10px] text-muted-foreground">
						{[
							"coding_tasks",
							"coding_proposals",
							"coding_approvals",
							"coding_deployments",
							"workspace_sessions",
							"workspace_todos",
							"workspace_references",
							"conversations",
						].map((table) => (
							<div key={table}>{table}</div>
						))}
					</div>
				</TabsContent>
				<TabsContent value="schedules" className="mt-0 flex min-h-0 flex-1 flex-col">
					<SessionSchedulesView sessionId={session.id} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
