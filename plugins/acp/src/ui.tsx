"use client";

import { EmptyState, PluginPage, definePluginUi, usePluginI18n } from "@tsukaima/sdk/ui";
import { i18n } from "./i18n.ts";

function AcpPanel() {
	const t = usePluginI18n();
	return (
		<PluginPage description={t.t("plugin_description")} title={t.t("plugin_name")}>
			<EmptyState title={t.t("plugin_name")} description={t.t("plugin_description")} />
		</PluginPage>
	);
}

export default definePluginUi({
	description: (t) => t.t("plugin_description"),
	displayName: (t) => t.t("plugin_name"),
	i18n,
	panels: [
		{
			component: AcpPanel,
			icon: "cpu",
			id: "acp",
			title: (t) => t.t("plugin_name"),
		},
	],
});
