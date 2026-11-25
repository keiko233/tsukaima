"use client";

import type {
	McpHttpAuth,
	McpOAuthSnapshot,
	McpOAuthTokenAuthMethod,
	McpServerSnapshot,
} from "@tsukaima/contracts";
import { clamp } from "es-toolkit";
import {
	Alert,
	Button,
	EditorialSelect,
	EditorialSelectContent,
	EditorialSelectItem,
	EditorialSelectTrigger,
	EditorialSelectValue,
	EditorialSwitch,
	EmptyState,
	ExpandableRow,
	Input,
	KeyValueList,
	PluginPage,
	PluginSection,
	PreferenceRow,
	StatGrid,
	StatusDot,
	definePluginUi,
	usePluginI18n,
	usePluginPanel,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import {
	ExternalLink,
	KeyRound,
	Pencil,
	Plus,
	RefreshCw,
	ShieldOff,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { i18n } from "./i18n.ts";
import { MCP_PLUGIN_ID } from "./manifest.ts";

type Scope = McpServerSnapshot["scope"];
type Surface = McpServerSnapshot["surface"];
type TransportType = "http" | "stdio";
type AuthMode = "none" | "bearer" | "oauth_authorization_code" | "oauth_client_credentials";

interface FormState {
	allowedTools: string;
	args: string;
	authMode: AuthMode;
	bearerToken: string;
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
	oauthAlgorithm: string;
	oauthClientId: string;
	oauthClientMetadataUrl: string;
	oauthClientSecret: string;
	oauthExpectedIssuer: string;
	oauthPrivateKey: string;
	oauthRedirectUri: string;
	oauthScope: string;
	oauthTokenAuthMethod: "" | McpOAuthTokenAuthMethod;
	scope: Scope;
	surface: Surface;
	timeoutMs: string;
	transportType: TransportType;
	url: string;
}

const rpc = (method: string): string => `${MCP_PLUGIN_ID}.${method}`;

function currentBrowserOrigin(): string | undefined {
	if (typeof globalThis.window === "undefined") return undefined;
	const origin = globalThis.window.location?.origin;
	return origin && origin.length > 0 ? origin : undefined;
}

function defaultCallbackDisplayUrl(): string {
	const origin = currentBrowserOrigin() ?? "http://127.0.0.1:7420";
	return `${origin}/api/mcp/oauth/callback`;
}

function blankForm(): FormState {
	return {
		allowedTools: "",
		args: "",
		authMode: "none",
		bearerToken: "",
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
		oauthAlgorithm: "RS256",
		oauthClientId: "",
		oauthClientMetadataUrl: "",
		oauthClientSecret: "",
		oauthExpectedIssuer: "",
		oauthPrivateKey: "",
		oauthRedirectUri: "",
		oauthScope: "",
		oauthTokenAuthMethod: "",
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

function authModeFromTransport(transport: McpServerSnapshot["transport"]): AuthMode {
	if (transport.type !== "http" || transport.auth === undefined || transport.auth.type === "none") {
		return "none";
	}
	if (transport.auth.type === "bearer") return "bearer";
	return transport.auth.grantType === "client_credentials"
		? "oauth_client_credentials"
		: "oauth_authorization_code";
}

function formFromSnapshot(server: McpServerSnapshot): FormState {
	const transport = server.transport;
	const auth = transport.type === "http" ? transport.auth : undefined;
	const oauth = auth?.type === "oauth" ? auth : undefined;
	return {
		allowedTools: server.allowedTools.join(", "),
		args: transport.type === "stdio" ? (transport.args ?? []).join("\n") : "",
		authMode: authModeFromTransport(transport),
		bearerToken: auth?.type === "bearer" ? auth.token : "",
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
		oauthAlgorithm: oauth?.algorithm ?? "RS256",
		oauthClientId: oauth?.clientId ?? "",
		oauthClientMetadataUrl: oauth?.clientMetadataUrl ?? "",
		oauthClientSecret: oauth?.clientSecret ?? "",
		oauthExpectedIssuer: oauth?.expectedIssuer ?? "",
		oauthPrivateKey: oauth?.privateKey ?? "",
		oauthRedirectUri: oauth?.redirectUri ?? "",
		oauthScope: oauth?.scope ?? "",
		oauthTokenAuthMethod: oauth?.tokenEndpointAuthMethod ?? "",
		scope: server.scope,
		surface: server.surface,
		timeoutMs: String(server.timeoutMs),
		transportType: transport.type,
		url: transport.type === "http" ? transport.url : "",
	};
}

function stateLabel(t: (key: string) => string, state: McpServerSnapshot["state"]): string {
	if (state === "connected") return t("state_connected");
	if (state === "connecting") return t("state_connecting");
	if (state === "auth_required") return t("state_auth_required");
	if (state === "error") return t("state_error");
	return t("state_disconnected");
}

function oauthStatusLabel(t: (key: string) => string, oauth: McpOAuthSnapshot): string {
	if (oauth.status === "authorized") return t("oauth_status_authorized");
	if (oauth.status === "pending") return t("oauth_status_pending");
	if (oauth.status === "error") return t("oauth_status_error");
	return t("oauth_status_unauthenticated");
}

function ServerRow({
	busy,
	onAuthorize,
	onClearOAuth,
	onCompleteOAuth,
	onDelete,
	onEdit,
	onReconnect,
	onToggle,
	server,
}: {
	readonly busy: boolean;
	readonly onAuthorize: () => void;
	readonly onClearOAuth: () => void;
	readonly onCompleteOAuth: (input: string) => Promise<boolean>;
	readonly onDelete: () => void;
	readonly onEdit: () => void;
	readonly onReconnect: () => void;
	readonly onToggle: (enabled: boolean) => void;
	readonly server: McpServerSnapshot;
}) {
	const t = usePluginI18n();
	const [callbackInput, setCallbackInput] = useState("");
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
	const oauth = server.oauth;
	const showClearOAuth =
		oauth !== undefined &&
		(oauth.status === "authorized" ||
			oauth.status === "pending" ||
			oauth.status === "error" ||
			oauth.clientId !== undefined);
	const statusLevel =
		server.state === "connected"
			? "ok"
			: server.state === "error"
				? "error"
				: server.state === "connecting" || server.state === "auth_required"
					? "warning"
					: "unknown";
	return (
		<div className="grid items-start gap-x-4 border-t border-line sm:grid-cols-[minmax(0,1fr)_auto]">
			<ExpandableRow
				className="border-t-0"
				summary={
					<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
						<StatusDot level={statusLevel} />
						<span className="break-words">{server.name}</span>
						<span className="break-all font-mono text-[11px] text-muted-foreground">
							{transportLabel}
						</span>
						<span className="text-[11px] text-muted-foreground">
							{scope} · {stateLabel(t.t, server.state)}
						</span>
						<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
							{t.t("tools_count", { count: server.tools.length })}
						</span>
					</span>
				}
			>
				<div className="space-y-3">
					<KeyValueList
						className="text-xs [&>div]:border-0"
						items={[
							{ label: t.t("id"), value: <code>{server.id}</code> },
							{ label: t.t("surface"), value: surface },
							{
								label: t.t("deferred"),
								value: server.deferred ? t.t("deferred_short") : t.t("eager_short"),
							},
							{
								label: t.t("secret_keys"),
								value:
									server.secretKeys.length === 0 ? (
										t.t("no_secrets")
									) : (
										<code>{server.secretKeys.join(", ")}</code>
									),
							},
						]}
					/>
					{oauth === undefined ? null : (
						<div className="space-y-2 text-xs">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="font-medium text-foreground">{oauthStatusLabel(t.t, oauth)}</span>
								<span className="font-mono text-[11px] text-muted-foreground">
									{oauth.grantType}
									{oauth.clientId === undefined ? "" : ` · ${oauth.clientId}`}
								</span>
							</div>
							{oauth.issuer !== undefined || oauth.scope !== undefined ? (
								<div className="truncate text-[11px] text-muted-foreground">
									{oauth.issuer ?? ""}
									{oauth.issuer !== undefined && oauth.scope !== undefined ? " · " : ""}
									{oauth.scope === undefined ? "" : `${t.t("oauth_scope")}: ${oauth.scope}`}
								</div>
							) : null}
							{oauth.status === "pending" && oauth.authorizationUrl !== undefined ? (
								<div className="space-y-1.5 pt-1">
									<div className="text-[11px] text-muted-foreground">
										{t.t("oauth_pending_hint")}
									</div>
									<div className="flex flex-wrap items-center gap-2">
										<a
											className="inline-flex items-center gap-1 py-1 text-[11px] font-medium text-accent-ink hover:underline"
											href={oauth.authorizationUrl}
											rel="noreferrer"
											target="_blank"
										>
											<ExternalLink className="size-3" />
											{t.t("oauth_open_url")}
										</a>
									</div>
									<div className="flex flex-wrap items-center gap-1.5">
										<div className="min-w-0 flex-1">
											<Input
												aria-label={t.t("oauth_callback_placeholder")}
												placeholder={t.t("oauth_callback_placeholder")}
												value={callbackInput}
												onChange={setCallbackInput}
											/>
										</div>
										<Button
											disabled={busy || callbackInput.trim() === ""}
											size="xs"
											variant="secondary"
											onClick={async () => {
												const ok = await onCompleteOAuth(callbackInput.trim());
												if (ok) setCallbackInput("");
											}}
										>
											{t.t("oauth_complete")}
										</Button>
									</div>
								</div>
							) : null}
						</div>
					)}
					<div className="flex flex-wrap gap-1.5 empty:hidden">
						{oauth?.grantType === "authorization_code" ? (
							<Button
								disabled={busy || !server.enabled}
								leadingIcon={<KeyRound />}
								size="xs"
								variant={server.state === "auth_required" ? "primary" : "secondary"}
								onClick={onAuthorize}
							>
								{oauth.status === "authorized" ? t.t("oauth_reauthorize") : t.t("oauth_authorize")}
							</Button>
						) : null}
						{showClearOAuth ? (
							<Button
								disabled={busy}
								leadingIcon={<ShieldOff />}
								size="xs"
								variant="ghost"
								onClick={onClearOAuth}
							>
								{t.t("oauth_clear")}
							</Button>
						) : null}
					</div>
					{server.lastError === undefined ? null : <Alert tone="warning">{server.lastError}</Alert>}
					{server.tools.length === 0 ? null : (
						<ul className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
							{server.tools.map((tool) => (
								<li key={tool.name} className="min-w-0 break-words">
									<div className="font-mono text-[11px] font-medium">{tool.name}</div>
									{tool.description === undefined ? null : (
										<div className="line-clamp-2 text-[11px] text-muted-foreground">
											{tool.description}
										</div>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			</ExpandableRow>
			<div className="flex flex-wrap items-center gap-1 pb-2 sm:justify-end sm:py-2">
				<EditorialSwitch
					aria-label={t.t("enable")}
					checked={server.enabled}
					disabled={busy}
					onCheckedChange={onToggle}
				/>
				<Button
					disabled={busy}
					aria-label={t.t("edit")}
					title={t.t("edit")}
					size="iconSm"
					variant="ghost"
					onClick={onEdit}
				>
					<Pencil />
				</Button>
				<Button
					disabled={busy || !server.enabled}
					aria-label={t.t("reconnect")}
					title={t.t("reconnect")}
					size="iconSm"
					variant="secondary"
					onClick={onReconnect}
				>
					<RefreshCw />
				</Button>
				<Button
					disabled={busy}
					aria-label={t.t("delete")}
					title={t.t("delete")}
					size="iconSm"
					variant="danger"
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</div>
	);
}

function McpPanel() {
	const formId = useId();
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
			const result = await panel.rpc.call<{ servers?: readonly McpServerSnapshot[] }>(rpc("list"));
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

	useEffect(() => {
		if (typeof globalThis.window === "undefined") return;
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== globalThis.window.location.origin) return;
			const data = event.data as {
				readonly error?: string;
				readonly ok?: boolean;
				readonly type?: string;
			} | null;
			if (!data || data.type !== "tsukaima:mcp-oauth-callback") return;
			if (data.ok) {
				toast.success(t.t("oauth_completed"));
			} else {
				toast.error(t.t("action_failed"), data.error ?? "");
			}
			void refresh();
		};
		globalThis.window.addEventListener("message", onMessage);
		return () => globalThis.window.removeEventListener("message", onMessage);
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

	const buildHttpAuth = (): McpHttpAuth | undefined => {
		if (form.authMode === "none") return undefined;
		if (form.authMode === "bearer") {
			return { token: form.bearerToken.trim(), type: "bearer" };
		}
		const isClientCredentials = form.authMode === "oauth_client_credentials";
		const clientId = form.oauthClientId.trim();
		const clientSecret = form.oauthClientSecret.trim();
		const privateKey = form.oauthPrivateKey.trim();
		const algorithm = form.oauthAlgorithm.trim();
		const scope = form.oauthScope.trim();
		const redirectUri = form.oauthRedirectUri.trim();
		const expectedIssuer = form.oauthExpectedIssuer.trim();
		const clientMetadataUrl = form.oauthClientMetadataUrl.trim();
		return {
			...(algorithm.length > 0 && privateKey.length > 0 ? { algorithm } : {}),
			...(clientId.length > 0 ? { clientId } : {}),
			...(clientMetadataUrl.length > 0 && !isClientCredentials ? { clientMetadataUrl } : {}),
			...(clientSecret.length > 0 ? { clientSecret } : {}),
			...(expectedIssuer.length > 0 ? { expectedIssuer } : {}),
			grantType: isClientCredentials ? "client_credentials" : "authorization_code",
			...(privateKey.length > 0 && isClientCredentials ? { privateKey } : {}),
			...(redirectUri.length > 0 && !isClientCredentials ? { redirectUri } : {}),
			...(scope.length > 0 ? { scope } : {}),
			...(form.oauthTokenAuthMethod === ""
				? {}
				: { tokenEndpointAuthMethod: form.oauthTokenAuthMethod }),
			type: "oauth",
		};
	};

	const buildInput = () => {
		const timeoutMs = clamp(Number(form.timeoutMs) || 30_000, 1, 600_000);
		const args = splitLines(form.args);
		const env = form.transportType === "stdio" ? parseEnv(form.env) : undefined;
		const headers = form.transportType === "http" ? parseHeaders(form.headers) : undefined;
		const auth = form.transportType === "http" ? buildHttpAuth() : undefined;
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
						...(auth === undefined ? {} : { auth }),
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

	const authorizeServer = async (id: string) => {
		setBusy(true);
		try {
			const origin = currentBrowserOrigin();
			const snapshot = await panel.rpc.call<McpServerSnapshot>(rpc("startOAuth"), {
				...(origin === undefined ? {} : { callbackOrigin: origin }),
				id,
			});
			const authUrl = snapshot.oauth?.authorizationUrl;
			if (authUrl !== undefined && typeof globalThis.window !== "undefined") {
				globalThis.window.open(authUrl, "tsukaima-mcp-oauth", "width=620,height=740");
				toast.info(t.t("oauth_started"));
			} else if (snapshot.state === "connected") {
				toast.success(t.t("oauth_completed"));
			}
			await refresh();
		} catch (error) {
			toast.error(t.t("action_failed"), String(error));
		} finally {
			setBusy(false);
		}
	};

	const completeOAuthServer = async (id: string, value: string): Promise<boolean> => {
		const looksLikeUrl = /^https?:\/\//iu.test(value);
		return run(
			() =>
				panel.rpc.call(rpc("completeOAuth"), {
					...(looksLikeUrl ? { callbackUrl: value } : { code: value }),
					id,
				}),
			t.t("oauth_completed"),
		);
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
				<PreferenceRow htmlFor={`${formId}-name`} label={t.t("name")}>
					<Input id={`${formId}-name`} value={form.name} onChange={(value) => set("name", value)} />
				</PreferenceRow>
				<PreferenceRow htmlFor={`${formId}-id`} label={t.t("id")}>
					<Input
						id={`${formId}-id`}
						disabled={form.editingId !== undefined}
						value={form.id}
						onChange={(value) => set("id", value)}
					/>
				</PreferenceRow>
				<PreferenceRow htmlFor={`${formId}-transport`} label={t.t("transport")}>
					<EditorialSelect
						disabled={form.editingId !== undefined}
						value={form.transportType}
						onValueChange={(value) => set("transportType", value)}
					>
						<EditorialSelectTrigger aria-label={t.t("transport")} id={`${formId}-transport`}>
							<EditorialSelectValue />
						</EditorialSelectTrigger>
						<EditorialSelectContent>
							<EditorialSelectItem value="stdio">{t.t("transport_stdio")}</EditorialSelectItem>
							<EditorialSelectItem value="http">{t.t("transport_http")}</EditorialSelectItem>
						</EditorialSelectContent>
					</EditorialSelect>
				</PreferenceRow>
				<PreferenceRow htmlFor={`${formId}-surface`} label={t.t("surface")}>
					<EditorialSelect value={form.surface} onValueChange={(value) => set("surface", value)}>
						<EditorialSelectTrigger aria-label={t.t("surface")} id={`${formId}-surface`}>
							<EditorialSelectValue />
						</EditorialSelectTrigger>
						<EditorialSelectContent>
							<EditorialSelectItem value="both">{t.t("surface_both")}</EditorialSelectItem>
							<EditorialSelectItem value="chat">{t.t("surface_chat")}</EditorialSelectItem>
							<EditorialSelectItem value="workspace">
								{t.t("surface_workspace")}
							</EditorialSelectItem>
						</EditorialSelectContent>
					</EditorialSelect>
				</PreferenceRow>
				<PreferenceRow htmlFor={`${formId}-scope`} label={t.t("scope")}>
					<EditorialSelect value={form.scope} onValueChange={(value) => set("scope", value)}>
						<EditorialSelectTrigger aria-label={t.t("scope")} id={`${formId}-scope`}>
							<EditorialSelectValue />
						</EditorialSelectTrigger>
						<EditorialSelectContent>
							<EditorialSelectItem value="admin">{t.t("scope_admin")}</EditorialSelectItem>
							<EditorialSelectItem value="everyone">{t.t("scope_everyone")}</EditorialSelectItem>
						</EditorialSelectContent>
					</EditorialSelect>
				</PreferenceRow>
				{form.transportType === "stdio" ? (
					<PreferenceRow htmlFor={`${formId}-command`} label={t.t("command")}>
						<Input
							id={`${formId}-command`}
							placeholder="bunx"
							value={form.command}
							onChange={(value) => set("command", value)}
						/>
					</PreferenceRow>
				) : (
					<PreferenceRow htmlFor={`${formId}-url`} label={t.t("url")}>
						<Input
							id={`${formId}-url`}
							placeholder="https://example.invalid/mcp"
							value={form.url}
							onChange={(value) => set("url", value)}
						/>
					</PreferenceRow>
				)}
				<PreferenceRow htmlFor={`${formId}-timeout`} label={t.t("timeout")}>
					<Input
						id={`${formId}-timeout`}
						type="number"
						value={form.timeoutMs}
						onChange={(value) => set("timeoutMs", value)}
					/>
				</PreferenceRow>
				{form.transportType === "stdio" ? (
					<>
						<PreferenceRow htmlFor={`${formId}-args`} label={t.t("args")} hint={t.t("args_hint")}>
							<textarea
								id={`${formId}-args`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={form.args}
								onChange={(event) => set("args", event.target.value)}
							/>
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-cwd`} label={t.t("cwd")}>
							<Input
								id={`${formId}-cwd`}
								value={form.cwd}
								onChange={(value) => set("cwd", value)}
							/>
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-env`} label={t.t("env")} hint={t.t("env_hint")}>
							<textarea
								id={`${formId}-env`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={form.env}
								onChange={(event) => set("env", event.target.value)}
							/>
						</PreferenceRow>
					</>
				) : (
					<>
						<PreferenceRow htmlFor={`${formId}-auth_mode`} label={t.t("auth_mode")}>
							<EditorialSelect
								value={form.authMode}
								onValueChange={(value) => set("authMode", value)}
							>
								<EditorialSelectTrigger aria-label={t.t("auth_mode")} id={`${formId}-auth_mode`}>
									<EditorialSelectValue />
								</EditorialSelectTrigger>
								<EditorialSelectContent>
									<EditorialSelectItem value="none">{t.t("auth_none")}</EditorialSelectItem>
									<EditorialSelectItem value="bearer">{t.t("auth_bearer")}</EditorialSelectItem>
									<EditorialSelectItem value="oauth_authorization_code">
										{t.t("auth_oauth_authorization_code")}
									</EditorialSelectItem>
									<EditorialSelectItem value="oauth_client_credentials">
										{t.t("auth_oauth_client_credentials")}
									</EditorialSelectItem>
								</EditorialSelectContent>
							</EditorialSelect>
						</PreferenceRow>
						{form.authMode === "bearer" ? (
							<PreferenceRow htmlFor={`${formId}-bearer_token`} label={t.t("bearer_token")}>
								<Input
									id={`${formId}-bearer_token`}
									type="password"
									value={form.bearerToken}
									onChange={(value) => set("bearerToken", value)}
								/>
							</PreferenceRow>
						) : null}
						{form.authMode === "oauth_authorization_code" ||
						form.authMode === "oauth_client_credentials" ? (
							<>
								<PreferenceRow
									htmlFor={`${formId}-oauth_client_id`}
									label={t.t("oauth_client_id")}
									hint={t.t("oauth_client_id_hint")}
								>
									<Input
										id={`${formId}-oauth_client_id`}
										value={form.oauthClientId}
										onChange={(value) => set("oauthClientId", value)}
									/>
								</PreferenceRow>
								<PreferenceRow
									htmlFor={`${formId}-oauth_client_secret`}
									label={t.t("oauth_client_secret")}
								>
									<Input
										id={`${formId}-oauth_client_secret`}
										type="password"
										value={form.oauthClientSecret}
										onChange={(value) => set("oauthClientSecret", value)}
									/>
								</PreferenceRow>
								<PreferenceRow
									htmlFor={`${formId}-oauth_scope`}
									label={t.t("oauth_scope")}
									hint={t.t("oauth_scope_hint")}
								>
									<Input
										id={`${formId}-oauth_scope`}
										placeholder="read write"
										value={form.oauthScope}
										onChange={(value) => set("oauthScope", value)}
									/>
								</PreferenceRow>
								<PreferenceRow
									htmlFor={`${formId}-oauth_token_auth_method`}
									label={t.t("oauth_token_auth_method")}
								>
									<EditorialSelect<"auto" | McpOAuthTokenAuthMethod>
										value={form.oauthTokenAuthMethod || "auto"}
										onValueChange={(value) =>
											set("oauthTokenAuthMethod", value === "auto" ? "" : value)
										}
									>
										<EditorialSelectTrigger
											aria-label={t.t("oauth_token_auth_method")}
											id={`${formId}-oauth_token_auth_method`}
										>
											<EditorialSelectValue />
										</EditorialSelectTrigger>
										<EditorialSelectContent>
											<EditorialSelectItem value="auto">
												{t.t("oauth_auth_method_auto")}
											</EditorialSelectItem>
											<EditorialSelectItem value="client_secret_basic">
												client_secret_basic
											</EditorialSelectItem>
											<EditorialSelectItem value="client_secret_post">
												client_secret_post
											</EditorialSelectItem>
											{form.authMode === "oauth_authorization_code" ? (
												<EditorialSelectItem value="none">
													none (PKCE public client)
												</EditorialSelectItem>
											) : (
												<EditorialSelectItem value="private_key_jwt">
													private_key_jwt
												</EditorialSelectItem>
											)}
										</EditorialSelectContent>
									</EditorialSelect>
								</PreferenceRow>
								<PreferenceRow
									htmlFor={`${formId}-oauth_expected_issuer`}
									label={t.t("oauth_expected_issuer")}
									hint={t.t("oauth_expected_issuer_hint")}
								>
									<Input
										id={`${formId}-oauth_expected_issuer`}
										placeholder="https://auth.example.invalid"
										value={form.oauthExpectedIssuer}
										onChange={(value) => set("oauthExpectedIssuer", value)}
									/>
								</PreferenceRow>
								{form.authMode === "oauth_authorization_code" ? (
									<>
										<PreferenceRow
											htmlFor={`${formId}-oauth_redirect_uri`}
											label={t.t("oauth_redirect_uri")}
											hint={t.t("oauth_redirect_uri_hint", {
												url: defaultCallbackDisplayUrl(),
											})}
										>
											<Input
												id={`${formId}-oauth_redirect_uri`}
												placeholder={defaultCallbackDisplayUrl()}
												value={form.oauthRedirectUri}
												onChange={(value) => set("oauthRedirectUri", value)}
											/>
										</PreferenceRow>
										<PreferenceRow
											htmlFor={`${formId}-oauth_client_metadata_url`}
											label={t.t("oauth_client_metadata_url")}
										>
											<Input
												id={`${formId}-oauth_client_metadata_url`}
												placeholder="https://client.example.invalid/oauth-metadata.json"
												value={form.oauthClientMetadataUrl}
												onChange={(value) => set("oauthClientMetadataUrl", value)}
											/>
										</PreferenceRow>
									</>
								) : (
									<>
										<PreferenceRow
											htmlFor={`${formId}-oauth_algorithm`}
											label={t.t("oauth_algorithm")}
										>
											<Input
												id={`${formId}-oauth_algorithm`}
												placeholder="RS256"
												value={form.oauthAlgorithm}
												onChange={(value) => set("oauthAlgorithm", value)}
											/>
										</PreferenceRow>
										<PreferenceRow
											htmlFor={`${formId}-oauth_private_key`}
											label={t.t("oauth_private_key")}
											hint={t.t("oauth_private_key_hint")}
										>
											<textarea
												id={`${formId}-oauth_private_key`}
												className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
												value={form.oauthPrivateKey}
												onChange={(event) => set("oauthPrivateKey", event.target.value)}
											/>
										</PreferenceRow>
									</>
								)}
							</>
						) : null}
						<PreferenceRow
							htmlFor={`${formId}-headers`}
							label={t.t("headers")}
							hint={t.t("headers_hint")}
						>
							<textarea
								id={`${formId}-headers`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={form.headers}
								onChange={(event) => set("headers", event.target.value)}
							/>
						</PreferenceRow>
					</>
				)}
				<>
					<PreferenceRow
						htmlFor={`${formId}-allowed_tools`}
						label={t.t("allowed_tools")}
						hint={t.t("tool_filter_hint")}
					>
						<Input
							id={`${formId}-allowed_tools`}
							value={form.allowedTools}
							onChange={(value) => set("allowedTools", value)}
						/>
					</PreferenceRow>
					<PreferenceRow
						htmlFor={`${formId}-disabled_tools`}
						label={t.t("disabled_tools")}
						hint={t.t("tool_filter_hint")}
					>
						<Input
							id={`${formId}-disabled_tools`}
							value={form.disabledTools}
							onChange={(value) => set("disabledTools", value)}
						/>
					</PreferenceRow>
				</>
				<PreferenceRow label={t.t("enabled")} htmlFor={`${formId}-enabled`}>
					<EditorialSwitch
						id={`${formId}-enabled`}
						checked={form.enabled}
						onCheckedChange={(checked) => set("enabled", checked)}
					/>
				</PreferenceRow>
				<PreferenceRow
					label={t.t("deferred")}
					hint={t.t("deferred_hint")}
					htmlFor={`${formId}-deferred`}
				>
					<EditorialSwitch
						id={`${formId}-deferred`}
						checked={form.deferred}
						onCheckedChange={(checked) => set("deferred", checked)}
					/>
				</PreferenceRow>
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
						aria-label={t.t("search_hint")}
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
					<div>
						{filtered.map((server) => (
							<ServerRow
								key={server.id}
								busy={busy}
								server={server}
								onAuthorize={() => void authorizeServer(server.id)}
								onClearOAuth={() =>
									void run(
										() => panel.rpc.call(rpc("clearOAuth"), { id: server.id }),
										t.t("oauth_cleared"),
									)
								}
								onCompleteOAuth={(value) => completeOAuthServer(server.id, value)}
								onDelete={() =>
									void run(() => panel.rpc.call(rpc("delete"), { id: server.id }), t.t("deleted"))
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
