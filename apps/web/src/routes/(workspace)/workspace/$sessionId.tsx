import { createFileRoute } from "@tanstack/react-router";
import { WorkspacePage } from "../_modules/workspace-page";

export const Route = createFileRoute("/(workspace)/workspace/$sessionId")({
	component: WorkspaceSessionRoute,
});

function WorkspaceSessionRoute() {
	const { sessionId } = Route.useParams();
	return <WorkspacePage sessionId={sessionId} />;
}
