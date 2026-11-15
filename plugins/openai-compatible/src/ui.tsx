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
	Switch,
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@tsukaima/sdk/ui";
import { Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
		<Button size="xs" variant={active ? "soft" : "outline"} aria-pressed={active} onClick={onClick}>
			{label}
		</Button>
	);
}

function ModelCard({
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
	const [customCapabilities, setCustomCapabilities] = useState(model.capabilities.join(", "));
	const capabilitiesKey = model.capabilities.join("\u0000");
	const capabilities = modelCapabilities(model).filter(
		(capability) => !model.capabilities.includes(capability),
	);

	useEffect(() => {
		setContextWindow(String(model.contextWindow));
		setMaxOutputTokens(String(model.maxOutputTokens));
		setCustomCapabilities(model.capabilities.join(", "));
	}, [capabilitiesKey, model.contextWindow, model.maxOutputTokens]);

	return (
		<div className="rounded-xl border border-border bg-background/40 p-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-3">
					<Switch
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
								<span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
									{t.t("default_model")}
								</span>
							) : null}
							{capabilities.map((capability) => (
								<span
									key={capability}
									className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
								>
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

			<div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border/70 pt-3">
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
						<Select
							value={model.defaultReasoningLevel}
							onValueChange={(value) =>
								onChange({
									...model,
									defaultReasoningLevel: openAiCompatibleReasoningLevelSchema.parse(value),
								})
							}
						>
							<SelectTrigger className="w-32">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{openAiCompatibleReasoningLevelSchema.options.map((level) => (
									<SelectItem key={level} value={level}>
										{level}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				) : null}
			</div>

			<details className="mt-3 border-t border-border/70 pt-2">
				<summary className="cursor-pointer text-xs text-muted-foreground">
					{t.t("advanced_parameters")}
				</summary>
				<div className="mt-3 grid gap-3 sm:grid-cols-2">
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
	const { plugin, status } = usePluginPanel();
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
				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={i18nValue.t("base_url")}>
						<Input placeholder="https://api.example.com/v1" value={baseUrl} onChange={setBaseUrl} />
					</Field>
					<Field
						hint={
							config.secretsSet.includes("apiKey")
								? i18nValue.t("api_key_configured")
								: i18nValue.t("api_key_hint")
						}
						label={i18nValue.t("api_key")}
					>
						<Input
							type="password"
							placeholder={
								config.secretsSet.includes("apiKey") ? i18nValue.t("keep_secret") : "sk-..."
							}
							value={apiKey}
							onChange={setApiKey}
						/>
					</Field>
				</div>
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
							className="min-w-52 flex-1"
							leftIcon={<Search />}
							placeholder={i18nValue.t("search_models")}
							value={query}
							onChange={setQuery}
						/>
						<Input
							className="min-w-52 flex-1"
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
						<div className="space-y-2">
							{filteredModels.map((model) => (
								<ModelCard
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

			<PluginSection title={plugin.name}>
				<div className="text-xs text-muted-foreground">
					{i18nValue.t("plugin_identity", {
						id: plugin.id,
						version: plugin.version,
					})}
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
