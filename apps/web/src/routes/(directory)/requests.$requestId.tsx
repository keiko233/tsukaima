import { createFileRoute } from "@tanstack/react-router";
import { RequestDetailPage } from "../_modules/directory/request-detail-page";

export const Route = createFileRoute("/(directory)/requests/$requestId")({
	component: RequestDetailRoute,
});

function RequestDetailRoute() {
	const { requestId } = Route.useParams();
	return <RequestDetailPage requestId={requestId} />;
}
