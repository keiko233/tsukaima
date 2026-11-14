import { conversations, modelPolicies, type memories } from "@tsukaima/db";
import { adminBase, type TsukaimaApiContext } from "./base.ts";
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
	listRunSteps,
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

type MemoryDbRow = typeof memories.$inferSelect;

/** Contract view: SQLite stores `pinned` as 0/1, the wire surface uses a boolean. */
function toMemoryRow(row: MemoryDbRow) {
	return { ...row, pinned: row.pinned === 1 };
}

async function auditMemory(
	context: TsukaimaApiContext,
	action: string,
	memory: { id: string; kind: string; scope: string; status: string },
): Promise<void> {
	await context.lifecycle.writeAudit({
		action,
		actorKind: "user",
		payload: { kind: memory.kind, memoryId: memory.id, scope: memory.scope, status: memory.status },
		result: "ok",
		targetId: memory.id,
		targetKind: "memory",
	});
}

type LifecycleModelPolicy = TsukaimaApiContext["lifecycle"]["routingPolicies"][number];

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
					...(status.mode === undefined ? {} : { mode: status.mode }),
					...(status.origin === undefined ? {} : { origin: status.origin }),
					reconnectAttempts: status.reconnectAttempts ?? 0,
					...(status.remoteAddress === undefined ? {} : { remoteAddress: status.remoteAddress }),
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
	memory: {
		approve: adminBase.admin.memory.approve.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.approve(input.id);
			await auditMemory(context, "memory.approve", memory);
			return toMemoryRow(memory);
		}),
		compact: adminBase.admin.memory.compact.handler(async ({ context, input }) => {
			const result = await context.lifecycle.memory.compactSession({
				conversationId: input.conversationId,
				...(input.throughMessageId === undefined
					? {}
					: { throughMessageId: input.throughMessageId }),
			});
			if (result.memory !== undefined) {
				await auditMemory(context, "memory.compact", result.memory);
			}
			return {
				created: result.created,
				memory: result.memory === undefined ? null : toMemoryRow(result.memory),
			};
		}),
		create: adminBase.admin.memory.create.handler(async ({ context, input }) => {
			const result = await context.lifecycle.memory.create({
				confidence: input.confidence,
				content: input.content,
				conversationId: input.conversationId,
				createdBy: input.createdBy,
				dedupeKey: input.dedupeKey,
				evidenceJson: input.evidenceJson,
				expiresAt: input.expiresAt,
				importance: input.importance,
				kind: input.kind,
				pinned: input.pinned,
				projectId: input.projectId,
				scope: input.scope,
				status: input.status,
				subjectUserId: input.subjectUserId,
				summary: input.summary,
				supersedes: input.supersedes,
				visibility: input.visibility,
			});
			await auditMemory(context, "memory.create", result.memory);
			return toMemoryRow(result.memory);
		}),
		expire: adminBase.admin.memory.expire.handler(async ({ context }) => {
			const expired = await context.lifecycle.memory.expireDue();
			await context.lifecycle.writeAudit({
				action: "memory.expire",
				actorKind: "user",
				payload: { expired },
				result: "ok",
				targetKind: "memory",
			});
			return { expired };
		}),
		get: adminBase.admin.memory.get.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.get(input.id);
			return memory === undefined ? null : toMemoryRow(memory);
		}),
		list: adminBase.admin.memory.list.handler(async ({ context, input }) => {
			const rows = await context.lifecycle.memory.list(input ?? {});
			return rows.map(toMemoryRow);
		}),
		pin: adminBase.admin.memory.pin.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.pin(input.id, input.pinned);
			await auditMemory(context, input.pinned ? "memory.pin" : "memory.unpin", memory);
			return toMemoryRow(memory);
		}),
		reject: adminBase.admin.memory.reject.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.reject(input.id);
			await auditMemory(context, "memory.reject", memory);
			return toMemoryRow(memory);
		}),
		revoke: adminBase.admin.memory.revoke.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.revoke(input.id);
			await auditMemory(context, "memory.revoke", memory);
			return toMemoryRow(memory);
		}),
		search: adminBase.admin.memory.search.handler(async ({ context, input }) => {
			const ranked = await context.lifecycle.memory.recordSearch(
				input.conversationId,
				input.query,
				input.limit ?? 10,
			);
			return ranked.map((entry) => ({
				lexical: entry.lexical,
				memory: toMemoryRow(entry.memory),
				recency: entry.recency,
				score: entry.score,
				vector: entry.vector,
			}));
		}),
		update: adminBase.admin.memory.update.handler(async ({ context, input }) => {
			const memory = await context.lifecycle.memory.update({
				confidence: input.confidence,
				content: input.content,
				dedupeKey: input.dedupeKey,
				expiresAt: input.expiresAt,
				id: input.id,
				importance: input.importance,
				kind: input.kind,
				pinned: input.pinned,
				status: input.status,
				summary: input.summary,
				supersedes: input.supersedes,
				visibility: input.visibility,
			});
			await auditMemory(context, "memory.update", memory);
			return toMemoryRow(memory);
		}),
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
	personas: {
		bindPersona: adminBase.admin.personas.bindPersona.handler(async ({ context, input }) => {
			const binding = await context.lifecycle.conversationPolicy.bindPersona({
				personaId: input.personaId,
				scope: input.scope,
				...(input.chatKind === undefined ? {} : { chatKind: input.chatKind }),
				...(input.chatObjectId === undefined ? {} : { chatObjectId: input.chatObjectId }),
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			});
			await context.lifecycle.writeAudit({
				action: "persona.bind",
				payload: { scope: input.scope },
				result: "ok",
				targetId: binding.id,
				targetKind: "persona-binding",
			});
			return binding;
		}),
		bindings: adminBase.admin.personas.bindings.handler(async ({ context }) =>
			context.lifecycle.conversationPolicy.listBindings(),
		),
		list: adminBase.admin.personas.list.handler(async ({ context }) =>
			context.lifecycle.conversationPolicy.listPersonas(),
		),
		upsert: adminBase.admin.personas.upsert.handler(async ({ context, input }) => {
			const persona = await context.lifecycle.conversationPolicy.upsertPersona({
				name: input.name,
				prompt: input.prompt,
				summary: input.summary,
				...(input.id === undefined ? {} : { id: input.id }),
				...(input.isActive === undefined ? {} : { isActive: input.isActive }),
				...(input.selfAliases === undefined ? {} : { selfAliases: input.selfAliases }),
				...(input.version === undefined ? {} : { version: input.version }),
			});
			await context.lifecycle.writeAudit({
				action: "persona.upsert",
				payload: { version: persona.version },
				result: "ok",
				targetId: persona.id,
				targetKind: "persona",
			});
			return persona;
		}),
	},
	plugins: {
		downgrade: adminBase.admin.plugins.downgrade.handler(async ({ context, input }) =>
			context.lifecycle.pluginHost.downgrade(input.pluginId, input.manifest),
		),
		install: adminBase.admin.plugins.install.handler(async ({ context, input }) =>
			context.lifecycle.pluginHost.install(input.manifest, {
				...(input.config === undefined ? {} : { config: input.config }),
				...(input.enabled === undefined ? {} : { enabled: input.enabled }),
				...(input.grantedPermissions === undefined
					? {}
					: { grantedPermissions: input.grantedPermissions }),
				...(input.runMode === undefined ? {} : { runMode: input.runMode }),
			}),
		),
		list: adminBase.admin.plugins.list.handler(async ({ context }) => [
			...(await context.lifecycle.pluginHost.list()),
		]),
		reload: adminBase.admin.plugins.reload.handler(async ({ context, input }) =>
			context.lifecycle.pluginHost.reload(input.pluginId),
		),
		rpc: adminBase.admin.plugins.rpc.handler(async ({ context, input }) => {
			return context.lifecycle.pluginHost.invokeRpc(input.method, input.input, input.pluginId);
		}),
		setEnabled: adminBase.admin.plugins.setEnabled.handler(async ({ context, input }) => {
			await context.lifecycle.setPluginEnabled(input.pluginId, input.enabled);
			const rows = await context.lifecycle.pluginHost.list();
			const row = rows.find((plugin) => plugin.id === input.pluginId);
			if (row === undefined) throw new Error(`Unknown plugin ${input.pluginId}`);
			return row;
		}),
		uninstall: adminBase.admin.plugins.uninstall.handler(async ({ context, input }) => ({
			pluginId: input.pluginId,
			removed: await context.lifecycle.pluginHost.uninstall(
				input.pluginId,
				input.retainData === undefined ? {} : { retainData: input.retainData },
			),
		})),
		updateConfig: adminBase.admin.plugins.updateConfig.handler(async ({ context, input }) => {
			await context.lifecycle.updatePluginConfig(input.pluginId, input.config);
			const view = await context.lifecycle.pluginConfigView(input.pluginId);
			return { config: view.config, secretsSet: [...view.secretsSet] };
		}),
		upgrade: adminBase.admin.plugins.upgrade.handler(async ({ context, input }) =>
			context.lifecycle.pluginHost.upgrade(input.pluginId, input.manifest, {
				...(input.config === undefined ? {} : { config: input.config }),
				...(input.grantedPermissions === undefined
					? {}
					: { grantedPermissions: input.grantedPermissions }),
			}),
		),
	},
	policies: {
		get: adminBase.admin.policies.get.handler(async ({ context, input }) =>
			context.lifecycle.conversationPolicy.view({
				...(input?.chatObjectId === undefined ? {} : { chatObjectId: input.chatObjectId }),
				...(input?.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			}),
		),
		history: adminBase.admin.policies.history.handler(async ({ context, input }) =>
			context.lifecycle.conversationPolicy.history({
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
				scope: input.scope,
			}),
		),
		update: adminBase.admin.policies.update.handler(async ({ context, input }) => {
			const view = await context.lifecycle.conversationPolicy.update({
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
				policy: input.policy,
				scope: input.scope,
			});
			await context.lifecycle.writeAudit({
				action: "policy.update",
				payload: {
					conversationId: input.conversationId,
					scope: input.scope,
					version: view.policy.version,
				},
				result: "ok",
				...(view.source.revisionId === null ? {} : { targetId: view.source.revisionId }),
				targetKind: "policy",
			});
			return view;
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
		runSteps: adminBase.admin.sessions.runSteps.handler(async ({ context, input }) =>
			listRunSteps(context.lifecycle, input),
		),
		send: adminBase.admin.sessions.send.handler(async ({ context, input }) => {
			try {
				return await sendMessage(context.lifecycle, input);
			} catch (error) {
				context.lifecycle.logger.child("tsukaima::server::rpc").error("session message send failed", {
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
