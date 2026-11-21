import { createFileRoute, Navigate } from "@tanstack/react-router";

function MemoriesRedirect() {
	return <Navigate params={{ pluginId: "memory" }} replace to="/plugins/$pluginId" />;
}

export const Route = createFileRoute("/(system)/memories")({ component: MemoriesRedirect });
