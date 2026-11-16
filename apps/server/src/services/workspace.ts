import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
	MessageDeliveryMode,
	WorkspaceDetail,
	WorkspaceMode,
	WorkspaceProposalSummary,
	WorkspaceSummary,
	WorkspaceTaskStatus,
} from "@tsukaima/contracts";
import type { PiDurableConversationHost } from "@tsukaima/core";
import {
	chatObjects,
	codingProposals,
	codingTasks,
	conversations,
	messages,
	workspaceSessions,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { SessionMessagingService } from "./session-messaging.ts";

const WORKSPACE_CAPABILITIES = ["coding"];

export interface WorkspaceServiceOptions {
	readonly applyToolPolicy?: (sessionId: string, durableConversationId: string) => Promise<void>;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly invokePluginRpc: (method: string, input: unknown) => Promise<unknown>;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly policy: ConversationPolicyService;
	readonly repositoryRoot: string;
}

export interface CreateWorkspaceInput {
	readonly baseRef?: string;
	readonly goal: string;
	readonly mode?: WorkspaceMode;
	readonly parentSessionId?: string;
	readonly requestedBy?: string;
}

export interface CreateWorkspaceResult {
	readonly chatId: string;
	readonly sessionId: string;
	readonly taskId: string;
}

type WorkspaceRow = typeof workspaceSessions.$inferSelect;
type ChatRow = typeof chatObjects.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

function titleFromGoal(goal: string): string {
	const firstLine = goal.trim().split("\n")[0]?.trim() || "Workspace task";
	return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

function workspacePrompt(input: {
	baseRef: string;
	goal: string;
	repositoryRoot: string;
	taskId: string;
}): string {
	return [
		"You are the dedicated workspace agent for a Tsukaima self-upgrade task.",
		`Repository root: ${input.repositoryRoot}`,
		`Coding task id: ${input.taskId}`,
		`Base revision: ${input.baseRef}`,
		"",
		"Goal:",
		input.goal,
		"",
		"Operating rules:",
		`- Pass taskId="${input.taskId}" to every self-iteration tool.`,
		"- Inspect with self-iteration.analyze before editing.",
		"- Create a bounded worktree with self-iteration.worktree before any write.",
		"- Use only self-iteration.edit and self-iteration.test for repository changes and validation.",
		"- Never edit the live repository directly and never run maintenance/deploy verbs yourself.",
		"- When the change is ready, create a proposal with self-iteration.propose and report the task id, tests, changed files, and blockers.",
		"- Keep progress concise so the parent chat can query the task status.",
	].join("\n");
}

/**
 * Owns workspace sessions and their coding-task metadata. A workspace reuses the ordinary
 * durable conversation and message store, but is always created with `coding` capability and a
 * scoped task id. Chat sessions can create and communicate with these sessions without gaining
 * coding tools themselves.
 */
export class WorkspaceService {
	readonly #applyToolPolicy: WorkspaceServiceOptions["applyToolPolicy"];
	readonly #audit: WorkspaceServiceOptions["audit"];
	readonly #database: WorkspaceServiceOptions["database"];
	readonly #host: WorkspaceServiceOptions["host"];
	readonly #invokePluginRpc: WorkspaceServiceOptions["invokePluginRpc"];
	readonly #logger: Logger;
	readonly #messaging: SessionMessagingService;
	readonly #policy: ConversationPolicyService;
	readonly #repositoryRoot: string;

	constructor(options: WorkspaceServiceOptions) {
		this.#applyToolPolicy = options.applyToolPolicy;
		this.#audit = options.audit;
		this.#database = options.database;
		this.#host = options.host;
		this.#invokePluginRpc = options.invokePluginRpc;
		this.#logger = options.logger.child("tsukaima::server::workspace");
		this.#messaging = options.messaging;
		this.#policy = options.policy;
		this.#repositoryRoot = options.repositoryRoot;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	#hostRequired(): PiDurableConversationHost {
		const host = this.#host();
		if (host === undefined) throw new Error("Conversation host is not ready");
		return host;
	}

	async create(
		input: CreateWorkspaceInput,
		options: { readonly start?: boolean } = {},
	): Promise<CreateWorkspaceResult> {
		const database = this.#db();
		const host = this.#hostRequired();
		const goal = input.goal.trim();
		if (goal.length === 0) throw new Error("Workspace goal is required");
		const mode = input.mode ?? "patch";
		const baseRef = input.baseRef?.trim() || "HEAD";
		const requestedBy = input.requestedBy ?? "webui-admin";
		let parentSessionId = input.parentSessionId;
		if (parentSessionId !== undefined) {
			const [parent] = await database
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, parentSessionId))
				.limit(1);
			if (parent === undefined) throw new Error("Parent session not found");
		} else {
			parentSessionId = undefined;
		}

		const taskResult = await this.#invokePluginRpc("self-iteration.tasks.create", {
			baseRef,
			goal,
			mode,
			sourceConversationId: parentSessionId ?? "workspace:webui",
		});
		const taskId =
			typeof taskResult === "object" &&
			taskResult !== null &&
			"id" in taskResult &&
			typeof taskResult.id === "string"
				? taskResult.id
				: undefined;
		if (taskId === undefined) {
			throw new Error("Self-iteration task creation returned no task id");
		}

		const chatId = randomUUID();
		const sessionId = randomUUID();
		const durableConversationId = await host.createConversation();
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const title = titleFromGoal(goal);
		await database.transaction((tx) => {
			tx.insert(chatObjects)
				.values({
					createdAt: now,
					id: chatId,
					kind: "workspace",
					title,
					updatedAt: now,
				})
				.run();
			tx.insert(conversations)
				.values({
					chatObjectId: chatId,
					createdAt: now,
					durableConversationId,
					id: sessionId,
					isReceiving: 1,
					kind: "workspace",
					title,
					updatedAt: now,
				})
				.run();
			tx.insert(workspaceSessions)
				.values({
					baseRef,
					chatObjectId: chatId,
					createdAtMs: nowMs,
					goal,
					id: sessionId,
					mode,
					parentSessionId: parentSessionId ?? null,
					repositoryRoot: this.#repositoryRoot,
					taskId,
					updatedAtMs: nowMs,
				})
				.run();
		});
		await this.#policy.update({
			conversationId: sessionId,
			policy: { capabilities: WORKSPACE_CAPABILITIES },
			scope: "conversation",
		});
		await this.#applyToolPolicy?.(sessionId, durableConversationId);
		await this.#audit?.({
			action: "workspace.create",
			actorId: requestedBy,
			actorKind: "user",
			payload: {
				baseRef,
				goal,
				mode,
				parentSessionId: parentSessionId ?? null,
				sessionId,
				taskId,
			},
			result: "ok",
			targetId: sessionId,
			targetKind: "workspace",
		});
		this.#logger.info("workspace created", {
			baseRef,
			chatId,
			mode,
			sessionId,
			taskId,
		});
		if (options.start !== false) {
			await this.#messaging.sendAgentMessage({
				context: [
					"[Workspace handoff] A parent chat created this workspace for repository work.",
					"Treat the goal below as the complete task brief unless follow-up messages add constraints.",
				].join("\n"),
				sessionId,
				source: "session-tool",
				text: workspacePrompt({
					baseRef,
					goal,
					repositoryRoot: this.#repositoryRoot,
					taskId,
				}),
			});
		}
		return { chatId, sessionId, taskId };
	}

	async spawnFromSession(
		sourceSessionId: string,
		input: { readonly baseRef?: string; readonly goal: string; readonly mode?: WorkspaceMode },
	): Promise<CreateWorkspaceResult> {
		const source = await this.#messaging.session(sourceSessionId);
		if (source.chat.kind !== "webui" && source.chat.kind !== "workspace") {
			throw new Error("Workspace spawn is only available to WebUI chat or workspace sessions");
		}
		return this.create({
			...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
			goal: input.goal,
			...(input.mode === undefined ? {} : { mode: input.mode }),
			parentSessionId: sourceSessionId,
			requestedBy: "chat-agent",
		});
	}

	async list(options: { readonly includeArchived?: boolean } = {}): Promise<WorkspaceSummary[]> {
		const database = this.#db();
		const rows = await database
			.select({
				chat: chatObjects,
				session: conversations,
				taskStatus: codingTasks.status,
				workspace: workspaceSessions,
			})
			.from(workspaceSessions)
			.innerJoin(conversations, eq(conversations.id, workspaceSessions.id))
			.innerJoin(chatObjects, eq(chatObjects.id, workspaceSessions.chatObjectId))
			.innerJoin(codingTasks, eq(codingTasks.id, workspaceSessions.taskId))
			.where(
				options.includeArchived === true
					? undefined
					: and(eq(chatObjects.status, "active"), eq(conversations.status, "active")),
			)
			.orderBy(desc(workspaceSessions.updatedAtMs));
		const summaries: WorkspaceSummary[] = [];
		for (const row of rows) {
			const [latest] = await database
				.select()
				.from(messages)
				.where(eq(messages.conversationId, row.session.id))
				.orderBy(desc(messages.occurredAt), desc(messages.id))
				.limit(1);
			summaries.push(
				this.#summary({
					chat: row.chat,
					latest: latest ?? null,
					session: row.session,
					taskStatus: row.taskStatus,
					workspace: row.workspace,
				}),
			);
		}
		return summaries;
	}

	async get(sessionId: string): Promise<WorkspaceDetail | null> {
		const database = this.#db();
		const [row] = await database
			.select({
				chat: chatObjects,
				session: conversations,
				taskStatus: codingTasks.status,
				workspace: workspaceSessions,
			})
			.from(workspaceSessions)
			.innerJoin(conversations, eq(conversations.id, workspaceSessions.id))
			.innerJoin(chatObjects, eq(chatObjects.id, workspaceSessions.chatObjectId))
			.innerJoin(codingTasks, eq(codingTasks.id, workspaceSessions.taskId))
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		if (row === undefined) return null;
		const [latest] = await database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, sessionId))
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(1);
		const proposals = await this.#proposals(row.workspace.taskId);
		return {
			proposals,
			session: {
				channelId: row.chat.channelId,
				chat: {
					id: row.chat.id,
					kind: "workspace",
					platformConversationId: row.chat.platformConversationId,
					status: row.chat.status,
					title: row.chat.title,
				},
				createdAt: row.session.createdAt,
				id: row.session.id,
				isReceiving: row.session.isReceiving === 1,
				kind: row.session.kind,
				status: row.session.status,
				title: row.session.title ?? row.chat.title,
				updatedAt: row.session.updatedAt,
			},
			workspace: this.#summary({
				chat: row.chat,
				latest: latest ?? null,
				session: row.session,
				taskStatus: row.taskStatus,
				workspace: row.workspace,
			}),
		};
	}

	async status(input: {
		readonly sessionId?: string;
		readonly taskId?: string;
	}): Promise<Record<string, unknown>> {
		const database = this.#db();
		if (input.sessionId === undefined && input.taskId === undefined) {
			throw new Error("sessionId or taskId is required");
		}
		const [task] =
			input.taskId === undefined
				? []
				: await database
						.select()
						.from(codingTasks)
						.where(eq(codingTasks.id, input.taskId))
						.limit(1);
		const [workspace] =
			input.sessionId === undefined
				? []
				: await database
						.select()
						.from(workspaceSessions)
						.where(eq(workspaceSessions.id, input.sessionId))
						.limit(1);
		const resolvedTaskId = task?.id ?? workspace?.taskId;
		if (resolvedTaskId === undefined) throw new Error("workspace_not_found");
		const [resolvedTask] =
			task === undefined
				? await database
						.select()
						.from(codingTasks)
						.where(eq(codingTasks.id, resolvedTaskId))
						.limit(1)
				: [task];
		if (resolvedTask === undefined) throw new Error("workspace_task_not_found");
		const resolvedWorkspace =
			workspace ??
			(
				await database
					.select()
					.from(workspaceSessions)
					.where(eq(workspaceSessions.taskId, resolvedTaskId))
					.limit(1)
			)[0];
		if (resolvedWorkspace === undefined) {
			return {
				mode: resolvedTask.mode,
				status: resolvedTask.status,
				taskId: resolvedTask.id,
				timeline: JSON.parse(resolvedTask.timelineJson) as unknown,
			};
		}
		return {
			baseRef: resolvedWorkspace.baseRef,
			goal: resolvedWorkspace.goal,
			mode: resolvedWorkspace.mode,
			parentSessionId: resolvedWorkspace.parentSessionId,
			proposals: await this.#proposals(resolvedTaskId),
			repositoryRoot: resolvedWorkspace.repositoryRoot,
			sessionId: resolvedWorkspace.id,
			status: resolvedTask.status,
			taskId: resolvedTask.id,
			timeline: JSON.parse(resolvedTask.timelineJson) as unknown,
			worktreePath: resolvedTask.worktreePath,
		};
	}

	async sendToWorkspace(input: {
		readonly deliveryMode?: MessageDeliveryMode;
		readonly sessionId: string;
		readonly text: string;
	}): Promise<Record<string, unknown>> {
		const [workspace] = await this.#db()
			.select({ id: workspaceSessions.id })
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, input.sessionId))
			.limit(1);
		if (workspace === undefined) throw new Error("workspace_not_found");
		const result = await this.#messaging.sendAgentMessage({
			deliveryMode: input.deliveryMode ?? "queue",
			sessionId: input.sessionId,
			source: "session-tool",
			text: input.text,
		});
		return {
			deliveryMode: result.mode,
			messageId: result.messageId,
			sessionId: input.sessionId,
			ok: true,
		};
	}

	async #proposals(taskId: string): Promise<WorkspaceProposalSummary[]> {
		const rows = await this.#db()
			.select()
			.from(codingProposals)
			.where(eq(codingProposals.taskId, taskId))
			.orderBy(desc(codingProposals.updatedAtMs));
		return rows.map((row) => ({
			changedFiles: JSON.parse(row.changedFilesJson) as string[],
			id: row.id,
			requiresRestart: row.requiresRestart === 1,
			status: row.status,
			title: row.title,
		}));
	}

	#summary(input: {
		readonly chat: ChatRow;
		readonly latest: typeof messages.$inferSelect | null;
		readonly session: ConversationRow;
		readonly taskStatus: WorkspaceTaskStatus;
		readonly workspace: WorkspaceRow;
	}): WorkspaceSummary {
		const latest = input.latest;
		return {
			baseRef: input.workspace.baseRef,
			chatObjectId: input.workspace.chatObjectId,
			createdAt: input.session.createdAt,
			goal: input.workspace.goal,
			id: input.workspace.id,
			latestMessage:
				latest === null
					? null
					: {
							contentText: latest.contentText ?? "",
							direction: latest.direction,
							deliveryStatus: latest.deliveryStatus,
							durableEntryId: latest.durableEntryId,
							id: latest.id,
							kind: latest.kind,
							occurredAt: latest.occurredAt,
							parts: [],
							platformMessageId: latest.platformMessageId,
							replyToMessageId: latest.replyToMessageId,
							senderDisplayName: latest.senderDisplayName ?? "Unknown",
							senderExternalId: latest.senderExternalId,
							senderKind:
								latest.kind === "assistant"
									? "assistant"
									: latest.senderExternalId === "webui-admin"
										? "system"
										: "human",
							triggerClassification: latest.triggerClassification,
						},
			mode: input.workspace.mode,
			parentSessionId: input.workspace.parentSessionId,
			repositoryRoot: input.workspace.repositoryRoot,
			taskId: input.workspace.taskId,
			taskStatus: input.taskStatus,
			title: input.chat.title,
			updatedAt: input.session.updatedAt,
		};
	}
}
