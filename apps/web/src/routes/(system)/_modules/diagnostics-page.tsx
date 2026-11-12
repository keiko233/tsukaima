"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/motion/card";
import { CardContent } from "@/components/motion/card";
import { Select } from "@/components/motion/select";
import { SelectContent } from "@/components/motion/select";
import { SelectItem } from "@/components/motion/select";
import { SelectTrigger } from "@/components/motion/select";
import { SelectValue } from "@/components/motion/select";
import { api } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { SystemPage } from "./page-header";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function DiagnosticsPage() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const diagnosticsQuery = useQuery({
		queryFn: api.diagnostics.status,
		queryKey: ["admin", "diagnostics"],
	});
	const settingsQuery = useQuery({
		queryFn: api.settings.get,
		queryKey: ["admin", "settings"],
	});
	const updateSettings = useMutation({
		mutationFn: api.settings.update,
		onError: (error) =>
			toast.error(m.toast_settings_save_failed(), {
				description: errorMessage(error),
			}),
		onSuccess: async () => {
			toast.success(m.toast_settings_saved());
			await queryClient.invalidateQueries({ queryKey: ["admin"] });
		},
	});

	if (diagnosticsQuery.isPending || settingsQuery.isPending) {
		return <Card className="p-4">{m.loading()}</Card>;
	}

	if (diagnosticsQuery.isError) {
		return <Card className="p-4">{diagnosticsQuery.error.message}</Card>;
	}

	const diagnostics = diagnosticsQuery.data;
	const settings = settingsQuery.data ?? { logLevel: "info" };

	return (
		<SystemPage description={m.diagnostics_page_description()} title={m.nav_diagnostics()}>
			<div className="space-y-4">
				<Card size="compact">
					<CardContent className="space-y-3">
						<div className="grid gap-2 text-sm">
							<span>
								{m.diagnostics_state_label()} {diagnostics.state.stage}
							</span>
							<span>
								{m.diagnostics_onebot_label()} {diagnostics.onebotConnected ? "true" : "false"}
							</span>
							<span>
								{m.diagnostics_processed_label()} {diagnostics.processedMessages}
							</span>
							<span>
								{m.diagnostics_log_level_label()} {diagnostics.logLevel}
							</span>
							<span>
								{m.diagnostics_usage_input_label()} {diagnostics.usageTotals.inputTokens}
							</span>
							<span>
								{m.diagnostics_usage_output_label()} {diagnostics.usageTotals.outputTokens}
							</span>
							<span>
								{m.diagnostics_usage_records_label()} {diagnostics.usage.length}
							</span>
							{diagnostics.onebotRestartRequired || diagnostics.providerRestartRequired ? (
								<span className="text-destructive">{m.settings_restart_hint()}</span>
							) : null}
							{diagnostics.lastError !== undefined ? (
								<span className="text-destructive">
									{m.diagnostics_last_error_label()} {diagnostics.lastError}
								</span>
							) : null}
						</div>
					</CardContent>
				</Card>
				<Card size="compact">
					<CardContent className="space-y-3">
						<Select
							value={settings.logLevel}
							disabled={updateSettings.isPending}
							onValueChange={(value) => {
								updateSettings.mutate({
									logLevel: value as (typeof LOG_LEVELS)[number],
								});
							}}
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
					</CardContent>
				</Card>
			</div>
		</SystemPage>
	);
}
