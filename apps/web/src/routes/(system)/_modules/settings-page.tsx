"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { api, type LogLevel } from "@/lib/api";
import { applyLocale } from "@/lib/locale";
import { m } from "@/paraglide/messages";
import { getLocale, locales, toLocale, type Locale } from "@/paraglide/runtime";
import { SystemPage } from "./page-header";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const LOCALE_LABELS: Record<Locale, string> = {
	en: "English",
	"zh-cn": "简体中文",
};

export function SettingsPage() {
	const queryClient = useQueryClient();
	const settingsQuery = useQuery({
		queryFn: api.settings.get,
		queryKey: ["admin", "settings"],
	});
	const updateSettings = useMutation({
		mutationFn: api.settings.update,
		onSuccess: async () => {
			setProviderApiKey("");
			setOnebotAccessToken("");
			await queryClient.invalidateQueries({ queryKey: ["admin"] });
		},
	});
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
	const changeLocale = (value: string) => {
		const next = toLocale(value);
		if (next === undefined || next === locale) return;
		setLocaleState(next);
		applyLocale(next);
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
							onChange={setProviderBaseUrl}
						/>
						<Input
							label={m.settings_provider_model_label()}
							placeholder="magpie-chat"
							value={currentProviderModelId}
							onChange={setProviderModelId}
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
							onChange={setProviderApiKey}
						/>
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
						{updateSettings.isSuccess ? (
							<div className="text-xs text-muted-foreground">{m.settings_saved()}</div>
						) : null}
						{updateSettings.isError ? (
							<div className="text-xs text-destructive">{updateSettings.error.message}</div>
						) : null}
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
