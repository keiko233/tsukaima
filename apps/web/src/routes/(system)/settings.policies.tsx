import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "./_modules/page-header";
import { PolicyDefaultsCard } from "./_modules/policy-defaults-card";
import { m } from "@/paraglide/messages";

function SettingsPoliciesPage() {
	return (
		<SystemPage
			description={m.settings_policies_description()}
			title={m.settings_tab_policies()}
		>
			<PolicyDefaultsCard />
		</SystemPage>
	);
}

export const Route = createFileRoute("/(system)/settings/policies")({
	component: SettingsPoliciesPage,
});
