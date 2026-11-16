import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "./_modules/page-header";
import { RuntimeMaintenanceCard } from "./_modules/runtime-maintenance-card";
import { m } from "@/paraglide/messages";

function SettingsMaintenancePage() {
	return (
		<SystemPage
			description={m.settings_maintenance_description()}
			title={m.settings_tab_maintenance()}
		>
			<RuntimeMaintenanceCard />
		</SystemPage>
	);
}

export const Route = createFileRoute("/(system)/settings/maintenance")({
	component: SettingsMaintenancePage,
});
