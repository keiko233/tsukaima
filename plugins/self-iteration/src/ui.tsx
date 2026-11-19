"use client";

import {
	Button,
	EmptyState,
	Field,
	Input,
	PluginPage,
	PluginSection,
	StatGrid,
	Switch,
	definePluginUi,
	usePluginI18n,
	usePluginPanel,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { Check, GitBranch, Play, RefreshCw, RotateCcw, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CodingPolicy } from "./domain.ts";
import { i18n } from "./i18n.ts";
import { SELF_ITERATION_PLUGIN_ID } from "./manifest.ts";

interface TaskLogEntry {
	readonly atMs: number;
	readonly level: string;
	readonly message: string;
}

interface TaskArtifact {
	readonly checksum?: string;
	readonly kind: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly name: string;
	readonly path?: string;
}

interface TaskTimelineEntry {
	readonly atMs: number;
	readonly detail?: string;
	readonly outcome: string;
	readonly tool: string;
}

interface TaskRow {
	readonly artifacts: readonly TaskArtifact[];
	readonly baseRef: string;
	readonly goal: string;
	readonly id: string;
	readonly logs: readonly TaskLogEntry[];
	readonly status: string;
	readonly timeline: readonly TaskTimelineEntry[];
	readonly worktreePath?: string;
}

interface GraphNode {
	readonly dependsOn: readonly string[];
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly status: string;
}

interface ProposalRow {
	readonly artifactMetadata: Readonly<Record<string, unknown>> | null;
	readonly changedFiles: readonly string[];
	readonly diff: string;
	readonly diffChecksum: string;
	readonly envChanges: readonly string[];
	readonly id: string;
	readonly motivation: string;
	readonly requiresRestart: boolean;
	readonly riskAssessment: string;
	readonly rollbackNotes: string;
	readonly sourceRevision: string;
	readonly status: string;
	readonly taskId: string;
	readonly testResult: Readonly<Record<string, unknown>> | null;
	readonly title: string;
}

interface ApprovalRow {
	readonly action: string;
	readonly expiresAtMs: number;
	readonly id: string;
	readonly proposalId?: string;
	readonly requestedBy: string;
	readonly status: string;
	readonly taskId: string;
}

interface DeploymentRow {
	readonly createdAtMs: number;
	readonly createdBy: string;
	readonly id: string;
	readonly postCheck: Readonly<{ ok?: boolean; message?: string }> | null;
	readonly preCheck: Readonly<{ ok?: boolean; message?: string }> | null;
	readonly proposalId: string;
	readonly reloadedAtMs: number | null;
	readonly rollbackOfId: string | null;
	readonly sourceRevision: string;
	readonly status: string;
	readonly taskId: string;
}

interface OverviewResponse {
	readonly policy: CodingPolicy;
	readonly stats: {
		readonly approvals: number;
		readonly deployments: number;
		readonly proposals: number;
		readonly tasks: number;
	};
	readonly tasks: readonly TaskRow[];
}

interface TaskDetailResponse {
	readonly approvals: readonly ApprovalRow[];
	readonly deployments: readonly DeploymentRow[];
	readonly graph: { readonly nodes: readonly GraphNode[] };
	readonly proposals: readonly ProposalRow[];
	readonly task: TaskRow;
	readonly worktree: { readonly commit: string | null; readonly path: string | null };
}

const rpcName = (method: string): string => `${SELF_ITERATION_PLUGIN_ID}.${method}`;
const joinList = (values: readonly string[]): string => values.join(", ");
const splitList = (value: string): string[] =>
	value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

function healthLabel(
	check: Readonly<{ ok?: boolean; message?: string }> | null,
	t: (key: string) => string,
): string {
	if (check === null) return t("none");
	return check.ok === true ? t("health_ok") : t("health_failed");
}

function ApprovalCard({
	approval,
	onChanged,
	proposal,
}: {
	approval: ApprovalRow;
	onChanged: () => Promise<void>;
	proposal: ProposalRow | undefined;
}) {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [note, setNote] = useState("");
	const resolve = async (action: "approve" | "reject") => {
		try {
			await panel.rpc.call(rpcName("approvals.resolve"), {
				action,
				approvalId: approval.id,
				note,
			});
			toast.success(t.t("approval_resolved"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};
	return (
		<div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="text-sm font-medium">
					{proposal?.title ?? approval.action} · {approval.status}
				</div>
				<div className="text-[11px] text-muted-foreground">
					{new Date(approval.expiresAtMs).toISOString()} · {approval.requestedBy}
				</div>
			</div>
			<div className="grid gap-1 text-xs sm:grid-cols-2">
				<span>
					<strong>{t.t("motivation")}:</strong> {proposal?.motivation ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("risk")}:</strong> {proposal?.riskAssessment ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("rollback")}:</strong> {proposal?.rollbackNotes ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("source_revision")}:</strong> {proposal?.sourceRevision ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("artifact_metadata")}:</strong>{" "}
					{proposal?.artifactMetadata === null || proposal?.artifactMetadata === undefined
						? t.t("none")
						: JSON.stringify(proposal.artifactMetadata)}
				</span>
				<span>
					<strong>{t.t("test_result")}:</strong>{" "}
					{proposal?.testResult === null || proposal?.testResult === undefined
						? t.t("none")
						: JSON.stringify(proposal.testResult)}
				</span>
				<span>
					<strong>{t.t("changed_files")}:</strong>{" "}
					{proposal === undefined ? t.t("none") : joinList(proposal.changedFiles)}
				</span>
				<span>
					<strong>{t.t("diff_checksum")}:</strong> {proposal?.diffChecksum ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("env_changes")}:</strong>{" "}
					{proposal === undefined ? t.t("none") : joinList(proposal.envChanges)}
				</span>
				<span>
					<strong>{t.t("requires_restart")}:</strong>{" "}
					{proposal?.requiresRestart === true ? t.t("yes") : t.t("no")}
				</span>
			</div>
			<Field label={t.t("approval_note")}>
				<Input value={note} onChange={setNote} />
			</Field>
			<div className="flex justify-end gap-2">
				<Button leadingIcon={<X />} size="xs" variant="danger" onClick={() => void resolve("reject")}>
					{t.t("approval_reject")}
				</Button>
				<Button leadingIcon={<Check />} size="xs" onClick={() => void resolve("approve")}>
					{t.t("approval_approve")}
				</Button>
			</div>
		</div>
	);
}

function DeploymentCard({
	deployment,
	onChanged,
}: {
	deployment: DeploymentRow;
	onChanged: () => Promise<void>;
}) {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [busy, setBusy] = useState(false);
	const deploy = async (dryRun: boolean) => {
		setBusy(true);
		try {
			await panel.rpc.call(rpcName("deployments.deploy"), {
				dryRun,
				proposalId: deployment.proposalId,
			});
			toast.success(t.t("deploy_done"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setBusy(false);
		}
	};
	const rollback = async () => {
		setBusy(true);
		try {
			await panel.rpc.call(rpcName("deployments.rollback"), {
				deploymentId: deployment.id,
			});
			toast.success(t.t("rollback_done"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="space-y-1 rounded-lg border border-border p-2 text-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">
					{deployment.status} · {deployment.id}
				</span>
				<span className="text-muted-foreground">
					{deployment.rollbackOfId === null ? "" : `${t.t("rollback_of")} ${deployment.rollbackOfId}`}
				</span>
			</div>
			<div className="flex flex-wrap gap-3 text-muted-foreground">
				<span>
					{t.t("pre_check")}: {healthLabel(deployment.preCheck, t.t)}
				</span>
				<span>
					{t.t("post_check")}: {healthLabel(deployment.postCheck, t.t)}
				</span>
				<span>
					{t.t("source_revision")}: {deployment.sourceRevision || t.t("none")}
				</span>
				<span>
					{t.t("created_by")}: {deployment.createdBy}
				</span>
			</div>
			{deployment.status === "manual_apply_required" ? (
				<p className="text-warning">{t.t("deployment_manual_apply")}</p>
			) : null}
			<div className="flex flex-wrap justify-end gap-2">
				<Button
					disabled={busy}
					leadingIcon={<Play />}
					size="xs"
					variant="secondary"
					onClick={() => void deploy(true)}
				>
					{t.t("deploy_dry_run")}
				</Button>
				<Button disabled={busy} leadingIcon={<Play />} size="xs" onClick={() => void deploy(false)}>
					{t.t("deploy")}
				</Button>
				{deployment.status === "deployed" ? (
					<Button
						disabled={busy}
						leadingIcon={<RotateCcw />}
						size="xs"
						variant="danger"
						onClick={() => void rollback()}
					>
						{t.t("rollback_action")}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function TaskDetail({
	detail,
	onChanged,
}: {
	detail: TaskDetailResponse | null;
	onChanged: () => Promise<void>;
}) {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	if (detail === null) return <EmptyState title={t.t("select_task")} />;
	const proposals = new Map(detail.proposals.map((proposal) => [proposal.id, proposal]));
	return (
		<div className="space-y-3">
			<div className="grid gap-2 text-xs sm:grid-cols-2">
				<span>
					<strong>{t.t("task_goal")}:</strong> {detail.task.goal}
				</span>
				<span>
					<strong>{t.t("task_status")}:</strong> {detail.task.status}
				</span>
				<span>
					<strong>{t.t("worktree")}:</strong> {detail.worktree.path ?? t.t("none")}
				</span>
				<span>
					<strong>{t.t("commit")}:</strong> {detail.worktree.commit ?? t.t("none")}
				</span>
			</div>
			<div>
				<div className="mb-1 text-xs font-medium">{t.t("task_graph")}</div>
				<div className="space-y-1">
					{detail.graph.nodes.map((node) => (
						<div
							key={node.id}
							className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-2 py-1 text-xs"
						>
							<span>
								{node.kind} · {node.label}
							</span>
							<span>{node.status}</span>
						</div>
					))}
				</div>
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				<div>
					<div className="mb-1 text-xs font-medium">{t.t("task_logs")}</div>
					{detail.task.logs.length === 0 ? (
						<EmptyState title={t.t("no_logs")} />
					) : (
						<div className="space-y-1 text-xs">
							{detail.task.logs.map((log, index) => (
								<div key={`${log.atMs}:${index}`} className="rounded border border-border px-2 py-1">
									{log.level} · {log.message}
								</div>
							))}
						</div>
					)}
				</div>
				<div>
					<div className="mb-1 text-xs font-medium">{t.t("task_artifacts")}</div>
					{detail.task.artifacts.length === 0 ? (
						<EmptyState title={t.t("no_artifacts")} />
					) : (
						<div className="space-y-1 text-xs">
							{detail.task.artifacts.map((artifact, index) => (
								<div
									key={`${artifact.kind}:${artifact.name}:${index}`}
									className="rounded border border-border px-2 py-1"
								>
									{artifact.kind} · {artifact.name}
									{artifact.checksum === undefined ? "" : ` · ${artifact.checksum.slice(0, 12)}`}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
			<div>
				<div className="mb-1 text-xs font-medium">{t.t("task_timeline")}</div>
				<div className="space-y-1 text-xs">
					{detail.task.timeline.map((entry, index) => (
						<div
							key={`${entry.atMs}:${entry.tool}:${index}`}
							className="flex flex-wrap justify-between gap-2 rounded border border-border px-2 py-1"
						>
							<span>{entry.tool}</span>
							<span>{entry.outcome}</span>
							<span>{entry.detail ?? t.t("none")}</span>
						</div>
					))}
				</div>
			</div>
			<div>
				<div className="mb-1 text-xs font-medium">{t.t("diff_viewer")}</div>
				{detail.proposals.length === 0 ? (
					<EmptyState title={t.t("proposals_empty")} />
				) : (
					<div className="space-y-2">
						{detail.proposals.map((proposal) => (
							<pre
								key={proposal.id}
								className="max-h-64 overflow-auto rounded border border-border bg-muted/40 p-2 text-[11px]"
							>
								{proposal.diff}
							</pre>
						))}
					</div>
				)}
			</div>
			<div>
				<div className="mb-1 text-xs font-medium">{t.t("approvals")}</div>
				{detail.approvals.filter((approval) => approval.status === "pending").length === 0 ? (
					<EmptyState title={t.t("approvals_empty")} />
				) : (
					<div className="space-y-2">
						{detail.approvals
							.filter((approval) => approval.status === "pending")
							.map((approval) => (
								<ApprovalCard
									key={approval.id}
									approval={approval}
									onChanged={async () => {
										await onChanged();
										await panel.refresh();
									}}
									proposal={
										approval.proposalId === undefined
											? undefined
											: proposals.get(approval.proposalId)
									}
								/>
							))}
					</div>
				)}
			</div>
			<div>
				<div className="mb-1 text-xs font-medium">{t.t("deployments")}</div>
				{detail.deployments.length === 0 ? (
					<EmptyState title={t.t("deployments_empty")} />
				) : (
					<div className="space-y-2">
						{detail.deployments.map((deployment) => (
							<DeploymentCard key={deployment.id} deployment={deployment} onChanged={async () => {
								await onChanged();
								await panel.refresh();
							}} />
						))}
					</div>
				)}
			</div>
			{detail.proposals.some((proposal) => proposal.status === "approved") ? (
				<Button
					leadingIcon={<ShieldCheck />}
					size="sm"
					onClick={() => toast.info(t.t("deploy"))}
				>
					{t.t("deploy")}
				</Button>
			) : null}
		</div>
	);
}

function SelfIterationPanel() {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [overview, setOverview] = useState<OverviewResponse | null>(null);
	const [tasks, setTasks] = useState<readonly TaskRow[]>([]);
	const [proposals, setProposals] = useState<readonly ProposalRow[]>([]);
	const [approvals, setApprovals] = useState<readonly ApprovalRow[]>([]);
	const [deployments, setDeployments] = useState<readonly DeploymentRow[]>([]);
	const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [goal, setGoal] = useState("");
	const [taskId, setTaskId] = useState("");
	const [autoApply, setAutoApply] = useState(false);
	const [allowedCommands, setAllowedCommands] = useState("");
	const [pathAllowlist, setPathAllowlist] = useState("");
	const [testCommand, setTestCommand] = useState("");
	const [buildCommand, setBuildCommand] = useState("");
	const [timeoutMs, setTimeoutMs] = useState("120000");
	const [checkTimeoutMs, setCheckTimeoutMs] = useState("600000");
	const [execTimeoutMs, setExecTimeoutMs] = useState("300000");
	const [maxOutputBytes, setMaxOutputBytes] = useState("65536");
	const [maxScriptBytes, setMaxScriptBytes] = useState("32768");
	const [maxDiffBytes, setMaxDiffBytes] = useState("262144");
	const [maxDiffFiles, setMaxDiffFiles] = useState("200");
	const [execNetwork, setExecNetwork] = useState<"none" | "outbound">("outbound");

	const applyPolicy = (policy: CodingPolicy): void => {
		setAutoApply(policy.autoApply);
		setAllowedCommands(joinList(policy.allowedCommands));
		setPathAllowlist(joinList(policy.pathAllowlist));
		setTestCommand(joinList(policy.testCommand));
		setBuildCommand(joinList(policy.buildCommand));
		setTimeoutMs(String(policy.timeoutMs));
		setCheckTimeoutMs(String(policy.checkTimeoutMs));
		setExecTimeoutMs(String(policy.execTimeoutMs));
		setMaxOutputBytes(String(policy.maxOutputBytes));
		setMaxScriptBytes(String(policy.maxScriptBytes));
		setMaxDiffBytes(String(policy.maxDiffBytes));
		setMaxDiffFiles(String(policy.maxDiffFiles));
		setExecNetwork(policy.execNetwork);
	};

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const [nextOverview, taskResult, proposalResult, approvalResult, deploymentResult] =
				await Promise.all([
					panel.rpc.call<OverviewResponse>(rpcName("overview")),
					panel.rpc.call<{ tasks: readonly TaskRow[] }>(rpcName("tasks.list"), { limit: 50 }),
					panel.rpc.call<{ proposals: readonly ProposalRow[] }>(rpcName("proposals.list"), {
						limit: 50,
					}),
					panel.rpc.call<{ approvals: readonly ApprovalRow[] }>(rpcName("approvals.list"), {
						limit: 50,
					}),
					panel.rpc.call<{ deployments: readonly DeploymentRow[] }>(rpcName("deployments.list"), {
						limit: 50,
					}),
				]);
			setOverview(nextOverview);
			setTasks(taskResult.tasks ?? []);
			setProposals(proposalResult.proposals ?? []);
			setApprovals(approvalResult.approvals ?? []);
			setDeployments(deploymentResult.deployments ?? []);
			applyPolicy(nextOverview.policy);
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
		} finally {
			setLoading(false);
		}
	};

	const loadTask = async (id: string): Promise<void> => {
		if (id.trim().length === 0) return;
		try {
			const next = await panel.rpc.call<TaskDetailResponse>(rpcName("tasks.get"), {
				taskId: id.trim(),
			});
			setDetail(next);
			setTaskId(id);
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
		}
	};

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const createTask = async () => {
		try {
			const task = await panel.rpc.call<TaskRow>(rpcName("tasks.create"), { goal });
			toast.success(t.t("task_created"));
			setGoal("");
			await refresh();
			if (typeof task.id === "string") await loadTask(task.id);
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const savePolicy = async () => {
		try {
			const policy = await panel.rpc.call<CodingPolicy>(rpcName("policy.update"), {
				patch: {
					allowedCommands: splitList(allowedCommands),
					autoApply,
					buildCommand: splitList(buildCommand),
					checkTimeoutMs: Number(checkTimeoutMs) || 600000,
					execNetwork,
					maxDiffBytes: Number(maxDiffBytes) || 0,
					maxDiffFiles: Number(maxDiffFiles) || 1,
					maxOutputBytes: Number(maxOutputBytes) || 0,
					maxScriptBytes: Number(maxScriptBytes) || 32768,
					pathAllowlist: splitList(pathAllowlist),
					testCommand: splitList(testCommand),
					timeoutMs: Number(timeoutMs) || 1000,
					execTimeoutMs: Number(execTimeoutMs) || 300000,
				},
			});
			applyPolicy(policy);
			toast.success(t.t("policy_saved"));
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
	return (
		<PluginPage
			actions={
				<Button
					disabled={loading}
					leadingIcon={<RefreshCw />}
					size="sm"
					variant="secondary"
					onClick={() => void refresh()}
				>
					{t.t("refresh")}
				</Button>
			}
			description={t.t("description")}
			title={t.t("title")}
		>
			<PluginSection title={t.t("overview")}>
				<StatGrid
					items={[
						{ label: t.t("stats_tasks"), value: overview?.stats.tasks ?? 0 },
						{ label: t.t("stats_proposals"), value: overview?.stats.proposals ?? 0 },
						{ label: t.t("stats_approvals"), value: overview?.stats.approvals ?? 0 },
						{ label: t.t("stats_deployments"), value: overview?.stats.deployments ?? 0 },
					]}
				/>
			</PluginSection>

			<PluginSection title={t.t("policy")} description={t.t("policy_description")}>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<label className="flex items-center gap-2 text-xs">
						<Switch ariaLabel={t.t("policy_auto_apply")} checked={autoApply} onCheckedChange={setAutoApply} />
						{t.t("policy_auto_apply")}
					</label>
					<Field label={t.t("policy_allowed_commands")}>
						<Input value={allowedCommands} onChange={setAllowedCommands} />
					</Field>
					<Field label={t.t("policy_path_allowlist")}>
						<Input value={pathAllowlist} onChange={setPathAllowlist} />
					</Field>
					<Field label={t.t("policy_test_command")}>
						<Input value={testCommand} onChange={setTestCommand} />
					</Field>
					<Field label={t.t("policy_build_command")}>
						<Input value={buildCommand} onChange={setBuildCommand} />
					</Field>
					<Field label={t.t("policy_timeout")}>
						<Input type="number" value={timeoutMs} onChange={setTimeoutMs} />
					</Field>
					<Field label={t.t("policy_check_timeout")}>
						<Input type="number" value={checkTimeoutMs} onChange={setCheckTimeoutMs} />
					</Field>
					<Field label={t.t("policy_exec_timeout")}>
						<Input type="number" value={execTimeoutMs} onChange={setExecTimeoutMs} />
					</Field>
					<Field label={t.t("policy_max_output")}>
						<Input type="number" value={maxOutputBytes} onChange={setMaxOutputBytes} />
					</Field>
					<Field label={t.t("policy_max_script_bytes")}>
						<Input type="number" value={maxScriptBytes} onChange={setMaxScriptBytes} />
					</Field>
					<Field label={t.t("policy_exec_network")}>
						<select
							className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-xs"
							value={execNetwork}
							onChange={(event) =>
								setExecNetwork(event.target.value === "none" ? "none" : "outbound")
							}
						>
							<option value="outbound">outbound</option>
							<option value="none">none</option>
						</select>
					</Field>
					<Field label={t.t("policy_max_diff_bytes")}>
						<Input type="number" value={maxDiffBytes} onChange={setMaxDiffBytes} />
					</Field>
					<Field label={t.t("policy_max_diff_files")}>
						<Input type="number" value={maxDiffFiles} onChange={setMaxDiffFiles} />
					</Field>
				</div>
				<div className="mt-3 flex justify-end">
					<Button leadingIcon={<Save />} size="sm" onClick={() => void savePolicy()}>
						{t.t("policy_save")}
					</Button>
				</div>
			</PluginSection>

			<PluginSection title={t.t("tasks")}>
				<div className="grid gap-2 sm:grid-cols-[1fr_auto]">
					<Field label={t.t("task_goal")}>
						<Input placeholder={t.t("goal_placeholder")} value={goal} onChange={setGoal} />
					</Field>
					<div className="flex items-end">
						<Button
							disabled={goal.trim().length === 0}
							size="sm"
							onClick={() => void createTask()}
						>
							{t.t("task_create")}
						</Button>
					</div>
				</div>
				<div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
					<Field label={t.t("task_detail")}>
						<Input placeholder={t.t("task_id_placeholder")} value={taskId} onChange={setTaskId} />
					</Field>
					<div className="flex items-end">
						<Button leadingIcon={<GitBranch />} size="sm" variant="secondary" onClick={() => void loadTask(taskId)}>
							{t.t("view")}
						</Button>
					</div>
				</div>
				{tasks.length === 0 ? (
					<EmptyState title={t.t("tasks_empty")} />
				) : (
					<div className="mt-3 space-y-1">
						{tasks.map((task) => (
							<button
								key={task.id}
								className="flex w-full flex-wrap items-center justify-between gap-2 rounded border border-border px-2 py-1 text-left text-xs hover:bg-muted/40"
								type="button"
								onClick={() => void loadTask(task.id)}
							>
								<span>{task.goal}</span>
								<span>{task.status}</span>
								<span>{task.id}</span>
							</button>
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("task_detail")}>
				<TaskDetail
					detail={detail}
					onChanged={async () => {
						if (detail !== null) await loadTask(detail.task.id);
					}}
				/>
			</PluginSection>

			<PluginSection title={t.t("proposals")}>
				{proposals.length === 0 ? (
					<EmptyState title={t.t("proposals_empty")} />
				) : (
					<div className="space-y-2">
						{proposals.map((proposal) => (
							<div key={proposal.id} className="rounded-lg border border-border p-2 text-xs">
								<div className="font-medium">
									{proposal.title} · {proposal.status}
								</div>
								<div className="text-muted-foreground">
									{proposal.changedFiles.join(", ") || t.t("none")} · {proposal.diffChecksum.slice(0, 12)}
								</div>
							</div>
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("approvals")}>
				{approvals.filter((approval) => approval.status === "pending").length === 0 ? (
					<EmptyState title={t.t("approvals_empty")} />
				) : (
					<div className="space-y-2">
						{approvals
							.filter((approval) => approval.status === "pending")
							.map((approval) => (
								<ApprovalCard
									key={approval.id}
									approval={approval}
									onChanged={async () => {
										await refresh();
										if (detail !== null) await loadTask(detail.task.id);
									}}
									proposal={
										approval.proposalId === undefined
											? undefined
											: proposalById.get(approval.proposalId)
									}
								/>
							))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("deployments")}>
				{deployments.length === 0 ? (
					<EmptyState title={t.t("deployments_empty")} />
				) : (
					<div className="space-y-2">
						{deployments.map((deployment) => (
							<DeploymentCard
								key={deployment.id}
								deployment={deployment}
								onChanged={async () => {
									await refresh();
									if (detail !== null) await loadTask(detail.task.id);
								}}
							/>
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={panel.plugin.name}>
				<div className="text-xs text-muted-foreground">
					{t.t("plugin_identity", { id: panel.plugin.id, version: panel.plugin.version })}
				</div>
			</PluginSection>
		</PluginPage>
	);
}

export default definePluginUi({
	description: (t) => t("plugin_description"),
	displayName: (t) => t("plugin_name"),
	i18n,
	icon: "terminal",
	panels: [
		{
			component: SelfIterationPanel,
			icon: "terminal",
			id: "self-iteration",
			title: (t) => t("panel_self_iteration"),
		},
	],
});
