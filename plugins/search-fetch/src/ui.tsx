"use client";

import {
	Alert,
	Button,
	EmptyState,
	Field,
	Input,
	PluginPage,
	PluginSection,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StatGrid,
	Switch,
	definePluginUi,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@elaina/sdk/ui";
import { RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { i18n } from "./i18n.ts";
import { SEARCH_FETCH_PLUGIN_ID } from "./manifest.ts";

interface ProviderStatusRow {
	readonly cooldownUntilMs: number | null;
	readonly failures: number;
	readonly lastError?: string;
	readonly perHour: number;
	readonly perMinute: number;
	readonly ready: boolean;
	readonly usedHour: number;
	readonly usedMinute: number;
}

interface ProviderRow {
	readonly capabilities: readonly string[];
	readonly configured: boolean;
	readonly enabled: boolean;
	readonly id: string;
	readonly label: string;
	readonly priority: number;
	readonly rateLimit: { readonly perHour: number; readonly perMinute: number };
	readonly status: ProviderStatusRow;
}

interface CacheStats {
	readonly bytes: number;
	readonly entries: number;
	readonly maxBytes: number;
	readonly maxEntries: number;
	readonly scopedEntries: number;
	readonly ttlMs: number;
}

interface PolicyRow {
	readonly allowDomains: readonly string[];
	readonly blockDomains: readonly string[];
	readonly cache: { readonly maxBytes: number; readonly maxEntries: number; readonly ttlMs: number };
}

interface Overview {
	readonly cache: CacheStats;
	readonly policy: PolicyRow;
	readonly providers: readonly ProviderRow[];
}

interface SearchResultRow {
	readonly domain: string;
	readonly providerId: string;
	readonly score: number;
	readonly snippet: string;
	readonly title: string;
	readonly url: string;
}

interface TestResult {
	readonly error?: string;
	readonly latencyMs: number;
	readonly provider: string;
	readonly resultCount: number;
	readonly results: readonly SearchResultRow[];
	readonly status: string;
}

const rpcName = (method: string): string => `${SEARCH_FETCH_PLUGIN_ID}.${method}`;
const list = (value: string): string[] =>
	value
		.split(/[,，]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
const join = (values: readonly string[]): string => values.join(", ");

function ProviderCard({
	onChanged,
	provider,
}: {
	onChanged: () => Promise<void>;
	provider: ProviderRow;
}) {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [priority, setPriority] = useState(String(provider.priority));
	const [saving, setSaving] = useState(false);
	const update = async (input: Record<string, unknown>, message: string) => {
		setSaving(true);
		try {
			await rpc.call(rpcName("providers.update"), { id: provider.id, ...input });
			toast.success(message);
			await onChanged();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setSaving(false);
		}
	};
	const cooldown =
		provider.status.cooldownUntilMs === null
			? t.t("provider_ready")
			: `${t.t("provider_cooldown")} ${new Date(provider.status.cooldownUntilMs).toLocaleTimeString()}`;
	return (
		<div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{provider.label}</div>
					<div className="text-[11px] text-muted-foreground">
						{provider.id} · {t.t("provider_capabilities")}:{" "}
						{provider.capabilities.length === 0 ? "—" : provider.capabilities.join(", ")}
					</div>
					<div className="text-[11px] text-muted-foreground">
						{t.t("provider_rate")}: {provider.rateLimit.perMinute}/min ·{" "}
						{provider.rateLimit.perHour}/h · {provider.status.usedMinute}/{provider.status.usedHour}{" "}
						· {cooldown}
					</div>
					{provider.status.lastError === undefined ? null : (
						<div className="text-[11px] text-warning">{provider.status.lastError}</div>
					)}
				</div>
				<div className="flex items-center gap-2">
					<Switch
						ariaLabel={t.t("provider_enabled")}
						checked={provider.enabled}
						onCheckedChange={() => {
							void update({ enabled: !provider.enabled }, t.t("save_success"));
						}}
					/>
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
				<Field label={t.t("provider_priority")}>
					<Input type="number" value={priority} onChange={setPriority} />
				</Field>
				<div className="flex items-end">
					<Button
						disabled={saving}
						leadingIcon={<Save />}
						size="xs"
						variant="secondary"
						onClick={() =>
							void update(
								{ priority: Math.max(0, Number(priority) || 0) },
								t.t("save_success"),
							)
						}
					>
						{t.t("provider_save")}
					</Button>
				</div>
				<div className="flex items-end">
					<Button
						disabled={saving}
						size="xs"
						variant="ghost"
						onClick={() => void update({ resetCooldown: true }, t.t("save_success"))}
					>
						{t.t("reset_cooldown")}
					</Button>
				</div>
			</div>
		</div>
	);
}

function SearchFetchPanel() {
	const t = usePluginI18n();
	const rpc = usePluginRpc();
	const { plugin } = usePluginPanel();
	const toast = usePluginToast();
	const [overview, setOverview] = useState<Overview | null>(null);
	const [blocks, setBlocks] = useState("");
	const [allows, setAllows] = useState("");
	const [perMinute, setPerMinute] = useState("20");
	const [perHour, setPerHour] = useState("120");
	const [ttlSeconds, setTtlSeconds] = useState("600");
	const [query, setQuery] = useState("");
	const [provider, setProvider] = useState("auto");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<TestResult | null>(null);
	const [loading, setLoading] = useState(false);

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const next = await rpc.call<Overview>(rpcName("overview"));
			setOverview(next);
			setBlocks(join(next.policy.blockDomains));
			setAllows(join(next.policy.allowDomains));
			setTtlSeconds(String(Math.round(next.policy.cache.ttlMs / 1_000)));
			const first = next.providers[0];
			if (first !== undefined) {
				setPerMinute(String(first.rateLimit.perMinute));
				setPerHour(String(first.rateLimit.perHour));
			}
			if (provider !== "auto" && !next.providers.some((row) => row.id === provider)) {
				setProvider("auto");
			}
		} catch (error) {
			toast.error(t.t("load_failed"), String(error));
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
			const providers = overview?.providers ?? [];
			const rateLimits = Object.fromEntries(
				providers.map((row) => [
					row.id,
					{
						perHour: Math.max(1, Number(perHour) || 120),
						perMinute: Math.max(1, Number(perMinute) || 20),
					},
				]),
			);
			await rpc.call(rpcName("policy.update"), {
				allowDomains: list(allows),
				blockDomains: list(blocks),
				cache: { ttlMs: Math.max(1, Number(ttlSeconds) || 600) * 1_000 },
				rateLimits,
			});
			toast.success(t.t("policy_saved"));
			await refresh();
		} catch (error) {
			toast.error(t.t("policy_failed"), String(error));
		}
	};

	const clearCache = async () => {
		try {
			await rpc.call(rpcName("cache.clear"), {});
			toast.success(t.t("cache_cleared"));
			await refresh();
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		}
	};

	const runTest = async () => {
		setTesting(true);
		try {
			const result = await rpc.call<TestResult>(rpcName("testQuery"), {
				provider,
				query,
			});
			setTestResult(result);
		} catch (error) {
			toast.error(t.t("save_failed"), String(error));
		} finally {
			setTesting(false);
		}
	};

	const providers = overview?.providers ?? [];
	const cache = overview?.cache;
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
			<PluginSection title={t.t("stats")}>
				<StatGrid
					items={[
						{ label: t.t("stats_providers"), value: providers.length },
						{
							label: t.t("stats_enabled"),
							value: providers.filter((row) => row.enabled).length,
						},
						{ label: t.t("stats_cache_entries"), value: cache?.entries ?? 0 },
						{ label: t.t("stats_cache_bytes"), value: cache?.bytes ?? 0 },
					]}
				/>
			</PluginSection>

			<PluginSection title={t.t("providers")}>
				{providers.length === 0 ? (
					<EmptyState title={t.t("providers_empty")} />
				) : (
					<div className="space-y-2">
						{providers.map((row) => (
							<ProviderCard key={row.id} provider={row} onChanged={refresh} />
						))}
					</div>
				)}
			</PluginSection>

			<PluginSection description={t.t("policy_description")} title={t.t("policy")}>
				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={t.t("policy_block_domains")}>
						<Input value={blocks} onChange={setBlocks} />
					</Field>
					<Field label={t.t("policy_allow_domains")}>
						<Input value={allows} onChange={setAllows} />
					</Field>
					<Field label={t.t("policy_rate_minute")}>
						<Input type="number" value={perMinute} onChange={setPerMinute} />
					</Field>
					<Field label={t.t("policy_rate_hour")}>
						<Input type="number" value={perHour} onChange={setPerHour} />
					</Field>
					<Field label={t.t("cache_ttl")}>
						<Input type="number" value={ttlSeconds} onChange={setTtlSeconds} />
					</Field>
				</div>
				<div className="mt-3 flex justify-end">
					<Button leadingIcon={<Save />} size="sm" onClick={() => void savePolicy()}>
						{t.t("policy_save")}
					</Button>
				</div>
			</PluginSection>

			<PluginSection title={t.t("cache")}>
				{cache === undefined || cache.entries === 0 ? (
					<EmptyState title={t.t("cache_empty")} />
				) : (
					<StatGrid
						items={[
							{ label: t.t("stats_cache_entries"), value: cache.entries },
							{ label: t.t("stats_cache_bytes"), value: cache.bytes },
							{ label: t.t("cache_ttl"), value: Math.round(cache.ttlMs / 1_000) },
						]}
					/>
				)}
				<div className="mt-3 flex justify-end">
					<Button
						leadingIcon={<Trash2 />}
						size="sm"
						variant="secondary"
						onClick={() => void clearCache()}
					>
						{t.t("cache_clear")}
					</Button>
				</div>
			</PluginSection>

			<PluginSection title={t.t("test_query")}>
				<div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]">
					<Field label={t.t("test_query")}>
						<Input
							placeholder={t.t("test_query_placeholder")}
							value={query}
							onChange={setQuery}
						/>
					</Field>
					<Field label={t.t("test_provider")}>
						<Select value={provider} onValueChange={setProvider}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="auto">{t.t("test_auto")}</SelectItem>
								{providers.map((row) => (
									<SelectItem key={row.id} value={row.id}>
										{row.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<div className="flex items-end">
						<Button
							disabled={testing || query.trim().length === 0}
							leadingIcon={<Search />}
							size="sm"
							onClick={() => void runTest()}
						>
							{testing ? t.t("test_running") : t.t("test_run")}
						</Button>
					</div>
				</div>
				{testResult === null ? null : (
					<div className="mt-3 space-y-2">
						<StatGrid
							items={[
								{ label: t.t("test_provider"), value: testResult.provider },
								{ label: t.t("test_status"), value: testResult.status },
								{ label: t.t("test_results"), value: testResult.resultCount },
								{
									label: t.t("test_latency"),
									value: `${testResult.latencyMs} ms`,
								},
							]}
						/>
						{testResult.error === undefined ? null : (
							<Alert tone="warning">
								{t.t("test_error")}: {testResult.error}
							</Alert>
						)}
						{testResult.results.length === 0 ? (
							<div className="text-xs text-muted-foreground">{t.t("test_empty")}</div>
						) : (
							<div className="space-y-1">
								{testResult.results.map((result) => (
									<div key={result.url} className="rounded-lg border border-border px-3 py-2">
										<div className="truncate text-sm font-medium">{result.title}</div>
										<div className="truncate text-[11px] text-muted-foreground">
											{result.url} · {result.providerId} · {result.score}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</PluginSection>

			<PluginSection title={plugin.name}>
				<div className="text-xs text-muted-foreground">
					{t.t("plugin_identity", { id: plugin.id, version: plugin.version })}
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
			component: SearchFetchPanel,
			icon: "puzzle",
			id: "providers",
			title: (t) => t("panel_search"),
		},
	],
});
