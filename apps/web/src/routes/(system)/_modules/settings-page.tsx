"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import {
	NATIVE_DECISION_MODELS,
	type ModelCatalogEntry,
	type ModelSelection,
	type ThinkingLevel,
} from "@tsukaima/contracts";
import {
	EditorialGroup,
	EditorialSelect,
	EditorialSelectContent,
	EditorialSelectItem,
	EditorialSelectTrigger,
	EditorialSelectValue,
	PreferenceRow,
	SegmentedControl,
} from "@tsukaima/ui";
import { Moon, Sun } from "lucide-react";
import { logLevels as LOG_LEVELS, orpc, type LogLevel } from "@/lib/api";
import { applyLocale } from "@/lib/locale";
import { applyTheme, type Theme } from "@/lib/theme";
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

function currentTheme(): Theme {
	if (typeof document === "undefined") return "light";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function useTheme(): [Theme, (theme: Theme) => void] {
	const [theme, setTheme] = useState<Theme>(currentTheme);
	// The app rail owns the theme class; follow it so this control never goes stale.
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme(currentTheme()));
		observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
		return () => observer.disconnect();
	}, []);
	const change = (next: Theme) => {
		setTheme(next);
		applyTheme(next);
	};
	return [theme, change];
}

function SelectRow({
	children,
	disabled,
	hint,
	label,
	onValueChange,
	value,
}: {
	children: React.ReactNode;
	disabled?: boolean;
	hint?: string;
	label: string;
	onValueChange: (value: string) => void;
	value: string;
}) {
	const id = useId();
	const hintId = hint === undefined ? undefined : `${id}-hint`;
	return (
		<PreferenceRow
			label={label}
			htmlFor={id}
			{...(hint === undefined ? {} : { hint })}
			{...(hintId === undefined ? {} : { hintId })}
		>
			<EditorialSelect
				value={value}
				onValueChange={onValueChange}
				{...(disabled === undefined ? {} : { disabled })}
			>
				<EditorialSelectTrigger
					id={id}
					className="w-full"
					{...(hintId === undefined ? {} : { "aria-describedby": hintId })}
				>
					<EditorialSelectValue />
				</EditorialSelectTrigger>
				<EditorialSelectContent>{children}</EditorialSelectContent>
			</EditorialSelect>
		</PreferenceRow>
	);
}

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
		<SelectRow
			disabled={disabled}
			label={label}
			value={selected}
			onValueChange={(next) => {
				if (next === ACTIVE_MODEL) {
					onChange(null);
					return;
				}
				const parsed = parseModelSelectionKey(next);
				if (parsed !== undefined) onChange(parsed);
			}}
		>
			<EditorialSelectItem value={ACTIVE_MODEL}>{m.settings_model_active()}</EditorialSelectItem>
			{models.map((model) => (
				<EditorialSelectItem
					key={`${model.providerId}:${model.id}`}
					value={modelSelectionKey({ modelId: model.id, providerId: model.providerId })}
				>
					{modelOptionLabel(model)}
				</EditorialSelectItem>
			))}
			{missing && value !== undefined ? (
				<EditorialSelectItem
					value={modelSelectionKey(value)}
					label={`${value.modelId} · ${m.settings_model_unavailable()}`}
				>
					{value.modelId} · {m.settings_model_unavailable()}
				</EditorialSelectItem>
			) : null}
		</SelectRow>
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
		<SelectRow
			disabled={disabled}
			label={label}
			value={value ?? DEFAULT_THINKING}
			onValueChange={(next) => {
				if (next === DEFAULT_THINKING) {
					onChange(null);
					return;
				}
				onChange(next as ThinkingLevel);
			}}
		>
			<EditorialSelectItem value={DEFAULT_THINKING}>{m.effort_default()}</EditorialSelectItem>
			{THINKING_LEVELS.map((level) => (
				<EditorialSelectItem key={level} value={level}>
					{thinkingLevelLabel(level)}
				</EditorialSelectItem>
			))}
		</SelectRow>
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
	const [theme, setTheme] = useTheme();
	const appearanceHintId = useId();

	if (settingsQuery.isError) {
		return (
			<SystemPage description={m.settings_general_description()} title={m.settings_tab_general()}>
				<p role="alert" className="text-sm text-destructive">
					{settingsQuery.error.message}
				</p>
			</SystemPage>
		);
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
			<div className="space-y-7">
				<EditorialGroup title={m.settings_interface_title()}>
					<PreferenceRow
						label={m.settings_appearance_label()}
						hint={m.settings_appearance_hint()}
						hintId={appearanceHintId}
					>
						<SegmentedControl
							size="sm"
							value={theme}
							onValueChange={setTheme}
							aria-label={m.settings_appearance_label()}
							aria-describedby={appearanceHintId}
							options={[
								{ value: "light", label: <Sun aria-hidden="true" className="size-3.5" /> },
								{ value: "dark", label: <Moon aria-hidden="true" className="size-3.5" /> },
							]}
						/>
					</PreferenceRow>
					<SelectRow
						label={m.settings_language_label()}
						hint={m.settings_language_hint()}
						value={locale}
						onValueChange={changeLocale}
					>
						{locales.map((value) => (
							<EditorialSelectItem key={value} value={value}>
								{LOCALE_LABELS[value]}
							</EditorialSelectItem>
						))}
					</SelectRow>
				</EditorialGroup>
				<EditorialGroup
					title={m.settings_title()}
					description={m.settings_model_defaults_description()}
				>
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
					{availableModels.length === 0 ? (
						<p className="border-b border-border/70 py-3 text-xs text-muted-foreground">
							{m.settings_model_defaults_empty()}
						</p>
					) : null}
					<SelectRow
						label={m.settings_log_level_label()}
						value={settings?.logLevel ?? "info"}
						onValueChange={(value) => updateSettings.mutate({ logLevel: value as LogLevel })}
					>
						{LOG_LEVELS.map((level) => (
							<EditorialSelectItem key={level} value={level}>
								{level}
							</EditorialSelectItem>
						))}
					</SelectRow>
					{classifierFields.map(({ key, label, fallback }) => {
						const configured = settings?.[key];
						const missing =
							configured !== undefined &&
							!models.some((model) => model.id === configured) &&
							!NATIVE_DECISION_MODELS.some((model) => model.id === configured);
						return (
							<SelectRow
								key={key}
								disabled={updateSettings.isPending}
								label={label}
								hint={m.settings_sidechat_model_hint()}
								value={configured ?? ACTIVE_SIDECHAT_MODEL}
								onValueChange={(value) => {
									const next = value === ACTIVE_SIDECHAT_MODEL ? null : value;
									if ((next ?? undefined) === configured) return;
									updateSettings.mutate({ [key]: next });
								}}
							>
								<EditorialSelectItem value={ACTIVE_SIDECHAT_MODEL}>{fallback}</EditorialSelectItem>
								{NATIVE_DECISION_MODELS.map((model) => (
									<EditorialSelectItem
										key={model.id}
										value={model.id}
										label={`${model.label} · ${model.apiKeyEnv}`}
									>
										{model.label} · {model.apiKeyEnv}
									</EditorialSelectItem>
								))}
								{models.map((model) => (
									<EditorialSelectItem key={model.id} value={model.id}>
										{modelOptionLabel(model)}
									</EditorialSelectItem>
								))}
								{missing && configured !== undefined ? (
									<EditorialSelectItem
										value={configured}
										label={`${configured} · ${m.settings_sidechat_model_unavailable()}`}
									>
										{configured} · {m.settings_sidechat_model_unavailable()}
									</EditorialSelectItem>
								) : null}
							</SelectRow>
						);
					})}
					<SelectRow
						disabled={updateSettings.isPending}
						label={m.settings_memory_model_label()}
						hint={m.settings_memory_model_hint()}
						value={memoryModelValue}
						onValueChange={(value) => {
							const next = value === ACTIVE_SIDECHAT_MODEL ? null : value;
							if ((next ?? undefined) === configuredMemoryModel) return;
							updateSettings.mutate({ memoryModelId: next });
						}}
					>
						<EditorialSelectItem value={ACTIVE_SIDECHAT_MODEL}>
							{m.settings_memory_model_active()}
						</EditorialSelectItem>
						{availableModels.map((model) => (
							<EditorialSelectItem key={model.id} value={model.id}>
								{modelOptionLabel(model)}
							</EditorialSelectItem>
						))}
						{configuredMemoryModel !== undefined && configuredMemoryModelMissing ? (
							<EditorialSelectItem
								value={configuredMemoryModel}
								label={`${configuredMemoryModel} · ${m.settings_memory_model_unavailable()}`}
							>
								{configuredMemoryModel} · {m.settings_memory_model_unavailable()}
							</EditorialSelectItem>
						) : null}
					</SelectRow>
					{availableModels.length === 0 ? (
						<p className="py-3 text-xs text-muted-foreground">{m.settings_memory_model_empty()}</p>
					) : null}
				</EditorialGroup>
			</div>
		</SystemPage>
	);
}
