import { apiBase } from "./base.ts";
import { authRouter } from "./auth.ts";
import { healthRouter } from "./health.ts";
import { adminRouter } from "./admin.ts";

export const appRouter = apiBase.router({
	admin: adminRouter,
	auth: authRouter,
	health: healthRouter,
});
