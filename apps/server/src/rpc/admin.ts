import { os } from "@orpc/server";
import { z } from "zod";
import { conversations, modelPolicies } from "@tsukaima/db";
import type { ChannelDiagnostics } from "@tsukaima/sdk";
import type { TsukaimaApiContext } from "./health.ts";
import {
	createLocalChat,
	createSession,
	getGroup,
	getRequest,
	getSession,
	getUser,
	listChats,
	listGroups,
	listMessages,
	listRequests,
	listUsers,
	respondToRequest,
	sendMessage,
	setReceivingSession,
	updateSession,
} from "../services/webui.ts";
import {
	patchRuntimeSettings,
	publicRuntimeSettings,
	readRuntimeSettings,
	runtimeSettingsPatchSchema,
} from "../runtime-settings.ts";
import { listRemoteModels, remoteModelsInputSchema } from "../remote-models.ts";
import { ONEBOT_DEFAULT_CHANNEL_ID, ONEBOT_PLUGIN_ID } from "../plugins/builtin.ts";

export const adminRouter = {
	chats: {
		createLocal: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					sessionTitle: z.string().trim().min(1).max(120),
					title: z.string().trim().min(1).max(120),
				}),
			)
			.handler(async ({ context, input }) => createLocalChat(context.lifecycle, input)),
		list: os
			.$context<TsukaimaApiContext>()
			.input(
				z
					.object({
						status: z.enum(["active", "archived", "all"]).optional(),
					})
					.optional(),
			)
			.handler(async ({ context, input }) =>
				listChats(context.lifecycle, input?.status === undefined ? {} : { status: input.status }),
			),
	},
	conversations: {
		list: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(conversations) ?? [];
		}),
	},
	diagnostics: {
		clearLogs: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const cleared = context.lifecycle.logs.clear();
			context.lifecycle.logger.info("log buffer cleared", { cleared });
			return { cleared };
		}),
		logs: os
			.$context<TsukaimaApiContext>()
			.input(
				z
					.object({
						afterId: z.number().int().nonnegative().optional(),
						level: z.enum(["debug", "info", "warn", "error"]).optional(),
						limit: z.number().int().positive().max(10_000).optional(),
					})
					.optional(),
			)
			.handler(async ({ context, input }) => {
				const logs = context.lifecycle.logs;
				return {
					capacity: logs.capacity,
					dropped: logs.dropped,
					entries: logs.list({
						...(input?.afterId === undefined ? {} : { afterId: input.afterId }),
						...(input?.level === undefined ? {} : { level: input.level }),
						...(input?.limit === undefined ? {} : { limit: input.limit }),
					}),
				};
			}),
		status: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const lifecycle = context.lifecycle;
			const onebot = await oneBotChannelDiagnostics(context);
			return {
				...(lifecycle.lastProcessingError === undefined
					? {}
					: { lastError: lifecycle.lastProcessingError.message }),
				channels: lifecycle.channels.statuses().map((status) => ({
					connected: status.connected,
					eventCount: status.eventCount ?? 0,
					id: status.id,
					kind: status.kind,
					lastErrorClass: status.lastErrorClass ?? null,
					reconnectAttempts: status.reconnectAttempts ?? 0,
					restartRequired: status.restartRequired ?? false,
					state: status.state,
				})),
				logLevel: lifecycle.logLevel,
				onebotConfigured: onebot?.configured ?? false,
				onebotConnected: onebot?.connected ?? false,
				onebotLastErrorClass: onebot?.lastErrorClass ?? null,
				onebotReconnectAttempts: onebot?.reconnectAttempts ?? 0,
				onebotState: onebot?.state ?? "closed",
				onebotRestartRequired: onebot?.restartRequired ?? false,
				processedMessages: lifecycle.processedMessageCount,
				providerRestartRequired: lifecycle.providerRestartRequired,
				routingPolicies: lifecycle.routingPolicies,
				state: lifecycle.state,
				usage: lifecycle.modelUsageLedger.records,
				usageTotals: lifecycle.modelUsageLedger.totals,
			};
		}),
	},
	groups: {
		get: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ groupId: z.string().min(1) }))
			.handler(async ({ context, input }) => getGroup(context.lifecycle, input.groupId)),
		list: os
			.$context<TsukaimaApiContext>()
			.handler(async ({ context }) => listGroups(context.lifecycle)),
	},
	modelPolicies: {
		list: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(modelPolicies) ?? [];
		}),
		set: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					capability: z.string().min(1),
					maxOutputTokens: z.number().int().positive().optional(),
					primaryModel: z.string().min(1),
					primaryProvider: z.string().min(1),
				}),
			)
			.handler(async ({ context, input }) => {
				const database = context.lifecycle.domainDatabase;
				if (database === undefined) throw new Error("Database not ready");
				await database
					.insert(modelPolicies)
					.values({
						capability: input.capability,
						fallbacksJson: "[]",
						id: input.capability,
						primaryModel: input.primaryModel,
						primaryProvider: input.primaryProvider,
					})
					.onConflictDoUpdate({
						target: modelPolicies.capability,
						set: {
							primaryModel: input.primaryModel,
							primaryProvider: input.primaryProvider,
						},
					});
				context.lifecycle.routingPolicies = [
					...context.lifecycle.routingPolicies.filter(
						(policy) => policy.capability !== input.capability,
					),
					{
						capability: input.capability,
						primary: {
							modelId: input.primaryModel,
							providerId: input.primaryProvider,
						},
					},
				];
				return context.lifecycle.routingPolicies;
			}),
	},
	plugins: {
		list: os
			.$context<TsukaimaApiContext>()
			.handler(async ({ context }) => context.lifecycle.pluginHost.list()),
	},
	requests: {
		get: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ requestId: z.string().min(1) }))
			.handler(async ({ context, input }) => getRequest(context.lifecycle, input.requestId)),
		list: os
			.$context<TsukaimaApiContext>()
			.input(
				z
					.object({
						status: z.enum(["all", "pending", "processed"]).optional(),
					})
					.optional(),
			)
			.handler(async ({ context, input }) =>
				listRequests(
					context.lifecycle,
					input?.status === undefined ? {} : { status: input.status },
				),
			),
		respond: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					action: z.enum(["approve", "reject"]),
					reason: z.string().trim().max(300).optional(),
					requestId: z.string().min(1),
				}),
			)
			.handler(async ({ context, input }) =>
				respondToRequest(context.lifecycle, {
					action: input.action,
					requestId: input.requestId,
					...(input.reason === undefined ? {} : { reason: input.reason }),
				}),
			),
	},
	sessions: {
		create: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					chatObjectId: z.string().min(1),
					title: z.string().trim().min(1).max(120),
				}),
			)
			.handler(async ({ context, input }) =>
				createSession(context.lifecycle, input.chatObjectId, input.title),
			),
		get: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ sessionId: z.string().min(1) }))
			.handler(async ({ context, input }) => getSession(context.lifecycle, input.sessionId)),
		messages: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ sessionId: z.string().min(1) }))
			.handler(async ({ context, input }) => listMessages(context.lifecycle, input.sessionId)),
		send: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					sessionId: z.string().min(1),
					target: z.enum(["channel", "tsukaima"]),
					text: z.string().trim().min(1).max(8_000),
				}),
			)
			.handler(async ({ context, input }) => {
				try {
					return await sendMessage(context.lifecycle, input);
				} catch (error) {
					context.lifecycle.logger
						.child("tsukaima::server::rpc")
						.error("session message send failed", {
							error: error instanceof Error ? error.message : String(error),
							sessionId: input.sessionId,
							target: input.target,
						});
					throw error;
				}
			}),
		setReceiving: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ sessionId: z.string().min(1) }))
			.handler(async ({ context, input }) => {
				await setReceivingSession(context.lifecycle, input.sessionId);
				return { ok: true };
			}),
		update: os
			.$context<TsukaimaApiContext>()
			.input(
				z.object({
					sessionId: z.string().min(1),
					status: z.enum(["active", "archived"]).optional(),
					title: z.string().trim().min(1).max(120).optional(),
				}),
			)
			.handler(async ({ context, input }) => {
				await updateSession(context.lifecycle, input.sessionId, {
					...(input.status === undefined ? {} : { status: input.status }),
					...(input.title === undefined ? {} : { title: input.title }),
				});
				return { ok: true };
			}),
	},
	settings: {
		get: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const settings = await readRuntimeSettings(context.lifecycle.domainDatabase);
			const onebot = await context.lifecycle.pluginConfigView(ONEBOT_PLUGIN_ID);
			return {
				...publicRuntimeSettings(settings),
				onebotAccessTokenSet: onebot.secretsSet.includes("accessToken"),
				...(typeof onebot.config.wsUrl === "string" ? { onebotWsUrl: onebot.config.wsUrl } : {}),
			};
		}),
		models: os
			.$context<TsukaimaApiContext>()
			.input(remoteModelsInputSchema)
			.handler(async ({ context, input }) => {
				const settings = await readRuntimeSettings(context.lifecycle.domainDatabase);
				const baseUrl =
					input.baseUrl ?? settings.openAiBaseUrl ?? context.lifecycle.config.openAiBaseUrl;
				const apiKey =
					input.apiKey ?? settings.openAiApiKey ?? context.lifecycle.config.openAiApiKey;
				if (baseUrl === undefined) throw new Error("Model base URL is not configured");
				if (apiKey === undefined) throw new Error("Provider API key is not configured");
				return listRemoteModels({ apiKey, baseUrl });
			}),
		update: os
			.$context<TsukaimaApiContext>()
			.input(runtimeSettingsPatchSchema)
			.handler(async ({ context, input }) => {
				const database = context.lifecycle.domainDatabase;
				if (database === undefined) throw new Error("Database not ready");
				const pluginPatch: Record<string, unknown> = {};
				if (Object.hasOwn(input, "onebotWsUrl")) pluginPatch.wsUrl = input.onebotWsUrl;
				if (Object.hasOwn(input, "onebotAccessToken")) {
					pluginPatch.accessToken = input.onebotAccessToken;
				}
				if (Object.keys(pluginPatch).length > 0) {
					await context.lifecycle.updatePluginConfig(ONEBOT_PLUGIN_ID, pluginPatch);
				}
				const settings = await patchRuntimeSettings(database, input);
				await context.lifecycle.applyRuntimeSettings(settings);
				const onebot = await context.lifecycle.pluginConfigView(ONEBOT_PLUGIN_ID);
				return {
					...publicRuntimeSettings(settings),
					onebotAccessTokenSet: onebot.secretsSet.includes("accessToken"),
					...(typeof onebot.config.wsUrl === "string" ? { onebotWsUrl: onebot.config.wsUrl } : {}),
				};
			}),
	},
	users: {
		get: os
			.$context<TsukaimaApiContext>()
			.input(z.object({ userId: z.string().min(1) }))
			.handler(async ({ context, input }) => getUser(context.lifecycle, input.userId)),
		list: os
			.$context<TsukaimaApiContext>()
			.handler(async ({ context }) => listUsers(context.lifecycle)),
	},
};

/**
 * Legacy WebUI contract: the diagnostics screen still reads `onebot*` fields. The data comes
 * from the channel registry, located through the onebot-napcat plugin's own config.
 */
async function oneBotChannelDiagnostics(
	context: TsukaimaApiContext,
): Promise<ChannelDiagnostics | undefined> {
	const config = await context.lifecycle.pluginConfig(ONEBOT_PLUGIN_ID);
	const channelId =
		typeof config.channelId === "string" ? config.channelId : ONEBOT_DEFAULT_CHANNEL_ID;
	return context.lifecycle.channels.get(channelId)?.diagnostics();
}
