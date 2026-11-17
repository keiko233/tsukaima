import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { MessageDeliveryMode, ThinkingLevel, WorkspaceMode } from "@tsukaima/contracts";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { PromptHookService } from "./prompt-hooks.ts";
import type { ScheduleService } from "./schedule-service.ts";
import type { SessionMessagingService } from "./session-messaging.ts";
import type { WorkspaceService } from "./workspace.ts";

export const WORKSPACE_TOOLS_EXTENSION_NAME = "tsukaima-workspace-tools";
export const WORKSPACE_TOOL_NAMES = [
	"workspace_spawn",
	"workspace_status",
	"workspace_send",
	"session_lookup",
	"hook_schedule",
	"hook_list",
] as const;

export interface WorkspaceToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly logger: Logger;
	readonly messaging: SessionMessagingService;
	readonly promptHooks: PromptHookService;
	readonly resolveSessionId: (durableConversationId: string) => Promise<string | undefined>;
	readonly schedules?: ScheduleService;
	readonly workspace: WorkspaceService;
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

function text(value: unknown): { output: { text: string; type: "text" }[] } {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text",
			},
		],
	};
}

function failure(error: unknown): {
	isError: true;
	output: { text: string; type: "text" }[];
} {
	return {
		isError: true,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text",
			},
		],
	};
}

function stringValue(
	input: Record<string, unknown>,
	key: string,
	required = false,
): string | undefined {
	const value = input[key];
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (required) throw new Error(`${key} is required`);
	return undefined;
}

function workspaceMode(value: unknown): WorkspaceMode | undefined {
	return value === "analysis" ||
		value === "patch" ||
		value === "proposal" ||
		value === "maintenance"
		? value
		: undefined;
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
		? value
		: undefined;
}

function deliveryMode(value: unknown): MessageDeliveryMode {
	return value === "interrupt" || value === "follow-up" || value === "queue" ? value : "queue";
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: string;
	readonly parameters: Record<string, unknown>;
	readonly surface: "chat" | "coding" | "both";
}): DurableToolRegistration {
	return {
		deferred: true,
		description: input.description,
		execute: input.execute,
		name: input.name,
		parameters: input.parameters,
		surface: input.surface,
	};
}

/**
 * Host-owned tools shared by chat and workspace sessions. Visibility is filtered per
 * conversation in the lifecycle; ordinary IM sessions never receive these tools.
 */
export function createWorkspaceToolsExtension(options: WorkspaceToolsOptions): DurableExtension {
	const resolveCurrentSession = async (durableConversationId: string): Promise<string> => {
		const sessionId = await options.resolveSessionId(durableConversationId);
		if (sessionId === undefined)
			throw new Error("Current session is not mapped to a domain session");
		return sessionId;
	};
	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("workspace tool audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};
	const run = async <T>(
		name: string,
		conversationId: string,
		body: () => Promise<T>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| {
				isError: true;
				output: { text: string; type: "text" }[];
		  }
	> => {
		try {
			const result = await body();
			await audit({
				action: `workspace-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				result: "ok",
				targetKind: "workspace-tool",
			});
			return text(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await audit({
				action: `workspace-tool.${name}`,
				actorKind: "agent",
				payload: { conversationId },
				reason: message,
				result: "failed",
				targetKind: "workspace-tool",
			});
			options.logger.warn("workspace tool failed", {
				conversationId,
				error: message,
				tool: name,
			});
			return failure(error);
		}
	};

	const spawn = tool({
		description:
			"Spawn a governed workspace session to inspect, patch, test, or propose a change in Tsukaima's running repository. Use this when the user reports a bug or asks for a new capability, or when you discover a concrete self-improvement worth executing. The workspace runs independently; do not claim the code is already changed.",
		name: "workspace_spawn",
		parameters: {
			properties: {
				baseRef: { type: "string" },
				effort: {
					enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
					type: "string",
				},
				goal: { description: "Concrete engineering goal and acceptance criteria.", type: "string" },
				model: { description: "Model id from the active provider's catalog.", type: "string" },
				modelProvider: {
					description: "Provider id; must be the active provider. Defaults to it.",
					type: "string",
				},
				mode: { enum: ["analysis", "patch", "proposal"], type: "string" },
			},
			required: ["goal"],
			type: "object",
		},
		surface: "chat",
		async execute(args, api) {
			const input = record(args);
			return run("workspace_spawn", String(api.conversationId), async () => {
				const sourceSessionId = await resolveCurrentSession(String(api.conversationId));
				const result = await options.workspace.spawnFromSession(sourceSessionId, {
					...(stringValue(input, "baseRef") === undefined
						? {}
						: { baseRef: stringValue(input, "baseRef")! }),
					goal: stringValue(input, "goal", true)!,
					...(stringValue(input, "model") === undefined
						? {}
						: {
								model: {
									modelId: stringValue(input, "model")!,
									...(stringValue(input, "modelProvider") === undefined
										? {}
										: { providerId: stringValue(input, "modelProvider")! }),
								},
							}),
					...(workspaceMode(input.mode) === undefined ? {} : { mode: workspaceMode(input.mode)! }),
					...(thinkingLevel(input.effort) === undefined
						? {}
						: { thinking: thinkingLevel(input.effort)! }),
				});
				return {
					...result,
					parentSessionId: sourceSessionId,
					status: "spawned",
					next: "Use workspace_status to poll and workspace_send to queue constraints or interrupt.",
				};
			});
		},
	});

	const status = tool({
		description:
			"Query a workspace coding task by workspace session id or task id. Returns status, goal, repo root, worktree, timeline, and proposals.",
		name: "workspace_status",
		parameters: {
			properties: {
				sessionId: { type: "string" },
				taskId: { type: "string" },
			},
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			return run("workspace_status", String(api.conversationId), async () => {
				const sessionId = stringValue(input, "sessionId");
				const taskId = stringValue(input, "taskId");
				if (sessionId === undefined && taskId === undefined) {
					const current = await resolveCurrentSession(String(api.conversationId));
					return await options.workspace.status({ sessionId: current });
				}
				return await options.workspace.status({
					...(sessionId === undefined ? {} : { sessionId }),
					...(taskId === undefined ? {} : { taskId }),
				});
			});
		},
	});

	const send = tool({
		description:
			"Send a message to a workspace session. queue inserts after the current loop step, interrupt cancels the current generation, and follow-up waits for the turn to settle.",
		name: "workspace_send",
		parameters: {
			properties: {
				mode: { enum: ["queue", "interrupt", "follow-up"], type: "string" },
				sessionId: { type: "string" },
				text: { type: "string" },
			},
			required: ["sessionId", "text"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			return run("workspace_send", String(api.conversationId), async () =>
				options.workspace.sendToWorkspace({
					deliveryMode: deliveryMode(input.mode),
					sessionId: stringValue(input, "sessionId", true)!,
					text: stringValue(input, "text", true)!,
				}),
			);
		},
	});

	const scheduleHook = tool({
		description:
			"Create a durable prompt hook. next-turn injects context before the next agent turn, after-restart submits a reserved turn on the next process boot, and at submits at an ISO time. Use after-restart when you tell a user you will return after maintenance.",
		name: "hook_schedule",
		parameters: {
			properties: {
				deliverAt: { description: "ISO timestamp for timing=at.", type: "string" },
				prompt: { type: "string" },
				sessionId: { description: "Defaults to the current session.", type: "string" },
				timing: { enum: ["next-turn", "after-restart", "at"], type: "string" },
			},
			required: ["prompt", "timing"],
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			return run("hook_schedule", String(api.conversationId), async () => {
				const currentSessionId = await resolveCurrentSession(String(api.conversationId));
				const targetSessionId = stringValue(input, "sessionId") ?? currentSessionId;
				await options.messaging.session(targetSessionId);
				const prompt = stringValue(input, "prompt", true)!;
				const timing = stringValue(input, "timing", true);
				if (timing === "next-turn") {
					return options.promptHooks.add({
						createdBy: "chat-agent",
						kind: "context",
						prompt,
						sourceSessionId: currentSessionId,
						targetSessionId,
					});
				}
				if (timing === "after-restart") {
					return options.promptHooks.add({
						afterRestart: true,
						createdBy: "chat-agent",
						kind: "resume",
						prompt,
						sourceSessionId: currentSessionId,
						status: "scheduled",
						targetSessionId,
					});
				}
				if (timing === "at") {
					const deliverAt = stringValue(input, "deliverAt", true)!;
					const deliverAtMs = Date.parse(deliverAt);
					if (!Number.isFinite(deliverAtMs)) throw new Error("deliverAt must be a valid ISO time");
					if (options.schedules !== undefined) {
						const schedule = await options.schedules.create({
							actionKind: "agent_turn",
							ownerId: "chat-agent",
							ownerKind: "agent",
							prompt,
							recurrence: { at: new Date(deliverAtMs).toISOString(), kind: "once" },
							source: "hook-compat",
							targetSessionId,
							timeZone: "UTC",
							title: "Scheduled follow-up",
						});
						return schedule;
					}
					const hook = await options.promptHooks.add({
						createdBy: "chat-agent",
						deliverAtMs,
						kind: "resume",
						prompt,
						sourceSessionId: currentSessionId,
						status: "scheduled",
						targetSessionId,
					});
					options.promptHooks.armResume(hook, (entry) =>
						options.messaging.dispatchResumeHook(entry),
					);
					return hook;
				}
				throw new Error("timing must be next-turn, after-restart, or at");
			});
		},
	});

	const lookupSessions = tool({
		description:
			"Find WebUI chat, workspace, or external session ids by title. Use this before targeting another conversation with hook_schedule.",
		name: "session_lookup",
		parameters: {
			properties: {
				limit: { maximum: 25, minimum: 1, type: "integer" },
				query: { type: "string" },
			},
			required: ["query"],
			type: "object",
		},
		surface: "chat",
		async execute(args, api) {
			const input = record(args);
			return run("session_lookup", String(api.conversationId), async () => ({
				sessions: await options.messaging.searchSessions(
					stringValue(input, "query", true)!,
					typeof input.limit === "number" ? input.limit : 10,
				),
			}));
		},
	});

	const listHooks = tool({
		description: "List pending context, runtime, and resume hooks for this session.",
		name: "hook_list",
		parameters: {
			properties: { includeFinished: { type: "boolean" } },
			type: "object",
		},
		surface: "both",
		async execute(args, api) {
			const input = record(args);
			return run("hook_list", String(api.conversationId), async () => {
				const sessionId = await resolveCurrentSession(String(api.conversationId));
				return {
					hooks: await options.promptHooks.list({
						includeFinished: input.includeFinished === true,
						sessionId,
					}),
				};
			});
		},
	});

	return {
		name: WORKSPACE_TOOLS_EXTENSION_NAME,
		tools: [spawn, status, send, lookupSessions, scheduleHook, listHooks],
	};
}
