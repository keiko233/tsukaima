import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type {
	MessageDeliveryMode,
	ThinkingLevel,
	WorkspaceKind,
	WorkspaceDetail,
	WorkspaceProposalSummary,
	WorkspaceSummary,
	WorkspaceTaskStatus,
	WorkspaceTodo,
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
import type { WorkspaceReferenceService } from "./workspace-references.ts";
import type { WorkspaceTodoService } from "./workspace-todos.ts";
import {
	collectSandboxOutputs,
	describeStagedInputs,
	stageSandboxInputs,
	type SandboxOutputFile,
	type SandboxStagedInput,
} from "./sandbox-files.ts";
import type { MediaService } from "./media-service.ts";
import { inspectWorkspaceGit } from "./workspace-git.ts";
import { SANDBOX_MAX_ACTIVE_PER_PARENT } from "./workspace-authorization.ts";

const WORKSPACE_CAPABILITIES = ["coding"];
const SANDBOX_CAPABILITIES = ["sandbox"];
const DEFAULT_WORKSPACE_TITLE = "New workspace";

export interface WorkspaceServiceOptions {
	readonly applyToolPolicy?: (sessionId: string, durableConversationId: string) => Promise<void>;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly createTask: (input: {
		readonly baseRef: string;
		readonly goal: string;
		readonly sandbox?: boolean;
		readonly sourceConversationId: string;
	}) => Promise<string>;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly dataDir: string;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly isRunning?: (sessionId: string) => boolean;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly media: MediaService;
	readonly policy: ConversationPolicyService;
	readonly references: WorkspaceReferenceService;
	readonly repositoryRoot: string;
	readonly todos: WorkspaceTodoService;
}

export interface CreateWorkspaceInput {
	readonly baseRef?: string;
	readonly goal?: string;
	readonly model?: WorkspaceModelSelection;
	readonly parentSessionId?: string;
	readonly requestedBy?: string;
	readonly tags?: readonly string[];
	readonly thinking?: ThinkingLevel;
	readonly workspaceKind?: WorkspaceKind;
}

/** A workspace model may omit the provider; the active conversation provider is the default. */
export interface WorkspaceModelSelection {
	readonly modelId: string;
	readonly providerId?: string;
}

export interface CreateWorkspaceResult {
	readonly chatId: string;
	readonly sessionId: string;
	readonly taskId: string | null;
	readonly workspaceKind: WorkspaceKind;
}

export interface StartWorkspaceTaskInput {
	readonly goal: string;
	readonly references?: readonly {
		readonly messageId?: string | undefined;
		readonly sessionId: string;
	}[];
}

export interface SandboxRequester {
	readonly isAdmin: boolean;
	readonly senderPlatformId: string | undefined;
}

type WorkspaceRow = typeof workspaceSessions.$inferSelect;
type ChatRow = typeof chatObjects.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

function titleFromGoal(goal: string): string {
	const firstLine = goal.trim().split("\n")[0]?.trim() || "Workspace task";
	return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117)}...`;
}

function normalizeTags(value: readonly string[] | undefined): string[] {
	return [
		...new Set(
			(value ?? [])
				.map((tag) => tag.trim().toLowerCase())
				.filter((tag) => tag.length > 0 && tag.length <= 32),
		),
	].slice(0, 8);
}

function parseTags(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((tag): tag is string => typeof tag === "string")
			: [];
	} catch {
		return [];
	}
}

/**
 * Owns workspace sessions and their coding-task metadata.
 *
 * A workspace starts as a draft: it has a durable conversation and policy but no coding task and
 * no model turn. The first user message atomically starts the task, derives its title and tags,
 * and injects the workspace brief into that same turn.
 */
export class WorkspaceService {
	readonly #applyToolPolicy: WorkspaceServiceOptions["applyToolPolicy"];
	readonly #audit: WorkspaceServiceOptions["audit"];
	readonly #createTask: WorkspaceServiceOptions["createTask"];
	readonly #database: WorkspaceServiceOptions["database"];
	readonly #dataDir: string;
	readonly #host: WorkspaceServiceOptions["host"];
	readonly #isRunning: WorkspaceServiceOptions["isRunning"];
	readonly #logger: Logger;
	readonly #media: MediaService;
	readonly #messaging: SessionMessagingService;
	readonly #policy: ConversationPolicyService;
	readonly #references: WorkspaceReferenceService;
	readonly #repositoryRoot: string;
	readonly #todos: WorkspaceTodoService;
	readonly #starting = new Map<string, Promise<string>>();

	constructor(options: WorkspaceServiceOptions) {
		this.#applyToolPolicy = options.applyToolPolicy;
		this.#audit = options.audit;
		this.#createTask = options.createTask;
		this.#database = options.database;
		this.#dataDir = options.dataDir;
		this.#host = options.host;
		this.#isRunning = options.isRunning;
		this.#logger = options.logger.child("tsukaima::server::workspace");
		this.#media = options.media;
		this.#messaging = options.messaging;
		this.#policy = options.policy;
		this.#references = options.references;
		this.#repositoryRoot = options.repositoryRoot;
		this.#todos = options.todos;
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
		const workspaceKind = input.workspaceKind ?? "coding";
		const goal = input.goal?.trim() || undefined;
		// Workspaces are the full-authority coding surface: there is no graded mode to select.
		const mode = "maintenance";
		const baseRef = input.baseRef?.trim() || "HEAD";
		const requestedBy = input.requestedBy ?? "webui-admin";
		const tags = normalizeTags(input.tags);
		const ownerUserId =
			workspaceKind === "sandbox" && requestedBy.startsWith("im:")
				? requestedBy.slice("im:".length)
				: undefined;
		const sandboxPath =
			workspaceKind === "sandbox"
				? join(this.#dataDir, "sandbox-workspaces", randomUUID())
				: undefined;
		const model = input.model === undefined ? undefined : host.resolveModelRef(input.model);
		if (input.model !== undefined && model === undefined) {
			throw new Error(
				`Model ${input.model.modelId} is not available${
					input.model.providerId === undefined ? "" : ` on provider ${input.model.providerId}`
				}`,
			);
		}
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

		const chatId = randomUUID();
		const sessionId = randomUUID();
		const durableConversationId = await host.createConversation();
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const title = goal === undefined ? DEFAULT_WORKSPACE_TITLE : titleFromGoal(goal);
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
					goal: goal ?? null,
					id: sessionId,
					mode,
					parentSessionId: parentSessionId ?? null,
					repositoryRoot: this.#repositoryRoot,
					...(sandboxPath === undefined ? {} : { sandboxPath }),
					tagsJson: JSON.stringify(tags),
					taskId: null,
					updatedAtMs: nowMs,
					workspaceKind,
					...(ownerUserId === undefined ? {} : { ownerUserId }),
				})
				.run();
		});
		if (sandboxPath !== undefined) {
			await mkdir(join(sandboxPath, "inputs"), { recursive: true });
			await mkdir(join(sandboxPath, "output"), { recursive: true });
		}
		await this.#policy.update({
			conversationId: sessionId,
			policy: {
				capabilities: workspaceKind === "sandbox" ? SANDBOX_CAPABILITIES : WORKSPACE_CAPABILITIES,
				...(model === undefined ? {} : { model }),
				...(input.thinking === undefined ? {} : { thinking: input.thinking }),
			},
			scope: "conversation",
		});
		await this.#applyToolPolicy?.(sessionId, durableConversationId);
		await this.#audit?.({
			action: "workspace.create",
			actorId: requestedBy,
			actorKind: "user",
			payload: {
				baseRef,
				goal: goal ?? null,
				model: model ?? null,
				mode,
				parentSessionId: parentSessionId ?? null,
				sessionId,
				tags,
				taskId: null,
				workspaceKind,
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
			taskId: null,
		});
		if (goal !== undefined && options.start !== false) {
			const taskId = await this.startTask(sessionId, { goal });
			return { chatId, sessionId, taskId, workspaceKind };
		}
		return { chatId, sessionId, taskId: null, workspaceKind };
	}

	/**
	 * Start the coding task for a draft workspace. Idempotent under concurrent first messages:
	 * callers are serialized per session, then re-read the row before creating the task.
	 */
	async startTask(sessionId: string, input: StartWorkspaceTaskInput): Promise<string> {
		const existing = this.#starting.get(sessionId);
		if (existing !== undefined) return existing;
		const starting = this.#startTaskInner(sessionId, input).finally(() => {
			this.#starting.delete(sessionId);
		});
		this.#starting.set(sessionId, starting);
		return starting;
	}

	async #startTaskInner(sessionId: string, input: StartWorkspaceTaskInput): Promise<string> {
		const database = this.#db();
		const goal = input.goal.trim();
		if (goal.length === 0) throw new Error("Workspace goal is required");
		const [workspace] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		if (workspace === undefined) throw new Error("workspace_not_found");
		if (workspace.taskId !== null) return workspace.taskId;
		const taskId =
			workspace.workspaceKind === "sandbox"
				? await this.#createSandboxTask(sessionId, workspace, goal)
				: await this.#createTask({
						baseRef: workspace.baseRef,
						goal,
						sourceConversationId: workspace.parentSessionId ?? "workspace:webui",
					});
		const title = titleFromGoal(goal);
		const now = new Date().toISOString();
		const tags = normalizeTags(parseTags(workspace.tagsJson));
		const updated = await database.transaction((tx) => {
			const result = tx
				.update(workspaceSessions)
				.set({
					goal,
					tagsJson: JSON.stringify(tags),
					taskId,
					updatedAtMs: Date.now(),
				})
				.where(and(eq(workspaceSessions.id, sessionId), isNull(workspaceSessions.taskId)))
				.returning({ id: workspaceSessions.id })
				.all();
			if (result.length === 0) return false;
			tx.update(chatObjects)
				.set({ title, updatedAt: now })
				.where(eq(chatObjects.id, workspace.chatObjectId))
				.run();
			tx.update(conversations)
				.set({ title, updatedAt: now })
				.where(eq(conversations.id, sessionId))
				.run();
			return true;
		});
		if (!updated) {
			const [current] = await database
				.select({ taskId: workspaceSessions.taskId })
				.from(workspaceSessions)
				.where(eq(workspaceSessions.id, sessionId))
				.limit(1);
			if (current?.taskId === null || current?.taskId === undefined) {
				throw new Error("Workspace task was not persisted");
			}
			return current.taskId;
		}
		await this.#audit?.({
			action: "workspace.start",
			actorKind: "user",
			payload: {
				goal,
				references: input.references?.length ?? 0,
				sessionId,
				taskId,
			},
			result: "ok",
			targetId: sessionId,
			targetKind: "workspace",
		});
		this.#logger.info("workspace task started", { sessionId, taskId });
		return taskId;
	}

	async #createSandboxTask(
		sessionId: string,
		workspace: WorkspaceRow,
		goal: string,
	): Promise<string> {
		return await this.#createTask({
			baseRef: "sandbox",
			goal,
			sandbox: true,
			sourceConversationId: workspace.parentSessionId ?? `sandbox:${sessionId}`,
		});
	}

	/**
	 * Prompt context for the turn that starts a draft. It carries the task contract without
	 * becoming a second user message in the transcript.
	 */
	/** Start the task and record references, returning only bounded per-turn reference context. */
	async prepareNativeTurn(
		sessionId: string,
		input: StartWorkspaceTaskInput,
	): Promise<{ readonly context: string | undefined; readonly taskId: string }> {
		const taskId = await this.startTask(sessionId, input);
		if (input.references !== undefined && input.references.length > 0) {
			await this.#references.record(sessionId, input.references);
		}
		const context = await this.#references.render(sessionId, input.references ?? []);
		return { context, taskId };
	}

	async spawnFromSession(
		sourceSessionId: string,
		input: {
			readonly autoStageRecentFiles?: boolean;
			readonly baseRef?: string;
			readonly fileNames?: readonly string[];
			readonly goal?: string;
			readonly model?: WorkspaceModelSelection;
			readonly requestedBy?: string;
			readonly tags?: readonly string[];
			readonly thinking?: ThinkingLevel;
			readonly mediaIds?: readonly string[];
			readonly workspaceKind?: WorkspaceKind;
		},
	): Promise<CreateWorkspaceResult> {
		const source = await this.#messaging.session(sourceSessionId);
		const workspaceKind = input.workspaceKind ?? "coding";
		const isImChat = source.chat.kind === "private" || source.chat.kind === "group";
		if (workspaceKind === "sandbox") {
			const effectivePolicy = await this.#policy.effectivePolicy(sourceSessionId);
			if (effectivePolicy.sandboxWorkspaceEnabled !== true) {
				throw new Error("Sandbox workspace is not enabled for this conversation");
			}
			if (
				source.chat.kind !== "webui" &&
				source.chat.kind !== "private" &&
				source.chat.kind !== "group"
			) {
				throw new Error("Sandbox workspace is not available from this conversation");
			}
			if (isImChat) {
				const active = await this.#activeSandboxCount(sourceSessionId);
				if (active >= SANDBOX_MAX_ACTIVE_PER_PARENT) {
					throw new Error("sandbox_quota_exceeded");
				}
			}
		} else if (source.chat.kind !== "webui" && source.chat.kind !== "workspace") {
			if (!isImChat) {
				throw new Error(
					"Workspace spawn is only available to authorized chat or workspace sessions",
				);
			}
			const effectivePolicy = await this.#policy.effectivePolicy(sourceSessionId);
			if (effectivePolicy.workspaceDelegationEnabled !== true) {
				throw new Error("Workspace delegation is not enabled for this conversation");
			}
		}
		const created = await this.create({
			...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
			...(input.goal === undefined ? {} : { goal: input.goal }),
			...(input.model === undefined ? {} : { model: input.model }),
			parentSessionId: sourceSessionId,
			requestedBy: input.requestedBy ?? "chat-agent",
			...(input.tags === undefined ? {} : { tags: input.tags }),
			...(input.thinking === undefined ? {} : { thinking: input.thinking }),
			workspaceKind,
		});
		if (workspaceKind === "sandbox") {
			const staged = await this.#stageSandboxMedia(
				sourceSessionId,
				created.sessionId,
				input.mediaIds ?? [],
				{
					autoStageRecentFiles: input.autoStageRecentFiles === true,
					...(input.fileNames === undefined ? {} : { fileNames: input.fileNames }),
					...(input.requestedBy !== undefined && input.requestedBy.startsWith("im:")
						? { senderPlatformId: input.requestedBy.slice("im:".length) }
						: {}),
				},
			);
			if (staged.length > 0) {
				const context = describeStagedInputs(staged);
				await this.#db()
					.update(workspaceSessions)
					.set({
						goal: [input.goal?.trim(), context]
							.filter((entry): entry is string => entry !== undefined && entry.length > 0)
							.join("\n\n"),
					})
					.where(eq(workspaceSessions.id, created.sessionId));
			}
		}
		const goal = input.goal?.trim();
		if (goal !== undefined && goal.length > 0 && created.taskId !== null) {
			await this.sendToWorkspace({
				deliveryMode: "steer",
				sessionId: created.sessionId,
				text: goal,
			});
		}
		return created;
	}

	async #activeSandboxCount(parentSessionId: string): Promise<number> {
		const [row] = await this.#db()
			.select({ total: count() })
			.from(workspaceSessions)
			.innerJoin(conversations, eq(conversations.id, workspaceSessions.id))
			.where(
				and(
					eq(workspaceSessions.parentSessionId, parentSessionId),
					eq(workspaceSessions.workspaceKind, "sandbox"),
					eq(conversations.status, "active"),
				),
			);
		return row?.total ?? 0;
	}

	async #stageSandboxMedia(
		sourceSessionId: string,
		targetSessionId: string,
		mediaIds: readonly string[],
		options: {
			readonly autoStageRecentFiles?: boolean;
			readonly fileNames?: readonly string[];
			readonly senderPlatformId?: string;
		} = {},
	): Promise<readonly SandboxStagedInput[]> {
		const [workspace] = await this.#db()
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, targetSessionId))
			.limit(1);
		if (workspace?.sandboxPath === null || workspace?.sandboxPath === undefined) return [];
		return await stageSandboxInputs({
			...(options.autoStageRecentFiles === undefined
				? {}
				: { autoStageRecentFiles: options.autoStageRecentFiles }),
			database: this.#db(),
			...(options.fileNames === undefined ? {} : { fileNames: options.fileNames }),
			logger: this.#logger,
			media: this.#media,
			mediaIds,
			sandboxPath: workspace.sandboxPath,
			...(options.senderPlatformId === undefined
				? {}
				: { senderPlatformId: options.senderPlatformId }),
			sourceSessionId,
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
			.leftJoin(codingTasks, eq(codingTasks.id, workspaceSessions.taskId))
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
			.leftJoin(codingTasks, eq(codingTasks.id, workspaceSessions.taskId))
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
			references: await this.#references.list(sessionId),
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
			todos: await this.#todos.list(sessionId),
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
		const resolvedTaskId = task?.id ?? workspace?.taskId ?? undefined;
		if (resolvedTaskId === undefined) {
			if (workspace === undefined) throw new Error("workspace_not_found");
			const outputFiles =
				workspace.workspaceKind === "sandbox" && workspace.sandboxPath !== null
					? await collectSandboxOutputs({
							logger: this.#logger,
							media: this.#media,
							sandboxPath: workspace.sandboxPath,
							sandboxSessionId: workspace.id,
						})
					: [];
			return {
				baseRef: workspace.baseRef,
				goal: workspace.goal,
				outputFiles,
				parentSessionId: workspace.parentSessionId,
				proposals: [],
				repositoryRoot: workspace.workspaceKind === "sandbox" ? "" : workspace.repositoryRoot,
				sessionId: workspace.id,
				status: "draft",
				tags: parseTags(workspace.tagsJson),
				taskId: null,
				timeline: [],
				workspaceKind: workspace.workspaceKind,
			};
		}
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
				running: false,
				status: resolvedTask.status,
				taskId: resolvedTask.id,
				timeline: JSON.parse(resolvedTask.timelineJson) as unknown,
			};
		}
		const [latestReply] = await database
			.select({ contentText: messages.contentText })
			.from(messages)
			.where(
				and(eq(messages.conversationId, resolvedWorkspace.id), eq(messages.direction, "outbound")),
			)
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(1);
		return {
			baseRef: resolvedWorkspace.baseRef,
			goal: resolvedWorkspace.goal,
			latestReply: latestReply?.contentText ?? null,
			outputFiles:
				resolvedWorkspace.workspaceKind === "sandbox" && resolvedWorkspace.sandboxPath !== null
					? await collectSandboxOutputs({
							logger: this.#logger,
							media: this.#media,
							sandboxPath: resolvedWorkspace.sandboxPath,
							sandboxSessionId: resolvedWorkspace.id,
						})
					: [],
			parentSessionId: resolvedWorkspace.parentSessionId,
			proposals: await this.#proposals(resolvedTaskId),
			repositoryRoot:
				resolvedWorkspace.workspaceKind === "sandbox" ? "" : resolvedWorkspace.repositoryRoot,
			running: this.#isRunning?.(resolvedWorkspace.id) ?? false,
			sessionId: resolvedWorkspace.id,
			status: resolvedTask.status,
			tags: parseTags(resolvedWorkspace.tagsJson),
			taskId: resolvedTask.id,
			timeline: JSON.parse(resolvedTask.timelineJson) as unknown,
			workspaceKind: resolvedWorkspace.workspaceKind,
			worktreePath:
				resolvedWorkspace.workspaceKind === "sandbox" ? undefined : resolvedTask.worktreePath,
		};
	}

	async update(input: {
		readonly sessionId: string;
		readonly tags?: readonly string[];
		readonly title?: string;
	}): Promise<WorkspaceSummary> {
		const database = this.#db();
		const [workspace] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, input.sessionId))
			.limit(1);
		if (workspace === undefined) throw new Error("workspace_not_found");
		const now = new Date().toISOString();
		const tags =
			input.tags === undefined ? parseTags(workspace.tagsJson) : normalizeTags(input.tags);
		await database.transaction((tx) => {
			tx.update(workspaceSessions)
				.set({ tagsJson: JSON.stringify(tags), updatedAtMs: Date.now() })
				.where(eq(workspaceSessions.id, input.sessionId))
				.run();
			if (input.title !== undefined) {
				tx.update(chatObjects)
					.set({ title: input.title, updatedAt: now })
					.where(eq(chatObjects.id, workspace.chatObjectId))
					.run();
				tx.update(conversations)
					.set({ title: input.title, updatedAt: now })
					.where(eq(conversations.id, input.sessionId))
					.run();
			}
		});
		const detail = await this.get(input.sessionId);
		if (detail === null) throw new Error("workspace_not_found");
		return detail.workspace;
	}

	async sendToWorkspace(input: {
		readonly deliveryMode?: MessageDeliveryMode;
		readonly fileNames?: readonly string[];
		readonly mediaIds?: readonly string[];
		readonly sourceSessionId?: string;
		readonly sessionId: string;
		readonly text: string;
	}): Promise<Record<string, unknown>> {
		const [workspace] = await this.#db()
			.select({
				ownerUserId: workspaceSessions.ownerUserId,
				workspaceKind: workspaceSessions.workspaceKind,
			})
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, input.sessionId))
			.limit(1);
		if (workspace === undefined) throw new Error("workspace_not_found");
		const staged =
			workspace.workspaceKind === "sandbox" &&
			input.sourceSessionId !== undefined &&
			(input.mediaIds !== undefined || input.fileNames !== undefined)
				? await this.stageInputsForSandbox({
						...(input.fileNames === undefined ? {} : { fileNames: input.fileNames }),
						mediaIds: input.mediaIds ?? [],
						sandboxSessionId: input.sessionId,
						...(workspace.ownerUserId === null ? {} : { senderPlatformId: workspace.ownerUserId }),
						sourceSessionId: input.sourceSessionId,
					})
				: [];
		const stagedContext = describeStagedInputs(staged);
		const text = stagedContext.length === 0 ? input.text : `${input.text}\n\n${stagedContext}`;
		const result = await this.#messaging.sendAgentMessage({
			deliveryMode: input.deliveryMode ?? "steer",
			sessionId: input.sessionId,
			source: "session-tool",
			text,
		});
		return {
			deliveryMode: result.mode,
			messageId: result.messageId,
			sessionId: input.sessionId,
			ok: true,
		};
	}

	async sandboxStatus(input: {
		readonly requester: SandboxRequester;
		readonly sessionId: string;
		readonly sourceSessionId: string;
	}): Promise<Record<string, unknown>> {
		const workspace = await this.#sandboxTarget(input.sessionId, input.sourceSessionId);
		const requester = input.requester;
		if (
			workspace.ownerUserId !== null &&
			requester.isAdmin !== true &&
			requester.senderPlatformId !== workspace.ownerUserId
		) {
			throw new Error("sandbox_owner_mismatch");
		}
		return await this.status({ sessionId: workspace.id });
	}

	async sandboxSend(input: {
		readonly deliveryMode?: MessageDeliveryMode;
		readonly fileNames?: readonly string[];
		readonly mediaIds?: readonly string[];
		readonly requester: SandboxRequester;
		readonly sessionId: string;
		readonly sourceSessionId: string;
		readonly text: string;
	}): Promise<Record<string, unknown>> {
		const workspace = await this.#sandboxTarget(input.sessionId, input.sourceSessionId);
		if (
			workspace.ownerUserId !== null &&
			input.requester.isAdmin !== true &&
			input.requester.senderPlatformId !== workspace.ownerUserId
		) {
			throw new Error("sandbox_owner_mismatch");
		}
		return await this.sendToWorkspace({
			...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
			...(input.fileNames === undefined ? {} : { fileNames: input.fileNames }),
			...(input.mediaIds === undefined ? {} : { mediaIds: input.mediaIds }),
			sessionId: workspace.id,
			sourceSessionId: input.sourceSessionId,
			text: input.text,
		});
	}

	async #sandboxTarget(sessionId: string, sourceSessionId: string): Promise<WorkspaceRow> {
		const [workspace] = await this.#db()
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		if (workspace === undefined || workspace.workspaceKind !== "sandbox") {
			throw new Error("sandbox_workspace_not_found");
		}
		if (workspace.parentSessionId !== sourceSessionId) {
			throw new Error("sandbox_scope_mismatch");
		}
		return workspace;
	}

	async stageInputsForSandbox(input: {
		readonly fileNames?: readonly string[];
		readonly mediaIds: readonly string[];
		readonly sandboxSessionId: string;
		readonly senderPlatformId?: string;
		readonly sourceSessionId: string;
	}): Promise<readonly SandboxStagedInput[]> {
		const [workspace] = await this.#db()
			.select({ workspaceKind: workspaceSessions.workspaceKind })
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, input.sandboxSessionId))
			.limit(1);
		if (workspace?.workspaceKind !== "sandbox") throw new Error("sandbox_workspace_not_found");
		return await this.#stageSandboxMedia(
			input.sourceSessionId,
			input.sandboxSessionId,
			input.mediaIds,
			{
				...(input.fileNames === undefined ? {} : { fileNames: input.fileNames }),
				...(input.senderPlatformId === undefined
					? {}
					: { senderPlatformId: input.senderPlatformId }),
			},
		);
	}

	async collectSandboxOutputs(sandboxSessionId: string): Promise<readonly SandboxOutputFile[]> {
		const [workspace] = await this.#db()
			.select({
				sandboxPath: workspaceSessions.sandboxPath,
				workspaceKind: workspaceSessions.workspaceKind,
			})
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, sandboxSessionId))
			.limit(1);
		if (workspace?.workspaceKind !== "sandbox" || workspace.sandboxPath === null) return [];
		return await collectSandboxOutputs({
			logger: this.#logger,
			media: this.#media,
			sandboxPath: workspace.sandboxPath,
			sandboxSessionId,
		});
	}

	async listTodos(sessionId: string): Promise<WorkspaceTodo[]> {
		return this.#todos.list(sessionId);
	}

	async git(sessionId: string, path?: string) {
		const [row] = await this.#db()
			.select({ worktree: codingTasks.worktreePath })
			.from(workspaceSessions)
			.innerJoin(codingTasks, eq(codingTasks.id, workspaceSessions.taskId))
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		return row?.worktree ? inspectWorkspaceGit(row.worktree, path) : null;
	}

	async #proposals(taskId: string | null): Promise<WorkspaceProposalSummary[]> {
		if (taskId === null) return [];
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
		readonly taskStatus: WorkspaceTaskStatus | null;
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
							deliveryMode: latest.deliveryMode,
							direction: latest.direction,
							deliveryStatus: latest.deliveryStatus,
							durableEntryId: latest.durableEntryId,
							id: latest.id,
							kind: latest.kind,
							occurredAt: latest.occurredAt,
							parts: [],
							platformMessageId: latest.platformMessageId,
							replyToMessageId: latest.replyToMessageId,
							runId: latest.runId,
							segmentIndex: latest.segmentIndex,
							seq: latest.seq,
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
			parentSessionId: input.workspace.parentSessionId,
			repositoryRoot:
				input.workspace.workspaceKind === "sandbox" ? "" : input.workspace.repositoryRoot,
			tags: parseTags(input.workspace.tagsJson),
			taskId: input.workspace.taskId,
			taskStatus: input.taskStatus,
			title: input.chat.title,
			updatedAt: input.session.updatedAt,
			workspaceKind: input.workspace.workspaceKind,
		};
	}
}
