import { os } from "@orpc/server";
import { z } from "zod";
import { conversations, modelPolicies, plugins } from "@tsukaima/db";
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
		status: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const lifecycle = context.lifecycle;
			const onebot = lifecycle.onebotDiagnostics;
			return {
				...(lifecycle.lastProcessingError === undefined
					? {}
					: { lastError: lifecycle.lastProcessingError.message }),
				channels:
					onebot === undefined
						? []
						: [
								{
									connected: onebot.connected,
									eventCount: onebot.eventCount,
									id: "onebot",
									kind: "onebot-v11",
									lastErrorClass: onebot.lastErrorClass ?? null,
									reconnectAttempts: onebot.reconnectAttempts,
									state: onebot.state,
								},
							],
				logLevel: lifecycle.logLevel,
				onebotConfigured: lifecycle.onebotConfigured,
				onebotConnected: onebot?.connected ?? false,
				onebotLastErrorClass: onebot?.lastErrorClass ?? null,
				onebotReconnectAttempts: onebot?.reconnectAttempts ?? 0,
				onebotState: onebot?.state ?? "closed",
				onebotRestartRequired: lifecycle.onebotRestartRequired,
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
		list: os.$context<TsukaimaApiContext>().handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(plugins) ?? [];
		}),
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
					console.error(
						JSON.stringify({
							level: "error",
							message: error instanceof Error ? error.message : String(error),
							stack: error instanceof Error ? error.stack : undefined,
							stage: "session-send",
							timestamp: new Date().toISOString(),
						}),
					);
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
			return publicRuntimeSettings(settings);
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
				const settings = await patchRuntimeSettings(database, input);
				await context.lifecycle.applyRuntimeSettings(settings);
				return publicRuntimeSettings(settings);
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
