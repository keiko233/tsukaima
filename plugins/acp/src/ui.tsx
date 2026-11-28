"use client";

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
	Field,
	Input,
	PluginPage,
	PluginSection,
	PreferenceRow,
	StatusDot,
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { ExternalLink, LogIn, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type {
	AcpAuthLoginResult,
	AcpAuthPreset,
	AcpAuthProviderStatus,
	AcpAuthStatusSnapshot,
} from "./auth.ts";
import {
	ACP_PRESET_TEMPLATES,
	acpProfileSchema,
	acpReasoningLevelSchema,
	createAcpModel,
	createPresetProfile,
	type AcpModelConfig,
	type AcpPreset,
	type AcpProfileConfig,
	type AcpReasoningLevel,
	type AcpToolBridgeMode,
} from "./config.ts";
import { i18n } from "./i18n.ts";
import type {
	AcpCustomPackageStatus,
	AcpRuntimeBinaryStatus,
	AcpRuntimeOperationResult,
	AcpRuntimeStatusSnapshot,
} from "./installer.ts";
import {
	ACP_AUTH_LOGIN_CANCEL_RPC,
	ACP_AUTH_LOGIN_POLL_RPC,
	ACP_AUTH_LOGIN_START_RPC,
	ACP_AUTH_LOGIN_SUBMIT_RPC,
	ACP_AUTH_STATUS_RPC,
	ACP_PROBE_RPC,
	ACP_RUNTIME_INSTALL_RPC,
	ACP_RUNTIME_STATUS_RPC,
	ACP_RUNTIME_UNINSTALL_RPC,
} from "./manifest.ts";
import type { AcpProbeResult } from "./probe.ts";

interface ProfileDraft extends AcpProfileConfig {
	readonly argsText: string;
	readonly envText: string;
}

interface ProbeState {
	readonly profileId: string;
	readonly result?: AcpProbeResult;
	readonly error?: string;
}

interface ParsedEnv {
	readonly env: Record<string, string>;
	readonly invalid: readonly string[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseArgs(text: string): string[] {
	return text
		.split(/\s+/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseEnvText(text: string): ParsedEnv {
	const env: Record<string, string> = {};
	const invalid: string[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const index = trimmed.indexOf("=");
		const key = index <= 0 ? "" : trimmed.slice(0, index).trim();
		if (key.length === 0) {
			invalid.push(trimmed);
			continue;
		}
		env[key] = trimmed.slice(index + 1).trim();
	}
	return { env, invalid };
}

function keyValueLines(values: Readonly<Record<string, string>>): string {
	return Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

function profileToDraft(profile: AcpProfileConfig): ProfileDraft {
	return {
		...profile,
		argsText: profile.args.join("\n"),
		envText: keyValueLines(profile.env),
	};
}

function readDraftProfiles(raw: Record<string, unknown>): readonly ProfileDraft[] {
	const profiles: ProfileDraft[] = [];
	const seen = new Set<string>();
	for (const candidate of Array.isArray(raw.profiles) ? raw.profiles : []) {
		const parsed = acpProfileSchema.safeParse(candidate);
		if (!parsed.success || seen.has(parsed.data.id)) continue;
		seen.add(parsed.data.id);
		profiles.push(profileToDraft(parsed.data));
	}
	return profiles;
}

function nextProfileId(preset: AcpPreset, profiles: readonly ProfileDraft[]): string {
	const base = ACP_PRESET_TEMPLATES[preset].defaultId;
	const ids = new Set(profiles.map((profile) => profile.id));
	if (!ids.has(base)) return base;
	let index = 2;
	while (ids.has(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}

function profilePayload(profile: ProfileDraft) {
	return {
		allowedCapabilityChat: profile.allowedCapabilityChat,
		args: parseArgs(profile.argsText),
		command: profile.command.trim(),
		enableAsModelProvider: profile.enableAsModelProvider,
		enabled: profile.enabled,
		env: parseEnvText(profile.envText).env,
		id: profile.id.trim(),
		idleTtlMs: profile.idleTtlMs,
		models: profile.models,
		preset: profile.preset,
		requestTimeoutMs: profile.requestTimeoutMs,
		supportsCapabilityTool: profile.supportsCapabilityTool,
		supportsImageGeneration: profile.supportsImageGeneration,
		supportsVideoGeneration: profile.supportsVideoGeneration,
		toolBridgeMode: profile.toolBridgeMode,
		...(profile.name === undefined || profile.name.trim().length === 0
			? {}
			: { name: profile.name.trim() }),
		...(profile.cwd === undefined || profile.cwd.trim().length === 0
			? {}
			: { cwd: profile.cwd.trim() }),
	};
}

function presetLabel(t: (key: string) => string, preset: AcpPreset): string {
	switch (preset) {
		case "antigravity":
			return t("preset_antigravity");
		case "codex":
			return t("preset_codex");
		case "claude-code":
			return t("preset_claude");
		case "custom":
			return t("preset_custom");
	}
}

function sourceLabel(t: (key: string) => string, source: AcpRuntimeBinaryStatus["source"]): string {
	switch (source) {
		case "managed":
			return t("runtime_source_managed");
		case "system":
			return t("runtime_source_system");
		case "none":
			return t("runtime_source_none");
	}
}

function effortLabel(t: (key: string) => string, level: AcpReasoningLevel): string {
	switch (level) {
		case "minimal":
			return t("effort_minimal");
		case "low":
			return t("effort_low");
		case "medium":
			return t("effort_medium");
		case "high":
			return t("effort_high");
		case "xhigh":
			return t("effort_xhigh");
		case "max":
			return t("effort_max");
	}
}

function NumberPreferenceRow({
	hint,
	label,
	max,
	min,
	onChange,
	value,
}: {
	readonly hint?: string;
	readonly label: string;
	readonly max: number;
	readonly min: number;
	readonly onChange: (value: number) => void;
	readonly value: number;
}) {
	const id = useId();
	const [text, setText] = useState(String(value));

	useEffect(() => {
		setText(String(value));
	}, [value]);

	const commit = () => {
		const parsed = Number(text);
		const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
		setText(String(next));
		onChange(next);
	};

	return (
		<PreferenceRow htmlFor={id} label={label} {...(hint === undefined ? {} : { hint })}>
			<Input
				id={id}
				max={max}
				min={min}
				type="number"
				value={text}
				onBlur={commit}
				onChange={setText}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
		</PreferenceRow>
	);
}

function CapabilityButton({
	active,
	label,
	onClick,
}: {
	readonly active: boolean;
	readonly label: string;
	readonly onClick: () => void;
}) {
	return (
		<Button
			size="xs"
			variant="ghost"
			className="rounded-full bg-muted text-muted-foreground aria-pressed:bg-accent-soft aria-pressed:text-accent-ink"
			aria-pressed={active}
			onClick={onClick}
		>
			{label}
		</Button>
	);
}

const LOGIN_RUNTIME_IDS: Readonly<Record<string, AcpAuthPreset>> = {
	"antigravity-cli": "antigravity",
	"claude-cli": "claude-code",
	"codex-cli": "codex",
};

function isAuthPreset(preset: AcpPreset): preset is AcpAuthPreset {
	return preset === "antigravity" || preset === "codex" || preset === "claude-code";
}

function RuntimeRow({
	authStatus,
	busy,
	loggingIn,
	onCheck,
	onInstall,
	onLogin,
	onUninstall,
	runtime,
}: {
	readonly authStatus?: AcpAuthProviderStatus;
	readonly busy: boolean;
	readonly loggingIn: boolean;
	readonly onCheck: () => void;
	readonly onInstall: () => void;
	readonly onLogin?: () => void;
	readonly onUninstall: () => void;
	readonly runtime: AcpRuntimeBinaryStatus;
}) {
	const t = usePluginI18n();
	const toast = usePluginToast();
	const installed = runtime.source !== "none";

	return (
		<div className="flex flex-wrap items-start justify-between gap-3 border-t border-line py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span className="mt-1.5">
					<StatusDot level={installed ? "ok" : "unknown"} />
				</span>
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="font-mono text-sm font-medium">{runtime.binaryName}</span>
						<span className="text-[11px] text-muted-foreground">{runtime.displayName}</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
						<span>{sourceLabel(t.t, runtime.source)}</span>
						<span className="font-mono">{runtime.version ?? t.t("version_unknown")}</span>
						{authStatus === undefined || authStatus.authenticated === null ? null : (
							<span
								className={
									authStatus.authenticated
										? "font-medium text-emerald-600 dark:text-emerald-400"
										: "text-amber-600 dark:text-amber-400"
								}
							>
								{authStatus.authenticated ? t.t("auth_signed_in") : t.t("auth_signed_out")}
								{authStatus.detail === undefined ? "" : ` · ${authStatus.detail}`}
							</span>
						)}
					</div>
					{runtime.binaryPath === undefined ? null : (
						<div className="font-mono text-[11px] break-all text-muted-foreground">
							{t.t("binary_path")}: {runtime.binaryPath}
						</div>
					)}
					{runtime.installMethod === "system" && runtime.installHint !== undefined ? (
						<p className="text-[11px] text-muted-foreground">{runtime.installHint}</p>
					) : null}
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{installed && onLogin !== undefined ? (
					<Button
						disabled={busy || loggingIn}
						leadingIcon={<LogIn />}
						loading={loggingIn}
						size="xs"
						variant="secondary"
						onClick={onLogin}
					>
						{loggingIn ? t.t("auth_logging_in") : t.t("auth_login")}
					</Button>
				) : null}
				{runtime.installMethod === "system" ? (
					<>
						<Button disabled={busy} size="xs" variant="secondary" onClick={onCheck}>
							{t.t("runtime_check")}
						</Button>
						{runtime.installHint === undefined ? null : (
							<Button
								disabled={busy}
								size="xs"
								variant="ghost"
								onClick={() => toast.info(t.t("runtime_install_guide"), runtime.installHint)}
							>
								{t.t("runtime_install_guide")}
							</Button>
						)}
					</>
				) : (
					<>
						<Button
							disabled={busy}
							size="xs"
							variant={installed ? "secondary" : "primary"}
							onClick={onInstall}
						>
							{installed ? t.t("runtime_update") : t.t("runtime_install")}
						</Button>
						{runtime.source === "managed" ? (
							<Button disabled={busy} size="xs" variant="ghost" onClick={onUninstall}>
								{t.t("runtime_uninstall")}
							</Button>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

function CustomPackageRow({
	busy,
	onUninstall,
	pkg,
}: {
	readonly busy: boolean;
	readonly onUninstall: () => void;
	readonly pkg: AcpCustomPackageStatus;
}) {
	const t = usePluginI18n();
	return (
		<div className="flex flex-wrap items-start justify-between gap-3 border-t border-line py-3">
			<div className="flex min-w-0 items-start gap-3">
				<span className="mt-1.5">
					<StatusDot level={pkg.source === "none" ? "unknown" : "ok"} />
				</span>
				<div className="min-w-0 space-y-1">
					<div className="font-mono text-sm font-medium break-all">{pkg.packageName}</div>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
						<span>{sourceLabel(t.t, pkg.source)}</span>
						<span>
							{t.t("package_version_spec")}: <span className="font-mono">{pkg.versionSpec}</span>
						</span>
						<span>
							{t.t("package_binary")}: <span className="font-mono">{pkg.binaryName}</span>
						</span>
						{pkg.version === undefined ? null : <span className="font-mono">{pkg.version}</span>}
					</div>
					{pkg.binaryPath === undefined ? null : (
						<div className="font-mono text-[11px] break-all text-muted-foreground">
							{pkg.binaryPath}
						</div>
					)}
				</div>
			</div>
			<Button disabled={busy} size="xs" variant="ghost" onClick={onUninstall}>
				{t.t("runtime_uninstall")}
			</Button>
		</div>
	);
}

function AuthLoginCard({
	onCancel,
	onSubmitInput,
	session,
	submitting,
}: {
	readonly onCancel: () => void;
	readonly onSubmitInput: (value: string) => void;
	readonly session: AcpAuthLoginResult;
	readonly submitting: boolean;
}) {
	const t = usePluginI18n();
	const [codeInput, setCodeInput] = useState("");
	const name = presetLabel(t.t, session.preset);
	const handleSubmit = () => {
		const trimmed = codeInput.trim();
		if (trimmed.length === 0 || submitting) return;
		onSubmitInput(trimmed);
		setCodeInput("");
	};
	return (
		<Alert tone="info" title={t.t("auth_login_title", { name })}>
			<div className="space-y-2">
				{session.userCode === undefined ? null : (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[11px] text-muted-foreground">{t.t("auth_login_code_label")}:</span>
						<code className="rounded bg-muted px-2 py-0.5 font-mono text-sm font-semibold tracking-widest">
							{session.userCode}
						</code>
					</div>
				)}
				{session.verificationUri === undefined ? null : (
					<div className="flex flex-wrap items-center gap-2">
						<a
							className="inline-flex items-center gap-1 font-mono text-[11px] text-primary underline underline-offset-4 break-all"
							href={session.verificationUri}
							rel="noreferrer"
							target="_blank"
						>
							<span>{session.verificationUri}</span>
							<ExternalLink className="h-3 w-3 shrink-0" />
						</a>
					</div>
				)}
				{session.needsInput === true ? (
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<Input
							aria-label={t.t("auth_login_input_placeholder")}
							className="min-w-0 flex-1 basis-56"
							placeholder={t.t("auth_login_input_placeholder")}
							value={codeInput}
							onChange={setCodeInput}
							onKeyDown={(event) => {
								if (event.key === "Enter") handleSubmit();
							}}
						/>
						<Button
							disabled={submitting || codeInput.trim().length === 0}
							loading={submitting}
							size="sm"
							onClick={handleSubmit}
						>
							{t.t("auth_login_submit")}
						</Button>
					</div>
				) : null}
				{session.output === undefined ? null : (
					<pre className="max-h-36 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
						{session.output}
					</pre>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2 pt-1">
					<span className="text-[11px] text-muted-foreground">{t.t("auth_login_waiting")}</span>
					<Button leadingIcon={<X />} size="xs" variant="ghost" onClick={onCancel}>
						{t.t("auth_cancel")}
					</Button>
				</div>
			</div>
		</Alert>
	);
}

function ProbeResultAlert({ result }: { readonly result: AcpProbeResult }) {
	const t = usePluginI18n();
	if (!result.ok) {
		return (
			<Alert tone="danger" title={t.t("probe_failed")}>
				<div className="space-y-1">
					<div>{result.error ?? t.t("unknown_error")}</div>
					{result.stderr === undefined ? null : (
						<pre className="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
							{result.stderr}
						</pre>
					)}
				</div>
			</Alert>
		);
	}
	const agent = [result.agentInfo?.title ?? result.agentInfo?.name, result.agentInfo?.version]
		.filter((value): value is string => value !== undefined && value.length > 0)
		.join(" · ");
	const promptCapabilities =
		result.promptCapabilities === undefined
			? []
			: Object.entries(result.promptCapabilities).filter(
					(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
				);
	return (
		<Alert tone={result.stderr === undefined ? "success" : "warning"} title={t.t("probe_success")}>
			<div className="space-y-1">
				{agent.length === 0 ? null : (
					<div>
						<span className="text-muted-foreground">{t.t("probe_agent")}: </span>
						{agent}
					</div>
				)}
				<div>{t.t("probe_models", { count: String(result.models.length) })}</div>
				{promptCapabilities.length === 0 ? null : (
					<div>
						<span className="text-muted-foreground">{t.t("probe_prompt_capabilities")}: </span>
						{promptCapabilities.map(([key, value]) => `${key}=${String(value)}`).join(", ")}
					</div>
				)}
				{result.stderr === undefined ? null : (
					<div>
						<div className="text-muted-foreground">{t.t("probe_stderr")}</div>
						<pre className="max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
							{result.stderr}
						</pre>
					</div>
				)}
			</div>
		</Alert>
	);
}

function ModelRow({
	model,
	onChange,
	onRemove,
}: {
	readonly model: AcpModelConfig;
	readonly onChange: (next: AcpModelConfig) => void;
	readonly onRemove: () => void;
}) {
	const t = usePluginI18n();
	const [contextWindow, setContextWindow] = useState(String(model.contextWindow));
	const [maxOutputTokens, setMaxOutputTokens] = useState(String(model.maxOutputTokens));
	const reasoningLevels =
		model.reasoningLevels.length === 0 ? acpReasoningLevelSchema.options : model.reasoningLevels;

	useEffect(() => {
		setContextWindow(String(model.contextWindow));
		setMaxOutputTokens(String(model.maxOutputTokens));
	}, [model.contextWindow, model.maxOutputTokens]);

	const commitContextWindow = () => {
		const value = Math.max(1, Math.round(Number(contextWindow) || 1));
		setContextWindow(String(value));
		onChange({ ...model, contextWindow: value });
	};

	const commitMaxOutputTokens = () => {
		const value = Math.max(1, Math.round(Number(maxOutputTokens) || 1));
		setMaxOutputTokens(String(value));
		onChange({ ...model, maxOutputTokens: value });
	};

	return (
		<div className="border-t border-line py-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-3">
					<EditorialSwitch
						ariaLabel={t.t("model_enabled")}
						checked={model.enabled}
						onCheckedChange={(enabled) => onChange({ ...model, enabled })}
					/>
					<div className="min-w-0">
						<div className="truncate font-mono text-sm font-medium">{model.name ?? model.id}</div>
						{model.name === undefined ? null : (
							<div className="truncate font-mono text-[11px] text-muted-foreground">{model.id}</div>
						)}
						{model.capabilities.length === 0 ? null : (
							<div className="mt-1.5 flex flex-wrap gap-1">
								{model.capabilities.map((capability) => (
									<span
										key={capability}
										className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
									>
										{capability}
									</span>
								))}
							</div>
						)}
					</div>
				</div>
				<Button
					size="iconSm"
					variant="ghost"
					aria-label={t.t("remove_model")}
					title={t.t("remove_model")}
					onClick={onRemove}
				>
					<Trash2 />
				</Button>
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-2">
				<CapabilityButton
					active={model.supportsTools}
					label={t.t("capability_tools")}
					onClick={() => onChange({ ...model, supportsTools: !model.supportsTools })}
				/>
				<CapabilityButton
					active={model.supportsReasoning}
					label={t.t("capability_reasoning")}
					onClick={() => onChange({ ...model, supportsReasoning: !model.supportsReasoning })}
				/>
				<CapabilityButton
					active={model.supportsImage}
					label={t.t("capability_image")}
					onClick={() => onChange({ ...model, supportsImage: !model.supportsImage })}
				/>
				<CapabilityButton
					active={model.supportsImageGeneration}
					label={t.t("capability_image_generation")}
					onClick={() =>
						onChange({
							...model,
							supportsImageGeneration: !model.supportsImageGeneration,
						})
					}
				/>
				<CapabilityButton
					active={model.supportsVideoGeneration}
					label={t.t("capability_video_generation")}
					onClick={() =>
						onChange({
							...model,
							supportsVideoGeneration: !model.supportsVideoGeneration,
						})
					}
				/>
				<CapabilityButton
					active={model.supportsAudio}
					label={t.t("capability_audio")}
					onClick={() => onChange({ ...model, supportsAudio: !model.supportsAudio })}
				/>
				<CapabilityButton
					active={model.supportsSidechat}
					label={t.t("capability_sidechat")}
					onClick={() => onChange({ ...model, supportsSidechat: !model.supportsSidechat })}
				/>
			</div>

			<div className="mt-3 grid gap-3 sm:grid-cols-3">
				<Field label={t.t("context_window")}>
					<Input
						type="number"
						min={1}
						value={contextWindow}
						onBlur={commitContextWindow}
						onChange={setContextWindow}
					/>
				</Field>
				<Field label={t.t("max_output_tokens")}>
					<Input
						type="number"
						min={1}
						value={maxOutputTokens}
						onBlur={commitMaxOutputTokens}
						onChange={setMaxOutputTokens}
					/>
				</Field>
				<Field label={t.t("default_effort")}>
					<EditorialSelect<AcpReasoningLevel>
						value={model.defaultReasoningLevel}
						onValueChange={(value) => onChange({ ...model, defaultReasoningLevel: value })}
					>
						<EditorialSelectTrigger aria-label={t.t("default_effort")} className="w-full">
							<EditorialSelectValue />
						</EditorialSelectTrigger>
						<EditorialSelectContent>
							{reasoningLevels.map((level) => (
								<EditorialSelectItem key={level} value={level}>
									{effortLabel(t.t, level)}
								</EditorialSelectItem>
							))}
						</EditorialSelectContent>
					</EditorialSelect>
				</Field>
			</div>
		</div>
	);
}

function AcpPanel() {
	const t = usePluginI18n();
	const config = usePluginConfig();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const formId = useId();
	const configSnapshot = JSON.stringify(config.value);
	const [profiles, setProfiles] = useState<readonly ProfileDraft[]>(() =>
		readDraftProfiles(config.value),
	);
	const [selectedProfileId, setSelectedProfileId] = useState(
		() => readDraftProfiles(config.value)[0]?.id ?? "",
	);
	const [secretEnvDrafts, setSecretEnvDrafts] = useState<Record<string, string>>({});
	const [runtimeStatus, setRuntimeStatus] = useState<AcpRuntimeStatusSnapshot | null>(null);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const [runtimeLoading, setRuntimeLoading] = useState(true);
	const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null);
	const [authProviders, setAuthProviders] = useState<readonly AcpAuthProviderStatus[]>([]);
	const [activeLogin, setActiveLogin] = useState<AcpAuthLoginResult | null>(null);
	const [loginStarting, setLoginStarting] = useState<AcpAuthPreset | null>(null);
	const [loginSubmitting, setLoginSubmitting] = useState(false);
	const [newPackageName, setNewPackageName] = useState("");
	const [probeState, setProbeState] = useState<ProbeState | null>(null);
	const [probing, setProbing] = useState(false);
	const [query, setQuery] = useState("");
	const [newModelId, setNewModelId] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const next = readDraftProfiles(config.value);
		setProfiles(next);
		setSecretEnvDrafts({});
		setSelectedProfileId((current) =>
			next.some((profile) => profile.id === current) ? current : (next[0]?.id ?? ""),
		);
	}, [configSnapshot]);

	const activeProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0];
	const activeProfileId = activeProfile?.id ?? "";
	const models = activeProfile?.models ?? [];
	const enabledCount = models.filter((model) => model.enabled).length;
	const secretDraft = activeProfile === undefined ? "" : (secretEnvDrafts[activeProfile.id] ?? "");
	const hasStoredSecrets =
		activeProfile !== undefined &&
		(config.secretsSet.includes("profileEnvSecrets") ||
			config.secretsSet.includes(`profileEnvSecrets.${activeProfile.id}`));
	const filteredModels = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (normalized.length === 0) return models;
		return models.filter(
			(model) =>
				model.id.toLowerCase().includes(normalized) ||
				model.name?.toLowerCase().includes(normalized) === true ||
				model.capabilities.some((capability) => capability.toLowerCase().includes(normalized)),
		);
	}, [models, query]);

	const updateActiveProfile = (updater: (profile: ProfileDraft) => ProfileDraft) => {
		if (activeProfile === undefined) return;
		const id = activeProfile.id;
		setProfiles((current) =>
			current.map((profile) => (profile.id === id ? updater(profile) : profile)),
		);
	};

	const addPreset = (preset: AcpPreset) => {
		const id = nextProfileId(preset, profiles);
		const profile = createPresetProfile(preset, { id });
		setProfiles((current) => [...current, profileToDraft(profile)]);
		setSelectedProfileId(id);
		setProbeState(null);
	};

	const removeActiveProfile = () => {
		if (activeProfile === undefined) return;
		const id = activeProfile.id;
		const next = profiles.filter((profile) => profile.id !== id);
		setProfiles(next);
		setSelectedProfileId(next[0]?.id ?? "");
		setSecretEnvDrafts((current) => {
			const updated = { ...current };
			delete updated[id];
			return updated;
		});
		if (probeState?.profileId === id) setProbeState(null);
	};

	const updateEnabled = (enabled: boolean) => {
		updateActiveProfile((profile) => ({ ...profile, enabled }));
	};

	const updateName = (name: string) => {
		updateActiveProfile((profile) => ({ ...profile, name }));
	};

	const updateCommand = (command: string) => {
		updateActiveProfile((profile) => ({ ...profile, command }));
	};

	const updateCwd = (cwd: string) => {
		updateActiveProfile((profile) => ({ ...profile, cwd }));
	};

	const updateArgs = (argsText: string) => {
		updateActiveProfile((profile) => ({ ...profile, args: parseArgs(argsText), argsText }));
	};

	const updateEnv = (envText: string) => {
		updateActiveProfile((profile) => ({
			...profile,
			env: parseEnvText(envText).env,
			envText,
		}));
	};

	const updateSecretEnv = (value: string) => {
		if (activeProfile === undefined) return;
		const id = activeProfile.id;
		setSecretEnvDrafts((current) => ({ ...current, [id]: value }));
	};

	const refreshAuthStatus = async (): Promise<void> => {
		try {
			const snapshot = await rpc.call<AcpAuthStatusSnapshot>(ACP_AUTH_STATUS_RPC, {});
			setAuthProviders(snapshot.providers);
		} catch {
			// Auth status is supplemental; keep runtime panel usable if it fails.
		}
	};

	const refreshRuntimeStatus = async (silent = false): Promise<void> => {
		setRuntimeLoading(true);
		try {
			const next = await rpc.call<AcpRuntimeStatusSnapshot>(ACP_RUNTIME_STATUS_RPC);
			setRuntimeStatus(next);
			setRuntimeError(null);
			void refreshAuthStatus();
			if (!silent) toast.success(t.t("runtime_refreshed"));
		} catch (error) {
			const message = errorMessage(error);
			setRuntimeError(message);
			if (!silent) toast.error(t.t("runtime_status_failed"), message);
		} finally {
			setRuntimeLoading(false);
		}
	};

	const startAuthLogin = async (preset: AcpAuthPreset): Promise<void> => {
		setLoginStarting(preset);
		const name = presetLabel(t.t, preset);
		try {
			const result = await rpc.call<AcpAuthLoginResult>(ACP_AUTH_LOGIN_START_RPC, { preset });
			if (result.status === "authorized") {
				setActiveLogin(null);
				toast.success(t.t("auth_login_success", { name }));
				void refreshAuthStatus();
				return;
			}
			if (result.status === "failed" || result.status === "expired") {
				setActiveLogin(null);
				toast.error(t.t("auth_login_failed", { name }), result.message ?? t.t("unknown_error"));
				return;
			}
			if (result.status === "pending") {
				setActiveLogin(result);
			}
		} catch (error) {
			toast.error(t.t("auth_login_failed", { name }), errorMessage(error));
		} finally {
			setLoginStarting(null);
		}
	};

	const cancelAuthLogin = async (preset: AcpAuthPreset): Promise<void> => {
		setActiveLogin(null);
		try {
			await rpc.call<AcpAuthLoginResult>(ACP_AUTH_LOGIN_CANCEL_RPC, { preset });
		} catch {
			// Ignore cancel errors.
		}
		toast.info(t.t("auth_login_cancelled"));
	};

	const submitAuthLoginInput = async (preset: AcpAuthPreset, input: string): Promise<void> => {
		setLoginSubmitting(true);
		const name = presetLabel(t.t, preset);
		try {
			const result = await rpc.call<AcpAuthLoginResult>(ACP_AUTH_LOGIN_SUBMIT_RPC, {
				input,
				preset,
			});
			if (result.status === "pending") {
				setActiveLogin(result);
				return;
			}
			setActiveLogin(null);
			if (result.status === "authorized") {
				toast.success(t.t("auth_login_success", { name }));
				void refreshAuthStatus();
			} else if (result.status === "expired") {
				toast.error(t.t("auth_login_expired", { name }));
			} else if (result.status === "failed") {
				toast.error(t.t("auth_login_failed", { name }), result.message ?? t.t("unknown_error"));
			}
		} catch (error) {
			toast.error(t.t("auth_login_failed", { name }), errorMessage(error));
		} finally {
			setLoginSubmitting(false);
		}
	};

	useEffect(() => {
		if (activeLogin === null || activeLogin.status !== "pending") return;
		const preset = activeLogin.preset;
		const name = presetLabel(t.t, preset);
		let cancelled = false;
		const timer = setInterval(() => {
			void rpc
				.call<AcpAuthLoginResult>(ACP_AUTH_LOGIN_POLL_RPC, { preset })
				.then((next) => {
					if (cancelled) return;
					if (next.status === "pending") {
						setActiveLogin(next);
						return;
					}
					setActiveLogin(null);
					if (next.status === "authorized") {
						toast.success(t.t("auth_login_success", { name }));
						void refreshAuthStatus();
					} else if (next.status === "expired") {
						toast.error(t.t("auth_login_expired", { name }));
					} else if (next.status === "failed") {
						toast.error(t.t("auth_login_failed", { name }), next.message ?? t.t("unknown_error"));
					}
				})
				.catch(() => {
					// Keep polling on transient network errors.
				});
		}, 2_500);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeLogin?.preset, activeLogin?.status]);

	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => {
		void refreshRuntimeStatus(true);
	}, []);

	const runRuntimeAction = async (
		key: string,
		action: () => Promise<AcpRuntimeOperationResult>,
		success: string,
	): Promise<boolean> => {
		setRuntimeBusy(key);
		try {
			const result = await action();
			if (result.ok) {
				toast.success(success, result.message);
			} else if (result.requiresManualInstall === true) {
				toast.info(t.t("runtime_manual_install"), result.message);
			} else {
				toast.error(t.t("runtime_action_failed"), result.message);
			}
			await refreshRuntimeStatus(true);
			return result.ok;
		} catch (error) {
			toast.error(t.t("runtime_action_failed"), errorMessage(error));
			return false;
		} finally {
			setRuntimeBusy(null);
		}
	};

	const installRuntime = (runtime: AcpRuntimeBinaryStatus) => {
		void runRuntimeAction(
			`runtime:${runtime.id}`,
			() => rpc.call<AcpRuntimeOperationResult>(ACP_RUNTIME_INSTALL_RPC, { id: runtime.id }),
			runtime.source === "none" ? t.t("runtime_install_success") : t.t("runtime_update_success"),
		);
	};

	const uninstallRuntime = (runtime: AcpRuntimeBinaryStatus) => {
		void runRuntimeAction(
			`runtime:${runtime.id}`,
			() => rpc.call<AcpRuntimeOperationResult>(ACP_RUNTIME_UNINSTALL_RPC, { id: runtime.id }),
			t.t("runtime_uninstall_success"),
		);
	};

	const installCustomPackage = async () => {
		const packageName = newPackageName.trim();
		if (packageName.length === 0) return;
		const installed = await runRuntimeAction(
			`package:${packageName}`,
			() =>
				rpc.call<AcpRuntimeOperationResult>(ACP_RUNTIME_INSTALL_RPC, {
					packageName,
				}),
			t.t("package_install_success"),
		);
		if (installed) setNewPackageName("");
	};

	const uninstallCustomPackage = (pkg: AcpCustomPackageStatus) => {
		void runRuntimeAction(
			`package:${pkg.packageName}`,
			() =>
				rpc.call<AcpRuntimeOperationResult>(ACP_RUNTIME_UNINSTALL_RPC, {
					packageName: pkg.packageName,
				}),
			t.t("package_uninstall_success"),
		);
	};

	const addModel = () => {
		if (activeProfile === undefined) return;
		const id = newModelId.trim();
		if (id.length === 0) return;
		if (activeProfile.models.some((model) => model.id === id)) {
			toast.error(t.t("duplicate_model"), id);
			return;
		}
		updateActiveProfile((profile) => ({
			...profile,
			models: [...profile.models, createAcpModel(id, { enabled: true, supportsTools: true })],
		}));
		setNewModelId("");
	};

	const updateModel = (id: string, next: AcpModelConfig) => {
		updateActiveProfile((profile) => ({
			...profile,
			models: profile.models.map((model) => (model.id === id ? next : model)),
		}));
	};

	const removeModel = (id: string) => {
		updateActiveProfile((profile) => ({
			...profile,
			models: profile.models.filter((model) => model.id !== id),
		}));
	};

	const probeProfile = async () => {
		if (activeProfile === undefined) return;
		const command = activeProfile.command.trim();
		if (command.length === 0) {
			toast.error(t.t("probe_failed"), t.t("command_required"));
			return;
		}
		const publicEnv = parseEnvText(activeProfile.envText);
		if (publicEnv.invalid.length > 0) {
			toast.error(t.t("probe_failed"), t.t("env_format_error"));
			return;
		}
		const secretText = secretEnvDrafts[activeProfile.id] ?? "";
		const secretEnv = parseEnvText(secretText);
		if (secretEnv.invalid.length > 0) {
			toast.error(t.t("probe_failed"), t.t("secret_env_format_error"));
			return;
		}
		setProbing(true);
		try {
			const result = await rpc.call<AcpProbeResult>(ACP_PROBE_RPC, {
				profileId: activeProfile.id,
				preset: activeProfile.preset,
				command,
				args: parseArgs(activeProfile.argsText),
				...(activeProfile.cwd === undefined || activeProfile.cwd.trim().length === 0
					? {}
					: { cwd: activeProfile.cwd.trim() }),
				env: {
					...publicEnv.env,
					...(secretText.trim().length === 0 ? {} : secretEnv.env),
				},
				requestTimeoutMs: activeProfile.requestTimeoutMs,
			});
			const known = new Set(activeProfile.models.map((model) => model.id));
			const additions = result.models.filter((model) => !known.has(model.id));
			setProbeState({ profileId: activeProfile.id, result });
			if (additions.length > 0) {
				setProfiles((current) =>
					current.map((profile) => {
						if (profile.id !== activeProfile.id) return profile;
						const currentIds = new Set(profile.models.map((model) => model.id));
						const discovered = additions
							.filter((model) => !currentIds.has(model.id))
							.map((model) =>
								createAcpModel(model.id, {
									enabled: true,
									supportsTools: true,
									...(model.name === undefined ? {} : { name: model.name }),
								}),
							);
						return { ...profile, models: [...profile.models, ...discovered] };
					}),
				);
			}
			if (result.ok) {
				toast.success(
					t.t("probe_success"),
					t.t("probe_models_added", { count: String(additions.length) }),
				);
			} else {
				toast.error(t.t("probe_failed"), result.error ?? t.t("unknown_error"));
			}
		} catch (error) {
			const message = errorMessage(error);
			setProbeState({ profileId: activeProfile.id, error: message });
			toast.error(t.t("probe_failed"), message);
		} finally {
			setProbing(false);
		}
	};

	const save = async () => {
		if (saving || config.saving) return;
		for (const profile of profiles) {
			if (parseEnvText(profile.envText).invalid.length > 0) {
				toast.error(t.t("save_failed"), t.t("env_format_error"));
				return;
			}
		}
		const payloadProfiles = [];
		for (const profile of profiles) {
			const parsed = acpProfileSchema.safeParse(profilePayload(profile));
			if (!parsed.success) {
				toast.error(
					t.t("save_failed"),
					t.t("profile_invalid", {
						id: profile.id,
						issue: parsed.error.issues[0]?.message ?? t.t("unknown_error"),
					}),
				);
				return;
			}
			payloadProfiles.push(parsed.data);
		}
		const profileEnvSecrets: Record<string, Record<string, string> | null> = {};
		for (const [profileId, text] of Object.entries(secretEnvDrafts)) {
			if (text.trim().length === 0) continue;
			if (!profiles.some((profile) => profile.id === profileId)) continue;
			const parsed = parseEnvText(text);
			if (parsed.invalid.length > 0 || Object.keys(parsed.env).length === 0) {
				toast.error(t.t("save_failed"), t.t("secret_env_format_error"));
				return;
			}
			profileEnvSecrets[profileId] = parsed.env;
		}
		for (const previous of readDraftProfiles(config.value)) {
			if (!profiles.some((profile) => profile.id === previous.id)) {
				profileEnvSecrets[previous.id] = null;
			}
		}
		setSaving(true);
		try {
			await config.save({
				profiles: payloadProfiles,
				...(Object.keys(profileEnvSecrets).length === 0 ? {} : { profileEnvSecrets }),
			});
			setSecretEnvDrafts({});
			setProbeState(null);
			toast.success(t.t("save_success"));
		} catch (error) {
			toast.error(t.t("save_failed"), errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<PluginPage
			actions={
				<Button
					disabled={saving || config.saving}
					leadingIcon={<Save />}
					size="sm"
					onClick={() => void save()}
				>
					{t.t("save")}
				</Button>
			}
			description={t.t("plugin_description")}
			title={t.t("panel_acp")}
		>
			<PluginSection
				actions={
					<Button
						disabled={runtimeLoading}
						leadingIcon={<RefreshCw />}
						loading={runtimeLoading}
						size="sm"
						variant="secondary"
						onClick={() => void refreshRuntimeStatus()}
					>
						{t.t("runtime_refresh")}
					</Button>
				}
				description={t.t("runtime_hint")}
				title={t.t("runtime_section")}
			>
				{runtimeError === null ? null : (
					<Alert tone="danger" title={t.t("runtime_status_failed")}>
						{runtimeError}
					</Alert>
				)}
				{runtimeStatus === null ? (
					runtimeLoading ? (
						<div className="text-[11px] text-muted-foreground">{t.t("runtime_loading")}</div>
					) : null
				) : (
					<>
						{runtimeStatus.runtimes.length === 0 ? (
							<EmptyState title={t.t("no_runtimes")} />
						) : (
							<div>
								{runtimeStatus.runtimes.map((runtime) => {
									const loginPreset = LOGIN_RUNTIME_IDS[runtime.id];
									const authStatus =
										loginPreset === undefined
											? undefined
											: authProviders.find((provider) => provider.preset === loginPreset);
									const isLoggingIn =
										loginPreset !== undefined &&
										(loginStarting === loginPreset ||
											(activeLogin?.preset === loginPreset && activeLogin.status === "pending"));
									return (
										<RuntimeRow
											key={runtime.id}
											{...(authStatus === undefined ? {} : { authStatus })}
											busy={runtimeBusy !== null}
											loggingIn={isLoggingIn}
											runtime={runtime}
											onCheck={() => void refreshRuntimeStatus()}
											onInstall={() => installRuntime(runtime)}
											{...(loginPreset === undefined
												? {}
												: { onLogin: () => void startAuthLogin(loginPreset) })}
											onUninstall={() => uninstallRuntime(runtime)}
										/>
									);
								})}
							</div>
						)}
						{activeLogin === null ? null : (
							<div className="pt-3">
								<AuthLoginCard
									session={activeLogin}
									submitting={loginSubmitting}
									onCancel={() => void cancelAuthLogin(activeLogin.preset)}
									onSubmitInput={(value) => void submitAuthLoginInput(activeLogin.preset, value)}
								/>
							</div>
						)}
						<div className="pt-2 font-mono text-[11px] break-all text-muted-foreground">
							{t.t("tools_root_dir")}: {runtimeStatus.toolsRootDir}
						</div>
					</>
				)}

				<div className="mt-4 space-y-2 border-t border-line pt-3">
					<div>
						<div className="text-xs font-medium">{t.t("custom_packages")}</div>
						<p className="text-[11px] text-muted-foreground">{t.t("custom_packages_hint")}</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							aria-label={t.t("custom_package_placeholder")}
							className="min-w-0 flex-1 basis-44"
							placeholder={t.t("custom_package_placeholder")}
							value={newPackageName}
							onChange={setNewPackageName}
						/>
						<Button
							disabled={runtimeBusy !== null || newPackageName.trim().length === 0}
							leadingIcon={<Plus />}
							size="sm"
							variant="outline"
							onClick={() => void installCustomPackage()}
						>
							{t.t("install_package")}
						</Button>
					</div>
					{runtimeStatus === null ? null : runtimeStatus.customPackages.length === 0 ? (
						<div className="text-[11px] text-muted-foreground">{t.t("no_custom_packages")}</div>
					) : (
						<div>
							{runtimeStatus.customPackages.map((pkg) => (
								<CustomPackageRow
									key={pkg.packageName}
									busy={runtimeBusy !== null}
									pkg={pkg}
									onUninstall={() => uninstallCustomPackage(pkg)}
								/>
							))}
						</div>
					)}
				</div>
			</PluginSection>

			<PluginSection
				actions={
					<div className="flex flex-wrap gap-1.5">
						<Button size="xs" variant="secondary" onClick={() => addPreset("antigravity")}>
							{t.t("add_preset_antigravity")}
						</Button>
						<Button size="xs" variant="secondary" onClick={() => addPreset("codex")}>
							{t.t("add_preset_codex")}
						</Button>
						<Button size="xs" variant="secondary" onClick={() => addPreset("claude-code")}>
							{t.t("add_preset_claude")}
						</Button>
						<Button size="xs" variant="secondary" onClick={() => addPreset("custom")}>
							{t.t("add_preset_custom")}
						</Button>
					</div>
				}
				description={t.t("profiles_hint")}
				title={t.t("profiles_section")}
			>
				{activeProfile === undefined ? (
					<EmptyState title={t.t("no_profiles")} description={t.t("no_profiles_hint")} />
				) : (
					<>
						<PreferenceRow label={t.t("profile_select")}>
							<div className="flex items-center gap-2">
								<EditorialSelect
									value={activeProfileId}
									onValueChange={(value) => {
										setSelectedProfileId(value);
										setProbeState(null);
									}}
								>
									<EditorialSelectTrigger
										aria-label={t.t("profile_select")}
										className="min-w-0 flex-1"
									>
										<EditorialSelectValue />
									</EditorialSelectTrigger>
									<EditorialSelectContent>
										{profiles.map((profile) => (
											<EditorialSelectItem key={profile.id} value={profile.id}>
												{profile.name ?? profile.id} · {presetLabel(t.t, profile.preset)}
											</EditorialSelectItem>
										))}
									</EditorialSelectContent>
								</EditorialSelect>
								<Button
									size="iconSm"
									variant="ghost"
									aria-label={t.t("profile_remove")}
									title={t.t("profile_remove")}
									onClick={removeActiveProfile}
								>
									<Trash2 />
								</Button>
							</div>
						</PreferenceRow>
						<PreferenceRow
							hint={t.t("profile_id_hint", { id: activeProfile.id })}
							label={t.t("profile_id")}
						>
							<Input disabled value={activeProfile.id} />
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-profile-name`} label={t.t("profile_name")}>
							<Input
								id={`${formId}-profile-name`}
								placeholder={t.t("profile_name_placeholder")}
								value={activeProfile.name ?? ""}
								onChange={updateName}
							/>
						</PreferenceRow>
						<PreferenceRow label={t.t("profile_preset")}>
							<span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
								{presetLabel(t.t, activeProfile.preset)}
							</span>
						</PreferenceRow>
						<PreferenceRow label={t.t("profile_enabled")}>
							<EditorialSwitch
								ariaLabel={t.t("profile_enabled")}
								checked={activeProfile.enabled}
								onCheckedChange={updateEnabled}
							/>
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-command`} label={t.t("command")}>
							<Input
								id={`${formId}-command`}
								placeholder="codex-acp"
								value={activeProfile.command}
								onChange={updateCommand}
							/>
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-args`} hint={t.t("args_hint")} label={t.t("args")}>
							<textarea
								id={`${formId}-args`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={activeProfile.argsText}
								onChange={(event) => updateArgs(event.target.value)}
							/>
						</PreferenceRow>
						<PreferenceRow htmlFor={`${formId}-cwd`} hint={t.t("cwd_hint")} label={t.t("cwd")}>
							<Input id={`${formId}-cwd`} value={activeProfile.cwd ?? ""} onChange={updateCwd} />
						</PreferenceRow>
						<NumberPreferenceRow
							hint={t.t("request_timeout_hint")}
							label={t.t("request_timeout")}
							max={900_000}
							min={1_000}
							value={activeProfile.requestTimeoutMs}
							onChange={(requestTimeoutMs) =>
								updateActiveProfile((profile) => ({ ...profile, requestTimeoutMs }))
							}
						/>
						<NumberPreferenceRow
							hint={t.t("idle_ttl_hint")}
							label={t.t("idle_ttl")}
							max={3_600_000}
							min={5_000}
							value={activeProfile.idleTtlMs}
							onChange={(idleTtlMs) =>
								updateActiveProfile((profile) => ({ ...profile, idleTtlMs }))
							}
						/>
						<PreferenceRow
							htmlFor={`${formId}-env`}
							hint={t.t("env_public_hint")}
							label={t.t("env_public")}
						>
							<textarea
								id={`${formId}-env`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								value={activeProfile.envText}
								onChange={(event) => updateEnv(event.target.value)}
							/>
						</PreferenceRow>
						<PreferenceRow
							htmlFor={`${formId}-secret-env`}
							hint={
								<span>
									{hasStoredSecrets ? `${t.t("env_secret_stored")} ` : ""}
									{t.t("env_secret_hint")}
								</span>
							}
							label={t.t("env_secret")}
						>
							<textarea
								id={`${formId}-secret-env`}
								className="min-h-20 w-full rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
								placeholder={hasStoredSecrets ? t.t("env_secret_stored") : "KEY=VALUE"}
								value={secretDraft}
								onChange={(event) => updateSecretEnv(event.target.value)}
							/>
						</PreferenceRow>

						<div className="mt-5 border-t border-line pt-3">
							<div className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
								{t.t("capabilities_security")}
							</div>
						</div>
						<PreferenceRow
							hint={t.t("enable_as_model_provider_hint")}
							label={t.t("enable_as_model_provider")}
						>
							<EditorialSwitch
								ariaLabel={t.t("enable_as_model_provider")}
								checked={activeProfile.enableAsModelProvider}
								onCheckedChange={(enableAsModelProvider) =>
									updateActiveProfile((profile) => ({
										...profile,
										enableAsModelProvider,
									}))
								}
							/>
						</PreferenceRow>
						<PreferenceRow hint={t.t("tool_bridge_mode_hint")} label={t.t("tool_bridge_mode")}>
							<EditorialSelect<AcpToolBridgeMode>
								value={activeProfile.toolBridgeMode}
								onValueChange={(toolBridgeMode) =>
									updateActiveProfile((profile) => ({ ...profile, toolBridgeMode }))
								}
							>
								<EditorialSelectTrigger aria-label={t.t("tool_bridge_mode")} className="w-full">
									<EditorialSelectValue />
								</EditorialSelectTrigger>
								<EditorialSelectContent>
									<EditorialSelectItem value="disabled">
										{t.t("bridge_disabled")}
									</EditorialSelectItem>
									<EditorialSelectItem value="mcp-bridge">
										{t.t("bridge_mcp_bridge")}
									</EditorialSelectItem>
									<EditorialSelectItem value="prompt-json">
										{t.t("bridge_prompt_json")}
									</EditorialSelectItem>
								</EditorialSelectContent>
							</EditorialSelect>
						</PreferenceRow>
						<PreferenceRow
							hint={t.t("supports_image_generation_hint")}
							label={t.t("supports_image_generation")}
						>
							<EditorialSwitch
								ariaLabel={t.t("supports_image_generation")}
								checked={activeProfile.supportsImageGeneration}
								onCheckedChange={(supportsImageGeneration) =>
									updateActiveProfile((profile) => ({
										...profile,
										supportsImageGeneration,
									}))
								}
							/>
						</PreferenceRow>
						<PreferenceRow
							hint={t.t("supports_video_generation_hint")}
							label={t.t("supports_video_generation")}
						>
							<EditorialSwitch
								ariaLabel={t.t("supports_video_generation")}
								checked={activeProfile.supportsVideoGeneration}
								onCheckedChange={(supportsVideoGeneration) =>
									updateActiveProfile((profile) => ({
										...profile,
										supportsVideoGeneration,
									}))
								}
							/>
						</PreferenceRow>
						<PreferenceRow
							hint={t.t("supports_capability_tool_hint")}
							label={t.t("supports_capability_tool")}
						>
							<EditorialSwitch
								ariaLabel={t.t("supports_capability_tool")}
								checked={activeProfile.supportsCapabilityTool}
								onCheckedChange={(supportsCapabilityTool) =>
									updateActiveProfile((profile) => ({
										...profile,
										supportsCapabilityTool,
									}))
								}
							/>
						</PreferenceRow>
						<PreferenceRow
							hint={t.t("allowed_capability_chat_hint")}
							label={t.t("allowed_capability_chat")}
						>
							<EditorialSwitch
								ariaLabel={t.t("allowed_capability_chat")}
								checked={activeProfile.allowedCapabilityChat}
								onCheckedChange={(allowedCapabilityChat) =>
									updateActiveProfile((profile) => ({
										...profile,
										allowedCapabilityChat,
									}))
								}
							/>
						</PreferenceRow>

						<div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
							{isAuthPreset(activeProfile.preset) ? (
								<Button
									disabled={
										loginStarting === activeProfile.preset ||
										(activeLogin?.preset === activeProfile.preset &&
											activeLogin.status === "pending")
									}
									leadingIcon={<LogIn />}
									loading={loginStarting === activeProfile.preset}
									size="sm"
									variant="secondary"
									onClick={() => {
										if (isAuthPreset(activeProfile.preset)) {
											void startAuthLogin(activeProfile.preset);
										}
									}}
								>
									{loginStarting === activeProfile.preset
										? t.t("auth_logging_in")
										: t.t("auth_login")}
								</Button>
							) : null}
							<Button
								disabled={probing}
								leadingIcon={<RefreshCw />}
								size="sm"
								variant="secondary"
								onClick={() => void probeProfile()}
							>
								{probing ? t.t("probing") : t.t("probe")}
							</Button>
						</div>
						{probeState?.profileId !== activeProfileId ? null : probeState.error !== undefined ? (
							<Alert tone="danger" title={t.t("probe_failed")}>
								{probeState.error}
							</Alert>
						) : probeState.result === undefined ? null : (
							<ProbeResultAlert result={probeState.result} />
						)}
					</>
				)}
			</PluginSection>

			<PluginSection
				description={
					activeProfile === undefined
						? undefined
						: t.t("models_hint", {
								enabled: String(enabledCount),
								total: String(models.length),
							})
				}
				title={t.t("models_section")}
			>
				{activeProfile === undefined ? (
					<EmptyState title={t.t("no_profiles")} description={t.t("no_profiles_hint")} />
				) : (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2">
							<Input
								aria-label={t.t("search_models")}
								className="min-w-0 flex-1 basis-44"
								leftIcon={<Search />}
								placeholder={t.t("search_models")}
								value={query}
								onChange={setQuery}
							/>
							<Input
								aria-label={t.t("model_id_placeholder")}
								className="min-w-0 flex-1 basis-44"
								placeholder={t.t("model_id_placeholder")}
								value={newModelId}
								onChange={setNewModelId}
							/>
							<Button
								disabled={newModelId.trim().length === 0}
								leadingIcon={<Plus />}
								size="sm"
								variant="outline"
								onClick={addModel}
							>
								{t.t("add_model")}
							</Button>
						</div>

						{models.length === 0 ? (
							<EmptyState description={t.t("no_models_hint")} title={t.t("no_models")} />
						) : filteredModels.length === 0 ? (
							<EmptyState
								description={t.t("no_matching_models_hint")}
								title={t.t("no_matching_models")}
							/>
						) : (
							<div>
								{filteredModels.map((model) => (
									<ModelRow
										key={model.id}
										model={model}
										onChange={(next) => updateModel(model.id, next)}
										onRemove={() => removeModel(model.id)}
									/>
								))}
							</div>
						)}
					</div>
				)}
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
			component: AcpPanel,
			icon: "terminal",
			id: "acp",
			title: (t) => t("panel_acp"),
		},
	],
});
