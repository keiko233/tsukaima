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
import { m } from "@/paraglide/messages";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function DiagnosticsPage() {
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
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["admin"] });
		},
	});

	if (diagnosticsQuery.isPending || settingsQuery.isPending) {
		return <Card className="p-4">{m.settings_saved()}</Card>;
	}

	if (diagnosticsQuery.isError) {
		return <Card className="p-4">{diagnosticsQuery.error.message}</Card>;
	}

	const diagnostics = diagnosticsQuery.data;
	const settings = settingsQuery.data ?? { logLevel: "info" };

	return (
		<div className="space-y-4">
			<Card size="compact">
				<CardContent className="space-y-3">
					<div className="grid gap-2 text-sm">
						<span>
							{m.diagnostics_state_label()} {diagnostics.state.stage}
						</span>
						<span>
							{m.diagnostics_onebot_label()}{" "}
							{diagnostics.onebotConnected ? "true" : "false"}
						</span>
						<span>
							{m.diagnostics_processed_label()} {diagnostics.processedMessages}
						</span>
						<span>
							{m.diagnostics_log_level_label()} {diagnostics.logLevel}
						</span>
						{diagnostics.onebotRestartRequired ? (
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
					{updateSettings.isPending ? <div className="text-xs">{m.settings_save()}</div> : null}
					{updateSettings.isSuccess ? (
						<div className="text-xs text-muted-foreground">{m.settings_saved()}</div>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}
