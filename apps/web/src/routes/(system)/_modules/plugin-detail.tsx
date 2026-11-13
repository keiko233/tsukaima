"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	Activity,
	ArrowLeft,
	ChartNoAxesColumn,
	List,
	MessageSquare,
	Plug,
	Puzzle,
	RefreshCw,
	Settings,
	Terminal,
} from "lucide-react";
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PluginPanelIcon, PluginUiModuleDefinition } from "@elaina/sdk/ui";
import {
	Alert,
	Button,
	EmptyState,
	KeyValueList,
	PluginConfigForm,
	PluginPanelProvider,
	PluginSection,
	StatusBadge,
	StatGrid,
	Skeleton,
	statusText,
	usePluginPanel,
} from "@elaina/sdk/ui";
import type { PluginI18n } from "@elaina/sdk/i18n";
import type { PluginRow, PluginStatusSnapshot } from "@/lib/api";
import { client, orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { pluginUiLoader } from "@/plugins/registry";
import { Modal, ModalActions } from "@/routes/_modules/ui/modal";

const PANEL_ICONS: Record<PluginPanelIcon, ReactNode> = {
	activity: <Activity className="size-4" />,
	chart: <ChartNoAxesColumn className="size-4" />,
	list: <List className="size-4" />,
	message: <MessageSquare className="size-4" />,
	plug: <Plug className="size-4" />,
	puzzle: <Puzzle className="size-4" />,
	settings: <Settings className="size-4" />,
	terminal: <Terminal className="size-4" />,
};

type UiState =
	| { readonly state: "loading" }
	| { readonly state: "none" }
	| { readonly state: "ready"; readonly definition: PluginUiModuleDefinition; readonly i18n: PluginI18n | null }
	| { readonly state: "error"; readonly error: string };

function statusLevelLabel(plugin: PluginRow): string {
	if (plugin.enabled !== 1) return m.plugins_status_disabled();
	switch (plugin.status?.level) {
		case "ok":
			return m.plugins_status_ok();
		case "warning":
			return m.plugins_status_warning();
		case "error":
			return m.plugins_status_error();
		default:
			return m.plugins_status_unknown();
	}
}

function statusMessage(plugin: PluginRow, i18n: PluginI18n | null): string | undefined {
	const status = plugin.status;
	if (status === null) return undefined;
	if (i18n !== null && status.code !== undefined) {
		const localized = statusText(i18n, status);
		if (localized !== undefined) return localized;
	}
	return status.summary;
}

function isStale(status: PluginStatusSnapshot | null): boolean {
	if (status?.staleAfterMs === undefined) return false;
	return Date.now() - new Date(status.updatedAt).getTime() > status.staleAfterMs;
}

function relativeTime(value: string): string {
	const date = new Date(value);
	const seconds = Math.round((date.getTime() - Date.now()) / 1000);
	const formatter = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
	if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
	const minutes = Math.round(seconds / 60);
	if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
	return formatter.format(Math.round(hours / 24), "day");
}

export function PluginStatusPanel({
	plugin,
	i18n = null,
}: {
	plugin: PluginRow;
	i18n?: PluginI18n | null;
}) {
	const status = plugin.status;
	const message = statusMessage(plugin, i18n);
	const stale = isStale(status);
	const metrics =
		status?.metrics === undefined
			? []
			: Object.entries(status.metrics).map(([label, value]) => ({
					label,
					value: String(value),
				}));
	const details =
		status?.details === undefined
			? []
			: Object.entries(status.details).map(([label, value]) => ({
					label,
					value: value === null ? "—" : String(value),
				}));
	const progress = status?.progress;

	return (
		<PluginSection
			title={m.plugins_tab_status()}
			actions={
				<StatusBadge
					disabled={plugin.enabled !== 1}
					label={statusLevelLabel(plugin)}
					stale={stale}
					status={status}
				/>
			}
		>
			<div className="space-y-4">
				{status === null ? (
					<p className="text-sm text-muted-foreground">{m.plugins_status_never()}</p>
				) : (
					<div className="space-y-1">
						{message ? <p className="text-sm">{message}</p> : null}
						{status.message ? (
							<p className="whitespace-pre-wrap text-xs text-muted-foreground">
								{status.message}
							</p>
						) : null}
						<p className="text-[11px] text-muted-foreground">
							{stale ? `${m.plugins_status_stale()} · ` : ""}
							{m.plugins_status_updated({ time: relativeTime(status.updatedAt) })}
						</p>
					</div>
				)}
				{progress ? (
					<div className="space-y-1.5">
						<div className="flex justify-between text-xs text-muted-foreground">
							<span>{progress.label}</span>
							<span>
								{progress.total === undefined
									? progress.current
									: m.plugins_status_progress({
											current: progress.current,
											total: progress.total,
										})}
							</span>
						</div>
						<div
							role="progressbar"
							aria-valuemax={progress.total}
							aria-valuemin={0}
							aria-valuenow={progress.current}
							className="h-1.5 overflow-hidden rounded-full bg-muted"
						>
							<div
								className="h-full rounded-full bg-primary transition-[width] duration-300"
								style={{
									width: `${progress.total === undefined ? 0 : Math.min(100, (progress.current / progress.total) * 100)}%`,
								}}
							/>
						</div>
					</div>
				) : null}
				{metrics.length > 0 ? (
					<div className="space-y-2">
						<div className="text-xs font-medium text-muted-foreground">
							{m.plugins_status_metrics()}
						</div>
						<StatGrid items={metrics} />
					</div>
				) : null}
				{details.length > 0 ? (
					<div className="space-y-2">
						<div className="text-xs font-medium text-muted-foreground">
							{m.plugins_status_details()}
						</div>
						<KeyValueList items={details} />
					</div>
				) : null}
			</div>
		</PluginSection>
	);
}

function ManifestPanel({ plugin }: { plugin: PluginRow }) {
	const none = m.plugins_facts_none();
	const list = (items: readonly string[]) =>
		items.length === 0 ? (
			<span className="text-muted-foreground">{none}</span>
		) : (
			<span className="flex flex-wrap gap-1">
				{items.map((item) => (
					<code
						key={item}
						className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
					>
						{item}
					</code>
				))}
			</span>
		);
	return (
		<PluginSection title={m.plugins_facts()}>
			<KeyValueList
				items={[
					{ label: m.plugins_kind(), value: plugin.kind },
					{ label: m.plugins_run_mode(), value: plugin.runMode },
					{ label: m.plugins_facts_permissions(), value: list(plugin.permissions) },
					{ label: m.plugins_facts_tools(), value: list(plugin.tools) },
					{ label: m.plugins_facts_rpc(), value: list(plugin.rpcMethods) },
					{ label: m.plugins_facts_providers(), value: list(plugin.modelProviders) },
				]}
			/>
		</PluginSection>
	);
}

class PanelBoundary extends Component<
	{ readonly children: ReactNode; readonly pluginId: string },
	{ readonly error: string | null }
> {
	override state = { error: null as string | null };

	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}

	override render() {
		if (this.state.error === null) return this.props.children;
		return (
			<Alert tone="danger" title={m.plugins_panel_error()}>
				<div className="space-y-2">
					<p className="font-mono text-[11px]">{this.state.error}</p>
					<Button
						size="sm"
						variant="secondary"
						onClick={() => this.setState({ error: null })}
					>
						{m.plugins_panel_retry()}
					</Button>
				</div>
			</Alert>
		);
	}
}

function PanelHost({ plugin, ui }: { plugin: PluginRow; ui: PluginUiModuleDefinition }) {
	const [active, setActive] = useState(ui.panels[0]?.id);
	const i18n = usePluginPanel().i18n;
	const panel = ui.panels.find((candidate) => candidate.id === active) ?? ui.panels[0];
	if (panel === undefined) return null;
	const Panel = panel.component;

	return (
		<div className="space-y-4">
			{ui.panels.length > 1 ? (
				<div
					role="tablist"
					aria-label={plugin.name}
					className="flex flex-wrap gap-1 border-b border-border pb-1"
				>
					{ui.panels.map((candidate) => {
						const selected = candidate.id === panel.id;
						return (
							<Button
								key={candidate.id}
								role="tab"
								aria-selected={selected}
								className="rounded-md"
								leadingIcon={candidate.icon ? PANEL_ICONS[candidate.icon] : undefined}
								onClick={() => setActive(candidate.id)}
								size="sm"
								variant={selected ? "secondary" : "ghost"}
							>
								{candidate.title((key) => i18n.t(key))}
							</Button>
						);
					})}
				</div>
			) : null}
			<div role="tabpanel">
				<PanelBoundary pluginId={plugin.id}>
					<Suspense fallback={<Skeleton className="h-40 w-full" />}>
						<Panel />
					</Suspense>
				</PanelBoundary>
			</div>
		</div>
	);
}

export function PluginDetail({ plugin }: { plugin: PluginRow }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const loader = useMemo(() => pluginUiLoader(plugin.id), [plugin.id]);
	const [ui, setUi] = useState<UiState>(() =>
		loader === undefined ? { state: "none" } : { state: "loading" },
	);
	const [warningOpen, setWarningOpen] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const trusted = plugin.kind !== "third-party";
	const needsWarning = !trusted && ui.state === "ready";

	useEffect(() => {
		setConfirmed(false);
		setWarningOpen(false);
	}, [plugin.id]);

	const setEnabled = useMutation(
		orpc.admin.plugins.setEnabled.mutationOptions({
			onError: (error) =>
				toast.error(m.plugins_toggle_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.plugins_toggle_updated());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.plugins.key() });
				await queryClient.invalidateQueries({ queryKey: orpc.admin.diagnostics.key() });
			},
		}),
	);
	const updateConfig = useMutation(
		orpc.admin.plugins.updateConfig.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_settings_save_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.toast_settings_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.plugins.key() });
			},
		}),
	);
	const refreshQuery = async () => {
		try {
			await queryClient.invalidateQueries({ queryKey: orpc.admin.plugins.key() });
		} catch (error) {
			toast.error(m.plugins_status_refresh_failed(), { description: errorMessage(error) });
		}
	};

	useEffect(() => {
		if (loader === undefined) {
			setUi({ state: "none" });
			return;
		}
		let cancelled = false;
		setUi({ state: "loading" });
		void loader()
			.then((module) => {
				if (cancelled) return;
				const definition = (module as { readonly default: PluginUiModuleDefinition }).default;
				const i18n =
					definition.i18n === undefined ? null : definition.i18n.bind(getLocale());
				setUi({ definition, i18n, state: "ready" });
				if (plugin.kind === "third-party") setWarningOpen(true);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setUi({ error: errorMessage(error), state: "error" });
			});
		return () => {
			cancelled = true;
		};
	}, [loader, plugin.kind]);

	const t = useMemo(() => (ui.state === "ready" && ui.i18n !== null ? ui.i18n : null), [ui]);
	const displayName =
		t !== null && ui.state === "ready" && ui.definition.displayName !== undefined
			? ui.definition.displayName((key) => t.t(key))
			: plugin.name;
	const description =
		t !== null && ui.state === "ready" && ui.definition.description !== undefined
			? ui.definition.description((key) => t.t(key))
			: undefined;
	const showPanels = ui.state === "ready" && (!needsWarning || confirmed);

	const context = {
		config: {
			save: async (patch: Record<string, unknown>) => {
				await updateConfig.mutateAsync({ config: patch, pluginId: plugin.id });
			},
			saving: updateConfig.isPending,
			secretsSet: plugin.secretsSet,
			value: plugin.config,
		},
		i18n: t ?? {
			formatDate: (value: Date | number | string) => String(value),
			formatNumber: (value: number) => String(value),
			locale: getLocale(),
			locales: [getLocale()],
			t: (key: string) => key,
		},
		notify: {
			error: (message: string, detail?: string) =>
				toast.error(message, detail === undefined ? undefined : { description: detail }),
			info: (message: string, detail?: string) =>
				toast.info(message, detail === undefined ? undefined : { description: detail }),
			success: (message: string, detail?: string) =>
				toast.success(message, detail === undefined ? undefined : { description: detail }),
		},
		plugin,
		refresh: refreshQuery,
		rpc: {
			call: async <T,>(method: string, input?: unknown): Promise<T> =>
				(await client.admin.plugins.rpc({ input, method, pluginId: plugin.id })) as T,
		},
		status: plugin.status,
	};

	return (
		<div className="space-y-5">
			<header className="space-y-3">
				<Button
					className="-ml-2 md:hidden"
					leadingIcon={<ArrowLeft />}
					onClick={() => void navigate({ to: "/plugins" })}
					size="sm"
					variant="ghost"
				>
					{m.plugins_back()}
				</Button>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="truncate text-xl font-semibold tracking-tight">{displayName}</h1>
							<StatusBadge
								disabled={plugin.enabled !== 1}
								label={statusLevelLabel(plugin)}
								stale={isStale(plugin.status)}
								status={plugin.status}
							/>
							<span className="text-xs text-muted-foreground">v{plugin.version}</span>
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							{description ?? `${plugin.kind} · ${plugin.runMode}`}
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" variant="secondary" onClick={() => void refreshQuery()}>
							<RefreshCw className="size-3.5" />
							{m.plugins_refresh_status()}
						</Button>
						<Button
							size="sm"
							variant={plugin.enabled === 1 ? "outline" : "primary"}
							disabled={setEnabled.isPending}
							onClick={() =>
								setEnabled.mutate({
									enabled: plugin.enabled !== 1,
									pluginId: plugin.id,
								})
							}
						>
							{plugin.enabled === 1 ? m.plugins_disable() : m.plugins_enable()}
						</Button>
					</div>
				</div>
				{plugin.enabled !== 1 ? (
					<Alert tone="warning">{m.plugins_enabled_hint()}</Alert>
				) : null}
			</header>

			{ui.state === "loading" ? <Skeleton className="h-40 w-full" /> : null}
			{ui.state === "error" ? (
				<Alert tone="danger" title={m.plugins_panel_error()}>
					{ui.error}
				</Alert>
			) : null}

			{showPanels && ui.state === "ready" ? (
				<PluginPanelProvider value={context}>
					<PanelHost plugin={plugin} ui={ui.definition} />
				</PluginPanelProvider>
			) : (
				<>
					<PluginStatusPanel i18n={t} plugin={plugin} />
					{needsWarning && !confirmed ? (
						<EmptyState
							action={
								<Button size="sm" variant="secondary" onClick={() => setWarningOpen(true)}>
									{m.plugins_custom_ui_confirm()}
								</Button>
							}
							description={m.plugins_custom_ui_notice()}
							icon={<Puzzle className="size-5" />}
							title={m.plugins_custom_ui_warning_title()}
						/>
					) : null}
					{ui.state === "none" ? (
						<EmptyState
							description={m.plugins_no_custom_ui()}
							icon={<Puzzle className="size-5" />}
							title={m.plugins_no_custom_ui()}
						/>
					) : null}
					<PluginSection title={m.plugins_config_title()}>
						<PluginConfigForm
							labels={{
								configured: m.plugins_config_configured(),
								empty: m.plugins_config_empty(),
								save: m.settings_save(),
								unset: m.plugins_config_unset(),
							}}
							onSave={async (patch) => {
								await updateConfig.mutateAsync({ config: patch, pluginId: plugin.id });
							}}
							saving={updateConfig.isPending}
							schema={plugin.configSchema}
							secretKeys={plugin.secretKeys}
							secretsSet={plugin.secretsSet}
							value={plugin.config}
						/>
					</PluginSection>
					<ManifestPanel plugin={plugin} />
				</>
			)}

			<Modal
				description={m.plugins_custom_ui_notice()}
				onOpenChange={setWarningOpen}
				open={warningOpen}
				title={m.plugins_custom_ui_warning_title()}
			>
				<Alert tone="warning">{m.plugins_custom_ui_notice()}</Alert>
				<ModalActions>
					<Button variant="ghost" onClick={() => setWarningOpen(false)}>
						{m.plugins_custom_ui_cancel()}
					</Button>
					<Button
						onClick={() => {
							setConfirmed(true);
							setWarningOpen(false);
						}}
					>
						{m.plugins_custom_ui_confirm()}
					</Button>
				</ModalActions>
			</Modal>
		</div>
	);
}
