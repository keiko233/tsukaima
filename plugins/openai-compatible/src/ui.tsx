"use client";

import {
	KeyValueList,
	PluginConfigForm,
	PluginPage,
	PluginSection,
	definePluginUi,
	usePluginConfig,
	usePluginI18n,
	usePluginPanel,
} from "@elaina/sdk/ui";
import { i18n } from "./i18n.ts";

function ProviderPanel() {
	const i18nValue = usePluginI18n();
	const { plugin, status } = usePluginPanel();
	const config = usePluginConfig();
	const model = status?.metrics?.model;
	const baseUrl = status?.details?.baseUrl;
	return (
		<PluginPage
			description={i18nValue.t("provider_hint")}
			title={i18nValue.t("provider_title")}
		>
			<PluginSection title={plugin.name}>
				<KeyValueList
					items={[
						{
							label: i18nValue.t("model"),
							value: typeof model === "string" ? model : i18nValue.t("not_configured"),
						},
						{
							label: i18nValue.t("base_url"),
							value: typeof baseUrl === "string" ? baseUrl : i18nValue.t("not_configured"),
						},
						{
							label: i18nValue.t("configured"),
							value: plugin.secretKeys.some((key) => config.secretsSet.includes(key))
								? i18nValue.t("configured")
								: i18nValue.t("not_configured"),
						},
					]}
				/>
			</PluginSection>
			<PluginSection title={i18nValue.t("panel_settings")}>
				<PluginConfigForm
					labels={{
						configured: i18nValue.t("configured_placeholder"),
						save: i18nValue.t("save"),
						unset: i18nValue.t("unset_placeholder"),
					}}
					onSave={config.save}
					saving={config.saving}
					schema={plugin.configSchema}
					secretKeys={plugin.secretKeys}
					secretsSet={config.secretsSet}
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
	icon: "puzzle",
	panels: [
		{
			component: ProviderPanel,
			icon: "puzzle",
			id: "provider",
			title: (t) => t("panel_provider"),
		},
	],
});
