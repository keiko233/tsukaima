import { ORPCError } from "@orpc/server";
import { MODEL_CAPABILITIES, type PluginModelInfo } from "@tsukaima/sdk";
import { conversations, modelPolicies, type memories } from "@tsukaima/db";
import { adminBase, type TsukaimaApiContext } from "./base.ts";
import { ChatSnapshotBlockError } from "../services/chat-snapshot.ts";
import {
	abortSessionRun,
	compactSessionContext,
	createLocalChat,
	createSession,
	getGroup,
	getRequest,
	getSession,
	getSessionContextStats,
	getSessionMessage,
	getUser,
	listChats,
	listGroups,
	listMessagePage,
	MessageCursorError,
	listRequests,
	listRunSteps,
	listUsers,
	resetSessionContext,
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
import { readGitIdentity, writeGitIdentity } from "../services/git-identity.ts";
import { GitHubCliError } from "../services/github-cli-service.ts";
import { PromptConflictError } from "../services/prompts.ts";

async function updatePrompt<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof PromptConflictError) {
			throw new ORPCError("CONFLICT", { message: error.message });
		}
		throw error;
	}
}

type MemoryDbRow = typeof memories.$inferSelect;

/** GitHub CLI failures are actionable operator problems, not opaque 500s. */
function asGitHubRpcError(error: unknown): unknown {
	return error instanceof GitHubCliError
		? new ORPCError("BAD_REQUEST", { message: error.message })
		: error;
}

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

/** Block reports become a 409 with every refusal reason attached. */
function asSnapshotRpcError(error: unknown): unknown {
	if (error instanceof ChatSnapshotBlockError) {
		return new ORPCError("CONFLICT", {
			data: { blocked: error.blocks },
			message: error.message,
		});
	}
	return error;
}

async function runSnapshot<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw asSnapshotRpcError(error);
	}
}

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

function toCatalogEntry(model: PluginModelInfo) {
	return {
		capabilities: [...model.capabilities],
		...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
		id: model.id,
		...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
		...(model.name === undefined ? {} : { name: model.name }),
		...(model.pluginId === undefined ? {} : { pluginId: model.pluginId }),
		providerId: model.providerId,
		...(model.reasoning === undefined
			? {}
			: {
					reasoning: {
						...(model.reasoning.default === undefined ? {} : { default: model.reasoning.default }),
						levels: [...model.reasoning.levels],
					},
				}),
	};
}

/**
 * Settings plus the models plugins advertise for the sidechat classifier. The catalog is omitted
 * when no provider declares one, which keeps the contract small and lets the WebUI explain that
 * the active model will be used instead.
 *
 * The stored setting is a bare model id, so duplicate ids collapse to one entry and the active
 * provider wins the tie — the same preference the classifier applies at run time.
 */
async function settingsView(context: TsukaimaApiContext) {
	const settings = await readRuntimeSettings(context.lifecycle.domainDatabase);
	const activeProviderId = context.lifecycle.activeModelProviderId;
	const catalog = await context.lifecycle.pluginHost.listModels({
		capability: MODEL_CAPABILITIES.sidechat,
	});
	const byId = new Map<string, (typeof catalog)[number]>();
	for (const model of catalog) {
		const existing = byId.get(model.id);
		if (existing === undefined || model.providerId === activeProviderId) byId.set(model.id, model);
	}
	const models = [...byId.values()].map(toCatalogEntry);
	const availableModels =
		activeProviderId === undefined
			? []
			: (await context.lifecycle.pluginHost.listModels({ providerId: activeProviderId })).map(
					toCatalogEntry,
				);
	return {
		...publicRuntimeSettings(settings),
		...(availableModels.length === 0 ? {} : { availableModels }),
		...(models.length === 0 ? {} : { models }),
		plugins: await context.lifecycle.pluginHost.configViews(),
	};
}

export const adminRouter = {
	chatSnapshot: {
		apply: adminBase.admin.chatSnapshot.apply.handler(async ({ context, input }) =>
			runSnapshot(() => context.lifecycle.chatSnapshots.apply(input.id)),
		),
		create: adminBase.admin.chatSnapshot.create.handler(async ({ context, input }) =>
			runSnapshot(() =>
				context.lifecycle.chatSnapshots.create({
					conversationId: input.conversationId,
					...(input.title === undefined ? {} : { title: input.title }),
				}),
			),
		),
		get: adminBase.admin.chatSnapshot.get.handler(
			async ({ context, input }) => (await context.lifecycle.chatSnapshots.get(input.id)) ?? null,
		),
		list: adminBase.admin.chatSnapshot.list.handler(async ({ context, input }) =>
			context.lifecycle.chatSnapshots.list(input ?? {}),
		),
		preview: adminBase.admin.chatSnapshot.preview.handler(async ({ context, input }) =>
			runSnapshot(() => context.lifecycle.chatSnapshots.preview(input.id)),
		),
	},
	chats: {
		createLocal: adminBase.admin.chats.createLocal.handler(async ({ context, input }) =>
			createLocalChat(context.lifecycle, input),
		),
		list: adminBase.admin.chats.list.handler(async ({ context, input }) => {
			try {
				return await listChats(
					context.lifecycle,
					input?.status === undefined ? {} : { status: input.status },
				);
			} catch (error) {
				// oRPC turns procedure errors into a bare 500 response, so without this log a failing
				// chats list leaves no trace of the underlying cause in the server log.
				context.lifecycle.logger.error("chats list failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}),
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
			const cache = lifecycle.liveRuns.stats();
			return {
				...(lifecycle.lastProcessingError === undefined
					? {}
					: { lastError: lifecycle.lastProcessingError.message }),
				cache: {
					deletes: cache.deletes,
					gets: cache.gets,
					hits: cache.hits,
					misses: cache.misses,
					publishes: cache.publishes,
					sets: cache.sets,
					streamAppends: cache.streamAppends,
				},
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
		updatePrompt: adminBase.admin.personas.updatePrompt.handler(({ context, input }) =>
			updatePrompt(async () => {
				const persona = context.lifecycle.conversationPolicy.updatePersonaPrompt(input, "user");
				await context.lifecycle.prompts.auditPersona(persona, "user");
				return persona;
			}),
		),
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
	prompts: {
		list: adminBase.admin.prompts.list.handler(({ context }) => context.lifecycle.prompts.list()),
		update: adminBase.admin.prompts.update.handler(({ context, input }) =>
			updatePrompt(() => context.lifecycle.prompts.update(input, "user")),
		),
		agentAccess: adminBase.admin.prompts.agentAccess.handler(({ context }) =>
			context.lifecycle.prompts.agentAccess(),
		),
		setAgentAccess: adminBase.admin.prompts.setAgentAccess.handler(({ context, input }) =>
			context.lifecycle.prompts.setAgentAccess(input),
		),
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
		overrideAll: adminBase.admin.policies.overrideAll.handler(async ({ context, input }) => {
			const result = await context.lifecycle.conversationPolicy.overrideAll({
				policy: input.policy,
			});
			await context.lifecycle.writeAudit({
				action: "policy.override-all",
				payload: {
					updated: result.updated,
					version: result.view.policy.version,
				},
				result: "ok",
				...(result.view.source.revisionId === null
					? {}
					: { targetId: result.view.source.revisionId }),
				targetKind: "policy",
			});
			return result;
		}),
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
	schedules: {
		cancel: adminBase.admin.schedules.cancel.handler(async ({ context, input }) =>
			context.lifecycle.schedules.cancel(input.scheduleId),
		),
		create: adminBase.admin.schedules.create.handler(async ({ context, input }) =>
			context.lifecycle.schedules.create({
				...input,
				ownerId: "webui-admin",
				ownerKind: "user",
				source: "webui",
			}),
		),
		get: adminBase.admin.schedules.get.handler(async ({ context, input }) =>
			context.lifecycle.schedules.get(input.scheduleId),
		),
		list: adminBase.admin.schedules.list.handler(async ({ context, input }) => ({
			schedules: await context.lifecycle.schedules.list({
				...(input.limit === undefined ? {} : { limit: input.limit }),
				...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
				...(input.status === undefined ? {} : { status: input.status }),
			}),
		})),
		occurrences: adminBase.admin.schedules.occurrences.handler(async ({ context, input }) => ({
			occurrences: await context.lifecycle.schedules.occurrences(input.scheduleId, input.limit),
		})),
		pause: adminBase.admin.schedules.pause.handler(async ({ context, input }) =>
			context.lifecycle.schedules.pause(input.scheduleId),
		),
		preview: adminBase.admin.schedules.preview.handler(async ({ context, input }) => ({
			nextRuns: context.lifecycle.schedules.preview({
				...(input.count === undefined ? {} : { count: input.count }),
				recurrence: input.recurrence,
				timeZone: input.timeZone,
			}),
		})),
		resume: adminBase.admin.schedules.resume.handler(async ({ context, input }) =>
			context.lifecycle.schedules.resume(input.scheduleId),
		),
		runNow: adminBase.admin.schedules.runNow.handler(async ({ context, input }) =>
			context.lifecycle.schedules.runNow(input.scheduleId),
		),
		summary: adminBase.admin.schedules.summary.handler(async ({ context, input }) =>
			context.lifecycle.schedules.summary(
				input.sessionIds === undefined ? {} : { sessionIds: input.sessionIds },
			),
		),
		update: adminBase.admin.schedules.update.handler(async ({ context, input }) =>
			context.lifecycle.schedules.update(input),
		),
	},
	sessions: {
		abort: adminBase.admin.sessions.abort.handler(async ({ context, input }) =>
			abortSessionRun(context.lifecycle, input.sessionId),
		),
		compact: adminBase.admin.sessions.compact.handler(async ({ context, input }) =>
			compactSessionContext(context.lifecycle, {
				...(input.instructions === undefined ? {} : { instructions: input.instructions }),
				sessionId: input.sessionId,
			}),
		),
		contextStats: adminBase.admin.sessions.contextStats.handler(async ({ context, input }) =>
			getSessionContextStats(context.lifecycle, input.sessionId),
		),
		create: adminBase.admin.sessions.create.handler(async ({ context, input }) =>
			createSession(context.lifecycle, input.chatObjectId, input.title),
		),
		get: adminBase.admin.sessions.get.handler(async ({ context, input }) =>
			getSession(context.lifecycle, input.sessionId),
		),
		message: adminBase.admin.sessions.message.handler(async ({ context, input }) =>
			getSessionMessage(context.lifecycle, input),
		),
		messages: adminBase.admin.sessions.messages.handler(async ({ context, input }) => {
			try {
				return await listMessagePage(context.lifecycle, input);
			} catch (error) {
				if (error instanceof MessageCursorError) {
					throw new ORPCError("INVALID_INPUT", {
						message: error.message,
						status: 400,
					});
				}
				throw error;
			}
		}),
		resetContext: adminBase.admin.sessions.resetContext.handler(async ({ context, input }) => {
			await resetSessionContext(context.lifecycle, {
				...(input.handoff === undefined ? {} : { handoff: input.handoff }),
				sessionId: input.sessionId,
			});
			return { ok: true };
		}),
		runSteps: adminBase.admin.sessions.runSteps.handler(async ({ context, input }) =>
			listRunSteps(context.lifecycle, input),
		),
		search: adminBase.admin.sessions.search.handler(async ({ context, input }) =>
			context.lifecycle.sessionMessaging.searchSessions(input?.query ?? "", input?.limit ?? 10),
		),
		send: adminBase.admin.sessions.send.handler(async ({ context, input }) => {
			try {
				return await sendMessage(context.lifecycle, {
					...(input.mode === undefined ? {} : { mode: input.mode }),
					...(input.references === undefined ? {} : { references: input.references }),
					sessionId: input.sessionId,
					target: input.target,
					text: input.text,
				});
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
	workspace: {
		create: adminBase.admin.workspace.create.handler(async ({ context, input }) => {
			const result = await context.lifecycle.workspace.create({
				...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
				...(input.goal === undefined ? {} : { goal: input.goal }),
				...(input.model === undefined ? {} : { model: input.model }),
				...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
				...(input.tags === undefined ? {} : { tags: input.tags }),
				...(input.thinking === undefined ? {} : { thinking: input.thinking }),
				...(input.workspaceKind === undefined ? {} : { workspaceKind: input.workspaceKind }),
				requestedBy: "webui-admin",
			});
			return result;
		}),
		get: adminBase.admin.workspace.get.handler(async ({ context, input }) =>
			context.lifecycle.workspace.get(input.sessionId),
		),
		git: adminBase.admin.workspace.git.handler(async ({ context, input }) =>
			context.lifecycle.workspace.git(input.sessionId, input.path),
		),
		list: adminBase.admin.workspace.list.handler(async ({ context, input }) => {
			const includeArchived = input?.includeArchived;
			return context.lifecycle.workspace.list(
				includeArchived === undefined ? {} : { includeArchived },
			);
		}),
		todos: adminBase.admin.workspace.todos.handler(async ({ context, input }) =>
			context.lifecycle.workspace.listTodos(input.sessionId),
		),
		update: adminBase.admin.workspace.update.handler(async ({ context, input }) =>
			context.lifecycle.workspace.update({
				sessionId: input.sessionId,
				...(input.tags === undefined ? {} : { tags: input.tags }),
				...(input.title === undefined ? {} : { title: input.title }),
			}),
		),
	},
	runtime: {
		cancelRestart: adminBase.admin.runtime.cancelRestart.handler(async ({ context }) => {
			const cancelled = await context.lifecycle.cancelRestart("cancelled from WebUI");
			return {
				cancelled,
				restart: await context.lifecycle.restartStatus(),
			};
		}),
		restartStatus: adminBase.admin.runtime.restartStatus.handler(async ({ context }) =>
			context.lifecycle.restartStatus(),
		),
		scheduleRestart: adminBase.admin.runtime.scheduleRestart.handler(async ({ context, input }) =>
			context.lifecycle.scheduleRestart({
				...(input.delaySeconds === undefined ? {} : { delaySeconds: input.delaySeconds }),
				...(input.mode === undefined ? {} : { mode: input.mode }),
				...(input.reason === undefined ? {} : { reason: input.reason }),
				requestedBy: "webui-admin",
			}),
		),
	},
	repository: {
		fetch: adminBase.admin.repository.fetch.handler(async ({ context, input }) => {
			const token = await context.lifecycle.github.gitCredential();
			return await context.lifecycle.repository.fetch({
				...(input.remote === undefined ? {} : { remote: input.remote }),
				...(token === undefined ? {} : { token }),
			});
		}),
		identity: adminBase.admin.repository.identity.handler(async ({ context }) => {
			const database = context.lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			return await readGitIdentity(database);
		}),
		pull: adminBase.admin.repository.pull.handler(async ({ context, input }) => {
			const token = await context.lifecycle.github.gitCredential();
			return await context.lifecycle.repository.pull({
				...(input.remote === undefined ? {} : { remote: input.remote }),
				...(token === undefined ? {} : { token }),
			});
		}),
		push: adminBase.admin.repository.push.handler(async ({ context, input }) => {
			// Optional: an ssh remote or an operator credential helper still works without one.
			const token = await context.lifecycle.github.gitCredential();
			return await context.lifecycle.repository.push({
				confirm: input.confirm,
				...(input.branch === undefined ? {} : { branch: input.branch }),
				...(input.remote === undefined ? {} : { remote: input.remote }),
				...(token === undefined ? {} : { token }),
			});
		}),
		status: adminBase.admin.repository.status.handler(async ({ context }) =>
			context.lifecycle.repository.status(),
		),
		updateIdentity: adminBase.admin.repository.updateIdentity.handler(
			async ({ context, input }) => {
				const database = context.lifecycle.domainDatabase;
				if (database === undefined) throw new Error("Database not ready");
				return await writeGitIdentity(database, input);
			},
		),
	},
	github: {
		issues: adminBase.admin.github.issues.handler(async ({ context }) =>
			context.lifecycle.github.issues(),
		),
		loginPoll: adminBase.admin.github.loginPoll.handler(async ({ context }) => {
			try {
				return await context.lifecycle.githubAuth.pollLogin();
			} catch (error) {
				throw asGitHubRpcError(error);
			}
		}),
		loginStart: adminBase.admin.github.loginStart.handler(async ({ context }) => {
			try {
				return await context.lifecycle.githubAuth.startLogin();
			} catch (error) {
				throw asGitHubRpcError(error);
			}
		}),
		logout: adminBase.admin.github.logout.handler(async ({ context }) => {
			try {
				return await context.lifecycle.githubAuth.logout();
			} catch (error) {
				throw asGitHubRpcError(error);
			}
		}),
		pulls: adminBase.admin.github.pulls.handler(async ({ context }) =>
			context.lifecycle.github.pulls(),
		),
		runs: adminBase.admin.github.runs.handler(async ({ context, input }) =>
			context.lifecycle.github.runs(input.sha === undefined ? {} : { sha: input.sha }),
		),
		status: adminBase.admin.github.status.handler(async ({ context }) =>
			context.lifecycle.githubAuth.status(),
		),
	},
	upgrade: {
		check: adminBase.admin.upgrade.check.handler(async ({ context, input }) =>
			context.lifecycle.upgrades.check(input?.remote === undefined ? {} : { remote: input.remote }),
		),
		finalize: adminBase.admin.upgrade.finalize.handler(async ({ context, input }) =>
			context.lifecycle.upgrades.finalize({
				...(input?.upgradeId === undefined ? {} : { upgradeId: input.upgradeId }),
				requestedBy: "webui-admin",
			}),
		),
		history: adminBase.admin.upgrade.history.handler(async ({ context }) => [
			...(await context.lifecycle.upgrades.history()),
		]),
		start: adminBase.admin.upgrade.start.handler(async ({ context, input }) =>
			context.lifecycle.upgrades.start({
				...(input?.autoFinalize === undefined ? {} : { autoFinalize: input.autoFinalize }),
				...(input?.remote === undefined ? {} : { remote: input.remote }),
				requestedBy: "webui-admin",
			}),
		),
		status: adminBase.admin.upgrade.status.handler(async ({ context }) =>
			context.lifecycle.upgrades.status(),
		),
	},
	settings: {
		get: adminBase.admin.settings.get.handler(async ({ context }) => settingsView(context)),
		update: adminBase.admin.settings.update.handler(async ({ context, input }) => {
			const database = context.lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const settings = await patchRuntimeSettings(database, input);
			await context.lifecycle.applyRuntimeSettings(settings);
			return settingsView(context);
		}),
	},
	users: {
		get: adminBase.admin.users.get.handler(async ({ context, input }) =>
			getUser(context.lifecycle, input.userId),
		),
		list: adminBase.admin.users.list.handler(async ({ context }) => listUsers(context.lifecycle)),
	},
};
