"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/motion/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select";
import { orpc, type LogLevel } from "@/lib/api";
import { applyLocale } from "@/lib/locale";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { getLocale, locales, toLocale, type Locale } from "@/paraglide/runtime";
import { PluginConfigForm } from "./plugin-config-form";
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
	const pluginsQuery = useQuery(orpc.admin.plugins.list.queryOptions());
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
	const providers = (pluginsQuery.data ?? []).filter(
		(plugin) => plugin.modelProviders.length > 0,
	);
	const modelProviderId = settings?.modelProviderId ?? providers[0]?.modelProviders[0] ?? "";
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
						{providers.length > 0 ? (
							<div className="space-y-1.5">
								<div className="px-1 text-sm font-medium text-foreground">
									{m.settings_provider_label()}
								</div>
								<Select
									value={modelProviderId}
									onValueChange={(value) => updateSettings.mutate({ modelProviderId: value })}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={m.settings_provider_placeholder()} />
									</SelectTrigger>
									<SelectContent>
										{providers.flatMap((plugin) =>
											plugin.modelProviders.map((providerId) => (
												<SelectItem key={providerId} value={providerId}>
													{providerId} ({plugin.name})
												</SelectItem>
											)),
										)}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">{m.settings_provider_hint()}</p>
							</div>
						) : null}
					</CardContent>
				</Card>
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_channels_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="text-xs text-muted-foreground">{m.settings_channels_hint()}</p>
						{(pluginsQuery.data ?? []).map((plugin) => (
							<PluginConfigForm key={plugin.id} plugin={plugin} />
						))}
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
