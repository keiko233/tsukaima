import { apiBase } from "./base.ts";

/**
 * Small status surface for API clients and the WebUI's "not configured" state.
 * Login, logout, session refresh, and cookie handling are served by Better Auth at
 * `/api/auth/*`; they are not duplicated as oRPC procedures.
 */
export const authRouter = {
	status: apiBase.auth.status.handler(({ context }) => context.auth.status(context.headers)),
};
