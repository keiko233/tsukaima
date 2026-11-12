import { Outlet, createRootRoute } from "@tanstack/react-router";
import { AdminShell } from "@/admin-shell";

export const Route = createRootRoute({
	component: () => (
		<AdminShell>
			<Outlet />
		</AdminShell>
	),
});
