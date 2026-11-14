"use client";

import { Input } from "@elaina/ui/components/motion/input";
import { Button } from "@elaina/ui/components/motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@elaina/ui/components/motion/select";
import { Switch } from "@elaina/ui/components/motion/switch";
import { useEffect, useState, type ReactNode } from "react";
import { Field } from "./components.tsx";

type JsonSchemaNode = {
	readonly anyOf?: readonly JsonSchemaNode[];
	readonly default?: unknown;
	readonly description?: string;
	readonly descriptionKey?: string;
	readonly enum?: readonly string[];
	readonly enumLabels?: Record<string, string>;
	readonly items?: JsonSchemaNode;
	readonly oneOf?: readonly JsonSchemaNode[];
	readonly properties?: Record<string, JsonSchemaNode>;
	readonly title?: string;
	readonly titleKey?: string;
	readonly type?: string;
};

type Control =
	| {
			/** Options exposed by the `anyOf` object branch, editable while the switch is on. */
			readonly detail?: Record<string, JsonSchemaNode>;
			readonly fallback: boolean;
			readonly kind: "boolean";
	  }
	| {
			readonly kind: "enum";
			readonly labels?: Record<string, string>;
			readonly options: readonly string[];
	  }
	| { readonly kind: "number" }
	| { readonly kind: "string" }
	| { readonly kind: "stringArray" }
	| { readonly kind: "object"; readonly properties: Record<string, JsonSchemaNode> }
	| { readonly kind: "unsupported" };

function properties(schema: Record<string, unknown> | undefined): Record<string, JsonSchemaNode> {
	const value = schema?.properties;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, JsonSchemaNode>)
		: {};
}

function controlFor(field: JsonSchemaNode): Control {
	if (field.enum !== undefined && field.enum.length > 0) {
		return {
			kind: "enum",
			options: field.enum,
			...(field.enumLabels === undefined ? {} : { labels: field.enumLabels }),
		};
	}
	if (field.type === "boolean") return { fallback: field.default === true, kind: "boolean" };
	if (field.type === "array") {
		const items = field.items;
		if (items === undefined || items.type === undefined || items.type === "string") {
			return { kind: "stringArray" };
		}
		return { kind: "unsupported" };
	}
	if (field.type === "object") {
		const nested = field.properties;
		if (nested === undefined || Object.keys(nested).length === 0) return { kind: "unsupported" };
		return { kind: "object", properties: nested };
	}
	if (field.type === "number" || field.type === "integer") return { kind: "number" };
	if (field.type === "string") return { kind: "string" };
	// `anyOf`/`oneOf` boolean-or-object shapes (for example "on by default, tune later").
	const branches = field.anyOf ?? field.oneOf;
	if (branches !== undefined) {
		const booleanBranch = branches.find((branch) => branch.type === "boolean");
		if (booleanBranch !== undefined) {
			const objectBranch = branches.find(
				(branch) => branch.type === "object" && branch.properties !== undefined,
			);
			return {
				...(objectBranch?.properties === undefined ? {} : { detail: objectBranch.properties }),
				fallback: field.default === true || booleanBranch.default === true,
				kind: "boolean",
			};
		}
	}
	return { kind: "unsupported" };
}

/** Turns one draft string into the JSON value the settings API expects. */
function parseDraft(next: string, control: Control): unknown {
	const trimmed = next.trim();
	switch (control.kind) {
		case "boolean":
			return next === "true";
		case "number": {
			if (trimmed.length === 0) return undefined;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : undefined;
		}
		case "stringArray": {
			const values = next
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
			return values.length === 0 ? undefined : values;
		}
		default:
			return trimmed.length === 0 ? undefined : next;
	}
}

export interface PluginConfigGroup {
	/** Message key or literal shown as the group heading. */
	readonly title?: string;
	readonly titleKey?: string;
	readonly keys: readonly string[];
}

/**
 * Turns the form's draft strings into the patch sent to `admin.plugins.updateConfig`.
 * Untouched fields are omitted so the host keeps their stored value; a cleared field
 * becomes `null`, which the settings store treats as "delete and fall back".
 */
export function buildConfigPatch(
	schema: Record<string, unknown> | undefined,
	draft: Record<string, string>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(properties(schema))) {
		const control = controlFor(field);
		if (control.kind === "object") {
			const nested: Record<string, unknown> = {};
			let touched = false;
			for (const [subKey, subField] of Object.entries(control.properties)) {
				const next = draft[`${key}.${subKey}`];
				if (next === undefined) continue;
				touched = true;
				const parsed = parseDraft(next, controlFor(subField));
				if (parsed !== undefined) nested[subKey] = parsed;
			}
			if (touched) patch[key] = Object.keys(nested).length === 0 ? null : nested;
			continue;
		}
		if (control.kind === "boolean" && control.detail !== undefined) {
			const next = draft[key];
			if (next === undefined) continue;
			if (next !== "true") {
				patch[key] = false;
				continue;
			}
			const nested: Record<string, unknown> = {};
			for (const [subKey, subField] of Object.entries(control.detail)) {
				const subNext = draft[`${key}.${subKey}`];
				if (subNext === undefined) continue;
				const parsed = parseDraft(subNext, controlFor(subField));
				if (parsed !== undefined) nested[subKey] = parsed;
			}
			patch[key] = Object.keys(nested).length === 0 ? true : nested;
			continue;
		}
		const next = draft[key];
		if (next === undefined) continue;
		patch[key] = parseDraft(next, control) ?? null;
	}
	return patch;
}

export interface PluginConfigFormProps {
	readonly schema?: Record<string, unknown>;
	readonly value: Record<string, unknown>;
	readonly secretsSet?: readonly string[];
	readonly secretKeys?: readonly string[];
	readonly saving?: boolean;
	readonly onSave: (patch: Record<string, unknown>) => Promise<void> | void;
	/**
	 * Resolves schema `titleKey`, `descriptionKey`, `enumLabels`, and group `titleKey`
	 * entries against the plugin's own message catalog. Without it the English
	 * `title`/`description` literals are shown.
	 */
	readonly translate?: (key: string) => string;
	/** Optional field grouping; keys that are not listed are appended at the end. */
	readonly groups?: readonly PluginConfigGroup[];
	readonly labels?: {
		readonly save?: string;
		readonly configured?: string;
		readonly unset?: string;
		readonly empty?: string;
		readonly unsupported?: string;
	};
}

/**
 * JSON-schema-driven configuration form. Supported field types: string, number/integer,
 * boolean, string enums, arrays of strings (comma separated), nested objects with scalar
 * properties, and `anyOf` boolean-or-object shapes (rendered as a switch).
 *
 * Fields can carry localized copy through `titleKey`/`descriptionKey` (message keys) and
 * `enumLabels` (option value -> message key); the literal `title`/`description` stay as the
 * fallback when no translator is provided.
 */
export function PluginConfigForm({
	schema,
	value,
	secretsSet = [],
	secretKeys = [],
	saving = false,
	onSave,
	translate,
	groups,
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
			<p className="text-xs text-muted-foreground">{labels.empty ?? "No configurable fields."}</p>
		);
	}

	const copy = (key: string | undefined, literal: string | undefined): string | undefined => {
		if (key === undefined) return literal;
		if (translate !== undefined) {
			const resolved = translate(key);
			if (resolved !== key) return resolved;
		}
		return literal ?? key;
	};

	const setField = (draftKey: string, next: string) =>
		setDraft((previous) => ({ ...previous, [draftKey]: next }));

	const draftText = (draftKey: string, field: JsonSchemaNode, current: unknown): string => {
		const control = controlFor(field);
		const next = draft[draftKey];
		if (next !== undefined) return next;
		const fallbackText =
			typeof field.default === "string" || typeof field.default === "number"
				? String(field.default)
				: undefined;
		switch (control.kind) {
			case "boolean":
				return String(typeof current === "boolean" ? current : control.fallback);
			case "stringArray":
				return Array.isArray(current) ? current.map((item) => String(item)).join(", ") : "";
			case "object":
			case "unsupported":
				return "";
			default:
				if (typeof current === "string" || typeof current === "number") return String(current);
				return fallbackText ?? "";
		}
	};

	const save = async () => {
		await onSave(buildConfigPatch(schema, draft));
		setDraft({});
	};

	const renderControl = (
		draftKey: string,
		field: JsonSchemaNode,
		current: unknown,
		secret: boolean,
	): ReactNode => {
		const control = controlFor(field);
		const currentText = draftText(draftKey, field, current);
		const configured = secret && secretsSet.includes(draftKey);
		if (control.kind === "boolean") {
			const enabled = currentText === "true";
			const detail =
				control.detail === undefined ? undefined : (
					<div className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
						{Object.entries(control.detail).map(([subKey, subField]) => (
							<Field
								key={subKey}
								hint={copy(subField.descriptionKey, subField.description)}
								label={copy(subField.titleKey, subField.title) ?? subKey}
							>
								{renderControl(
									`${draftKey}.${subKey}`,
									subField,
									typeof current === "object" && current !== null && !Array.isArray(current)
										? (current as Record<string, unknown>)[subKey]
										: undefined,
									false,
								)}
							</Field>
						))}
					</div>
				);
			return (
				<div className="space-y-3">
					<Switch
						ariaLabel={copy(field.titleKey, field.title) ?? draftKey}
						checked={enabled}
						onCheckedChange={(checked) => setField(draftKey, String(checked))}
					/>
					{enabled ? detail : null}
				</div>
			);
		}
		if (control.kind === "enum") {
			const optionLabel = (option: string) => copy(control.labels?.[option], undefined) ?? option;
			const defaultOption = typeof field.default === "string" ? field.default : undefined;
			return (
				<Select value={currentText} onValueChange={(next) => setField(draftKey, next)}>
					<SelectTrigger className="w-full">
						<SelectValue
							placeholder={
								currentText.length > 0
									? optionLabel(currentText)
									: defaultOption === undefined
										? undefined
										: optionLabel(defaultOption)
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{control.options.map((option) => (
							<SelectItem key={option} value={option}>
								{optionLabel(option)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		}
		if (control.kind === "object") {
			const nestedCurrent =
				typeof current === "object" && current !== null && !Array.isArray(current)
					? (current as Record<string, unknown>)
					: {};
			return (
				<div className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
					{Object.entries(control.properties).map(([subKey, subField]) => (
						<Field
							key={subKey}
							hint={copy(subField.descriptionKey, subField.description)}
							label={copy(subField.titleKey, subField.title) ?? subKey}
						>
							{renderControl(`${draftKey}.${subKey}`, subField, nestedCurrent[subKey], false)}
						</Field>
					))}
				</div>
			);
		}
		if (control.kind === "unsupported") {
			return (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground">
						{labels.unsupported ?? "Edit this value in the plugin configuration JSON."}
					</p>
					{current === undefined ? null : (
						<pre className="overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-5">
							{JSON.stringify(current, null, 2)}
						</pre>
					)}
				</div>
			);
		}
		return (
			<Input
				type={secret ? "password" : control.kind === "number" ? "number" : "text"}
				placeholder={
					configured
						? (labels.configured ?? "Configured; enter a new value to replace it")
						: secret
							? (labels.unset ?? "Not configured")
							: undefined
				}
				value={currentText}
				onChange={(next) => setField(draftKey, next)}
			/>
		);
	};

	const renderField = (key: string): ReactNode => {
		const field = fields[key] ?? {};
		return (
			<Field
				key={key}
				hint={copy(field.descriptionKey, field.description)}
				label={copy(field.titleKey, field.title) ?? key}
			>
				{renderControl(key, field, value[key], secretKeys.includes(key))}
			</Field>
		);
	};

	const grouped: { readonly heading: string | undefined; readonly keys: readonly string[] }[] =
		groups === undefined || groups.length === 0
			? [{ heading: undefined, keys }]
			: [
					...groups.map((group) => ({
						heading: copy(group.titleKey, group.title),
						keys: group.keys.filter((key) => key in fields),
					})),
					{
						heading: undefined,
						keys: keys.filter((key) => !groups.some((group) => group.keys.includes(key))),
					},
				].filter((group) => group.keys.length > 0);

	return (
		<div className="space-y-5">
			{grouped.map((group, index) => (
				<section key={group.heading ?? `group-${index}`} className="space-y-3">
					{group.heading === undefined ? null : (
						<h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							{group.heading}
						</h4>
					)}
					{group.keys.map((key) => renderField(key))}
				</section>
			))}
			<Button disabled={saving} size="sm" onClick={() => void save()}>
				{labels.save ?? "Save"}
			</Button>
		</div>
	);
}
