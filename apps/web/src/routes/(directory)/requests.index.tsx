import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { m } from "@/paraglide/messages";
import { DirectoryEmptyState } from "../_modules/directory/directory-page";

export const Route = createFileRoute("/(directory)/requests/")({
	component: RequestsIndexRoute,
});

function RequestsIndexRoute() {
	return (
		<DirectoryEmptyState
			description={m.requests_select_description()}
			icon={Inbox}
			title={m.requests_select_title()}
		/>
	);
}
