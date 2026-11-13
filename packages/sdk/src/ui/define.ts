"use client";

import type { ComponentType, ReactNode } from "react";
import type { PluginI18nSource } from "../i18n/index.ts";

export type PluginPanelIcon =
	| "activity"
	| "plug"
	| "settings"
	| "list"
	| "chart"
	| "message"
	| "terminal"
	| "puzzle";

export interface PluginPanelDefinition {
	readonly id: string;
	readonly title: (t: (key: string) => string) => string;
	readonly icon?: PluginPanelIcon;
	readonly component: ComponentType;
}

export interface PluginUiModuleDefinition {
	/** Localized display name for the plugin page header and sidebar. */
	readonly displayName?: (t: (key: string) => string) => string;
	readonly description?: (t: (key: string) => string) => string;
	readonly icon?: PluginPanelIcon;
	/** Paraglide binding or dictionary source. Omit for host-language-only panels. */
	readonly i18n?: PluginI18nSource;
	readonly panels: readonly PluginPanelDefinition[];
}

/** Identity helper for a trusted plugin browser entry. */
export function definePluginUi(definition: PluginUiModuleDefinition): PluginUiModuleDefinition {
	return definition;
}

export type PluginUiModule = { readonly default: PluginUiModuleDefinition };

export type PluginUiLoader = () => Promise<PluginUiModule | { readonly default: PluginUiModule }>;

export interface ResolvedPluginUi {
	readonly pluginId: string;
	readonly displayName: (t: (key: string) => string) => string;
	readonly description: (t: (key: string) => string) => string;
	readonly icon?: PluginPanelIcon;
	readonly panels: readonly PluginPanelDefinition[];
}

export function resolvePluginUi(
	pluginId: string,
	definition: PluginUiModuleDefinition,
): ResolvedPluginUi {
	return {
		displayName: definition.displayName ?? (() => pluginId),
		description: definition.description ?? (() => ""),
		...(definition.icon === undefined ? {} : { icon: definition.icon }),
		panels: definition.panels,
		pluginId,
	};
}

export type PluginUiHost = (props: {
	readonly pluginId: string;
	readonly fallback: ReactNode;
}) => ReactNode;
