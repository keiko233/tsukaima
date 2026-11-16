import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "./_modules/settings-layout";

export const Route = createFileRoute("/(system)/settings")({
	component: () => (
		<SettingsLayout>
			<Outlet />
		</SettingsLayout>
	),
});
