import { Outlet, createFileRoute } from "@tanstack/react-router";
import { PluginLayout } from "./_modules/plugin-layout";

export const Route = createFileRoute("/(system)/plugins")({
	component: () => (
		<PluginLayout>
			<Outlet />
		</PluginLayout>
	),
});
