import { os } from "@orpc/server";
import { healthResponseSchema } from "@elaina/contracts";
import type { ElainaLifecycle } from "../lifecycle.ts";

export interface ElainaApiContext {
	readonly lifecycle: ElainaLifecycle;
}

const lifecycleContext = os.$context<ElainaApiContext>();

export const healthRouter = {
	status: lifecycleContext.handler(async ({ context }: { context: ElainaApiContext }) => {
		const { state } = context.lifecycle;
		return healthResponseSchema.parse({
			stage: state.stage,
			state: state.state,
			uptimeMs: Date.now() - context.lifecycle.startedAtMs,
			version: "0.1.0",
		});
	}),
};
