import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { orpc } from "@/lib/api";
import { AdminShell } from "./_modules/shell/admin-shell";

/**
 * Auth gate for the whole WebUI. The admin shell never renders without a live session: the
 * `auth.status` query decides between the shell and a redirect to `/login`. `/login` itself is
 * rendered bare, and an authenticated visitor on `/login` is bounced back to the app.
 */
function RootLayout() {
	const status = useQuery(
		orpc.auth.status.queryOptions({
			refetchInterval: 30_000,
			retry: false,
		}),
	);
	const pathname = useRouterState({ select: (state) => state.location.pathname });

	if (status.isPending) {
		return (
			<div className="grid h-dvh place-items-center bg-background">
				<div
					aria-label="Loading"
					className="size-6 animate-spin rounded-full border-2 border-border border-t-foreground"
				/>
			</div>
		);
	}

	const authenticated = status.data?.authenticated === true;
	if (!authenticated && pathname !== "/login") return <Navigate replace to="/login" />;
	if (authenticated && pathname === "/login") return <Navigate replace to="/" />;

	return pathname === "/login" ? (
		<Outlet />
	) : (
		<AdminShell>
			<Outlet />
		</AdminShell>
	);
}

export const Route = createRootRoute({ component: RootLayout });
