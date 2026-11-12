import { ORPCError } from "@orpc/server";
import { clearedSessionCookie, sessionCookie } from "../services/auth.ts";
import { recordAdminAudit } from "./audit.ts";
import { apiBase } from "./base.ts";

/**
 * Public auth surface. `login` issues the session cookie, `logout` clears it, and `status` lets
 * the WebUI gate decide between rendering the admin shell and redirecting to sign-in.
 * Tokens never appear in response bodies — only in the httpOnly cookie.
 */
export const authRouter = {
	login: apiBase.auth.login.handler(async ({ context, input }) => {
		const result = await context.auth.login(input.username, input.password);
		if (!result.ok) {
			if (result.reason === "invalid") {
				await recordAdminAudit(context.lifecycle, {
					action: "admin.sign-in-denied",
					actorId: `admin:${input.username}`,
					payload: { username: input.username },
					result: "denied",
				});
			}
			if (result.reason === "locked") {
				throw new ORPCError("TOO_MANY_REQUESTS", {
					data: { retryAfterMs: result.retryAfterMs },
					message: "Too many failed sign-in attempts; try again later",
					status: 429,
				});
			}
			throw new ORPCError("UNAUTHENTICATED", {
				message:
					result.reason === "unconfigured"
						? "Admin credentials are not configured"
						: "Invalid username or password",
				status: 401,
			});
		}
		const headers = context.resHeaders;
		if (headers === undefined) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "RPC handler is missing the response headers plugin",
				status: 500,
			});
		}
		headers.append("set-cookie", sessionCookie(result.token, context.auth.sessionTtlSeconds));
		await recordAdminAudit(context.lifecycle, {
			action: "admin.sign-in",
			actorId: `admin:${result.username}`,
		});
		return { username: result.username };
	}),
	logout: apiBase.auth.logout.handler(async ({ context }) => {
		const session = context.auth.resolveSession(context.sessionToken);
		context.auth.logout(context.sessionToken);
		if (session !== undefined) {
			await recordAdminAudit(context.lifecycle, {
				action: "admin.sign-out",
				actorId: `admin:${session.username}`,
			});
		}
		context.resHeaders?.append("set-cookie", clearedSessionCookie());
		return { ok: true as const };
	}),
	status: apiBase.auth.status.handler(({ context }) => context.auth.status(context.sessionToken)),
};
