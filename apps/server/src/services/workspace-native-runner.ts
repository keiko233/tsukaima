import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	createPiWorkspaceRunner,
	type PiWorkspaceNativeToolName,
	type PiWorkspaceRunner,
	type PiWorkspaceRunResult,
	type SandboxExecutor,
} from "@tsukaima/coding";
import type { ConversationAgentSettings, LiveRunSnapshot, ModelPort } from "@tsukaima/core";
import type { SessionContextStats, WorkspaceTodoStatus } from "@tsukaima/contracts";
import {
	chatObjects,
	codingTasks,
	conversations,
	messages,
	workspaceSessions,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import {
	defineTool,
	ModelRuntime,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import type { Logger } from "../logging.ts";
import type { WorkspaceReferenceService } from "./workspace-references.ts";
import type { WorkspaceTodoService } from "./workspace-todos.ts";
import type { GitIdentity } from "./git-identity.ts";

export const WORKSPACE_NATIVE_LIVE_RUN_INTERVAL_MS = 120;

const DEFAULT_PATH_ALLOWLIST = [
	"README.md",
	"apps",
	"docs",
	"package.json",
	"packages",
	"plugins",
	"src",
	"tests",
	"tools",
] as const;
const DEFAULT_ALLOWED_COMMANDS = ["bun", "git", "rg"] as const;

export const WORKSPACE_NATIVE_TASK_CONSTRAINTS = {
	allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
	maxOutputBytes: 64 * 1024,
	pathAllowlist: [...DEFAULT_PATH_ALLOWLIST],
	timeoutMs: 120_000,
} as const;

/** Adapt the host-owned plugin ModelPort to the canonical Pi model runtime. */
export async function createPiModelRuntime(
	port: ModelPort,
	ref: { readonly modelId: string; readonly providerId: string },
): Promise<{ readonly model: Model<Api>; readonly runtime: ModelRuntime }> {
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	for (const provider of port.models.getProviders()) runtime.registerNativeProvider(provider);
	const model = runtime.getModel(ref.providerId, ref.modelId);
	if (model === undefined) {
		throw new Error(`Workspace model ${ref.providerId}/${ref.modelId} is not available`);
	}
	return { model, runtime };
}

export interface WorkspaceTaskWorktree {
	readonly path: string;
	readonly baseRef: string;
	readonly constraints: {
		readonly allowedCommands: readonly string[];
		readonly pathAllowlist: readonly string[];
		readonly maxOutputBytes?: number;
		readonly timeoutMs?: number;
	};
}

export interface WorkspaceNativeDispatchInput {
	readonly context?: string | undefined;
	readonly deliveryMode: "follow-up" | "interrupt" | "queue";
	readonly messageId: string;
	readonly sessionId: string;
	readonly text: string;
}

export interface WorkspaceNativeRunnerOptions {
	readonly agentDirRoot: string;
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly finalizeLiveRun: (sessionId: string, entryId: string) => Promise<void>;
	readonly emitAfterReply: (payload: {
		readonly channelId: string | null;
		readonly chatObjectId: string;
		readonly deliveryStatus: "sent";
		readonly entryId: string;
		readonly sessionId: string;
		readonly text: string;
	}) => void;
	readonly ensureWorktree: (taskId: string) => Promise<WorkspaceTaskWorktree>;
	readonly executor: () => Promise<SandboxExecutor>;
	readonly gitIdentity: () => Promise<GitIdentity> | GitIdentity;
	readonly logger: Logger;
	readonly onLiveRun: (
		sessionId: string,
		durableConversationId: string,
		snapshot: LiveRunSnapshot,
	) => void;
	readonly authorizeCoding: (sessionId: string) => Promise<boolean>;
	readonly references: WorkspaceReferenceService;
	readonly resolveAgentSettings: (sessionId: string) => Promise<ConversationAgentSettings>;
	readonly resolveModel: (ref: {
		readonly modelId: string;
		readonly providerId: string;
	}) => Promise<{ readonly model: Model<Api>; readonly runtime: ModelRuntime }>;
	readonly repositoryRoot: string;
	readonly sessionDirRoot: string;
	readonly taskPrompt: (input: {
		readonly baseRef: string;
		readonly goal: string | null;
		readonly repositoryRoot: string;
		readonly taskId: string;
	}) => string;
	readonly todos: WorkspaceTodoService;
	readonly worktreeRoot: string;
}

interface PipeMessageBlock {
	readonly text?: string;
	readonly thinking?: string;
	readonly type?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

interface PipeMessage {
	readonly content?: readonly PipeMessageBlock[];
	readonly model?: string;
	readonly provider?: string;
	readonly role?: string;
	readonly stopReason?: string;
	readonly timestamp?: number;
}

interface WorkspaceContext {
	readonly baseRef: string;
	readonly chatObjectId: string;
	readonly durableConversationId: string;
	readonly goal: string | null;
	readonly repositoryRoot: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly worktreePath: string;
}

interface NativeToolState {
	readonly argumentsText: string | undefined;
	readonly callId: string;
	output: string;
	status: "done" | "pending" | "running";
	readonly toolName: string;
}

interface NativeRunState {
	readonly conversationId: string;
	readonly durableConversationId: string;
	readonly runId: string;
	readonly sessionId: string;
	readonly startedAtMs: number;
	attempt: number | undefined;
	draftTools: {
		readonly argumentsText: string | undefined;
		readonly callId: string;
		readonly toolName: string;
	}[];
	failure: string | undefined;
	model: { readonly modelId: string; readonly providerId: string } | undefined;
	partialText: string | undefined;
	partialThinking: string | undefined;
	retry: { readonly at: number; readonly error: string } | undefined;
	settled: boolean;
	thinkingSteps: string[];
	tools: NativeToolState[];
	turns: number;
}

interface NativeSession {
	readonly session: NativeSessionHandle;
	activeRun: Promise<void> | undefined;
	agentDir: string;
	readonly agentSettingsSignature: string;
	readonly durableConversationId: string;
	readonly sessionFile: string;
	readonly taskId: string;
	readonly worktreePath: string;
}

interface NativeSessionHandle {
	readonly runner: PiWorkspaceRunner;
	readonly abort: () => Promise<void>;
	readonly run: (text: string) => Promise<PiWorkspaceRunResult>;
	readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
	isStreaming: () => boolean;
	queue: (text: string, behavior: "followUp" | "steer") => Promise<void>;
}

function recordOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function jsonText(value: unknown): string {
	return JSON.stringify(value);
}

function toolResult(value: unknown) {
	return {
		content: [{ text: typeof value === "string" ? value : jsonText(value), type: "text" as const }],
		details: undefined,
	};
}

function textOfBlocks(blocks: readonly PipeMessageBlock[] | undefined): string {
	if (blocks === undefined) return "";
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

function thinkingOfBlocks(blocks: readonly PipeMessageBlock[] | undefined): string {
	if (blocks === undefined) return "";
	return blocks
		.filter((block) => block.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking ?? "")
		.join("");
}

function argumentsText(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		return text === undefined || text === "{}" ? undefined : text.slice(0, 400);
	} catch {
		return undefined;
	}
}

function toolResultText(result: unknown): string {
	const record = recordOf(result);
	const content = Array.isArray(record.content) ? record.content : [];
	return content
		.map((part) => recordOf(part))
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => String(part.text))
		.join("\n");
}

function snapshotOf(state: NativeRunState): LiveRunSnapshot {
	return {
		attempt: state.attempt,
		conversationId: state.durableConversationId,
		draftTools: state.draftTools,
		failure: state.failure,
		generationStartedAtMs: undefined,
		model: state.model,
		partialText: state.partialText,
		partialThinking: state.partialThinking,
		retry: state.retry,
		runId: state.runId,
		settled: state.settled,
		startedAtMs: state.startedAtMs,
		tools: state.tools.map((tool) => ({
			argumentsText: tool.argumentsText,
			callId: tool.callId,
			output: tool.output.length === 0 ? undefined : tool.output,
			status: tool.status,
			toolName: tool.toolName,
		})),
		turns: state.turns,
	};
}

/**
 * A Workspace-only Pi session.
 *
 * Durable chat is untouched: this class is reached only from the workspace branch of the shared
 * session-messaging ingress. It owns one native Pi session per workspace, persists the answer into
 * the domain transcript, and projects Pi's own events into the existing live-run cache.
 */
export class WorkspaceNativeRunner {
	readonly #options: WorkspaceNativeRunnerOptions;
	readonly #sessions = new Map<string, NativeSession>();
	readonly #locks = new Map<string, Promise<void>>();
	readonly #lastLiveAt = new Map<string, number>();

	constructor(options: WorkspaceNativeRunnerOptions) {
		this.#options = options;
	}

	#db(): TsukaimaDatabase {
		const database = this.#options.database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async #withLock<T>(sessionId: string, body: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => current);
		this.#locks.set(sessionId, tail);
		await previous;
		try {
			return await body();
		} finally {
			release();
			void tail.then(() => {
				if (this.#locks.get(sessionId) === tail) this.#locks.delete(sessionId);
			});
		}
	}

	async dispatch(input: WorkspaceNativeDispatchInput): Promise<void> {
		await this.#withLock(input.sessionId, async () => {
			if (!(await this.#options.authorizeCoding(input.sessionId))) {
				throw new Error("Workspace coding capability is disabled");
			}
			const context = await this.#context(input.sessionId);
			const native = await this.#ensureSession(context);
			const prompt = this.#composePrompt(input.text, input.context);
			if (native.activeRun !== undefined) {
				if (native.session.isStreaming()) {
					if (input.deliveryMode === "follow-up") {
						await native.session.queue(prompt, "followUp");
						return;
					}
					if (input.deliveryMode === "queue") {
						await native.session.queue(prompt, "steer");
						return;
					}
					if (input.deliveryMode === "interrupt") {
						await native.session.abort();
						await native.activeRun.catch(() => undefined);
					}
				} else if (input.deliveryMode !== "interrupt") {
					await native.activeRun.catch(() => undefined);
				} else {
					await native.session.abort();
					await native.activeRun.catch(() => undefined);
				}
			}
			if (native.activeRun !== undefined) await native.activeRun.catch(() => undefined);
			this.#startRun(native, context, prompt);
		});
	}

	/** Abort one workspace turn. Returns false when the session never used the native runner. */
	async abort(sessionId: string): Promise<boolean> {
		return await this.#withLock(sessionId, async () => {
			const native = this.#sessions.get(sessionId);
			if (native === undefined) return false;
			await native.session.abort();
			return true;
		});
	}

	contextStats(sessionId: string): SessionContextStats | null {
		const runner = this.#sessions.get(sessionId)?.session.runner;
		if (runner === undefined) return null;
		const session = runner.session;
		const model = session.model;
		if (model === undefined) return null;
		const branch = session.sessionManager.getBranch();
		const compacted = branch.some((entry) => entry.type === "compaction");
		const compaction = session.settingsManager.getCompactionSettings(model);
		const contextWindow = model.contextWindow;
		const bufferTokens = compaction.enabled ? Math.min(contextWindow, compaction.reserveTokens) : 0;
		const tools = session.getActiveToolNames().map((name) => {
			const definition = session.getToolDefinition(name);
			const description = definition?.description ?? "";
			return {
				deferred: false,
				description,
				name,
				tokens: estimateTextTokens(
					JSON.stringify({ description, name, parameters: definition?.parameters }),
				),
			};
		});
		const toolsTokens = tools.reduce((total, tool) => total + tool.tokens, 0);
		const systemTokens = estimateTextTokens(session.systemPrompt);
		const base = toolsTokens + systemTokens;
		const usage = session.getContextUsage()?.tokens;
		const hasProviderUsage = session.messages.some(
			(message) => message.role === "assistant" && calculateContextTokens(message.usage) > 0,
		);
		const usedTokens =
			usage != null && hasProviderUsage
				? Math.max(base, usage)
				: base + estimateTextTokens(JSON.stringify(session.messages));
		return {
			autocompact: {
				backgroundTokens: 0,
				bufferTokens,
				enabled: compaction.enabled,
				keepRecentTokens: compaction.keepRecentTokens,
			},
			categories: {
				memoriesTokens: 0,
				messagesTokens: usedTokens - base,
				otherSystemTokens: systemTokens,
				personaTokens: 0,
				policyTokens: 0,
				toolsTokens,
				turnContextTokens: 0,
			},
			compacted,
			contextWindow,
			deferredToolsTokens: 0,
			freeSpaceTokens: Math.max(0, contextWindow - usedTokens - bufferTokens),
			measuredUsageTokens: null,
			memories: { enabled: false, items: [], recentCount: 0, warmTopics: [] },
			messageCount: session.messages.length,
			model: { modelId: model.id, providerId: model.provider },
			personaName: null,
			sections: [
				{ key: "system", label: "System", text: session.systemPrompt, tokens: systemTokens },
			],
			tokenSource: "estimated",
			tools,
			usedPercent: contextWindow > 0 ? Math.min(100, (usedTokens / contextWindow) * 100) : 0,
			usedTokens,
		};
	}

	async dispose(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		this.#locks.clear();
		this.#lastLiveAt.clear();
		await Promise.all(
			sessions.map(async (native) => {
				await native.session.abort().catch(() => undefined);
				await native.activeRun?.catch(() => undefined);
				await native.session.runner.dispose().catch(() => undefined);
				await rm(native.agentDir, { force: true, recursive: true }).catch(() => undefined);
			}),
		);
	}

	async #context(sessionId: string): Promise<WorkspaceContext> {
		const database = this.#db();
		const [row] = await database
			.select({
				chat: chatObjects,
				conversation: conversations,
				workspace: workspaceSessions,
			})
			.from(workspaceSessions)
			.innerJoin(conversations, eq(conversations.id, workspaceSessions.id))
			.innerJoin(chatObjects, eq(chatObjects.id, workspaceSessions.chatObjectId))
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		if (row === undefined || row.workspace.taskId === null) {
			throw new Error("workspace_task_not_started");
		}
		const [task] = await database
			.select()
			.from(codingTasks)
			.where(eq(codingTasks.id, row.workspace.taskId))
			.limit(1);
		if (task === undefined) throw new Error("workspace_task_not_found");
		const worktree = await this.#options.ensureWorktree(task.id);
		return {
			baseRef: worktree.baseRef,
			chatObjectId: row.chat.id,
			durableConversationId: row.conversation.durableConversationId,
			goal: row.workspace.goal,
			repositoryRoot: row.workspace.repositoryRoot,
			sessionId,
			taskId: task.id,
			worktreePath: worktree.path,
		};
	}

	async #ensureSession(context: WorkspaceContext): Promise<NativeSession> {
		const agentSettings = await this.#options.resolveAgentSettings(context.sessionId);
		const signature = JSON.stringify(agentSettings);
		const existing = this.#sessions.get(context.sessionId);
		if (existing !== undefined && existing.agentSettingsSignature === signature) {
			return existing;
		}
		if (existing !== undefined) {
			await existing.session.abort().catch(() => undefined);
			await existing.activeRun?.catch(() => undefined);
			await existing.session.runner.dispose().catch(() => undefined);
			this.#sessions.delete(context.sessionId);
		}
		const { model, runtime } = await this.#resolveModel(agentSettings);
		const agentDir = join(this.#options.agentDirRoot, context.sessionId);
		const sessionDir = join(this.#options.sessionDirRoot, context.sessionId);
		await mkdir(agentDir, { recursive: true });
		await mkdir(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "session.jsonl");
		const worktreeTask = await this.#options.ensureWorktree(context.taskId);
		const executor = await this.#options.executor();
		const nativeTools: readonly PiWorkspaceNativeToolName[] = executor.isolated
			? ["read", "bash", "edit", "write"]
			: ["read", "edit", "write"];
		const runner = await createPiWorkspaceRunner({
			agentDir,
			allowedCommands: worktreeTask.constraints.allowedCommands,
			appendPrompt: [
				this.#options.taskPrompt({
					baseRef: context.baseRef,
					goal: context.goal,
					repositoryRoot: context.repositoryRoot,
					taskId: context.taskId,
				}),
			],
			additionalTools: this.#additionalTools(context),
			executor: async () => executor,
			...(worktreeTask.constraints.maxOutputBytes === undefined
				? {}
				: { maxOutputBytes: worktreeTask.constraints.maxOutputBytes }),
			model,
			modelRuntime: runtime,
			nativeTools,
			pathAllowlist: worktreeTask.constraints.pathAllowlist,
			repositoryPath: this.#options.repositoryRoot,
			sessionFile,
			thinkingLevel: agentSettings.thinkingLevel ?? "off",
			...(worktreeTask.constraints.timeoutMs === undefined
				? {}
				: { timeoutMs: worktreeTask.constraints.timeoutMs }),
			worktreePath: context.worktreePath,
			worktreeRoot: this.#options.worktreeRoot,
		});
		const native: NativeSession = {
			activeRun: undefined,
			agentDir,
			agentSettingsSignature: signature,
			durableConversationId: context.durableConversationId,
			session: {
				abort: async () => {
					await runner.abort();
				},
				isStreaming: () => runner.session.isStreaming,
				queue: async (text, behavior) => {
					await runner.session.prompt(text, { streamingBehavior: behavior });
				},
				run: async (text) => await runner.run(text),
				runner,
				subscribe: (listener) => runner.subscribe(listener),
			},
			sessionFile,
			taskId: context.taskId,
			worktreePath: context.worktreePath,
		};
		this.#sessions.set(context.sessionId, native);
		return native;
	}

	async #resolveModel(settings: ConversationAgentSettings): Promise<{
		readonly model: Model<Api>;
		readonly runtime: ModelRuntime;
	}> {
		if (settings.model === null || settings.model === undefined) {
			throw new Error("workspace_model_unavailable");
		}
		return await this.#options.resolveModel(settings.model);
	}

	#composePrompt(text: string, context: string | undefined): string {
		const attached = (context ?? "").trim();
		return attached.length === 0 ? text : `${attached}\n\n${text}`;
	}

	#additionalTools(context: WorkspaceContext): ToolDefinition[] {
		return [
			defineTool({
				description:
					"Replace the workspace todo list. Use this to keep a multi-step coding plan visible; at most one item may be in_progress.",
				execute: async (_id, args) => {
					const input = recordOf(args);
					const items = Array.isArray(input.items) ? input.items : [];
					const todos = await this.#options.todos.replace(
						context.sessionId,
						items
							.map((item) => recordOf(item))
							.map((item) => {
								const status: WorkspaceTodoStatus | undefined =
									item.status === "pending" ||
									item.status === "in_progress" ||
									item.status === "completed" ||
									item.status === "cancelled"
										? item.status
										: undefined;
								return {
									content: typeof item.content === "string" ? item.content.trim() : "",
									...(status === undefined ? {} : { status }),
								};
							})
							.filter((item) => item.content.length > 0),
					);
					return toolResult({ todos });
				},
				label: "Workspace todos",
				name: "todo_write",
				parameters: Type.Object({
					items: Type.Array(
						Type.Object({
							content: Type.String(),
							status: Type.Optional(
								Type.Union([
									Type.Literal("pending"),
									Type.Literal("in_progress"),
									Type.Literal("completed"),
									Type.Literal("cancelled"),
								]),
							),
						}),
					),
				}),
			}),
			defineTool({
				description: "Read the current workspace todo list.",
				execute: async () =>
					toolResult({ todos: await this.#options.todos.list(context.sessionId) }),
				label: "Workspace todos",
				name: "todo_list",
				parameters: Type.Object({}),
			}),
			defineTool({
				description:
					"Read bounded context from a conversation the user referenced in this workspace.",
				execute: async (_id, args) => {
					const input = recordOf(args);
					const sessionId = String(input.sessionId ?? "");
					const references = await this.#options.references.list(context.sessionId);
					if (!references.some((reference) => reference.sessionId === sessionId)) {
						throw new Error("Session is not referenced by this workspace");
					}
					const messageId = typeof input.messageId === "string" ? input.messageId : undefined;
					return toolResult(
						await this.#options.references.render(context.sessionId, [
							{ ...(messageId === undefined ? {} : { messageId }), sessionId },
						]),
					);
				},
				label: "Referenced session",
				name: "session_context",
				parameters: Type.Object({
					messageId: Type.Optional(Type.String()),
					sessionId: Type.String(),
				}),
			}),
			defineTool({
				description: "Read the effective Git author/committer identity for server-owned commits.",
				execute: async () => {
					const identity = await this.#options.gitIdentity();
					return toolResult({
						author: identity,
						committer: identity,
					});
				},
				label: "Git identity",
				name: "workspace_git_identity",
				parameters: Type.Object({}),
			}),
		];
	}

	#startRun(native: NativeSession, context: WorkspaceContext, prompt: string): void {
		const state: NativeRunState = {
			attempt: 1,
			conversationId: context.sessionId,
			durableConversationId: context.durableConversationId,
			draftTools: [],
			failure: undefined,
			model: undefined,
			partialText: undefined,
			partialThinking: undefined,
			retry: undefined,
			runId: randomUUID(),
			sessionId: context.sessionId,
			settled: false,
			startedAtMs: Date.now(),
			thinkingSteps: [],
			tools: [],
			turns: 0,
		};
		let scheduled: ReturnType<typeof setTimeout> | undefined;
		const emit = (settled = false) => {
			if (settled) state.settled = true;
			this.#options.onLiveRun(context.sessionId, context.durableConversationId, snapshotOf(state));
		};
		const throttled = () => {
			const now = Date.now();
			const previous = this.#lastLiveAt.get(context.sessionId) ?? 0;
			if (now - previous >= WORKSPACE_NATIVE_LIVE_RUN_INTERVAL_MS) {
				this.#lastLiveAt.set(context.sessionId, now);
				emit();
				return;
			}
			if (scheduled !== undefined) return;
			scheduled = setTimeout(
				() => {
					scheduled = undefined;
					this.#lastLiveAt.set(context.sessionId, Date.now());
					emit();
				},
				WORKSPACE_NATIVE_LIVE_RUN_INTERVAL_MS - (now - previous),
			);
			scheduled.unref?.();
		};
		const unsubscribe = native.session.subscribe((event) => {
			const message = "message" in event ? (event.message as PipeMessage | undefined) : undefined;
			if (event.type === "turn_start") {
				state.turns += 1;
				throttled();
				return;
			}
			if (event.type === "message_update" && message?.role === "assistant") {
				state.model =
					typeof message.model === "string" && typeof message.provider === "string"
						? { modelId: message.model, providerId: message.provider }
						: state.model;
				state.partialText = textOfBlocks(message.content) || undefined;
				state.partialThinking = thinkingOfBlocks(message.content) || undefined;
				state.draftTools = (message.content ?? [])
					.filter((block) => block.type === "toolCall" && typeof block.id === "string")
					.map((block) => ({
						argumentsText: argumentsText(block.arguments),
						callId: block.id ?? "",
						toolName: block.name ?? "",
					}))
					.filter((tool) => tool.callId.length > 0 && tool.toolName.length > 0);
				throttled();
				return;
			}
			if (event.type === "tool_execution_start") {
				const existing = state.tools.find((tool) => tool.callId === event.toolCallId);
				if (existing === undefined) {
					state.tools.push({
						argumentsText: argumentsText(event.args),
						callId: event.toolCallId,
						output: "",
						status: "running",
						toolName: event.toolName,
					});
				} else {
					existing.status = "running";
				}
				state.draftTools = state.draftTools.filter((tool) => tool.callId !== event.toolCallId);
				throttled();
				return;
			}
			if (event.type === "tool_execution_update") {
				const existing = state.tools.find((tool) => tool.callId === event.toolCallId);
				if (existing !== undefined) existing.output = toolResultText(event.partialResult);
				throttled();
				return;
			}
			if (event.type === "tool_execution_end") {
				const existing = state.tools.find((tool) => tool.callId === event.toolCallId);
				if (existing !== undefined) {
					existing.output = toolResultText(event.result);
					existing.status = "done";
				}
				throttled();
				return;
			}
			if (event.type === "message_end" && message?.role === "assistant") {
				state.partialText = textOfBlocks(message.content) || state.partialText;
				state.partialThinking = thinkingOfBlocks(message.content) || state.partialThinking;
				state.draftTools = [];
				throttled();
			}
		});
		const run = (async () => {
			try {
				const result = await native.session.run(prompt);
				if (result.aborted) state.failure = "aborted";
				await this.#persistAnswer(native, context, state, result);
			} catch (error) {
				state.failure = error instanceof Error ? error.message : String(error);
				this.#options.logger.warn("workspace native run failed", {
					error: state.failure,
					sessionId: context.sessionId,
				});
			} finally {
				if (scheduled !== undefined) clearTimeout(scheduled);
				unsubscribe();
				emit(true);
			}
		})();
		native.activeRun = run;
		void run.finally(() => {
			if (native.activeRun === run) native.activeRun = undefined;
		});
	}

	async #persistAnswer(
		native: NativeSession,
		context: WorkspaceContext,
		state: NativeRunState,
		result: PiWorkspaceRunResult,
	): Promise<void> {
		const text = result.assistantText.trim();
		if (text.length === 0) return;
		const database = this.#db();
		const entryId = `native-${randomUUID()}`;
		const now = new Date().toISOString();
		await database
			.insert(messages)
			.values({
				chatObjectId: context.chatObjectId,
				contentText: text,
				conversationId: context.sessionId,
				deliveryStatus: "sent",
				direction: "outbound",
				durableEntryId: entryId,
				id: randomUUID(),
				ingestedAt: now,
				kind: "workspace",
				occurredAt: now,
				partsJson: JSON.stringify([{ text, type: "text" }]),
				senderDisplayName: "Tsukaima",
				senderExternalId: "tsukaima",
				updatedAt: now,
			})
			.onConflictDoNothing();
		await Promise.all([
			database
				.update(conversations)
				.set({ updatedAt: now })
				.where(eq(conversations.id, context.sessionId)),
			database
				.update(chatObjects)
				.set({ updatedAt: now })
				.where(eq(chatObjects.id, context.chatObjectId)),
		]);
		state.partialText = text;
		state.settled = true;
		this.#options.onLiveRun(context.sessionId, context.durableConversationId, snapshotOf(state));
		await this.#options.finalizeLiveRun(context.sessionId, entryId);
		this.#options.emitAfterReply({
			channelId: null,
			chatObjectId: context.chatObjectId,
			deliveryStatus: "sent",
			entryId,
			sessionId: context.sessionId,
			text,
		});
		await this.#options.audit?.({
			action: "workspace.native.answer",
			actorKind: "agent",
			payload: {
				entryId,
				sessionFile: result.sessionFile ?? native.sessionFile,
				toolCalls: result.toolCalls,
				toolErrors: result.toolErrors,
			},
			result: "ok",
			targetId: context.sessionId,
			targetKind: "session",
		});
	}
}

export async function isWorkspaceWorktreeCheckout(path: string): Promise<boolean> {
	return await stat(join(path, ".git")).then(
		() => true,
		() => false,
	);
}
