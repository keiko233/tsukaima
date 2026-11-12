import { healthResponseSchema } from "@elaina/contracts";
import { apiBase } from "./base.ts";

export type { ElainaApiContext } from "./base.ts";

export const healthRouter = {
	status: apiBase.health.status.handler(async ({ context }) => {
		const { state } = context.lifecycle;
		return healthResponseSchema.parse({
			stage: state.stage,
			state: state.state,
			uptimeMs: Date.now() - context.lifecycle.startedAtMs,
			version: "0.1.0",
		});
	}),
};
