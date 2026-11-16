import { createFileRoute } from "@tanstack/react-router";
import { UserDetailPage } from "../_modules/directory/user-detail-page";

export const Route = createFileRoute("/(directory)/users/$userId")({
	component: UserDetailRoute,
});

function UserDetailRoute() {
	const { userId } = Route.useParams();
	return <UserDetailPage userId={userId} />;
}
