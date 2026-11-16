import { createFileRoute } from "@tanstack/react-router";
import { GroupDetailPage } from "../_modules/directory/group-detail-page";

export const Route = createFileRoute("/(directory)/groups/$groupId")({
	component: GroupDetailRoute,
});

function GroupDetailRoute() {
	const { groupId } = Route.useParams();
	return <GroupDetailPage groupId={groupId} />;
}
