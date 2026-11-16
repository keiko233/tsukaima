import { implement, ORPCError } from "@orpc/server";
import { appContract } from "@tsukaima/contracts";
import type { TsukaimaLifecycle } from "../lifecycle.ts";
import type { AuthService } from "../services/auth.ts";

/** The RPC context. Keep it small: the lifecycle handle plus the admin auth seam. */
export interface TsukaimaApiContext {
	readonly auth: AuthService;
	/** Raw request headers; Better Auth resolves the session cookie from them. */
	readonly headers: Headers;
	readonly lifecycle: TsukaimaLifecycle;
	/**
	 * Response header bag injected by oRPC's `ResponseHeadersPlugin` through `app.ts`; absent in
	 * handlers created without that plugin (for example, hand-rolled test handlers).
	 */
	readonly resHeaders?: Headers;
}

/**
 * The contract-bound implementer. Every procedure below is derived from `appContract`, so the
 * compiler rejects any handler whose input or output drifts from the published contract.
 */
export const apiBase = implement(appContract).$context<TsukaimaApiContext>();

export const adminBase = apiBase.use(
	apiBase.middleware(async ({ context, next, path, procedure }) => {
		const session = await context.auth.getSession(context.headers);
		if (session === undefined) {
			throw new ORPCError("UNAUTHENTICATED", {
				message: "Admin sign-in required",
				status: 401,
			});
		}
		const procedurePath = path.join("/");
		const metadata = procedure["~orpc"].meta as { audit?: boolean } | undefined;
		if (metadata?.audit !== true) {
			return next();
		}
		try {
			const result = await next();
			await context.lifecycle.writeAudit({
				action: "admin.rpc",
				actorId: `admin:${session.username}`,
				payload: { path: procedurePath },
				result: "ok",
				targetKind: "admin",
			});
			return result;
		} catch (error) {
			await context.lifecycle.writeAudit({
				action: "admin.rpc",
				actorId: `admin:${session.username}`,
				payload: { path: procedurePath },
				reason: error instanceof Error ? error.message : String(error),
				result: "failed",
				targetKind: "admin",
			});
			throw error;
		}
	}),
);
