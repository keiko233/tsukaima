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
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
	createOpenAiCompatibleModel,
	modelCapabilities,
	openAiCompatibleReasoningLevelSchema,
	readOpenAiCompatibleModels,
	type OpenAiCompatibleModel,
} from "./config.ts";
import type { DiscoveredModels } from "./discovery.ts";
import { i18n } from "./i18n.ts";
import { OPENAI_COMPATIBLE_DISCOVER_RPC } from "./manifest.ts";

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalNumber(raw: string, minimum: number, maximum: number): number | undefined {
	const value = raw.trim().length === 0 ? Number.NaN : Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(maximum, Math.max(minimum, value));
}

function CapabilityButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
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

function ModelRow({
	isDefault,
	model,
	onChange,
	onRemove,
}: {
	isDefault: boolean;
	model: OpenAiCompatibleModel;
	onChange: (next: OpenAiCompatibleModel) => void;
	onRemove: () => void;
}) {
	const t = usePluginI18n();
	const [contextWindow, setContextWindow] = useState(String(model.contextWindow));
	const [maxOutputTokens, setMaxOutputTokens] = useState(String(model.maxOutputTokens));
	const [temperature, setTemperature] = useState(model.temperature?.toString() ?? "");
	const [topP, setTopP] = useState(model.topP?.toString() ?? "");
	const [stopSequences, setStopSequences] = useState((model.stop ?? []).join(", "));
	const [requestTimeoutMs, setRequestTimeoutMs] = useState(
		model.requestTimeoutMs?.toString() ?? "",
	);
	const [customCapabilities, setCustomCapabilities] = useState(model.capabilities.join(", "));
	const capabilitiesKey = model.capabilities.join("\u0000");
	const stopKey = (model.stop ?? []).join("\u0000");
	const capabilities = modelCapabilities(model).filter(
		(capability) => !model.capabilities.includes(capability),
	);

	useEffect(() => {
		setContextWindow(String(model.contextWindow));
		setMaxOutputTokens(String(model.maxOutputTokens));
		setTemperature(model.temperature?.toString() ?? "");
		setTopP(model.topP?.toString() ?? "");
		setStopSequences((model.stop ?? []).join(", "));
		setRequestTimeoutMs(model.requestTimeoutMs?.toString() ?? "");
		setCustomCapabilities(model.capabilities.join(", "));
	}, [
		capabilitiesKey,
		model.contextWindow,
		model.maxOutputTokens,
		model.temperature,
		model.topP,
		model.requestTimeoutMs,
		stopKey,
	]);

	const updateTemperature = (raw: string) => {
		const value = optionalNumber(raw, 0, 2);
		const { temperature: _previous, ...rest } = model;
		setTemperature(value === undefined ? "" : String(value));
		onChange(value === undefined ? rest : { ...rest, temperature: value });
	};
	const updateTopP = (raw: string) => {
		const value = optionalNumber(raw, 0.01, 1);
		const { topP: _previous, ...rest } = model;
		setTopP(value === undefined ? "" : String(value));
		onChange(value === undefined ? rest : { ...rest, topP: value });
	};
	const updateStopSequences = (raw: string) => {
		const values = [
			...new Set(
				raw
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0),
			),
		].slice(0, 4);
		const { stop: _previous, ...rest } = model;
		setStopSequences(values.join(", "));
		onChange(values.length === 0 ? rest : { ...rest, stop: values });
	};
	const updateRequestTimeout = (raw: string) => {
		const value = optionalNumber(raw, 1_000, 600_000);
		const { requestTimeoutMs: _previous, ...rest } = model;
		setRequestTimeoutMs(value === undefined ? "" : String(value));
		onChange(value === undefined ? rest : { ...rest, requestTimeoutMs: Math.round(value) });
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
						<div className="mt-1.5 flex flex-wrap gap-1">
							{isDefault ? (
								<span className="text-[11px] font-medium text-accent-ink">
									{t.t("default_model")}
								</span>
							) : null}
							{capabilities.map((capability) => (
								<span key={capability} className="font-mono text-[11px] text-muted-foreground">
									{capability}
								</span>
							))}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-[11px] text-muted-foreground">
						{model.enabled ? t.t("model_enabled") : t.t("model_disabled")}
					</span>
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
					active={model.supportsAudio}
					label={t.t("capability_audio")}
					onClick={() => onChange({ ...model, supportsAudio: !model.supportsAudio })}
				/>
				<CapabilityButton
					active={model.supportsSidechat}
					label={t.t("capability_sidechat")}
					onClick={() => onChange({ ...model, supportsSidechat: !model.supportsSidechat })}
				/>
				{model.supportsReasoning ? (
					<div className="ml-auto flex items-center gap-2">
						<span className="text-[11px] text-muted-foreground">{t.t("reasoning_effort")}</span>
						<EditorialSelect
							value={model.defaultReasoningLevel}
							onValueChange={(value) =>
								onChange({
									...model,
									defaultReasoningLevel: openAiCompatibleReasoningLevelSchema.parse(value),
								})
							}
						>
							<EditorialSelectTrigger aria-label={t.t("reasoning_effort")} className="w-28">
								<EditorialSelectValue />
							</EditorialSelectTrigger>
							<EditorialSelectContent>
								{openAiCompatibleReasoningLevelSchema.options.map((level) => (
									<EditorialSelectItem key={level} value={level}>
										{level}
									</EditorialSelectItem>
								))}
							</EditorialSelectContent>
						</EditorialSelect>
					</div>
				) : null}
			</div>

			<details className="mt-2">
				<summary className="cursor-pointer py-1 text-xs text-muted-foreground hover:text-accent-ink">
					{t.t("advanced_parameters")}
				</summary>
				<div className="ms-1 mt-2 grid gap-3 border-s-2 border-accent-ink py-3 ps-4 sm:grid-cols-2">
					<Field label={t.t("context_window")}>
						<Input
							type="number"
							value={contextWindow}
							onBlur={() => {
								const value = Math.max(1, Number(contextWindow) || 1);
								setContextWindow(String(value));
								onChange({ ...model, contextWindow: value });
							}}
							onChange={setContextWindow}
						/>
					</Field>
					<Field label={t.t("max_output_tokens")}>
						<Input
							type="number"
							value={maxOutputTokens}
							onBlur={() => {
								const value = Math.max(1, Number(maxOutputTokens) || 1);
								setMaxOutputTokens(String(value));
								onChange({ ...model, maxOutputTokens: value });
							}}
							onChange={setMaxOutputTokens}
						/>
					</Field>
					<Field label={t.t("temperature")}>
						<Input
							type="number"
							min={0}
							max={2}
							step={0.05}
							value={temperature}
							onBlur={() => updateTemperature(temperature)}
							onChange={setTemperature}
						/>
					</Field>
					<Field label={t.t("top_p")}>
						<Input
							type="number"
							min={0.01}
							max={1}
							step={0.01}
							value={topP}
							onBlur={() => updateTopP(topP)}
							onChange={setTopP}
						/>
					</Field>
					<Field hint={t.t("stop_sequences_hint")} label={t.t("stop_sequences")}>
						<Input
							value={stopSequences}
							onBlur={() => updateStopSequences(stopSequences)}
							onChange={setStopSequences}
						/>
					</Field>
					<Field hint={t.t("request_timeout_hint")} label={t.t("request_timeout")}>
						<Input
							type="number"
							min={1_000}
							max={600_000}
							value={requestTimeoutMs}
							onBlur={() => updateRequestTimeout(requestTimeoutMs)}
							onChange={setRequestTimeoutMs}
						/>
					</Field>
					<Field
						className="sm:col-span-2"
						hint={t.t("custom_capabilities_hint")}
						label={t.t("custom_capabilities")}
					>
						<Input
							value={customCapabilities}
							onBlur={() => {
								const values = [
									...new Set(
										customCapabilities
											.split(",")
											.map((capability) => capability.trim())
											.filter((capability) => capability.length > 0),
									),
								];
								setCustomCapabilities(values.join(", "));
								onChange({ ...model, capabilities: values });
							}}
							onChange={setCustomCapabilities}
						/>
					</Field>
				</div>
			</details>
		</div>
	);
}

function ProviderPanel() {
	const i18nValue = usePluginI18n();
	const { status } = usePluginPanel();
	const connectionId = useId();
	const config = usePluginConfig();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const configSnapshot = JSON.stringify(config.value);
	const [baseUrl, setBaseUrl] = useState(() => stringValue(config.value.baseUrl));
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<readonly OpenAiCompatibleModel[]>(() =>
		readOpenAiCompatibleModels(config.value),
	);
	const [query, setQuery] = useState("");
	const [newModelId, setNewModelId] = useState("");
	const [discovering, setDiscovering] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setBaseUrl(stringValue(config.value.baseUrl));
		setModels(readOpenAiCompatibleModels(config.value));
		setApiKey("");
	}, [configSnapshot]);

	const enabledCount = models.filter((model) => model.enabled).length;
	const defaultModelId = models.find((model) => model.enabled)?.id;
	const filteredModels = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (normalized.length === 0) return models;
		return models.filter(
			(model) =>
				model.id.toLowerCase().includes(normalized) ||
				model.name?.toLowerCase().includes(normalized) === true ||
				modelCapabilities(model).some((capability) =>
					capability.toLowerCase().includes(normalized),
				),
		);
	}, [models, query]);

	const updateModel = (id: string, next: OpenAiCompatibleModel) => {
		setModels((current) => current.map((model) => (model.id === id ? next : model)));
	};

	const discover = async () => {
		if (baseUrl.trim().length === 0) {
			toast.error(i18nValue.t("discovery_failed"), i18nValue.t("base_url_required"));
			return;
		}
		if (apiKey.trim().length === 0 && !config.secretsSet.includes("apiKey")) {
			toast.error(i18nValue.t("discovery_failed"), i18nValue.t("api_key_required"));
			return;
		}
		setDiscovering(true);
		try {
			const discovered = await rpc.call<DiscoveredModels>(OPENAI_COMPATIBLE_DISCOVER_RPC, {
				baseUrl: baseUrl.trim(),
				...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
			});
			const known = new Set(models.map((model) => model.id));
			const additions = discovered.models.filter((model) => !known.has(model.id));
			setModels((current) => {
				const currentIds = new Set(current.map((model) => model.id));
				return [...current, ...additions.filter((model) => !currentIds.has(model.id))];
			});
			toast.success(
				i18nValue.t("discovery_complete", { count: String(discovered.models.length) }),
				i18nValue.t("discovery_added", { count: String(additions.length) }),
			);
		} catch (error) {
			toast.error(i18nValue.t("discovery_failed"), String(error));
		} finally {
			setDiscovering(false);
		}
	};

	const addModel = () => {
		const id = newModelId.trim();
		if (id.length === 0) return;
		if (models.some((model) => model.id === id)) {
			toast.error(i18nValue.t("duplicate_model"), id);
			return;
		}
		setModels((current) => [
			...current,
			createOpenAiCompatibleModel(id, { enabled: true, supportsTools: true }),
		]);
		setNewModelId("");
	};

	const save = async () => {
		if (baseUrl.trim().length === 0) {
			toast.error(i18nValue.t("save_failed"), i18nValue.t("base_url_required"));
			return;
		}
		setSaving(true);
		try {
			await config.save({
				baseUrl: baseUrl.trim(),
				modelId: null,
				models,
				...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
			});
			setApiKey("");
			toast.success(i18nValue.t("save_success"));
		} catch (error) {
			toast.error(i18nValue.t("save_failed"), String(error));
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
					{i18nValue.t("save")}
				</Button>
			}
			description={i18nValue.t("provider_hint")}
			title={i18nValue.t("provider_title")}
		>
			{status?.level === "warning" || status?.level === "error" ? (
				<Alert tone={status.level === "error" ? "danger" : "warning"}>
					{status.summary ?? status.message ?? i18nValue.t("status_needs_attention")}
				</Alert>
			) : null}

			<PluginSection title={i18nValue.t("connection_section")}>
				<PreferenceRow htmlFor={`${connectionId}-url`} label={i18nValue.t("base_url")}>
					<Input
						id={`${connectionId}-url`}
						placeholder="https://api.example.com/v1"
						value={baseUrl}
						onChange={setBaseUrl}
					/>
				</PreferenceRow>
				<PreferenceRow
					htmlFor={`${connectionId}-key`}
					hint={
						config.secretsSet.includes("apiKey")
							? i18nValue.t("api_key_configured")
							: i18nValue.t("api_key_hint")
					}
					label={i18nValue.t("api_key")}
				>
					<Input
						id={`${connectionId}-key`}
						type="password"
						placeholder={
							config.secretsSet.includes("apiKey") ? i18nValue.t("keep_secret") : "sk-..."
						}
						value={apiKey}
						onChange={setApiKey}
					/>
				</PreferenceRow>
			</PluginSection>

			<PluginSection
				actions={
					<Button
						disabled={discovering}
						leadingIcon={<RefreshCw />}
						size="sm"
						variant="secondary"
						onClick={() => void discover()}
					>
						{discovering ? i18nValue.t("fetching_models") : i18nValue.t("fetch_models")}
					</Button>
				}
				description={i18nValue.t("models_hint", {
					enabled: String(enabledCount),
					total: String(models.length),
				})}
				title={i18nValue.t("models_section")}
			>
				<div className="space-y-3">
					<div className="flex flex-wrap gap-2">
						<Input
							aria-label={i18nValue.t("search_models")}
							className="min-w-0 flex-1 basis-44"
							leftIcon={<Search />}
							placeholder={i18nValue.t("search_models")}
							value={query}
							onChange={setQuery}
						/>
						<Input
							aria-label={i18nValue.t("model_id_placeholder")}
							className="min-w-0 flex-1 basis-44"
							placeholder={i18nValue.t("model_id_placeholder")}
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
							{i18nValue.t("add_model")}
						</Button>
					</div>

					{models.length === 0 ? (
						<EmptyState
							description={i18nValue.t("no_models_hint")}
							title={i18nValue.t("no_models")}
						/>
					) : filteredModels.length === 0 ? (
						<EmptyState
							description={i18nValue.t("no_matching_models_hint")}
							title={i18nValue.t("no_matching_models")}
						/>
					) : (
						<div>
							{filteredModels.map((model) => (
								<ModelRow
									key={model.id}
									isDefault={model.id === defaultModelId}
									model={model}
									onChange={(next) => updateModel(model.id, next)}
									onRemove={() =>
										setModels((current) => current.filter((candidate) => candidate.id !== model.id))
									}
								/>
							))}
						</div>
					)}
					<p className="text-[11px] text-muted-foreground">{i18nValue.t("default_model_hint")}</p>
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
			component: ProviderPanel,
			icon: "puzzle",
			id: "provider",
			title: (t) => t("panel_provider"),
		},
	],
});
