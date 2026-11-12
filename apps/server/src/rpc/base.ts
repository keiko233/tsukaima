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

/**
 * Guarded base for the whole `admin/*` namespace: every procedure derived from it rejects
 * requests without a live admin session. `UNAUTHENTICATED` is the stable error code the WebUI
 * keys off when it redirects to the sign-in page. `health` and `auth` stay on `apiBase` because
 * they must answer before any session exists.
 *
 * State-changing procedures additionally record a supplementary audit row carrying the real
 * `admin:<username>` actor (see `audit.ts` for why this lives in the RPC layer).
 */
const ADMIN_MUTATING_PATHS = new Set([
	"admin/chats/createLocal",
	"admin/diagnostics/clearLogs",
	"admin/modelPolicies/set",
	"admin/requests/respond",
	"admin/sessions/create",
	"admin/sessions/send",
	"admin/sessions/setReceiving",
	"admin/sessions/update",
	"admin/settings/update",
]);

export const adminBase = apiBase.use(
	apiBase.middleware(async ({ context, next, path }) => {
		const session = await context.auth.getSession(context.headers);
		if (session === undefined) {
			throw new ORPCError("UNAUTHENTICATED", {
				message: "Admin sign-in required",
				status: 401,
			});
		}
		const result = await next();
		const procedurePath = path.join("/");
		if (ADMIN_MUTATING_PATHS.has(procedurePath)) {
			await context.lifecycle.writeAudit({
				action: "admin.rpc",
				actorId: `admin:${session.username}`,
				payload: { path: procedurePath },
				result: "ok",
				targetKind: "admin",
			});
		}
		return result;
	}),
);
