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
import { m } from "@/paraglide/messages";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function SettingsPage() {
	const queryClient = useQueryClient();
	const settingsQuery = useQuery({
		queryFn: api.settings.get,
		queryKey: ["admin", "settings"],
	});
	const updateSettings = useMutation({
		mutationFn: api.settings.update,
		onSuccess: async () => {
			setOnebotAccessToken("");
			await queryClient.invalidateQueries({ queryKey: ["admin"] });
		},
	});
	const [onebotWsUrl, setOnebotWsUrl] = useState<string | undefined>(undefined);
	const [onebotAccessToken, setOnebotAccessToken] = useState("");

	if (settingsQuery.isError) {
		return <Card className="p-4">{settingsQuery.error.message}</Card>;
	}

	const settings = settingsQuery.data;
	const currentUrl = onebotWsUrl ?? settings?.onebotWsUrl ?? "";

	return (
		<div className="space-y-4">
			<Card size="compact">
				<CardHeader>
					<CardTitle as="h2">{m.settings_title()}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<Select
						value={settings?.logLevel ?? "info"}
						onValueChange={(value) =>
							updateSettings.mutate({ logLevel: value as LogLevel })
						}
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
	);
}
