import { conversations, modelPolicies } from "@elaina/db";
import { adminBase, type ElainaApiContext } from "./base.ts";
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
} from "../runtime-settings.ts";

type LifecycleModelPolicy = ElainaApiContext["lifecycle"]["routingPolicies"][number];

/** Normalizes the readonly policy list owned by the lifecycle into the mutable contract shape. */
function toContractPolicies(policies: readonly LifecycleModelPolicy[]) {
	return policies.map((policy) => ({
		capability: policy.capability,
		fallbacks:
			policy.fallbacks === undefined
				? undefined
				: policy.fallbacks.map((fallback) => ({
						modelId: fallback.modelId,
						providerId: fallback.providerId,
					})),
		maxOutputTokens: policy.maxOutputTokens,
		primary: { modelId: policy.primary.modelId, providerId: policy.primary.providerId },
		thinking: policy.thinking,
	}));
}

export const adminRouter = {
	chats: {
		createLocal: adminBase.admin.chats.createLocal.handler(async ({ context, input }) =>
			createLocalChat(context.lifecycle, input),
		),
		list: adminBase.admin.chats.list.handler(async ({ context, input }) =>
			listChats(context.lifecycle, input?.status === undefined ? {} : { status: input.status }),
		),
	},
	conversations: {
		list: adminBase.admin.conversations.list.handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(conversations) ?? [];
		}),
	},
	diagnostics: {
		clearLogs: adminBase.admin.diagnostics.clearLogs.handler(async ({ context }) => {
			const cleared = context.lifecycle.logs.clear();
			context.lifecycle.logger.info("log buffer cleared", { cleared });
			return { cleared };
		}),
		logs: adminBase.admin.diagnostics.logs.handler(async ({ context, input }) => {
			const logs = context.lifecycle.logs;
			return {
				capacity: logs.capacity,
				dropped: logs.dropped,
				entries: [
					...logs.list({
						...(input?.afterId === undefined ? {} : { afterId: input.afterId }),
						...(input?.level === undefined ? {} : { level: input.level }),
						...(input?.limit === undefined ? {} : { limit: input.limit }),
					}),
				],
			};
		}),
		status: adminBase.admin.diagnostics.status.handler(async ({ context }) => {
			const lifecycle = context.lifecycle;
			return {
				...(lifecycle.lastProcessingError === undefined
					? {}
					: { lastError: lifecycle.lastProcessingError.message }),
				channels: lifecycle.channels.statuses().map((status) => ({
					configured: status.configured ?? true,
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
				processedMessages: lifecycle.processedMessageCount,
				providerRestartRequired: lifecycle.providerRestartRequired,
				routingPolicies: toContractPolicies(lifecycle.routingPolicies),
				state: lifecycle.state,
				usage: [...lifecycle.modelUsageLedger.records],
				usageTotals: lifecycle.modelUsageLedger.totals,
			};
		}),
	},
	groups: {
		get: adminBase.admin.groups.get.handler(async ({ context, input }) =>
			getGroup(context.lifecycle, input.groupId),
		),
		list: adminBase.admin.groups.list.handler(async ({ context }) => listGroups(context.lifecycle)),
	},
	modelPolicies: {
		list: adminBase.admin.modelPolicies.list.handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			return database?.select().from(modelPolicies) ?? [];
		}),
		set: adminBase.admin.modelPolicies.set.handler(async ({ context, input }) => {
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
			return toContractPolicies(context.lifecycle.routingPolicies);
		}),
	},
	plugins: {
		list: adminBase.admin.plugins.list.handler(async ({ context }) => [
			...(await context.lifecycle.pluginHost.list()),
		]),
		rpc: adminBase.admin.plugins.rpc.handler(async ({ context, input }) => {
			return context.lifecycle.pluginHost.invokeRpc(input.method, input.input);
		}),
		updateConfig: adminBase.admin.plugins.updateConfig.handler(async ({ context, input }) => {
			await context.lifecycle.updatePluginConfig(input.pluginId, input.config);
			const view = await context.lifecycle.pluginConfigView(input.pluginId);
			return { config: view.config, secretsSet: [...view.secretsSet] };
		}),
	},
	requests: {
		get: adminBase.admin.requests.get.handler(async ({ context, input }) =>
			getRequest(context.lifecycle, input.requestId),
		),
		list: adminBase.admin.requests.list.handler(async ({ context, input }) =>
			listRequests(context.lifecycle, input?.status === undefined ? {} : { status: input.status }),
		),
		respond: adminBase.admin.requests.respond.handler(async ({ context, input }) =>
			respondToRequest(context.lifecycle, {
				action: input.action,
				requestId: input.requestId,
				...(input.reason === undefined ? {} : { reason: input.reason }),
			}),
		),
	},
	sessions: {
		create: adminBase.admin.sessions.create.handler(async ({ context, input }) =>
			createSession(context.lifecycle, input.chatObjectId, input.title),
		),
		get: adminBase.admin.sessions.get.handler(async ({ context, input }) =>
			getSession(context.lifecycle, input.sessionId),
		),
		messages: adminBase.admin.sessions.messages.handler(async ({ context, input }) =>
			listMessages(context.lifecycle, input.sessionId),
		),
		send: adminBase.admin.sessions.send.handler(async ({ context, input }) => {
			try {
				return await sendMessage(context.lifecycle, input);
			} catch (error) {
				context.lifecycle.logger.child("elaina::server::rpc").error("session message send failed", {
					error: error instanceof Error ? error.message : String(error),
					sessionId: input.sessionId,
					target: input.target,
				});
				throw error;
			}
		}),
		setReceiving: adminBase.admin.sessions.setReceiving.handler(async ({ context, input }) => {
			await setReceivingSession(context.lifecycle, input.sessionId);
			return { ok: true };
		}),
		update: adminBase.admin.sessions.update.handler(async ({ context, input }) => {
			await updateSession(context.lifecycle, input.sessionId, {
				...(input.status === undefined ? {} : { status: input.status }),
				...(input.title === undefined ? {} : { title: input.title }),
			});
			return { ok: true };
		}),
	},
	settings: {
		get: adminBase.admin.settings.get.handler(async ({ context }) => {
			const settings = await readRuntimeSettings(context.lifecycle.domainDatabase);
			return {
				...publicRuntimeSettings(settings),
				plugins: await context.lifecycle.pluginHost.configViews(),
			};
		}),
		update: adminBase.admin.settings.update.handler(async ({ context, input }) => {
			const database = context.lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const settings = await patchRuntimeSettings(database, input);
			await context.lifecycle.applyRuntimeSettings(settings);
			return {
				...publicRuntimeSettings(settings),
				plugins: await context.lifecycle.pluginHost.configViews(),
			};
		}),
	},
	users: {
		get: adminBase.admin.users.get.handler(async ({ context, input }) =>
			getUser(context.lifecycle, input.userId),
		),
		list: adminBase.admin.users.list.handler(async ({ context }) => listUsers(context.lifecycle)),
	},
};
