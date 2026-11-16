import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceEmptyState } from "../_modules/workspace-page";

export const Route = createFileRoute("/(workspace)/workspace/")({
	component: WorkspaceEmptyState,
});
