"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PluginRow, PluginStatusSnapshot } from "@tsukaima/contracts";
import type { PluginI18n } from "../i18n/index.ts";

export type PluginSummary = Pick<
	PluginRow,
	| "apiVersion"
	| "config"
	| "configSchema"
	| "enabled"
	| "id"
	| "kind"
	| "name"
	| "permissions"
	| "runMode"
	| "secretKeys"
	| "secretsSet"
	| "status"
	| "version"
>;

export interface PluginConfigApi {
	readonly value: Record<string, unknown>;
	readonly secretsSet: readonly string[];
	save(patch: Record<string, unknown>): Promise<void>;
	readonly saving: boolean;
}

export interface PluginNotifyApi {
	success(message: string, description?: string): void;
	error(message: string, description?: string): void;
	info(message: string, description?: string): void;
}

export interface PluginRpcApi {
	call<T = unknown>(method: string, input?: unknown): Promise<T>;
}

export interface PluginPanelContextValue {
	readonly plugin: PluginSummary;
	readonly status: PluginStatusSnapshot | null;
	readonly rpc: PluginRpcApi;
	readonly config: PluginConfigApi;
	readonly i18n: PluginI18n;
	readonly notify: PluginNotifyApi;
	refresh(): Promise<void>;
}

const PluginPanelContext = createContext<PluginPanelContextValue | null>(null);

export function PluginPanelProvider({
	value,
	children,
}: {
	value: PluginPanelContextValue;
	children: ReactNode;
}) {
	return <PluginPanelContext.Provider value={value}>{children}</PluginPanelContext.Provider>;
}

export function usePluginPanel(): PluginPanelContextValue {
	const value = useContext(PluginPanelContext);
	if (value === null) {
		throw new Error("usePluginPanel must be used inside a plugin panel");
	}
	return value;
}

export function usePluginRpc(): PluginRpcApi {
	return usePluginPanel().rpc;
}

export function usePluginConfig(): PluginConfigApi {
	return usePluginPanel().config;
}

export function usePluginI18n(): PluginI18n {
	return usePluginPanel().i18n;
}

export function usePluginToast(): PluginNotifyApi {
	return usePluginPanel().notify;
}
