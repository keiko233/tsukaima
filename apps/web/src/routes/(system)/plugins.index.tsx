import { createFileRoute } from "@tanstack/react-router";
import { PluginListPlaceholder } from "./_modules/plugin-layout";

export const Route = createFileRoute("/(system)/plugins/")({
	component: () => <PluginListPlaceholder />,
});
