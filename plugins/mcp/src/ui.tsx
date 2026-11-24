"use client";

import type { McpServerSnapshot } from "@tsukaima/contracts";
import { clamp } from "es-toolkit";
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
import { Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { i18n } from "./i18n.ts";
import { MCP_PLUGIN_ID } from "./manifest.ts";

type Scope = McpServerSnapshot["scope"];
type Surface = McpServerSnapshot["surface"];
type TransportType = "http" | "stdio";

interface FormState {
	allowedTools: string;
	args: string;
	command: string;
	cwd: string;
	deferred: boolean;
	disabledTools: string;
	editingId: string | undefined;
	enabled: boolean;
	env: string;
	headers: string;
	id: string;
	name: string;
	scope: Scope;
	surface: Surface;
	timeoutMs: string;
	transportType: TransportType;
	url: string;
}

const rpc = (method: string): string => `${MCP_PLUGIN_ID}.${method}`;

function blankForm(): FormState {
	return {
		allowedTools: "",
		args: "",
		command: "",
		cwd: "",
		deferred: true,
		disabledTools: "",
		editingId: undefined,
		enabled: true,
		env: "",
		headers: "",
		id: "",
		name: "",
		scope: "admin",
		surface: "both",
		timeoutMs: "30000",
		transportType: "stdio",
		url: "",
	};
}

function splitLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function splitList(text: string): string[] {
	return text
		.split(/[,，\n]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseEnv(text: string): Record<string, string> | undefined {
	const entries: [string, string][] = [];
	for (const line of splitLines(text)) {
		const index = line.indexOf("=");
		if (index <= 0) continue;
		entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function parseHeaders(text: string): Record<string, string> | undefined {
	const entries: [string, string][] = [];
	for (const line of splitLines(text)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
	}
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function keyValueLines(values: Record<string, string> | undefined, separator: string): string {
	return Object.entries(values ?? {})
		.map(([key, value]) => `${key}${separator}${value}`)
		.join("\n");
}

function formFromSnapshot(server: McpServerSnapshot): FormState {
	const transport = server.transport;
	return {
		allowedTools: server.allowedTools.join(", "),
		args: transport.type === "stdio" ? (transport.args ?? []).join("\n") : "",
		command: transport.type === "stdio" ? transport.command : "",
		cwd: transport.type === "stdio" ? (transport.cwd ?? "") : "",
		deferred: server.deferred,
		disabledTools: server.disabledTools.join(", "),
		editingId: server.id,
		enabled: server.enabled,
		env: transport.type === "stdio" ? keyValueLines(transport.env, "=") : "",
		headers: transport.type === "http" ? keyValueLines(transport.headers, ": ") : "",
		id: server.id,
		name: server.name,
		scope: server.scope,
		surface: server.surface,
		timeoutMs: String(server.timeoutMs),
		transportType: transport.type,
		url: transport.type === "http" ? transport.url : "",
	};
}

function stateLabel(
	t: (key: string) => string,
	state: McpServerSnapshot["state"],
): string {
	if (state === "connected") return t("state_connected");
	if (state === "connecting") return t("state_connecting");
	if (state === "error") return t("state_error");
	return t("state_disconnected");
}

function stateClass(state: McpServerSnapshot["state"]): string {
	if (state === "connected") {
		return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
	}
	if (state === "error") return "border-destructive/30 bg-destructive/10 text-destructive";
	if (state === "connecting") {
		return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
	}
	return "border-border bg-muted/40 text-muted-foreground";
}

function ServerCard({
	busy,
	onDelete,
	onEdit,
	onReconnect,
	onToggle,
	server,
}: {
	readonly busy: boolean;
	readonly onDelete: () => void;
	readonly onEdit: () => void;
	readonly onReconnect: () => void;
	readonly onToggle: (enabled: boolean) => void;
	readonly server: McpServerSnapshot;
}) {
	const t = usePluginI18n();
	const transportLabel =
		server.transport.type === "stdio"
			? `stdio · ${server.transport.command}`
			: `http · ${server.transport.url}`;
	const surface =
		server.surface === "both"
			? t.t("surface_both")
			: server.surface === "chat"
				? t.t("surface_chat")
				: t.t("surface_workspace");
	const scope = server.scope === "everyone" ? t.t("scope_everyone") : t.t("scope_admin");
	return (
		<div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-medium">{server.name}</div>
					<div className="truncate font-mono text-[10.5px] text-muted-foreground">
						{server.id} · {transportLabel}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
						{scope}
					</span>
					<span
						className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${stateClass(server.state)}`}
					>
						{stateLabel(t.t, server.state)}
					</span>
					<Switch
						ariaLabel={server.enabled ? t.t("disable") : t.t("enable")}
						checked={server.enabled}
						disabled={busy}
						onCheckedChange={onToggle}
					/>
				</div>
			</div>
			<div className="grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
				<div>
					{t.t("tools_count", { count: server.tools.length })} ·{" "}
					{server.deferred ? t.t("deferred_short") : t.t("eager_short")} · {surface}
				</div>
				<div>
					{server.secretKeys.length === 0
						? t.t("no_secrets")
						: `${t.t("secret_keys")}: ${server.secretKeys.join(", ")}`}
				</div>
			</div>
			{server.lastError === undefined ? null : <Alert tone="warning">{server.lastError}</Alert>}
			{server.tools.length === 0 ? null : (
				<div className="space-y-1">
					{server.tools.map((tool) => (
						<div key={tool.name} className="rounded-md border border-border/70 px-2.5 py-1.5">
							<div className="font-mono text-[11px] font-medium">{tool.name}</div>
							{tool.description === undefined ? null : (
								<div className="line-clamp-2 text-[10.5px] text-muted-foreground">
									{tool.description}
								</div>
							)}
						</div>
					))}
				</div>
			)}
			<div className="flex flex-wrap justify-end gap-1.5">
				<Button
					disabled={busy}
					leadingIcon={<Pencil />}
					size="xs"
					variant="ghost"
					onClick={onEdit}
				>
					{t.t("edit")}
				</Button>
				<Button
					disabled={busy || !server.enabled}
					leadingIcon={<RefreshCw />}
					size="xs"
					variant="secondary"
					onClick={onReconnect}
				>
					{t.t("reconnect")}
				</Button>
				<Button
					disabled={busy}
					leadingIcon={<Trash2 />}
					size="xs"
					variant="danger"
					onClick={onDelete}
				>
					{t.t("delete")}
				</Button>
			</div>
		</div>
	);
}

function McpPanel() {
	const t = usePluginI18n();
	const panel = usePluginPanel();
	const toast = usePluginToast();
	const [servers, setServers] = useState<readonly McpServerSnapshot[]>([]);
	const [form, setForm] = useState<FormState>(blankForm);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);

	const refresh = async (): Promise<void> => {
		setLoading(true);
		try {
			const result = await panel.rpc.call<{ servers?: readonly McpServerSnapshot[] }>(
				rpc("list"),
			);
			setServers(result.servers ?? []);
		} catch (error) {
			toast.error(t.t("action_failed"), String(error));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const run = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
		setBusy(true);
		try {
			await operation();
			toast.success(success);
			await refresh();
			return true;
		} catch (error) {
			toast.error(t.t("action_failed"), String(error));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((current) => ({ ...current, [key]: value }));

	const buildInput = () => {
		const timeoutMs = clamp(Number(form.timeoutMs) || 30_000, 1, 600_000);
		const args = splitLines(form.args);
		const env = form.transportType === "stdio" ? parseEnv(form.env) : undefined;
		const headers = form.transportType === "http" ? parseHeaders(form.headers) : undefined;
		const transport =
			form.transportType === "stdio"
				? {
						...(args.length === 0 ? {} : { args }),
						command: form.command.trim(),
						...(form.cwd.trim() === "" ? {} : { cwd: form.cwd.trim() }),
						...(env === undefined ? {} : { env }),
						type: "stdio" as const,
					}
				: {
						...(headers === undefined ? {} : { headers }),
						type: "http" as const,
						url: form.url.trim(),
					};
		const allowedTools = splitList(form.allowedTools);
		const disabledTools = splitList(form.disabledTools);
		return {
			...(allowedTools.length === 0 ? {} : { allowedTools }),
			deferred: form.deferred,
			...(disabledTools.length === 0 ? {} : { disabledTools }),
			enabled: form.enabled,
			name: form.name.trim(),
			scope: form.scope,
			surface: form.surface,
			timeoutMs,
			transport,
		};
	};

	const save = async () => {
		const input = buildInput();
		const id = form.editingId;
		const saved =
			id === undefined
				? await run(
						() =>
							panel.rpc.call(rpc("create"), {
								...input,
								...(form.id.trim() === "" ? {} : { id: form.id.trim() }),
							}),
						t.t("saved"),
					)
				: await run(() => panel.rpc.call(rpc("update"), { ...input, id }), t.t("saved"));
		if (saved) setForm(blankForm());
	};

	const filtered = servers.filter((server) => {
		const query = search.trim().toLowerCase();
		if (query.length === 0) return true;
		return (
			server.id.toLowerCase().includes(query) ||
			server.name.toLowerCase().includes(query) ||
			server.tools.some((tool) => tool.name.toLowerCase().includes(query))
		);
	});
	const noServers = servers.length === 0;
	return (
		<PluginPage description={t.t("description")} title={t.t("title")}>
			<PluginSection title={t.t("overview")}>
				<StatGrid
					items={[
						{ label: t.t("servers"), value: servers.length },
						{
							label: t.t("state_connected"),
							value: servers.filter((server) => server.state === "connected").length,
						},
						{
							label: t.t("tools"),
							value: servers.reduce((total, server) => total + server.tools.length, 0),
						},
					]}
				/>
			</PluginSection>

			<PluginSection
				description={t.t("form_hint")}
				actions={
					form.editingId === undefined ? undefined : (
						<Button
							leadingIcon={<X />}
							size="xs"
							variant="ghost"
							onClick={() => setForm(blankForm())}
						>
							{t.t("cancel")}
						</Button>
					)
				}
				title={form.editingId === undefined ? t.t("new_server") : t.t("edit_server")}
			>
				<div className="grid gap-2.5 sm:grid-cols-2">
					<Field label={t.t("name")}>
						<Input value={form.name} onChange={(value) => set("name", value)} />
					</Field>
					<Field label={t.t("id")}>
						<Input
							disabled={form.editingId !== undefined}
							value={form.id}
							onChange={(value) => set("id", value)}
						/>
					</Field>
					<Field label={t.t("transport")}>
						<label className="flex items-center gap-2 text-xs">
							<select
								className="min-h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
								disabled={form.editingId !== undefined}
								value={form.transportType}
								onChange={(event) =>
									set("transportType", event.target.value as TransportType)
								}
							>
								<option value="stdio">{t.t("transport_stdio")}</option>
								<option value="http">{t.t("transport_http")}</option>
							</select>
						</label>
					</Field>
					<Field label={t.t("surface")}>
						<label className="flex items-center gap-2 text-xs">
							<select
								className="min-h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
								value={form.surface}
								onChange={(event) => set("surface", event.target.value as Surface)}
							>
								<option value="both">{t.t("surface_both")}</option>
								<option value="chat">{t.t("surface_chat")}</option>
								<option value="workspace">{t.t("surface_workspace")}</option>
							</select>
						</label>
					</Field>
					<Field label={t.t("scope")}>
						<label className="flex items-center gap-2 text-xs">
							<select
								className="min-h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
								value={form.scope}
								onChange={(event) => set("scope", event.target.value as Scope)}
							>
								<option value="admin">{t.t("scope_admin")}</option>
								<option value="everyone">{t.t("scope_everyone")}</option>
							</select>
						</label>
					</Field>
					{form.transportType === "stdio" ? (
						<Field label={t.t("command")}>
							<Input
								placeholder="npx"
								value={form.command}
								onChange={(value) => set("command", value)}
							/>
						</Field>
					) : (
						<Field label={t.t("url")}>
							<Input
								placeholder="https://example.invalid/mcp"
								value={form.url}
								onChange={(value) => set("url", value)}
							/>
						</Field>
					)}
					<Field label={t.t("timeout")}>
						<Input
							type="number"
							value={form.timeoutMs}
							onChange={(value) => set("timeoutMs", value)}
						/>
					</Field>
				</div>
				{form.transportType === "stdio" ? (
					<div className="mt-2 grid gap-2.5 sm:grid-cols-2">
						<Field label={t.t("args")} hint={t.t("args_hint")}>
							<textarea
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={form.args}
								onChange={(event) => set("args", event.target.value)}
							/>
						</Field>
						<Field label={t.t("cwd")}>
							<Input value={form.cwd} onChange={(value) => set("cwd", value)} />
						</Field>
						<Field label={t.t("env")} hint={t.t("env_hint")}>
							<textarea
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={form.env}
								onChange={(event) => set("env", event.target.value)}
							/>
						</Field>
					</div>
				) : (
					<Field label={t.t("headers")} hint={t.t("headers_hint")}>
						<textarea
							className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
							value={form.headers}
							onChange={(event) => set("headers", event.target.value)}
						/>
					</Field>
				)}
				<div className="mt-2 grid gap-2.5 sm:grid-cols-2">
					<Field label={t.t("allowed_tools")} hint={t.t("tool_filter_hint")}>
						<Input
							value={form.allowedTools}
							onChange={(value) => set("allowedTools", value)}
						/>
					</Field>
					<Field label={t.t("disabled_tools")} hint={t.t("tool_filter_hint")}>
						<Input
							value={form.disabledTools}
							onChange={(value) => set("disabledTools", value)}
						/>
					</Field>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-4">
					<label className="flex items-center gap-2 text-xs">
						<Switch
							ariaLabel={t.t("enabled")}
							checked={form.enabled}
							onCheckedChange={(checked) => set("enabled", checked)}
						/>
						{t.t("enabled")}
					</label>
					<label className="flex items-center gap-2 text-xs">
						<Switch
							ariaLabel={t.t("deferred")}
							checked={form.deferred}
							onCheckedChange={(checked) => set("deferred", checked)}
						/>
						{t.t("deferred")}
					</label>
					<span className="text-[11px] text-muted-foreground">{t.t("deferred_hint")}</span>
				</div>
				<div className="mt-3 flex justify-end">
					<Button
						disabled={busy || form.name.trim() === ""}
						leadingIcon={<Plus />}
						size="sm"
						onClick={() => void save()}
					>
						{form.editingId === undefined ? t.t("add") : t.t("save")}
					</Button>
				</div>
			</PluginSection>

			<PluginSection title={t.t("servers")}>
				<div className="mb-2 flex justify-end">
					<Input
						placeholder={t.t("search_hint")}
						value={search}
						onChange={setSearch}
					/>
				</div>
				{loading && noServers ? (
					<div className="text-[11px] text-muted-foreground">{t.t("loading")}</div>
				) : filtered.length === 0 ? (
					<EmptyState title={noServers ? t.t("no_servers") : t.t("no_matches")} />
				) : (
					<div className="space-y-2">
						{filtered.map((server) => (
							<ServerCard
								key={server.id}
								busy={busy}
								server={server}
								onDelete={() =>
									void run(
										() => panel.rpc.call(rpc("delete"), { id: server.id }),
										t.t("deleted"),
									)
								}
								onEdit={() => setForm(formFromSnapshot(server))}
								onReconnect={() =>
									void run(
										() => panel.rpc.call(rpc("reconnect"), { id: server.id }),
										t.t("reconnected"),
									)
								}
								onToggle={(enabled) =>
									void run(
										() => panel.rpc.call(rpc("toggle"), { enabled, id: server.id }),
										enabled ? t.t("state_connected") : t.t("state_disconnected"),
									)
								}
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
	icon: "plug",
	panels: [
		{
			component: McpPanel,
			icon: "plug",
			id: "servers",
			title: (t) => t("panel_mcp"),
		},
	],
});
