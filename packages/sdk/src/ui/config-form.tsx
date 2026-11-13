"use client";

import { Input } from "@tsukaima/ui/components/motion/input";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@tsukaima/ui/components/motion/select";
import { Switch } from "@tsukaima/ui/components/motion/switch";
import { useEffect, useState } from "react";
import { Field } from "./components.tsx";

type JsonSchemaProperty = {
	readonly enum?: readonly string[];
	readonly type?: string;
	readonly title?: string;
	readonly description?: string;
};

function properties(
	schema: Record<string, unknown> | undefined,
): Record<string, JsonSchemaProperty> {
	const value = schema?.properties;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, JsonSchemaProperty>)
		: {};
}

function displayValue(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export interface PluginConfigFormProps {
	readonly schema?: Record<string, unknown>;
	readonly value: Record<string, unknown>;
	readonly secretsSet?: readonly string[];
	readonly secretKeys?: readonly string[];
	readonly saving?: boolean;
	readonly onSave: (patch: Record<string, unknown>) => Promise<void> | void;
	readonly labels?: {
		readonly save?: string;
		readonly configured?: string;
		readonly unset?: string;
		readonly empty?: string;
	};
}

/**
 * JSON-schema-driven configuration form. Supported field types: string, number, boolean,
 * and string enums. Nested objects are not edited here yet.
 */
export function PluginConfigForm({
	schema,
	value,
	secretsSet = [],
	secretKeys = [],
	saving = false,
	onSave,
	labels = {},
}: PluginConfigFormProps) {
	const fields = properties(schema);
	const keys = Object.keys(fields);
	const [draft, setDraft] = useState<Record<string, string>>({});

	useEffect(() => {
		setDraft({});
	}, [value]);

	if (keys.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				{labels.empty ?? "No configurable fields."}
			</p>
		);
	}

	const save = async () => {
		const patch: Record<string, unknown> = {};
		for (const key of keys) {
			const field = fields[key];
			const next = draft[key];
			if (next === undefined) continue;
			if (field?.type === "number") {
				patch[key] = next.trim().length === 0 ? null : Number(next);
			} else if (field?.type === "boolean") {
				patch[key] = next === "true";
			} else if (next.trim().length === 0) {
				patch[key] = null;
			} else {
				patch[key] = next;
			}
		}
		await onSave(patch);
		setDraft({});
	};

	return (
		<div className="space-y-3">
			{keys.map((key) => {
				const field = fields[key] ?? {};
				const secret = secretKeys.includes(key);
				const current = value[key];
				const currentValue =
					draft[key] ?? (typeof current === "boolean" ? String(current) : displayValue(current));
				const configured = secret && secretsSet.includes(key);
				const label = field.title ?? key;
				const hint = field.description;
				if (field.type === "boolean") {
					return (
						<Field key={key} hint={hint} label={label}>
							<Switch
								checked={currentValue === "true"}
								onCheckedChange={(checked) =>
									setDraft((previous) => ({ ...previous, [key]: String(checked) }))
								}
							/>
						</Field>
					);
				}
				if (field.enum !== undefined) {
					return (
						<Field key={key} hint={hint} label={label}>
							<Select
								value={currentValue}
								onValueChange={(next) =>
									setDraft((previous) => ({ ...previous, [key]: next }))
								}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder={label} />
								</SelectTrigger>
								<SelectContent>
									{field.enum.map((option) => (
										<SelectItem key={option} value={option}>
											{option}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
					);
				}
				return (
					<Input
						key={key}
						label={label}
						type={secret ? "password" : field.type === "number" ? "number" : "text"}
						placeholder={
							configured
								? (labels.configured ?? "Configured; enter a new value to replace it")
								: secret
									? (labels.unset ?? "Not configured")
									: hint
						}
						value={currentValue}
						onChange={(next) => setDraft((previous) => ({ ...previous, [key]: next }))}
					/>
				);
			})}
			<Button disabled={saving} size="sm" onClick={() => void save()}>
				{labels.save ?? "Save"}
			</Button>
		</div>
	);
}
