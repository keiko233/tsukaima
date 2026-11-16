import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { m } from "@/paraglide/messages";
import { DirectoryEmptyState } from "../_modules/directory/directory-page";

export const Route = createFileRoute("/(directory)/groups/")({
	component: GroupsIndexRoute,
});

function GroupsIndexRoute() {
	return (
		<DirectoryEmptyState
			description={m.groups_select_description()}
			icon={Users}
			title={m.groups_select_title()}
		/>
	);
}
