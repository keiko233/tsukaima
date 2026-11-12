import { os } from "@orpc/server";
import { healthResponseSchema } from "@tsukaima/contracts";
import type { TsukaimaLifecycle } from "../lifecycle.ts";

export interface TsukaimaApiContext {
	readonly lifecycle: TsukaimaLifecycle;
}

const lifecycleContext = os.$context<TsukaimaApiContext>();

export const healthRouter = {
	status: lifecycleContext.handler(async ({ context }: { context: TsukaimaApiContext }) => {
		const { state } = context.lifecycle;
		return healthResponseSchema.parse({
			stage: state.stage,
			state: state.state,
			uptimeMs: Date.now() - context.lifecycle.startedAtMs,
			version: "0.1.0",
		});
	}),
};
