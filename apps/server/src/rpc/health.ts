import { healthResponseSchema } from "@tsukaima/contracts";
import { apiBase } from "./base.ts";
import { runtimeVersion } from "../version.ts";

export type { TsukaimaApiContext } from "./base.ts";

export const healthRouter = {
	status: apiBase.health.status.handler(async ({ context }) => {
		const { state } = context.lifecycle;
		return healthResponseSchema.parse({
			stage: state.stage,
			state: state.state,
			uptimeMs: Date.now() - context.lifecycle.startedAtMs,
			version: runtimeVersion(process.env, context.lifecycle.config.repositoryRoot),
		});
	}),
};
