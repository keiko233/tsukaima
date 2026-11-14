"use client";

import {
	Button,
	PluginConfigForm,
	PluginPage,
	PluginSection,
	StatGrid,
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
	usePluginRpc,
	usePluginToast,
} from "@elaina/sdk/ui";
import { useState } from "react";
import { i18n } from "./i18n.ts";

function ConnectionPanel() {
	const { plugin, status, refresh } = usePluginPanel();
	const i18nValue = usePluginI18n();
	const rpc = usePluginRpc();
	const toast = usePluginToast();
	const [busy, setBusy] = useState(false);
	const metrics = status?.metrics ?? {};
	const details = status?.details ?? {};

	return (
		<PluginPage
			actions={
				<Button
					disabled={busy}
					size="sm"
					variant="secondary"
					onClick={async () => {
						setBusy(true);
						try {
							await rpc.call("reconnect");
							toast.success(i18nValue.t("reconnect_started"));
							await refresh();
						} catch (error) {
							toast.error(i18nValue.t("reconnect_failed"), String(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{i18nValue.t("reconnect")}
				</Button>
			}
			description={i18nValue.t("connection_hint")}
			title={i18nValue.t("connection_title")}
		>
			<StatGrid
				items={[
					{ label: i18nValue.t("events"), value: String(metrics.events ?? "—") },
					{ label: i18nValue.t("reconnects"), value: String(metrics.reconnects ?? "—") },
					{
						label: i18nValue.t("endpoint"),
						value: typeof details.endpoint === "string" ? details.endpoint : plugin.runMode,
					},
				]}
			/>
		</PluginPage>
	);
}

function SettingsPanel() {
	const i18nValue = usePluginI18n();
	const { plugin } = usePluginPanel();
	const config = usePluginConfig();
	return (
		<PluginPage description={i18nValue.t("settings_hint")} title={i18nValue.t("panel_settings")}>
			<PluginSection title={plugin.name}>
				<PluginConfigForm
					groups={[
						{
							keys: ["mode", "wsUrl", "accessToken", "host", "port", "channelId", "botAccountId"],
							titleKey: "group_connection",
						},
						{
							keys: [
								"replyAsQuote",
								"splitMaxChars",
								"sendIntervalMs",
								"pendingGraceMs",
								"pttToText",
								"forwardExpand",
							],
							titleKey: "group_behaviour",
						},
						{
							keys: [
								"groupManage",
								"selfManage",
								"deleteGroupFile",
								"rawActionAllowlist",
								"adminUsers",
								"adminTitles",
							],
							titleKey: "group_permissions",
						},
						{
							keys: ["reconnect", "actionTimeoutMs"],
							titleKey: "group_network",
						},
					]}
					labels={{
						configured: i18nValue.t("configured"),
						save: i18nValue.t("save"),
						unset: i18nValue.t("unset"),
					}}
					onSave={config.save}
					saving={config.saving}
					schema={plugin.configSchema}
					secretKeys={plugin.secretKeys}
					secretsSet={config.secretsSet}
					translate={(key) => i18nValue.t(key)}
					value={config.value}
				/>
			</PluginSection>
		</PluginPage>
	);
}

export default definePluginUi({
	description: (t) => t("plugin_description"),
	displayName: (t) => t("plugin_name"),
	i18n,
	icon: "plug",
	panels: [
		{
			component: ConnectionPanel,
			icon: "plug",
			id: "connection",
			title: (t) => t("panel_connection"),
		},
		{
			component: SettingsPanel,
			icon: "settings",
			id: "settings",
			title: (t) => t("panel_settings"),
		},
	],
});
