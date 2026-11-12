import { healthRouter } from "./health.ts";
import { adminRouter } from "./admin.ts";

export const appRouter = {
	admin: adminRouter,
	health: healthRouter,
};
