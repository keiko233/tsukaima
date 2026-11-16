import { createFileRoute } from "@tanstack/react-router";
import { UsersRound } from "lucide-react";
import { m } from "@/paraglide/messages";
import { DirectoryEmptyState } from "../_modules/directory/directory-page";

export const Route = createFileRoute("/(directory)/users/")({
	component: UsersIndexRoute,
});

function UsersIndexRoute() {
	return (
		<DirectoryEmptyState
			description={m.users_select_description()}
			icon={UsersRound}
			title={m.users_select_title()}
		/>
	);
}
