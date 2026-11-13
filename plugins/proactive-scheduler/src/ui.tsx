"use client";

import {
	Alert,
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
import { Ban, Play, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProactivePolicy } from "./domain.ts";
import { i18n } from "./i18n.ts";
import { PROACTIVE_SCHEDULER_PLUGIN_ID } from "./manifest.ts";
import type { SimulationRow } from "./service.ts";

interface ScheduledTaskRow {
	readonly attempts: number;
	readonly conversationId: string;
	readonly id: string;
	readonly kind: string;
	readonly lastError: string | null;
	readonly maxAttempts: number;
	readonly occurrences: number;
	readonly prompt: string;
	readonly scheduledForMs: number;
	readonly status: string;
}

interface DecisionRow {
	readonly conversationId: string;
	readonly createdAtMs: number;
	readonly deliveryStatus: string | null;
	readonly gateResult: string;
	readonly id: string;
	readonly kind: string;
	readonly marker: string | null;
	readonly skippedReason: string | null;
}

interface OverviewResponse {
	readonly enabled: boolean;
	readonly globalPolicy: ProactivePolicy;
	readonly overrides: readonly { readonly policy: ProactivePolicy; readonly scope: string; readonly scopeId: string }[];
	readonly recentTasks: readonly ScheduledTaskRow[];
	readonly stats: {
		readonly decisions: number;
		readonly delivered: number;
		readonly pending: number;
		readonly skipped: number;
		readonly tasks: number;
	};
	readonly tick: { readonly intervalMs: number; readonly taskId: string | null };
}

const rpcName = (method: string): string => `${PROACTIVE_SCHEDULER_PLUGIN_ID}.${method}`;

function minutes(ms: number): string {
	return String(Math.round(ms / 60_000));
}
const toMs = (value: string): number => Math.max(0, Math.round(Number(value) || 0)) * 60_000;
const toRatio = (value: string): number => Math.min(1, Math.max(0, Number(value) || 0));

function TaskCard({
	onChanged,
	task,
}: {
	onChanged: () => Promise<void>;
	task: ScheduledTaskRow;
}) {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [prompt, setPrompt] = useState(task.prompt);
	const [saving, setSaving] = useState(false);
	const updatePrompt = async () => {
		setSaving(true);
		try {
			await panel.rpc.call(rpcName("tasks.updatePrompt"), { prompt, taskId: task.id });
			toast.success(t.t("policy_saved"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setSaving(false);
		}
	};
	const cancel = async () => {
		try {
			await panel.rpc.call(rpcName("tasks.cancel"), { taskId: task.id });
			toast.success(t.t("task_cancelled"));
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};
	return (
		<div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<div className="text-sm font-medium">
						{task.kind} · {task.status}
					</div>
					<div className="text-[11px] text-muted-foreground">
						{task.conversationId} · {new Date(task.scheduledForMs).toISOString()} ·{" "}
						{task.attempts}/{task.maxAttempts}
					</div>
				</div>
				<Button
					leadingIcon={<Ban />}
					size="xs"
					variant="danger"
					onClick={() => void cancel()}
				>
					{t.t("task_cancel")}
				</Button>
			</div>
			<Field label={t.t("task_prompt")}>
				<Input value={prompt} onChange={setPrompt} />
			</Field>
			<div className="flex justify-end">
				<Button
					disabled={saving}
					leadingIcon={<Save />}
					size="xs"
					variant="secondary"
					onClick={() => void updatePrompt()}
				>
					{t.t("task_update_prompt")}
				</Button>
			</div>
			{task.lastError === null ? null : <Alert tone="warning">{task.lastError}</Alert>}
		</div>
	);
}

function SchedulerPanel() {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [overview, setOverview] = useState<OverviewResponse | null>(null);
	const [tasks, setTasks] = useState<readonly ScheduledTaskRow[]>([]);
	const [decisions, setDecisions] = useState<readonly DecisionRow[]>([]);
	const [simulations, setSimulations] = useState<readonly SimulationRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [resetArmed, setResetArmed] = useState(false);
	const [simulateConversation, setSimulateConversation] = useState("");
	const [createConversation, setCreateConversation] = useState("");
	const [createPrompt, setCreatePrompt] = useState("");
	const [createKind, setCreateKind] = useState("remind");
	const [createDelay, setCreateDelay] = useState("10");
	const [dailyCap, setDailyCap] = useState("5");
	const [hourlyCap, setHourlyCap] = useState("2");
	const [cooldown, setCooldown] = useState("15");
	const [backoff, setBackoff] = useState("10");
	const [minMessages, setMinMessages] = useState("3");
	const [minIdle, setMinIdle] = useState("20");
	const [maxIdle, setMaxIdle] = useState("360");
	const [minWarmness, setMinWarmness] = useState("0.25");
	const [probability, setProbability] = useState("0.15");
	const [quietRanges, setQuietRanges] = useState("");
	const [enabled, setEnabled] = useState(false);
	const [bubbleGate, setBubbleGate] = useState(false);

	const applyPolicy = (policy: ProactivePolicy): void => {
		setEnabled(policy.enabled);
		setDailyCap(String(policy.dailyCap));
		setHourlyCap(String(policy.hourlyCap));
		setCooldown(minutes(policy.cooldownMs));
		setBackoff(minutes(policy.backoffMs));
		setMinMessages(String(policy.minMessages));
		setMinIdle(minutes(policy.minIdleMs));
		setMaxIdle(minutes(policy.maxIdleMs));
		setMinWarmness(String(policy.minWarmness));
		setProbability(String(policy.probability));
		setBubbleGate(policy.bubbleGate);
		setQuietRanges(
			policy.quietHours.ranges.map((range) => `${range.start}-${range.end}`).join(", "),
		);
	};

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const [nextOverview, taskResult, decisionResult] = await Promise.all([
				panel.rpc.call<OverviewResponse>(rpcName("overview")),
				panel.rpc.call<{ tasks: readonly ScheduledTaskRow[] }>(rpcName("tasks.list"), {
					limit: 50,
				}),
				panel.rpc.call<{ decisions: readonly DecisionRow[] }>(rpcName("decisions.list"), {
					limit: 30,
				}),
			]);
			setOverview(nextOverview);
			setTasks(taskResult.tasks ?? []);
			setDecisions(decisionResult.decisions ?? []);
			applyPolicy(nextOverview.globalPolicy);
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const savePolicy = async () => {
		try {
			const ranges = quietRanges
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
				.flatMap((entry) => {
					const [start, end] = entry.split("-").map((value) => value.trim());
					return start === undefined || end === undefined ? [] : [{ end, start }];
				});
			await panel.rpc.call(rpcName("policies.save"), {
				patch: {
					backoffMs: toMs(backoff),
					bubbleGate,
					cooldownMs: toMs(cooldown),
					dailyCap: Math.max(0, Number(dailyCap) || 0),
					enabled,
					hourlyCap: Math.max(0, Number(hourlyCap) || 0),
					maxIdleMs: toMs(maxIdle),
					minIdleMs: toMs(minIdle),
					minMessages: Math.max(0, Number(minMessages) || 0),
					minWarmness: toRatio(minWarmness),
					probability: toRatio(probability),
					quietHours: { enabled: ranges.length > 0, ranges, timezoneOffsetMinutes: 0 },
				},
				scope: "global",
			});
			toast.success(t.t("policy_saved"));
			await refresh();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const resetPolicies = async () => {
		if (!resetArmed) return;
		try {
			await panel.rpc.call(rpcName("policies.reset"), { confirm: true });
			toast.success(t.t("policy_reset_done"));
			setResetArmed(false);
			await refresh();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const runSimulation = async () => {
		try {
			const result = await panel.rpc.call<{ rows: readonly SimulationRow[] }>(
				rpcName("simulate"),
				simulateConversation.trim().length === 0
					? {}
					: { conversationId: simulateConversation.trim() },
			);
			setSimulations(result.rows ?? []);
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const runTick = async () => {
		try {
			await panel.rpc.call(rpcName("tick"));
			toast.success(t.t("tick_done"));
			await refresh();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const createTask = async () => {
		try {
			await panel.rpc.call(rpcName("tasks.create"), {
				conversationId: createConversation.trim(),
				delayMs: toMs(createDelay),
				kind: createKind,
				prompt: createPrompt,
			});
			toast.success(t.t("task_created"));
			setCreatePrompt("");
			await refresh();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const stats = overview?.stats;
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
						{ label: t.t("stats_enabled"), value: overview?.enabled ? t.t("enabled") : t.t("disabled") },
						{ label: t.t("stats_tasks"), value: stats?.tasks ?? 0 },
						{ label: t.t("stats_pending"), value: stats?.pending ?? 0 },
						{ label: t.t("stats_decisions"), value: stats?.decisions ?? 0 },
						{ label: t.t("stats_delivered"), value: stats?.delivered ?? 0 },
						{ label: t.t("stats_skipped"), value: stats?.skipped ?? 0 },
					]}
				/>
				<div className="mt-3 flex justify-end">
					<Button leadingIcon={<Play />} size="sm" onClick={() => void runTick()}>
						{t.t("tick")}
					</Button>
				</div>
			</PluginSection>

			<PluginSection description={t.t("policy_description")} title={t.t("policy")}>
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					<label className="flex items-center gap-2 text-xs">
						<Switch ariaLabel={t.t("policy_enabled")} checked={enabled} onCheckedChange={setEnabled} />
						{t.t("policy_enabled")}
					</label>
					<label className="flex items-center gap-2 text-xs">
						<Switch
							ariaLabel={t.t("policy_bubble_gate")}
							checked={bubbleGate}
							onCheckedChange={setBubbleGate}
						/>
						{t.t("policy_bubble_gate")}
					</label>
					<Field label={t.t("policy_daily_cap")}>
						<Input type="number" value={dailyCap} onChange={setDailyCap} />
					</Field>
					<Field label={t.t("policy_hourly_cap")}>
						<Input type="number" value={hourlyCap} onChange={setHourlyCap} />
					</Field>
					<Field label={t.t("policy_cooldown")}>
						<Input type="number" value={cooldown} onChange={setCooldown} />
					</Field>
					<Field label={t.t("policy_backoff")}>
						<Input type="number" value={backoff} onChange={setBackoff} />
					</Field>
					<Field label={t.t("policy_min_messages")}>
						<Input type="number" value={minMessages} onChange={setMinMessages} />
					</Field>
					<Field label={t.t("policy_min_idle")}>
						<Input type="number" value={minIdle} onChange={setMinIdle} />
					</Field>
					<Field label={t.t("policy_max_idle")}>
						<Input type="number" value={maxIdle} onChange={setMaxIdle} />
					</Field>
					<Field label={t.t("policy_min_warmness")}>
						<Input type="number" value={minWarmness} onChange={setMinWarmness} />
					</Field>
					<Field label={t.t("policy_probability")}>
						<Input type="number" value={probability} onChange={setProbability} />
					</Field>
					<Field label={t.t("policy_quiet_ranges")}>
						<Input value={quietRanges} onChange={setQuietRanges} />
					</Field>
				</div>
				<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
					<label className="flex items-center gap-2 text-xs">
						<Switch
							ariaLabel={t.t("policy_reset_arm")}
							checked={resetArmed}
							onCheckedChange={setResetArmed}
						/>
						{t.t("policy_reset_arm")}
					</label>
					<div className="flex gap-2">
						<Button
							disabled={!resetArmed}
							leadingIcon={<Trash2 />}
							size="sm"
							variant="danger"
							onClick={() => void resetPolicies()}
						>
							{t.t("policy_reset")}
						</Button>
						<Button leadingIcon={<Save />} size="sm" onClick={() => void savePolicy()}>
							{t.t("policy_save")}
						</Button>
					</div>
				</div>
			</PluginSection>

			<PluginSection title={t.t("tasks")}>
				<div className="grid gap-2 sm:grid-cols-[1fr_8rem_8rem_auto]">
					<Field label={t.t("task_conversation")}>
						<Input
							placeholder={t.t("conversation_placeholder")}
							value={createConversation}
							onChange={setCreateConversation}
						/>
					</Field>
					<Field label={t.t("task_kind")}>
						<Input value={createKind} onChange={setCreateKind} />
					</Field>
					<Field label={t.t("task_delay")}>
						<Input type="number" value={createDelay} onChange={setCreateDelay} />
					</Field>
					<div className="flex items-end">
						<Button
							disabled={createConversation.trim().length === 0 || createPrompt.trim().length === 0}
							size="sm"
							onClick={() => void createTask()}
						>
							{t.t("task_create")}
						</Button>
					</div>
				</div>
				<Field label={t.t("task_prompt")}>
					<Input value={createPrompt} onChange={setCreatePrompt} />
				</Field>
				{tasks.length === 0 ? (
					<EmptyState title={t.t("tasks_empty")} />
				) : (
					<div className="mt-3 space-y-2">
						{tasks.map((task) => (
							<TaskCard key={task.id} onChanged={refresh} task={task} />
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection description={t.t("simulate_description")} title={t.t("simulate")}>
				<div className="grid gap-2 sm:grid-cols-[1fr_auto]">
					<Field label={t.t("task_conversation")}>
						<Input
							placeholder={t.t("conversation_placeholder")}
							value={simulateConversation}
							onChange={setSimulateConversation}
						/>
					</Field>
					<div className="flex items-end">
						<Button leadingIcon={<Play />} size="sm" variant="secondary" onClick={() => void runSimulation()}>
							{t.t("simulate_run")}
						</Button>
					</div>
				</div>
				<Alert tone="info">{t.t("simulate_only")}</Alert>
				{simulations.length === 0 ? null : (
					<div className="mt-2 space-y-2">
						{simulations.map((row) => (
							<div key={row.conversationId} className="rounded-lg border border-border p-2 text-xs">
								<div className="font-medium">
									{row.conversationId} · {row.eligible ? t.t("gate_passed") : t.t("gate_blocked")}
								</div>
								<div className="mt-1 flex flex-wrap gap-1">
									{row.gates.map((gate) => (
										<span key={`${row.conversationId}:${gate.gate}`} className="rounded bg-muted px-1.5 py-0.5">
											{gate.gate}: {gate.status}
										</span>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection title={t.t("decisions")}>
				{decisions.length === 0 ? (
					<EmptyState title={t.t("decisions_empty")} />
				) : (
					<div className="space-y-1 text-xs">
						{decisions.map((decision) => (
							<div key={decision.id} className="flex flex-wrap justify-between gap-2 rounded border border-border px-2 py-1">
								<span>{decision.kind}</span>
								<span>{decision.gateResult}</span>
								<span>{decision.deliveryStatus ?? t.t("none")}</span>
								<span>{decision.marker ?? t.t("none")}</span>
								<span>{new Date(decision.createdAtMs).toISOString()}</span>
							</div>
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
	icon: "puzzle",
	panels: [
		{
			component: SchedulerPanel,
			icon: "puzzle",
			id: "scheduler",
			title: (t) => t("panel_scheduler"),
		},
	],
});
