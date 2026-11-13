import { createFileRoute } from "@tanstack/react-router";
import { PluginRoute } from "./_modules/plugin-route";

export const Route = createFileRoute("/(system)/plugins/$pluginId")({
	component: PluginRoute,
});
