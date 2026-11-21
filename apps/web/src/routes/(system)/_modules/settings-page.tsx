"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	NATIVE_DECISION_MODELS,
	type ModelCatalogEntry,
	type ModelSelection,
	type ThinkingLevel,
} from "@tsukaima/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@tsukaima/ui/components/motion/select";
import { logLevels as LOG_LEVELS, orpc, type LogLevel } from "@/lib/api";
import { applyLocale } from "@/lib/locale";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { getLocale, locales, toLocale, type Locale } from "@/paraglide/runtime";
import {
	modelOptionLabel,
	modelSelectionKey,
	parseModelSelectionKey,
	THINKING_LEVELS,
	thinkingLevelLabel,
} from "../../_modules/policy/conversation-policy-fields";
import { SystemPage } from "./page-header";

const LOCALE_LABELS: Record<Locale, string> = {
	en: "English",
	"zh-cn": "简体中文",
};

const ACTIVE_SIDECHAT_MODEL = "__active__";
const ACTIVE_MODEL = "__active_model__";
const DEFAULT_THINKING = "__default_thinking__";

function ModelDefaultSelect({
	disabled,
	label,
	models,
	onChange,
	value,
}: {
	disabled: boolean;
	label: string;
	models: readonly ModelCatalogEntry[];
	onChange: (value: ModelSelection | null) => void;
	value: ModelSelection | undefined;
}) {
	const selected = value === undefined ? ACTIVE_MODEL : modelSelectionKey(value);
	const missing =
		value !== undefined &&
		!models.some((model) => model.id === value.modelId && model.providerId === value.providerId);
	return (
		<div className="space-y-1.5">
			<div className="px-1 text-[11.5px] font-medium text-foreground">{label}</div>
			<Select
				value={selected}
				disabled={disabled}
				onValueChange={(next) => {
					if (next === ACTIVE_MODEL) {
						onChange(null);
						return;
					}
					const parsed = parseModelSelectionKey(next);
					if (parsed !== undefined) onChange(parsed);
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={ACTIVE_MODEL}>{m.settings_model_active()}</SelectItem>
					{models.map((model) => (
						<SelectItem
							key={`${model.providerId}:${model.id}`}
							value={modelSelectionKey({ modelId: model.id, providerId: model.providerId })}
						>
							{modelOptionLabel(model)}
						</SelectItem>
					))}
					{missing && value !== undefined ? (
						<SelectItem value={modelSelectionKey(value)}>
							{value.modelId} · {m.settings_model_unavailable()}
						</SelectItem>
					) : null}
				</SelectContent>
			</Select>
		</div>
	);
}

function ThinkingDefaultSelect({
	disabled,
	label,
	onChange,
	value,
}: {
	disabled: boolean;
	label: string;
	onChange: (value: ThinkingLevel | null) => void;
	value: ThinkingLevel | undefined;
}) {
	return (
		<div className="space-y-1.5">
			<div className="px-1 text-[11.5px] font-medium text-foreground">{label}</div>
			<Select
				value={value ?? DEFAULT_THINKING}
				disabled={disabled}
				onValueChange={(next) => {
					if (next === DEFAULT_THINKING) {
						onChange(null);
						return;
					}
					onChange(next as ThinkingLevel);
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={DEFAULT_THINKING}>{m.effort_default()}</SelectItem>
					{THINKING_LEVELS.map((level) => (
						<SelectItem key={level} value={level}>
							{thinkingLevelLabel(level)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function SettingsPage() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const settingsQuery = useQuery(orpc.admin.settings.get.queryOptions());
	const updateSettings = useMutation(
		orpc.admin.settings.update.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_settings_save_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.toast_settings_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.key() });
			},
		}),
	);
	const [locale, setLocaleState] = useState<Locale>(() => getLocale());

	if (settingsQuery.isError) {
		return <Card className="p-4">{settingsQuery.error.message}</Card>;
	}

	const settings = settingsQuery.data;
	const models = settings?.models ?? [];
	const availableModels = settings?.availableModels ?? [];
	const classifierFields = [
		{
			key: "sidechatModelId",
			label: m.settings_sidechat_model_label(),
			fallback: m.settings_sidechat_model_active(),
		},
		{
			key: "gateModelId",
			label: m.settings_gate_model_label(),
			fallback: m.settings_gate_model_default(),
		},
	] as const;
	const configuredMemoryModel = settings?.memoryModelId;
	const memoryModelValue = configuredMemoryModel ?? ACTIVE_SIDECHAT_MODEL;
	const configuredMemoryModelMissing =
		configuredMemoryModel !== undefined &&
		!availableModels.some((model) => model.id === configuredMemoryModel);
	const changeLocale = (value: string) => {
		const next = toLocale(value);
		if (next === undefined || next === locale) return;
		setLocaleState(next);
		applyLocale(next);
	};

	return (
		<SystemPage description={m.settings_general_description()} title={m.settings_tab_general()}>
			<div className="space-y-3">
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_interface_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						<div className="space-y-1.5">
							<div className="px-1 text-[11.5px] font-medium text-foreground">
								{m.settings_language_label()}
							</div>
							<Select value={locale} onValueChange={changeLocale}>
								<SelectTrigger className="w-full">
									<span className="sr-only">{m.settings_language_label()}: </span>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{locales.map((value) => (
										<SelectItem key={value} value={value}>
											{LOCALE_LABELS[value]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<p className="text-[11px] text-muted-foreground">{m.settings_language_hint()}</p>
					</CardContent>
				</Card>
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="space-y-1.5">
							<div className="px-1 text-[11.5px] font-medium text-foreground">
								{m.settings_model_defaults_title()}
							</div>
							<p className="text-[11px] leading-4 text-muted-foreground">
								{m.settings_model_defaults_description()}
							</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<ModelDefaultSelect
								disabled={updateSettings.isPending}
								label={m.settings_chat_model_label()}
								models={availableModels}
								onChange={(value) => updateSettings.mutate({ chatModel: value })}
								value={settings?.chatModel}
							/>
							<ThinkingDefaultSelect
								disabled={updateSettings.isPending}
								label={m.settings_chat_effort_label()}
								onChange={(value) => updateSettings.mutate({ chatThinking: value })}
								value={settings?.chatThinking}
							/>
							<ModelDefaultSelect
								disabled={updateSettings.isPending}
								label={m.settings_workspace_model_label()}
								models={availableModels}
								onChange={(value) => updateSettings.mutate({ workspaceModel: value })}
								value={settings?.workspaceModel}
							/>
							<ThinkingDefaultSelect
								disabled={updateSettings.isPending}
								label={m.settings_workspace_effort_label()}
								onChange={(value) => updateSettings.mutate({ workspaceThinking: value })}
								value={settings?.workspaceThinking}
							/>
						</div>
						{availableModels.length === 0 ? (
							<p className="text-[11px] text-muted-foreground">
								{m.settings_model_defaults_empty()}
							</p>
						) : null}
						<div className="px-1 text-[11.5px] font-medium text-foreground">
							{m.settings_log_level_label()}
						</div>
						<Select
							value={settings?.logLevel ?? "info"}
							onValueChange={(value) => updateSettings.mutate({ logLevel: value as LogLevel })}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder={m.settings_log_level_label()} />
							</SelectTrigger>
							<SelectContent>
								{LOG_LEVELS.map((level) => (
									<SelectItem key={level} value={level}>
										{level}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{classifierFields.map(({ key, label, fallback }) => {
							const configured = settings?.[key];
							const missing =
								configured !== undefined &&
								!models.some((model) => model.id === configured) &&
								!NATIVE_DECISION_MODELS.some((model) => model.id === configured);
							return (
								<div key={key} className="space-y-1.5">
									<div className="px-1 text-[11.5px] font-medium text-foreground">{label}</div>
									<Select
										value={configured ?? ACTIVE_SIDECHAT_MODEL}
										disabled={updateSettings.isPending}
										onValueChange={(value) => {
											const next = value === ACTIVE_SIDECHAT_MODEL ? null : value;
											if ((next ?? undefined) === configured) return;
											updateSettings.mutate({ [key]: next });
										}}
									>
										<SelectTrigger className="w-full">
											<span className="sr-only">{label}</span>
											<SelectValue placeholder={label} />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={ACTIVE_SIDECHAT_MODEL}>{fallback}</SelectItem>
											{NATIVE_DECISION_MODELS.map((model) => (
												<SelectItem key={model.id} value={model.id}>
													{model.label} · {model.apiKeyEnv}
												</SelectItem>
											))}
											{models.map((model) => (
												<SelectItem key={model.id} value={model.id}>
													{modelOptionLabel(model)}
												</SelectItem>
											))}
											{missing && configured !== undefined ? (
												<SelectItem value={configured}>
													{configured} · {m.settings_sidechat_model_unavailable()}
												</SelectItem>
											) : null}
										</SelectContent>
									</Select>
									<p className="text-[11px] text-muted-foreground">
										{m.settings_sidechat_model_hint()}
									</p>
								</div>
							);
						})}
						<div className="space-y-1.5">
							<div className="px-1 text-[11.5px] font-medium text-foreground">
								{m.settings_memory_model_label()}
							</div>
							<Select
								value={memoryModelValue}
								disabled={updateSettings.isPending}
								onValueChange={(value) => {
									const next = value === ACTIVE_SIDECHAT_MODEL ? null : value;
									if ((next ?? undefined) === configuredMemoryModel) return;
									updateSettings.mutate({ memoryModelId: next });
								}}
							>
								<SelectTrigger className="w-full">
									<span className="sr-only">{m.settings_memory_model_label()}: </span>
									<SelectValue placeholder={m.settings_memory_model_placeholder()} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ACTIVE_SIDECHAT_MODEL}>
										{m.settings_memory_model_active()}
									</SelectItem>
									{availableModels.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{modelOptionLabel(model)}
										</SelectItem>
									))}
									{configuredMemoryModel !== undefined && configuredMemoryModelMissing ? (
										<SelectItem value={configuredMemoryModel}>
											{configuredMemoryModel} · {m.settings_memory_model_unavailable()}
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
							<p className="text-[11px] text-muted-foreground">{m.settings_memory_model_hint()}</p>
							{availableModels.length === 0 ? (
								<p className="text-[11px] text-muted-foreground">
									{m.settings_memory_model_empty()}
								</p>
							) : null}
						</div>
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
