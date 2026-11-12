import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
	ModelPolicyRouter,
	ModelUsageLedger,
	PiDurableConversationHost,
	createFakeModel,
	createOpenAICompatibleModelPort,
	type ModelPort,
	type ModelPolicy,
} from "@tsukaima/core";
import {
	auditLog,
	chatObjects,
	conversations,
	conversationMembers,
	identities,
	messages,
	requests,
	type TsukaimaDatabase,
	migrateDomainDatabase,
	openDomainDatabase,
	users,
	userAliases,
} from "@tsukaima/db";
import { BACKGROUND_CONTEXT, openDurableStorage } from "@tsukaima/durable";
import type { SqliteStorage } from "@tsukaima/durable";
import { OneBotChannel } from "@tsukaima/onebot";
import type { OneBotTransportFactory } from "@tsukaima/onebot";
import { loadConfig, type TsukaimaConfig } from "./config.ts";
import { readRuntimeSettings, type RuntimeSettings } from "./runtime-settings.ts";
import type { ChannelRequest, MessageEnvelope, MessagePart } from "@tsukaima/contracts";

export interface LifecycleOptions {
	readonly onebotTransportFactory?: OneBotTransportFactory;
}

export interface LifecycleState {
	readonly state: "starting" | "degraded" | "ready" | "maintenance" | "failed";
	readonly stage: string;
	readonly startedAtMs: number;
	readonly reason?: string;
}

const messageText = (parts: readonly MessagePart[]): string =>
	parts
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join(" ")
		.trim();

export class TsukaimaLifecycle {
	readonly config: TsukaimaConfig;
	readonly startedAtMs = Date.now();
	private currentState: LifecycleState["state"] = "starting";
	private currentStage = "initialize";
	private failureReason: string | undefined;
	private onebotTransportFactory: OneBotTransportFactory | undefined;

	conversationHost: PiDurableConversationHost | undefined;
	domainDatabase: TsukaimaDatabase | undefined;
	durableStorage: SqliteStorage | undefined;
	lastProcessingError: Error | undefined;
	logLevel: TsukaimaConfig["logLevel"];
	readonly modelUsageLedger = new ModelUsageLedger();
	modelRouter: ModelPolicyRouter | undefined;
	onebotChannel: OneBotChannel | undefined;
	onebotRestartRequired = false;
	processedMessageCount = 0;
	providerRestartRequired = false;
	routingPolicies: readonly ModelPolicy[] = [];
	private readonly ingestingMessages = new Set<string>();
	private readonly requestActions = new Set<string>();
	private activeOneBotSettings: Pick<RuntimeSettings, "onebotAccessToken" | "onebotWsUrl"> = {};
	private activeProviderSettings: Pick<
		RuntimeSettings,
		"openAiApiKey" | "openAiBaseUrl" | "openAiModelId"
	> = {};

	constructor(config: TsukaimaConfig, options?: LifecycleOptions) {
		this.config = config;
		this.logLevel = config.logLevel;
		if (options?.onebotTransportFactory !== undefined) {
			this.onebotTransportFactory = options.onebotTransportFactory;
		}
	}

	get state(): LifecycleState {
		return {
			stage: this.currentStage,
			startedAtMs: this.startedAtMs,
			state: this.currentState,
			...(this.failureReason ? { reason: this.failureReason } : {}),
		};
	}

	get ready(): boolean {
		return this.currentState === "ready" || this.currentState === "degraded";
	}

	private transition(stage: string, state: LifecycleState["state"] = "starting"): void {
		this.currentStage = stage;
		this.currentState = state;
		this.log("info", stage);
	}

	private log(level: TsukaimaConfig["logLevel"], message?: string): void {
		const priority = { debug: 0, error: 3, info: 1, warn: 2 } as const;
		if (priority[level] < priority[this.logLevel]) return;
		const payload = {
			level,
			message: message ?? this.currentStage,
			stage: this.currentStage,
			timestamp: new Date().toISOString(),
		};
		if (level === "error") console.error(JSON.stringify(payload));
		else if (level === "warn") console.warn(JSON.stringify(payload));
		else console.log(JSON.stringify(payload));
	}

	private createModelPort(settings: RuntimeSettings): ModelPort {
		const openAiApiKey = settings.openAiApiKey ?? this.config.openAiApiKey;
		const openAiBaseUrl = settings.openAiBaseUrl ?? this.config.openAiBaseUrl;
		const openAiModelId = settings.openAiModelId ?? this.config.openAiModelId;
		if (openAiBaseUrl === undefined || openAiApiKey === undefined || openAiModelId === undefined) {
			this.log("info", "OpenAI-compatible provider not configured; using fake model");
			return createFakeModel({
				onMessage: (message) => {
					this.modelUsageLedger.record(message, "basic-chat");
				},
			});
		}
		return createOpenAICompatibleModelPort(
			{
				apiKey: openAiApiKey,
				baseUrl: openAiBaseUrl,
				onMessage: (message) => {
					this.modelUsageLedger.record(message, "basic-chat");
				},
				providerId: "openai-compatible",
			},
			[{ capabilities: ["basic-chat", "tool-use"], modelId: openAiModelId }],
		);
	}

	async start(): Promise<void> {
		this.transition("prepare-directories");
		await mkdir(join(this.config.dataDir, "blobs"), { recursive: true });
		this.transition("durable-storage");
		this.durableStorage = await openDurableStorage(join(this.config.dataDir, "durable.sqlite"));
		this.transition("domain-database");
		this.domainDatabase = await openDomainDatabase(join(this.config.dataDir, "domain.sqlite"));
		migrateDomainDatabase(this.domainDatabase);
		this.transition("load-settings");
		const settings = await readRuntimeSettings(this.domainDatabase);
		this.logLevel = settings.logLevel;

		this.transition("domain-services");
		const model = this.createModelPort(settings);
		const activeOpenAiApiKey = settings.openAiApiKey ?? this.config.openAiApiKey;
		const activeOpenAiBaseUrl = settings.openAiBaseUrl ?? this.config.openAiBaseUrl;
		const activeOpenAiModelId = settings.openAiModelId ?? this.config.openAiModelId;
		this.activeProviderSettings = {
			...(activeOpenAiApiKey === undefined ? {} : { openAiApiKey: activeOpenAiApiKey }),
			...(activeOpenAiBaseUrl === undefined ? {} : { openAiBaseUrl: activeOpenAiBaseUrl }),
			...(activeOpenAiModelId === undefined ? {} : { openAiModelId: activeOpenAiModelId }),
		};
		this.conversationHost = new PiDurableConversationHost({
			model,
			storage: this.durableStorage,
		});
		const persistedSessions = await this.domainDatabase
			.select({ durableConversationId: conversations.durableConversationId })
			.from(conversations);
		for (const session of persistedSessions) {
			await this.conversationHost.resumeActivityWindow(session.durableConversationId);
		}
		const models = model.models.getModels(model.providerId);
		this.modelRouter = new ModelPolicyRouter(models);
		this.routingPolicies = [
			{
				capability: "basic-chat",
				primary: { modelId: model.modelId, providerId: model.providerId },
			},
		];

		this.transition("channel-adapters");
		await this.replaceOneBotChannel(settings);

		this.transition("ready", "ready");
	}

	fail(reason: string): void {
		this.failureReason = reason;
		this.currentState = "failed";
		this.currentStage = "failed";
		this.log("error", reason);
	}

	async applyRuntimeSettings(settings: RuntimeSettings): Promise<void> {
		this.logLevel = settings.logLevel;
		this.onebotRestartRequired =
			settings.onebotWsUrl !== this.activeOneBotSettings.onebotWsUrl ||
			settings.onebotAccessToken !== this.activeOneBotSettings.onebotAccessToken;
		this.providerRestartRequired =
			settings.openAiApiKey !== this.activeProviderSettings.openAiApiKey ||
			settings.openAiBaseUrl !== this.activeProviderSettings.openAiBaseUrl ||
			settings.openAiModelId !== this.activeProviderSettings.openAiModelId;
	}

	private async replaceOneBotChannel(settings: RuntimeSettings): Promise<void> {
		this.onebotChannel?.stop();
		this.onebotChannel = undefined;
		this.activeOneBotSettings = {
			...(settings.onebotAccessToken === undefined
				? {}
				: { onebotAccessToken: settings.onebotAccessToken }),
			...(settings.onebotWsUrl === undefined ? {} : { onebotWsUrl: settings.onebotWsUrl }),
		};
		if (settings.onebotWsUrl === undefined) {
			return;
		}
		try {
			const channel = new OneBotChannel(
				{
					botAccountId: "tsukaima-server",
					channelId: "onebot",
					reconnect: { initialDelayMs: 1_000, jitterRatio: 0.1, maxDelayMs: 30_000 },
					url: settings.onebotWsUrl,
					...(settings.onebotAccessToken !== undefined
						? { accessToken: settings.onebotAccessToken }
						: {}),
				},
				this.onebotTransportFactory,
			);
			channel.onMessage((envelope) => {
				void this.processEnvelope(envelope).catch(() => undefined);
			});
			channel.onRequest((request) => {
				void this.processRequest(request).catch(() => undefined);
			});
			await channel.start();
			this.onebotChannel = channel;
			this.onebotRestartRequired = false;
		} catch (error) {
			this.onebotRestartRequired = true;
			this.log(
				"error",
				`OneBot channel failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async processEnvelope(envelope: MessageEnvelope): Promise<void> {
		const ingestionKey = `${envelope.channelId}:${envelope.source.messageId ?? envelope.id}`;
		if (this.ingestingMessages.has(ingestionKey)) return;
		this.ingestingMessages.add(ingestionKey);
		try {
			if (this.conversationHost === undefined) {
				throw new Error("Conversation host is not ready");
			}
			const database = this.domainDatabase;
			if (database === undefined) throw new Error("Domain database is not ready");
			const sender = await this.ensureSender(envelope);
			const target = await this.resolveChatSession(envelope, sender.displayName);
			const platformMessageId = envelope.source.messageId ?? envelope.id;
			const existing = await database
				.select({ id: messages.id })
				.from(messages)
				.where(
					and(
						eq(messages.chatObjectId, target.chatObjectId),
						eq(messages.platformMessageId, platformMessageId),
					),
				)
				.limit(1);
			if (existing.length > 0) {
				return;
			}
			const result = await this.conversationHost.append({
				conversationId: target.durableConversationId,
				envelope,
				submittedAtMs: Date.now(),
			});
			const occurredAt = new Date(
				envelope.source.timestampMs > 0 ? envelope.source.timestampMs : Date.now(),
			).toISOString();
			const now = new Date().toISOString();
			await database
				.insert(messages)
				.values({
					activityId: result.activityId,
					chatObjectId: target.chatObjectId,
					contentText: messageText(envelope.parts),
					conversationId: target.sessionId,
					direction: "inbound",
					id: randomUUID(),
					ingestedAt: now,
					kind: envelope.channelKind,
					occurredAt,
					partsJson: JSON.stringify(envelope.parts),
					platformMessageId,
					rawRefJson: JSON.stringify(envelope),
					...(envelope.target?.replyToEnvelopeId === undefined
						? {}
						: { replyToMessageId: envelope.target.replyToEnvelopeId }),
					senderDisplayName: sender.displayName,
					senderExternalId: envelope.sender.platformId,
					senderUserId: sender.userId,
					updatedAt: now,
				})
				.onConflictDoNothing();
			await Promise.all([
				database
					.update(chatObjects)
					.set({ updatedAt: now })
					.where(eq(chatObjects.id, target.chatObjectId)),
				database
					.update(conversations)
					.set({ updatedAt: now })
					.where(eq(conversations.id, target.sessionId)),
			]);
			if (envelope.conversationKey.kind === "group") {
				await database
					.insert(conversationMembers)
					.values({
						conversationId: target.sessionId,
						lastSeenAt: occurredAt,
						role: envelope.sender.groupRole === "admin" ? "admin" : "member",
						userId: sender.userId,
						...(envelope.sender.groupRole === undefined
							? {}
							: { platformRole: envelope.sender.groupRole }),
					})
					.onConflictDoUpdate({
						set: { lastSeenAt: occurredAt },
						target: [conversationMembers.conversationId, conversationMembers.userId],
					});
			}
			if (!result.deduplicated) {
				this.processedMessageCount += 1;
			}
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			this.log("error", "Failed to process channel message");
			throw error;
		} finally {
			this.ingestingMessages.delete(ingestionKey);
		}
	}

	async processRequest(request: ChannelRequest): Promise<void> {
		const database = this.domainDatabase;
		if (database === undefined) throw new Error("Domain database is not ready");
		try {
			const now = new Date().toISOString();
			await database
				.insert(requests)
				.values({
					accountId: request.accountId,
					channelId: request.channelId,
					...(request.comment === undefined ? {} : { comment: request.comment }),
					createdAt: new Date(request.receivedAtMs || Date.now()).toISOString(),
					flag: request.flag,
					...(request.groupId === undefined ? {} : { groupExternalId: request.groupId }),
					id: randomUUID(),
					kind: request.kind,
					...(request.raw === undefined ? {} : { rawJson: JSON.stringify(request.raw) }),
					requesterExternalId: request.requesterId,
					...(request.requesterDisplayName === undefined
						? {}
						: { requesterDisplayName: request.requesterDisplayName }),
					...(request.subType === undefined ? {} : { subType: request.subType }),
					updatedAt: now,
				})
				.onConflictDoUpdate({
					set: {
						...(request.comment === undefined ? {} : { comment: request.comment }),
						updatedAt: now,
					},
					target: [requests.channelId, requests.flag],
				});
		} catch (error) {
			this.lastProcessingError = error instanceof Error ? error : new Error(String(error));
			this.log("error", "Failed to persist channel request");
			throw error;
		}
	}

	get onebotDiagnostics() {
		return this.onebotChannel?.diagnostics;
	}

	get onebotConfigured(): boolean {
		return this.activeOneBotSettings.onebotWsUrl !== undefined || this.onebotRestartRequired;
	}

	async resolveChannelRequest(
		requestId: string,
		action: "approve" | "reject",
		reason?: string,
	): Promise<{ status: "approved" | "rejected" | "failed" | "uncertain" }> {
		const database = this.domainDatabase;
		if (database === undefined) throw new Error("Domain database is not ready");
		const [request] = await database
			.select()
			.from(requests)
			.where(eq(requests.id, requestId))
			.limit(1);
		if (request === undefined) throw new Error("Request not found");
		if (request.status !== "pending") {
			throw new Error(`Request is already ${request.status}`);
		}
		const channel = this.onebotChannel;
		if (channel === undefined || !channel.diagnostics.connected) {
			throw new Error("OneBot channel is not connected");
		}
		if (this.requestActions.has(requestId)) {
			throw new Error("Request action is already in progress");
		}
		this.requestActions.add(requestId);
		const attemptedAt = new Date().toISOString();
		try {
			await database
				.update(requests)
				.set({
					errorMessage: null,
					resolutionAction: action,
					...(reason === undefined ? {} : { resolutionReason: reason }),
					status: "uncertain",
					updatedAt: attemptedAt,
				})
				.where(and(eq(requests.id, requestId), eq(requests.status, "pending")));
			if (request.kind === "friend") {
				await channel.setFriendAddRequest(
					request.flag,
					action === "approve",
					action === "approve" ? reason : undefined,
				);
			} else {
				await channel.setGroupAddRequest(
					request.flag,
					request.subType ?? undefined,
					action === "approve",
					reason,
				);
			}
			const status = action === "approve" ? "approved" : "rejected";
			const resolvedAt = new Date().toISOString();
			await database
				.update(requests)
				.set({ resolvedAt, status, updatedAt: resolvedAt })
				.where(eq(requests.id, requestId));
			await this.writeAudit({
				action: `request.${action}`,
				payload: { requestId },
				result: "ok",
				targetId: request.requesterExternalId,
				targetKind: "request",
			});
			return { status };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /timeout/i.test(message) ? "uncertain" : "failed";
			const updatedAt = new Date().toISOString();
			await database
				.update(requests)
				.set({ errorMessage: message, status, updatedAt })
				.where(eq(requests.id, requestId));
			await this.writeAudit({
				action: `request.${action}`,
				payload: { requestId },
				reason: message,
				result: "failed",
				targetId: request.requesterExternalId,
				targetKind: "request",
			});
			return { status };
		} finally {
			this.requestActions.delete(requestId);
		}
	}

	async writeAudit(input: {
		action: string;
		payload?: unknown;
		reason?: string;
		result: "ok" | "denied" | "failed";
		targetId?: string;
		targetKind: string;
	}): Promise<void> {
		const database = this.domainDatabase;
		if (database === undefined) return;
		await database.insert(auditLog).values({
			action: input.action,
			actorId: "webui-admin",
			actorKind: "user",
			id: randomUUID(),
			occurredAt: new Date().toISOString(),
			...(input.payload === undefined ? {} : { payloadJson: JSON.stringify(input.payload) }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
			result: input.result,
			...(input.targetId === undefined ? {} : { targetId: input.targetId }),
			targetKind: input.targetKind,
		});
	}

	private async ensureSender(
		envelope: MessageEnvelope,
	): Promise<{ displayName: string; userId: string }> {
		const database = this.domainDatabase;
		if (database === undefined) throw new Error("Domain database is not ready");
		const displayName = envelope.sender.displayName;
		const [existing] = await database
			.select({
				displayName: users.displayName,
				userId: users.id,
			})
			.from(identities)
			.innerJoin(users, eq(users.id, identities.canonicalUserId))
			.where(
				and(
					eq(identities.platform, "onebot-v11"),
					eq(identities.platformAccountId, envelope.channelId),
					eq(identities.externalId, envelope.sender.platformId),
					eq(identities.kind, "user"),
				),
			)
			.limit(1);
		if (existing !== undefined) {
			if (existing.displayName !== displayName) {
				await database
					.update(users)
					.set({ displayName, updatedAt: new Date().toISOString() })
					.where(eq(users.id, existing.userId));
			}
			return { displayName, userId: existing.userId };
		}
		const userId = randomUUID();
		const now = new Date().toISOString();
		await database.insert(users).values({
			createdAt: now,
			displayName,
			id: userId,
			kind: envelope.sender.isBot === true ? "bot" : "human",
			updatedAt: now,
		});
		await database
			.insert(identities)
			.values({
				canonicalUserId: userId,
				createdAt: now,
				displayName,
				externalId: envelope.sender.platformId,
				id: randomUUID(),
				kind: "user",
				platform: "onebot-v11",
				platformAccountId: envelope.channelId,
				updatedAt: now,
			})
			.onConflictDoNothing();
		await database
			.insert(userAliases)
			.values({
				alias: displayName,
				createdAt: now,
				id: randomUUID(),
				source: "onebot",
				userId,
			})
			.onConflictDoNothing();
		return { displayName, userId };
	}

	private async resolveChatSession(
		envelope: MessageEnvelope,
		senderDisplayName: string,
	): Promise<{
		chatObjectId: string;
		durableConversationId: string;
		sessionId: string;
	}> {
		if (this.conversationHost === undefined || this.domainDatabase === undefined) {
			throw new Error("Conversation host or domain database is not ready");
		}
		const kind = envelope.conversationKey.kind;
		if (kind !== "private" && kind !== "group") {
			throw new Error(`External processing does not support ${kind} conversations`);
		}
		const platformConversationId =
			kind === "group" ? envelope.conversationKey.groupId : envelope.conversationKey.peerId;
		if (platformConversationId === undefined) {
			throw new Error("External conversation is missing its platform conversation id");
		}
		const database = this.domainDatabase;
		const findChatObject = async () => {
			const [row] = await database
				.select()
				.from(chatObjects)
				.where(
					and(
						eq(chatObjects.channelId, envelope.channelId),
						eq(chatObjects.kind, kind),
						eq(chatObjects.platformConversationId, platformConversationId),
					),
				)
				.limit(1);
			return row;
		};
		let chat = await findChatObject();
		if (chat === undefined) {
			const now = new Date().toISOString();
			await database
				.insert(chatObjects)
				.values({
					channelId: envelope.channelId,
					createdAt: now,
					id: randomUUID(),
					kind,
					platformConversationId,
					title: kind === "group" ? `Group ${platformConversationId}` : senderDisplayName,
					updatedAt: now,
				})
				.onConflictDoNothing();
			chat = await findChatObject();
		}
		if (chat === undefined) throw new Error("Failed to resolve chat object");
		const [receiving] = await database
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.chatObjectId, chat.id),
					eq(conversations.isReceiving, 1),
					eq(conversations.status, "active"),
				),
			)
			.limit(1);
		if (receiving !== undefined) {
			return {
				chatObjectId: chat.id,
				durableConversationId: receiving.durableConversationId,
				sessionId: receiving.id,
			};
		}
		const [latest] = await database
			.select()
			.from(conversations)
			.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.status, "active")))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (latest !== undefined) {
			await database
				.update(conversations)
				.set({ isReceiving: 1 })
				.where(eq(conversations.id, latest.id));
			return {
				chatObjectId: chat.id,
				durableConversationId: latest.durableConversationId,
				sessionId: latest.id,
			};
		}
		const durableConversationId = await this.conversationHost.createConversation();
		const sessionId = randomUUID();
		await database
			.insert(conversations)
			.values({
				channelId: envelope.channelId,
				chatObjectId: chat.id,
				durableConversationId,
				id: sessionId,
				isReceiving: 1,
				kind,
				platformConversationId,
				title: kind === "group" ? "Main" : "Main",
			})
			.onConflictDoNothing();
		const [created] = await database
			.select()
			.from(conversations)
			.where(eq(conversations.id, sessionId))
			.limit(1);
		if (created !== undefined) {
			return { chatObjectId: chat.id, durableConversationId, sessionId };
		}
		const [winner] = await database
			.select()
			.from(conversations)
			.where(and(eq(conversations.chatObjectId, chat.id), eq(conversations.isReceiving, 1)))
			.limit(1);
		if (winner === undefined) throw new Error("Failed to resolve receiving session");
		return {
			chatObjectId: chat.id,
			durableConversationId: winner.durableConversationId,
			sessionId: winner.id,
		};
	}

	async stop(): Promise<void> {
		this.transition("stopping", "maintenance");
		this.onebotChannel?.stop();
		await this.conversationHost?.close();
		await this.durableStorage?.close(BACKGROUND_CONTEXT);
		this.domainDatabase?.$client.close();
	}
}

export { loadConfig };
