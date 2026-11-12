"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/motion/button";
import { Card } from "@/components/motion/card";
import { CardContent } from "@/components/motion/card";
import { CardHeader, CardTitle } from "@/components/motion/card";
import { Input } from "@/components/motion/input";
import { Select } from "@/components/motion/select";
import { SelectContent } from "@/components/motion/select";
import { SelectItem } from "@/components/motion/select";
import { SelectTrigger } from "@/components/motion/select";
import { SelectValue } from "@/components/motion/select";
import { orpc, type LogLevel } from "@/lib/api";
import { applyLocale } from "@/lib/locale";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { getLocale, locales, toLocale, type Locale } from "@/paraglide/runtime";
import { SystemPage } from "./page-header";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const LOCALE_LABELS: Record<Locale, string> = {
	en: "English",
	"zh-cn": "简体中文",
};

export function SettingsPage() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const settingsQuery = useQuery(orpc.admin.settings.get.queryOptions());
	const updateSettings = useMutation(
		orpc.admin.settings.update.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_settings_save_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async () => {
				setProviderApiKey("");
				setOnebotAccessToken("");
				toast.success(m.toast_settings_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.key() });
			},
		}),
	);
	const fetchModels = useMutation(
		orpc.admin.settings.models.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_models_fetch_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: (result) => {
				const notify = result.models.length === 0 ? toast.info : toast.success;
				notify(m.toast_models_loaded(), {
					description: m.toast_models_loaded_description({ count: result.models.length }),
				});
			},
		}),
	);
	const [providerBaseUrl, setProviderBaseUrl] = useState<string | undefined>(undefined);
	const [providerModelId, setProviderModelId] = useState<string | undefined>(undefined);
	const [providerApiKey, setProviderApiKey] = useState("");
	const [onebotWsUrl, setOnebotWsUrl] = useState<string | undefined>(undefined);
	const [onebotAccessToken, setOnebotAccessToken] = useState("");
	const [locale, setLocaleState] = useState<Locale>(() => getLocale());

	if (settingsQuery.isError) {
		return <Card className="p-4">{settingsQuery.error.message}</Card>;
	}

	const settings = settingsQuery.data;
	const currentProviderBaseUrl = providerBaseUrl ?? settings?.openAiBaseUrl ?? "";
	const currentProviderModelId = providerModelId ?? settings?.openAiModelId ?? "";
	const currentUrl = onebotWsUrl ?? settings?.onebotWsUrl ?? "";
	const remoteModels = fetchModels.data?.models ?? [];
	const remoteModelValue = remoteModels.some((model) => model.id === currentProviderModelId)
		? currentProviderModelId
		: "";
	const changeLocale = (value: string) => {
		const next = toLocale(value);
		if (next === undefined || next === locale) return;
		setLocaleState(next);
		applyLocale(next);
	};
	const changeProviderBaseUrl = (value: string) => {
		setProviderBaseUrl(value);
		fetchModels.reset();
	};
	const changeProviderApiKey = (value: string) => {
		setProviderApiKey(value);
		fetchModels.reset();
	};

	return (
		<SystemPage description={m.settings_page_description()} title={m.nav_settings()}>
			<div className="space-y-4">
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_interface_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						<div className="space-y-1.5">
							<div className="px-1 text-sm font-medium text-foreground">
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
						<p className="text-xs text-muted-foreground">{m.settings_language_hint()}</p>
					</CardContent>
				</Card>
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
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
						<Input
							label={m.settings_provider_base_url_label()}
							placeholder="https://magpie.example/v1"
							value={currentProviderBaseUrl}
							onChange={changeProviderBaseUrl}
						/>
						<Input
							label={m.settings_provider_key_label()}
							placeholder={
								settings?.openAiApiKeySet
									? m.settings_provider_key_placeholder()
									: m.settings_provider_key_unset()
							}
							type="password"
							value={providerApiKey}
							onChange={changeProviderApiKey}
						/>
						<div className="space-y-2">
							<div className="flex items-end gap-2">
								<Input
									label={m.settings_provider_model_label()}
									placeholder="magpie-chat"
									value={currentProviderModelId}
									onChange={setProviderModelId}
									className="flex-1"
								/>
								<Button
									variant="outline"
									className="h-11 shrink-0"
									disabled={fetchModels.isPending || updateSettings.isPending}
									aria-busy={fetchModels.isPending}
									onClick={() =>
										fetchModels.mutate({
											...(currentProviderBaseUrl.trim().length > 0
												? { baseUrl: currentProviderBaseUrl.trim() }
												: {}),
											...(providerApiKey.trim().length > 0
												? { apiKey: providerApiKey.trim() }
												: {}),
										})
									}
								>
									<RefreshCw className={fetchModels.isPending ? "size-4 animate-spin" : "size-4"} />
									{fetchModels.isPending ? m.settings_models_fetching() : m.settings_models_fetch()}
								</Button>
							</div>
							{fetchModels.data !== undefined ? (
								<div className="space-y-1.5">
									<div className="flex items-center justify-between gap-2 px-1">
										<span className="text-sm font-medium text-foreground">
											{m.settings_remote_models_label()}
										</span>
										<span className="text-xs text-muted-foreground">
											{m.settings_remote_models_count({
												count: remoteModels.length,
											})}
										</span>
									</div>
									{remoteModels.length > 0 ? (
										<Select value={remoteModelValue} onValueChange={setProviderModelId}>
											<SelectTrigger className="w-full">
												<span className="sr-only">{m.settings_remote_models_label()}: </span>
												<SelectValue placeholder={m.settings_remote_models_placeholder()} />
											</SelectTrigger>
											<SelectContent className="max-h-64 overflow-y-auto">
												{remoteModels.map((model) => (
													<SelectItem key={model.id} value={model.id}>
														{model.id}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									) : (
										<p className="px-1 text-xs text-muted-foreground">
											{m.settings_remote_models_empty()}
										</p>
									)}
									<p className="px-1 text-xs text-muted-foreground">
										{m.settings_models_fetched_from({
											baseUrl: fetchModels.data.baseUrl,
										})}
									</p>
									<p className="px-1 text-xs text-muted-foreground">
										{m.settings_remote_models_hint()}
									</p>
								</div>
							) : null}
							<p className="text-xs text-muted-foreground">{m.settings_models_hint()}</p>
						</div>
						<p className="text-xs text-muted-foreground">{m.settings_provider_hint()}</p>
						<div className="border-t border-border" />
						<Input
							label={m.settings_onebot_url_label()}
							placeholder="ws://127.0.0.1:3001"
							value={currentUrl}
							onChange={setOnebotWsUrl}
						/>
						<Input
							label={m.settings_onebot_token_label()}
							placeholder={
								settings?.onebotAccessTokenSet
									? m.settings_token_placeholder()
									: m.settings_token_unset()
							}
							type="password"
							value={onebotAccessToken}
							onChange={setOnebotAccessToken}
						/>
						<p className="text-xs text-muted-foreground">{m.settings_onebot_hint()}</p>
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={updateSettings.isPending}
								onClick={() =>
									updateSettings.mutate({
										openAiBaseUrl: currentProviderBaseUrl.trim(),
										openAiModelId: currentProviderModelId.trim(),
										...(providerApiKey.trim().length > 0
											? { openAiApiKey: providerApiKey.trim() }
											: {}),
										onebotWsUrl: currentUrl.trim(),
										...(onebotAccessToken.trim().length > 0
											? { onebotAccessToken: onebotAccessToken.trim() }
											: {}),
									})
								}
							>
								{m.settings_save()}
							</Button>
							{settings?.onebotAccessTokenSet ? (
								<Button
									variant="outline"
									disabled={updateSettings.isPending}
									onClick={() => updateSettings.mutate({ onebotAccessToken: null })}
								>
									{m.settings_clear_token()}
								</Button>
							) : null}
							{settings?.openAiApiKeySet ? (
								<Button
									variant="outline"
									disabled={updateSettings.isPending}
									onClick={() => updateSettings.mutate({ openAiApiKey: null })}
								>
									{m.settings_clear_provider_key()}
								</Button>
							) : null}
						</div>
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
