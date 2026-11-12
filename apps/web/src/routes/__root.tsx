import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, createRootRoute, useRouterState } from "@tanstack/react-router";
import { orpc } from "@/lib/api";
import { authSessionQueryOptions } from "@/lib/auth";
import { useEventStream } from "@/lib/use-event-stream";
import { AdminShell } from "./_modules/shell/admin-shell";

/**
 * Auth gate for the whole WebUI. Better Auth's `getSession` is the authority; the oRPC status
 * query only supplies the "no administrator configured yet" guidance. `/login` itself is rendered
 * bare, and an authenticated visitor on `/login` is bounced back to the app.
 */
function RootLayout() {
	const session = useQuery(authSessionQueryOptions());
	const status = useQuery(orpc.auth.status.queryOptions({ retry: false }));
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const authenticated = session.data !== null && session.data !== undefined;
	useEventStream(authenticated);

	if (session.isPending || (!authenticated && status.isPending)) {
		return (
			<div className="grid h-dvh place-items-center bg-background">
				<div
					aria-label="Loading"
					className="size-6 animate-spin rounded-full border-2 border-border border-t-foreground"
				/>
			</div>
		);
	}

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
