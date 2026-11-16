"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { modelOptionLabel } from "../../_modules/policy/conversation-policy-fields";
import { SystemPage } from "./page-header";
import { PolicyDefaultsCard } from "./policy-defaults-card";
import { RuntimeMaintenanceCard } from "./runtime-maintenance-card";

const LOCALE_LABELS: Record<Locale, string> = {
	en: "English",
	"zh-cn": "简体中文",
};

const ACTIVE_SIDECHAT_MODEL = "__active__";

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
	const configuredSidechatModel = settings?.sidechatModelId;
	const sidechatModelValue = configuredSidechatModel ?? ACTIVE_SIDECHAT_MODEL;
	const configuredModelMissing =
		configuredSidechatModel !== undefined &&
		!models.some((model) => model.id === configuredSidechatModel);
	const changeLocale = (value: string) => {
		const next = toLocale(value);
		if (next === undefined || next === locale) return;
		setLocaleState(next);
		applyLocale(next);
	};

	return (
		<SystemPage description={m.settings_page_description()} title={m.nav_settings()}>
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
				<RuntimeMaintenanceCard />
				<PolicyDefaultsCard />
				<Card size="compact">
					<CardHeader>
						<CardTitle as="h2">{m.settings_title()}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
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
						<div className="space-y-1.5">
							<div className="px-1 text-[11.5px] font-medium text-foreground">
								{m.settings_sidechat_model_label()}
							</div>
							<Select
								value={sidechatModelValue}
								disabled={updateSettings.isPending}
								onValueChange={(value) => {
									const next = value === ACTIVE_SIDECHAT_MODEL ? null : value;
									if ((next ?? undefined) === configuredSidechatModel) return;
									updateSettings.mutate({ sidechatModelId: next });
								}}
							>
								<SelectTrigger className="w-full">
									<span className="sr-only">{m.settings_sidechat_model_label()}: </span>
									<SelectValue placeholder={m.settings_sidechat_model_placeholder()} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ACTIVE_SIDECHAT_MODEL}>
										{m.settings_sidechat_model_active()}
									</SelectItem>
									{models.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{modelOptionLabel(model)}
										</SelectItem>
									))}
									{configuredSidechatModel !== undefined && configuredModelMissing ? (
										<SelectItem value={configuredSidechatModel}>
											{configuredSidechatModel} · {m.settings_sidechat_model_unavailable()}
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
							<p className="text-[11px] text-muted-foreground">
								{m.settings_sidechat_model_hint()}
							</p>
							{models.length === 0 ? (
								<p className="text-[11px] text-muted-foreground">
									{m.settings_sidechat_model_empty()}
								</p>
							) : null}
						</div>
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
