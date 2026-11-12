import { z } from "zod";
import type { OneBotConfig } from "./protocol/types.ts";

/**
 * Channel instance id. Envelopes and `chat_objects` rows are keyed by this value, so it
 * stays `onebot` rather than the plugin package name.
 */
export const ONEBOT_DEFAULT_CHANNEL_ID = "onebot";

export const oneBotPluginConfigSchema = z.object({
	accessToken: z.string().min(1).optional(),
	botAccountId: z.string().min(1).optional(),
	channelId: z.string().min(1).optional(),
	reconnect: z
		.object({
			initialDelayMs: z.number().int().positive(),
			jitterRatio: z.number().min(0).max(1),
			maxDelayMs: z.number().int().positive(),
		})
		.optional(),
	wsUrl: z.string().min(1).optional(),
});

export type OneBotPluginConfig = z.infer<typeof oneBotPluginConfigSchema>;

export interface ResolvedOneBotState {
	readonly channel?: OneBotConfig;
	readonly channelId: string;
	/** Changes exactly when the live connection must be replaced. */
	readonly key: string;
}

const DEFAULT_RECONNECT = {
	initialDelayMs: 1_000,
	jitterRatio: 0.1,
	maxDelayMs: 30_000,
} as const;

/**
 * Normalizes stored/environment config into either "not configured" or a ready-to-use
 * channel configuration. The channel itself validates the WebSocket URL scheme so a bad
 * value surfaces as a failed channel start instead of a settings rejection.
 */
export function resolveOneBotState(input: OneBotPluginConfig): ResolvedOneBotState {
	const channelId = input.channelId ?? ONEBOT_DEFAULT_CHANNEL_ID;
	const key = `${input.wsUrl ?? ""}\u0000${input.accessToken ?? ""}`;
	if (input.wsUrl === undefined) {
		return { channelId, key };
	}
	const channel: OneBotConfig = {
		botAccountId: input.botAccountId ?? "elaina-server",
		channelId,
		reconnect: input.reconnect ?? DEFAULT_RECONNECT,
		url: input.wsUrl,
		...(input.accessToken === undefined ? {} : { accessToken: input.accessToken }),
	};
	return { channel, channelId, key };
}
