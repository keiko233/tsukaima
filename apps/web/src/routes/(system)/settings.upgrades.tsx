import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "./_modules/page-header";
import { UpgradeCenter } from "./_modules/upgrade-center";
import { m } from "@/paraglide/messages";

function SettingsUpgradesPage() {
	return (
		<SystemPage description={m.settings_upgrades_description()} title={m.settings_tab_upgrades()}>
			<UpgradeCenter />
		</SystemPage>
	);
}

export const Route = createFileRoute("/(system)/settings/upgrades")({
	component: SettingsUpgradesPage,
});
