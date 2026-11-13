"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@elaina/ui/components/motion/button";
import { Input } from "@elaina/ui/components/motion/input";
import { orpc, type PluginRow } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";

type JsonSchema = Record<string, unknown>;
type JsonSchemaProperty = {
	readonly enum?: readonly string[];
	readonly type?: string;
};

function properties(schema: JsonSchema | undefined): Record<string, JsonSchemaProperty> {
	const value = schema?.properties;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, JsonSchemaProperty>)
		: {};
}

function stringValue(config: Record<string, unknown>, key: string): string {
	const value = config[key];
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** Generic settings form driven by the plugin manifest's JSON schema. */
export function PluginConfigForm({ plugin }: { plugin: PluginRow }) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<Record<string, string>>({});
	const update = useMutation(
		orpc.admin.plugins.updateConfig.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_settings_save_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				setDraft({});
				toast.success(m.toast_settings_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.plugins.key() });
				await queryClient.invalidateQueries({ queryKey: orpc.admin.settings.key() });
			},
		}),
	);
	const fields = properties(plugin.configSchema);
	const keys = Object.keys(fields);
	if (keys.length === 0) return null;

	const save = () => {
		const config: Record<string, unknown> = {};
		for (const key of keys) {
			const value = draft[key];
			if (value === undefined) continue;
			config[key] = value.trim().length === 0 ? null : value;
		}
		update.mutate({ config, pluginId: plugin.id });
	};

	return (
		<div className="space-y-3 rounded-xl border border-border p-3">
			<div className="text-sm font-medium">{plugin.name}</div>
			{keys.map((key) => {
				const secret = plugin.secretKeys.includes(key);
				const configured = secret && plugin.secretsSet.includes(key);
				return (
					<Input
						key={key}
						label={key}
						type={secret ? "password" : "text"}
						placeholder={
							configured
								? m.settings_provider_key_placeholder()
								: secret
									? m.settings_provider_key_unset()
									: undefined
						}
						value={draft[key] ?? stringValue(plugin.config, key)}
						onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
					/>
				);
			})}
			<Button size="sm" disabled={update.isPending} onClick={save}>
				{m.settings_save()}
			</Button>
		</div>
	);
}
