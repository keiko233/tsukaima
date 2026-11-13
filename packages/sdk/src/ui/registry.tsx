"use client";

import type { ComponentType, ReactNode } from "react";
import { hasPermission, type PluginPermission } from "../permissions.ts";
import type { PluginUiDefinition, PluginUiSlot } from "../types.ts";
import { Alert, EmptyState, KeyValueList, PluginSection, StatGrid } from "./components.tsx";

export const HOST_UI_VERSION = "1";

export type DeclarativeUiComponentName =
	| "approval-card"
	| "memory-review"
	| "sticker-grid"
	| "task-list"
	| "task-graph"
	| "diagnostic-card"
	| "settings-form"
	| "fallback";

export interface DeclarativeUiRenderProps {
	readonly definition: PluginUiDefinition;
	readonly data: Record<string, unknown>;
	readonly pluginId?: string;
	readonly t?: (key: string) => string;
}

export interface DeclarativeUiRegistryEntry {
	readonly name: DeclarativeUiComponentName;
	readonly description: string;
	readonly slots?: readonly PluginUiSlot[];
	readonly minHostVersion?: string;
	readonly component: ComponentType<DeclarativeUiRenderProps>;
}

export type UiComponentResolution =
	| {
			readonly status: "ok";
			readonly component: DeclarativeUiRegistryEntry;
	  }
	| {
			readonly status: "fallback";
			readonly reason:
				| "unknown-component"
				| "host-version-mismatch"
				| "permission-denied"
				| "slot-mismatch";
			readonly component: DeclarativeUiRegistryEntry;
	  };

function versionParts(version: string): number[] {
	return version
		.split(/[^0-9]+/u)
		.filter((part) => part.length > 0)
		.map(Number);
}

export function isUiVersionCompatible(required?: string, host = HOST_UI_VERSION): boolean {
	if (required === undefined) return true;
	const requiredParts = versionParts(required);
	const hostParts = versionParts(host);
	const length = Math.max(requiredParts.length, hostParts.length);
	for (let index = 0; index < length; index += 1) {
		const left = requiredParts[index] ?? 0;
		const right = hostParts[index] ?? 0;
		if (left !== right) return left < right;
	}
	return true;
}

function GenericFallback({ definition, t }: DeclarativeUiRenderProps) {
	const title = t?.(definition.title) ?? definition.title;
	const rows = Object.entries(definition.data).map(([key, value]) => ({
		label: key,
		value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
	}));
	return (
		<PluginSection title={title} description="Generic plugin UI fallback">
			<div className="space-y-3">
				<Alert tone="warning">
					This plugin requested an unavailable UI component ({definition.component}).
				</Alert>
				<KeyValueList
					items={
						rows.length === 0
							? [{ label: "component", value: definition.component }]
							: rows
					}
				/>
			</div>
		</PluginSection>
	);
}

function ApprovalCard({ definition, t }: DeclarativeUiRenderProps) {
	const data = definition.data;
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			<div className="space-y-3">
				<Alert tone="warning">
					{String(data.summary ?? data.reason ?? "Approval is required")}
				</Alert>
				<KeyValueList
					items={Object.entries(data)
						.filter(([key]) => key !== "summary" && key !== "reason")
						.map(([key, value]) => ({ label: key, value: String(value) }))}
				/>
			</div>
		</PluginSection>
	);
}

function MemoryReview({ definition, t }: DeclarativeUiRenderProps) {
	const items = Array.isArray(definition.data.items) ? definition.data.items : [];
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			{items.length === 0 ? (
				<EmptyState title="No memories to review" />
			) : (
				<ul className="space-y-2 text-sm">
					{items.map((item, index) => (
						<li key={index} className="rounded-lg border border-border px-3 py-2">
							{typeof item === "object" && item !== null
								? String((item as Record<string, unknown>).summary ?? JSON.stringify(item))
								: String(item)}
						</li>
					))}
				</ul>
			)}
		</PluginSection>
	);
}

function StickerGrid({ definition, t }: DeclarativeUiRenderProps) {
	const items = Array.isArray(definition.data.items) ? definition.data.items : [];
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
				{items.map((item, index) => {
					const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
					return (
						<div key={index} className="rounded-lg border border-border px-2 py-3 text-center text-xs">
							{String(record.label ?? record.stickerId ?? record.id ?? `sticker ${index + 1}`)}
						</div>
					);
				})}
			</div>
		</PluginSection>
	);
}

function TaskList({ definition, t }: DeclarativeUiRenderProps) {
	const items = Array.isArray(definition.data.items) ? definition.data.items : [];
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			{items.length === 0 ? (
				<EmptyState title="No tasks" />
			) : (
				<ul className="space-y-2 text-sm">
					{items.map((item, index) => {
						const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
						return (
							<li key={index} className="flex justify-between rounded-lg border border-border px-3 py-2">
								<span>{String(record.kind ?? record.id ?? `task ${index + 1}`)}</span>
								<span className="text-muted-foreground">{String(record.status ?? "")}</span>
							</li>
						);
					})}
				</ul>
			)}
		</PluginSection>
	);
}

function TaskGraph({ definition, t }: DeclarativeUiRenderProps) {
	const nodes = Array.isArray(definition.data.nodes) ? definition.data.nodes : [];
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			<StatGrid
				items={nodes.map((node, index) => {
					const record = typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
					return { label: String(record.label ?? `node ${index + 1}`), value: String(record.status ?? "") };
				})}
			/>
		</PluginSection>
	);
}

function DiagnosticCard({ definition, t }: DeclarativeUiRenderProps) {
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			<KeyValueList
				items={Object.entries(definition.data).map(([key, value]) => ({
					label: key,
					value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
				}))}
			/>
		</PluginSection>
	);
}

function SettingsForm({ definition, t }: DeclarativeUiRenderProps) {
	return (
		<PluginSection title={t?.(definition.title) ?? definition.title}>
			<KeyValueList
				items={Object.entries(definition.data).map(([key, value]) => ({
					label: key,
					value: String(value),
				}))}
			/>
		</PluginSection>
	);
}

function entry(
	name: DeclarativeUiComponentName,
	description: string,
	component: ComponentType<DeclarativeUiRenderProps>,
	slots?: readonly PluginUiSlot[],
	minHostVersion?: string,
): DeclarativeUiRegistryEntry {
	return {
		component,
		description,
		name,
		...(slots === undefined ? {} : { slots }),
		...(minHostVersion === undefined ? {} : { minHostVersion }),
	};
}

class DeclarativeUiRegistry {
	readonly #entries = new Map<string, DeclarativeUiRegistryEntry>();

	constructor() {
		for (const item of [
			entry("approval-card", "Approve or reject a requested action.", ApprovalCard, [
				"approval-card",
				"message-card",
			]),
			entry("memory-review", "Review and curate remembered facts.", MemoryReview),
			entry("sticker-grid", "Browse stickers contributed by a plugin.", StickerGrid),
			entry("task-list", "Show durable plugin tasks.", TaskList),
			entry("task-graph", "Show task dependencies and status.", TaskGraph),
			entry("diagnostic-card", "Show diagnostic values.", DiagnosticCard),
			entry("settings-form", "Render plugin settings.", SettingsForm, ["settings-form"]),
			entry("fallback", "Generic card for unknown components.", GenericFallback),
		]) {
			this.register(item);
		}
	}

	register(item: DeclarativeUiRegistryEntry): void {
		this.#entries.set(item.name, item);
	}

	get(name: string): DeclarativeUiRegistryEntry | undefined {
		return this.#entries.get(name);
	}

	list(): readonly DeclarativeUiRegistryEntry[] {
		return [...this.#entries.values()];
	}
}

export const declarativeUiRegistry = new DeclarativeUiRegistry();
/** Backwards-friendly alias for consumers that prefer the shorter registry name. */
export const uiComponentRegistry = declarativeUiRegistry;
export type PluginUiComponentName = DeclarativeUiComponentName;

export function resolveUiComponent(
	definition: Pick<PluginUiDefinition, "component" | "kind" | "requiredPermissions" | "slot" | "version">,
	options: {
		readonly grantedPermissions?: readonly PluginPermission[];
		readonly hostVersion?: string;
	} = {},
): UiComponentResolution {
	const fallback = declarativeUiRegistry.get("fallback") as DeclarativeUiRegistryEntry;
	const component = declarativeUiRegistry.get(definition.component);
	if (component === undefined) return { component: fallback, reason: "unknown-component", status: "fallback" };
	if (!isUiVersionCompatible(definition.version, options.hostVersion ?? HOST_UI_VERSION)) {
		return { component: fallback, reason: "host-version-mismatch", status: "fallback" };
	}
	if (
		definition.requiredPermissions !== undefined &&
		options.grantedPermissions !== undefined &&
		!definition.requiredPermissions.every((permission) =>
			hasPermission(options.grantedPermissions as readonly string[], permission),
		)
	) {
		return { component: fallback, reason: "permission-denied", status: "fallback" };
	}
	if (component.slots !== undefined) {
		const slot = definition.slot ?? definition.kind;
		if (!component.slots.includes(slot)) {
			return { component: fallback, reason: "slot-mismatch", status: "fallback" };
		}
	}
	return { component, status: "ok" };
}

export function resolvePluginUiComponent(
	definition: Pick<PluginUiDefinition, "component" | "kind" | "requiredPermissions" | "slot" | "version">,
	options: {
		readonly grantedPermissions?: readonly PluginPermission[];
		readonly hostVersion?: string;
	} = {},
): UiComponentResolution {
	return resolveUiComponent(definition, options);
}

export function UiComponentRenderer({
	definition,
	pluginId,
	t,
	grantedPermissions,
	hostVersion,
}: {
	readonly definition: PluginUiDefinition;
	readonly pluginId?: string;
	readonly t?: (key: string) => string;
	readonly grantedPermissions?: readonly PluginPermission[];
	readonly hostVersion?: string;
}): ReactNode {
	const resolution = resolveUiComponent(definition, {
		...(grantedPermissions === undefined ? {} : { grantedPermissions }),
		...(hostVersion === undefined ? {} : { hostVersion }),
	});
	const Component = resolution.component.component;
	return (
		<Component
			data={definition.data}
			definition={definition}
			{...(pluginId === undefined ? {} : { pluginId })}
			{...(t === undefined ? {} : { t })}
		/>
	);
}
