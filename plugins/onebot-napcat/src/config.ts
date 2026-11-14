import { z } from "zod";
import type { OneBotConfig } from "./protocol/types.ts";

/**
 * Channel instance id. Envelopes and `chat_objects` rows are keyed by this value, so it
 * stays `onebot` rather than the plugin package name.
 */
export const ONEBOT_DEFAULT_CHANNEL_ID = "onebot";
export const ONEBOT_DEFAULT_REVERSE_HOST = "127.0.0.1";
export const ONEBOT_DEFAULT_REVERSE_PORT = 3002;

const forwardExpandSchema = z.union([
	z.boolean(),
	z.object({
		maxChars: z.number().int().positive().optional(),
		maxNodes: z.number().int().positive().optional(),
		timeoutMs: z.number().int().positive().optional(),
	}),
]);

const pttToTextSchema = z.union([
	z.boolean(),
	z.object({
		minIntervalMs: z.number().int().nonnegative().optional(),
		timeoutMs: z.number().int().positive().optional(),
	}),
]);

export const oneBotPluginConfigSchema = z.object({
	accessToken: z.string().min(1).optional(),
	actionTimeoutMs: z.number().int().positive().optional(),
	adminTitles: z.array(z.string().min(1)).optional(),
	adminUsers: z.array(z.string().min(1)).optional(),
	botAccountId: z.string().min(1).optional(),
	channelId: z.string().min(1).optional(),
	deleteGroupFile: z.boolean().optional(),
	forwardExpand: forwardExpandSchema.optional(),
	groupManage: z.boolean().optional(),
	host: z.string().min(1).optional(),
	mode: z.enum(["forward", "reverse"]).optional(),
	nativeSticker: z.boolean().optional(),
	pendingGraceMs: z.number().int().nonnegative().optional(),
	port: z.number().int().min(1).max(65_535).optional(),
	pttToText: pttToTextSchema.optional(),
	rawActionAllowlist: z.array(z.string().min(1)).optional(),
	reconnect: z
		.object({
			initialDelayMs: z.number().int().positive(),
			jitterRatio: z.number().min(0).max(1),
			maxDelayMs: z.number().int().positive(),
		})
		.optional(),
	replyAsQuote: z.boolean().optional(),
	selfManage: z.boolean().optional(),
	sendIntervalMs: z.number().int().nonnegative().optional(),
	splitMaxChars: z.number().int().positive().optional(),
	wsUrl: z.string().min(1).optional(),
});

export type OneBotPluginConfig = z.infer<typeof oneBotPluginConfigSchema>;

export interface ResolvedOneBotState {
	readonly channel?: OneBotConfig;
	readonly channelId: string;
	/** Changes exactly when the live connection must be replaced. */
	readonly key: string;
	readonly settings: OneBotPluginConfig;
}

const DEFAULT_RECONNECT = {
	initialDelayMs: 1_000,
	jitterRatio: 0.1,
	maxDelayMs: 30_000,
} as const;

const connectionKey = (input: OneBotPluginConfig, mode: "forward" | "reverse"): string =>
	JSON.stringify([
		mode,
		input.wsUrl ?? "",
		input.host ?? "",
		input.port ?? "",
		input.accessToken ?? "",
		input.botAccountId ?? "",
		input.channelId ?? "",
		input.actionTimeoutMs ?? "",
		input.reconnect ?? null,
	]);

/**
 * Normalizes stored/environment config into either "not configured" or a ready-to-use
 * channel configuration. The channel itself validates the WebSocket URL scheme so a bad
 * value surfaces as a failed channel start instead of a settings rejection.
 */
export function resolveOneBotState(input: OneBotPluginConfig): ResolvedOneBotState {
	const channelId = input.channelId ?? ONEBOT_DEFAULT_CHANNEL_ID;
	const mode = input.mode ?? "forward";
	const key = connectionKey(input, mode);
	if (mode === "forward" && input.wsUrl === undefined) {
		return { channelId, key, settings: input };
	}
	const channel: OneBotConfig = {
		botAccountId: input.botAccountId ?? "elaina-server",
		channelId,
		mode,
		reconnect: input.reconnect ?? DEFAULT_RECONNECT,
		...(input.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: input.actionTimeoutMs }),
		...(input.accessToken === undefined ? {} : { accessToken: input.accessToken }),
		...(input.forwardExpand === undefined ? {} : { forwardExpand: input.forwardExpand }),
		...(input.host === undefined ? {} : { host: input.host }),
		...(input.nativeSticker === undefined ? {} : { nativeSticker: input.nativeSticker }),
		...(input.pendingGraceMs === undefined ? {} : { pendingGraceMs: input.pendingGraceMs }),
		...(input.port === undefined ? {} : { port: input.port }),
		...(input.pttToText === undefined ? {} : { pttToText: input.pttToText }),
		...(input.replyAsQuote === undefined ? {} : { replyAsQuote: input.replyAsQuote }),
		...(input.sendIntervalMs === undefined ? {} : { sendIntervalMs: input.sendIntervalMs }),
		...(input.splitMaxChars === undefined ? {} : { splitMaxChars: input.splitMaxChars }),
		...(input.wsUrl === undefined ? {} : { url: input.wsUrl }),
	};
	return { channel, channelId, key, settings: input };
}

export const resolveOneBotChannel = resolveOneBotState;
