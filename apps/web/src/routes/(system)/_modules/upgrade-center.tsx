"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDownToLine,
	ArrowUpFromLine,
	CheckCircle2,
	GitBranch,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup } from "@tsukaima/ui";
import { orpc, type UpgradeCheck, type UpgradeRecord } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { InlineError } from "../../_modules/shell/primitives";

function shortCommit(commit: string): string {
	return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function recordTone(status: UpgradeRecord["status"]): string {
	switch (status) {
		case "completed":
			return "text-success";
		case "failed":
			return "text-destructive";
		case "restarting":
		case "merging":
		case "running":
			return "text-warning";
		default:
			return "text-muted-foreground";
	}
}

function statusLabel(status: UpgradeCheck["status"]): string {
	switch (status) {
		case "available":
			return m.upgrade_status_available();
		case "diverged":
			return m.upgrade_status_diverged();
		case "up_to_date":
			return m.upgrade_status_up_to_date();
		default:
			return m.upgrade_status_unavailable();
	}
}

function recordStatusLabel(status: UpgradeRecord["status"]): string {
	switch (status) {
		case "running":
			return m.upgrade_status_running();
		case "ready":
			return m.upgrade_status_ready();
		case "merging":
			return m.upgrade_status_merging();
		case "restarting":
			return m.upgrade_status_restarting();
		case "completed":
			return m.upgrade_status_completed();
		case "cancelled":
			return m.upgrade_status_cancelled();
		default:
			return m.upgrade_status_failed();
	}
}

function reasonLabel(reason: string | undefined): string | undefined {
	switch (reason) {
		case "detached_head":
			return m.upgrade_reason_detached_head();
		case "fetch_failed":
			return m.upgrade_reason_fetch_failed();
		case "invalid_branch":
			return m.upgrade_reason_invalid_branch();
		case "remote_not_configured":
			return m.upgrade_reason_remote_not_configured();
		case "upstream_branch_missing":
			return m.upgrade_reason_upstream_branch_missing();
		case "working_tree_dirty":
			return m.upgrade_reason_working_tree_dirty();
		default:
			return reason;
	}
}

function CheckSummary({ check }: { readonly check: UpgradeCheck }) {
	return (
		<div className="border-t border-border pt-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[12px] font-semibold text-foreground">
					{statusLabel(check.status)}
				</span>
				{check.mode !== "none" && (
					<span className="text-xs text-muted-foreground">
						{check.mode === "fast_forward"
							? m.upgrade_mode_fast_forward()
							: m.upgrade_mode_workspace()}
					</span>
				)}
			</div>
			<dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] sm:grid-cols-[auto_1fr_auto_1fr]">
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_branch()}</dt>
					<dd className="truncate font-medium text-foreground">{check.branch || "—"}</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_remote()}</dt>
					<dd className="truncate font-medium text-foreground">{check.remote}</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_current_version()}</dt>
					<dd className="font-mono tabular-nums text-[11px] text-foreground">
						{check.currentVersion || "—"}
					</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_target_version()}</dt>
					<dd className="font-mono tabular-nums text-[11px] text-foreground">
						{check.upstreamVersion || "—"}
					</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_commit()}</dt>
					<dd className="font-mono tabular-nums text-[11px] text-foreground">
						{shortCommit(check.currentCommit) || "—"}
					</dd>
				</div>
				<div className="contents">
					<dt className="text-muted-foreground">{m.upgrade_upstream_commits()}</dt>
					<dd className="flex items-center gap-1.5 font-mono tabular-nums text-foreground">
						<ArrowUpFromLine className="size-3" /> {check.ahead}
						<ArrowDownToLine className="size-3" /> {check.behind}
					</dd>
				</div>
			</dl>
			{check.reason === undefined ? null : (
				<p className="mt-2 text-[11px] leading-4 text-muted-foreground">
					{reasonLabel(check.reason)}
				</p>
			)}
		</div>
	);
}

export function UpgradeCenter({ fetchAction }: { fetchAction?: ReactNode } = {}) {
	const toast = useToast();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const check = useQuery({
		...orpc.admin.upgrade.check.queryOptions(),
		staleTime: 15_000,
	});
	const status = useQuery({
		...orpc.admin.upgrade.status.queryOptions(),
		refetchInterval: (query) => {
			const value = query.state.data?.status;
			return value === "running" || value === "ready" || value === "merging" ? 5_000 : false;
		},
	});
	const history = useQuery(orpc.admin.upgrade.history.queryOptions());
	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: orpc.admin.upgrade.key() }),
			queryClient.invalidateQueries({ queryKey: orpc.admin.runtime.key() }),
		]);
	};
	const start = useMutation(
		orpc.admin.upgrade.start.mutationOptions({
			onError: (error) =>
				toast.error(m.upgrade_start_failed(), { description: errorMessage(error) }),
			onSuccess: async (result) => {
				toast.success(
					result.workspace === null ? m.upgrade_started() : m.upgrade_started_workspace(),
				);
				await invalidate();
				if (result.workspace !== null) {
					await navigate({
						params: { sessionId: result.workspace.sessionId },
						to: "/workspace/$sessionId",
					});
				}
			},
		}),
	);
	const finalize = useMutation(
		orpc.admin.upgrade.finalize.mutationOptions({
			onError: (error) =>
				toast.error(m.upgrade_finalize_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.upgrade_finalized());
				await invalidate();
			},
		}),
	);
	const latest = status.data;
	const checking = check.isFetching && !check.isPending;
	const canStart =
		check.data?.canUpgrade === true &&
		start.isPending === false &&
		latest !== undefined &&
		(latest === null ||
			latest.status === "completed" ||
			latest.status === "failed" ||
			latest.status === "cancelled");
	const canFinalize =
		latest !== null &&
		latest !== undefined &&
		(latest.status === "ready" || latest.status === "running") &&
		finalize.isPending === false;

	return (
		<div className="space-y-6">
			<EditorialGroup title={m.upgrade_title()} description={m.upgrade_description()}>
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						{fetchAction}
						<Button
							leadingIcon={<RefreshCw className={checking ? "animate-spin" : undefined} />}
							size="sm"
							variant="outline"
							disabled={check.isFetching}
							onClick={() => void check.refetch()}
						>
							{checking ? m.upgrade_checking() : m.upgrade_check()}
						</Button>
						<Button
							disabled={!canStart}
							leadingIcon={<GitBranch />}
							size="sm"
							loading={start.isPending}
							onClick={() => start.mutate({ autoFinalize: true })}
						>
							{m.upgrade_start()}
						</Button>
						<Button
							disabled={!canFinalize}
							leadingIcon={<CheckCircle2 />}
							size="sm"
							loading={finalize.isPending}
							onClick={() => finalize.mutate({})}
						>
							{m.upgrade_finalize()}
						</Button>
					</div>
					{check.isError ? (
						<InlineError
							message={check.error.message}
							onRetry={() => void check.refetch()}
							retryLabel={m.retry()}
						/>
					) : check.data === undefined ? (
						<p className="text-[11px] text-muted-foreground">{m.loading()}</p>
					) : (
						<CheckSummary check={check.data} />
					)}
					{check.data?.mode === "fast_forward" ? (
						<p className="text-[11px] leading-4 text-muted-foreground">
							{m.upgrade_fast_forward_description()}
						</p>
					) : null}
					{check.data?.mode === "workspace" ? (
						<p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
							{m.upgrade_workspace_description()}
						</p>
					) : null}
					{check.data?.dirty === true ? (
						<p className="flex items-start gap-1.5 text-[11px] leading-4 text-warning">
							<TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
							{m.upgrade_dirty_description()}
						</p>
					) : null}
				</div>
			</EditorialGroup>

			<EditorialGroup title={m.upgrade_status()}>
				<div className="space-y-3">
					{latest === null || latest === undefined ? (
						<p className="text-[11px] text-muted-foreground">{m.upgrade_history_empty()}</p>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<span className={recordTone(latest.status)}>
									{recordStatusLabel(latest.status)}
								</span>
								<span className="font-mono tabular-nums text-xs text-muted-foreground">
									{latest.currentVersion} → {latest.targetVersion}
								</span>
								<span className="text-xs text-muted-foreground">
									{latest.mode === "fast_forward"
										? m.upgrade_mode_fast_forward()
										: m.upgrade_mode_workspace()}
								</span>
							</div>
							<p className="font-mono tabular-nums text-[11px] text-muted-foreground">
								{shortCommit(latest.currentCommit)} → {shortCommit(latest.targetCommit)}
							</p>
							{latest.error === null ? null : (
								<p className="text-xs text-destructive">{latest.error}</p>
							)}
							{latest.mode === "workspace" && latest.workspaceSessionId !== null ? (
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-[11px] text-muted-foreground">
										{m.upgrade_proposal_required()}
									</span>
									<Button
										size="xs"
										variant="outline"
										onClick={() =>
											void navigate({
												params: { sessionId: latest.workspaceSessionId ?? "" },
												to: "/workspace/$sessionId",
											})
										}
									>
										{m.upgrade_open_workspace()}
									</Button>
								</div>
							) : null}
						</>
					)}
				</div>
			</EditorialGroup>

			<EditorialGroup title={m.upgrade_history()}>
				<div className="space-y-3">
					{history.data === undefined || history.data.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">{m.upgrade_history_empty()}</p>
					) : (
						<div className="overflow-x-auto">
							<table
								aria-label={m.upgrade_history()}
								className="w-full whitespace-nowrap text-start text-xs"
							>
								<thead className="border-b border-border text-muted-foreground">
									<tr>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.request_status()}
										</th>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.repository_version()}
										</th>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.upgrade_commit()}
										</th>
										<th scope="col" className="py-2 pe-4 text-start font-medium">
											{m.upgrade_mode()}
										</th>
										<th scope="col" className="py-2 text-start font-medium">
											{m.tasks_created()}
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border/70">
									{history.data.map((record) => (
										<tr key={record.id}>
											<td className={`py-2 pe-4 ${recordTone(record.status)}`}>
												{recordStatusLabel(record.status)}
											</td>
											<td className="py-2 pe-4 font-mono tabular-nums">
												{record.currentVersion} → {record.targetVersion}
											</td>
											<td className="py-2 pe-4 font-mono tabular-nums">
												{shortCommit(record.currentCommit)} → {shortCommit(record.targetCommit)}
											</td>
											<td className="py-2 pe-4 text-muted-foreground">
												{record.mode === "fast_forward"
													? m.upgrade_mode_fast_forward()
													: m.upgrade_mode_workspace()}
											</td>
											<td className="py-2 font-mono tabular-nums text-muted-foreground">
												{new Date(record.createdAt).toLocaleString()}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			</EditorialGroup>
		</div>
	);
}
