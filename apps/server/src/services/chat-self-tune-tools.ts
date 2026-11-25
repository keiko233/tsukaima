import type { ConversationPolicy, ConversationPolicyPatch } from "@tsukaima/contracts";
import type { DurableExtension, DurableToolRegistration } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import { z } from "zod";
import type { Logger } from "../logging.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { PromptHook, PromptHookService } from "./prompt-hooks.ts";

export const CHAT_SELF_TUNE_TOOLS_EXTENSION_NAME = "tsukaima-chat-self-tune-tools";
export const CHAT_SELF_TUNE_TOOL_NAMES = [
	"chat_settings_get",
	"chat_settings_adjust",
	"chat_context_note",
] as const;
export const AGENT_NOTE_CREATED_BY = "agent-note";

const MAX_ACTIVE_AGENT_NOTES = 8;
const CHAT_ONLY_ERROR = "Chat self-tune tools are only available in chat conversations";

export interface ChatSelfTuneToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly logger: Logger;
	readonly now?: () => number;
	readonly policy: ConversationPolicyService;
	readonly promptHooks: PromptHookService;
	readonly resolveSession: (
		durableConversationId: string,
	) => Promise<{ readonly chatKind: string; readonly sessionId: string } | undefined>;
	readonly onQuietUntilChanged?: (
		durableConversationId: string,
		quietUntilMs: number | null,
	) => void;
}

function text(value: unknown) {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text" as const,
			},
		],
	};
}

function failure(error: unknown) {
	return {
		isError: true as const,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text" as const,
			},
		],
	};
}

function tool(input: {
	readonly description: string;
	readonly execute: DurableToolRegistration["execute"];
	readonly name: (typeof CHAT_SELF_TUNE_TOOL_NAMES)[number];
	readonly parameters: Record<string, unknown>;
}): DurableToolRegistration {
	return {
		// Omitted `deferred` is the registry's eager/default (not deferred) tool.
		description: input.description,
		execute: input.execute,
		name: input.name,
		parameters: input.parameters,
		surface: "chat",
	};
}

function safeSettings(policy: ConversationPolicy, activeContextNotes: number, nowMs: number) {
	const quietUntilMs = policy.pacing.quietUntilMs;
	const quietRemainingMinutes =
		quietUntilMs === undefined ? null : Math.max(0, Math.ceil((quietUntilMs - nowMs) / 60_000));
	return {
		activeContextNotes,
		gate: {
			ambientGroupReply: policy.gate.ambientGroupReply,
			enabled: policy.gate.enabled,
			undirectedGroupReply: policy.gate.undirectedGroupReply,
		},
		humanization: {
			antiRepetitionEnabled: policy.humanization.antiRepetitionEnabled,
			rhythmVarietyEnabled: policy.humanization.rhythmVarietyEnabled,
		},
		pacing: {
			burstMaxWaitMs: policy.pacing.burstMaxWaitMs,
			burstSettleMs: policy.pacing.burstSettleMs,
			maxRepliesPerMinute: policy.pacing.maxRepliesPerMinute,
			narrationEnabled: policy.pacing.narrationEnabled,
			quietHours: policy.pacing.quietHours ?? null,
			quietRemainingMinutes,
			quietUntilMs: quietUntilMs ?? null,
			replyCooldownMs: policy.pacing.replyCooldownMs,
			replyDelayEnabled: policy.pacing.replyDelayEnabled,
			replyDelayMaxMs: policy.pacing.replyDelayMaxMs,
			streamingLineFlushEnabled: policy.pacing.streamingLineFlushEnabled,
		},
		trigger: {
			groupMentionMode: policy.trigger.groupMentionMode,
			imageOnly: policy.trigger.imageOnly,
			recentActivityEscalation: policy.trigger.recentActivityEscalation,
			recentActivityMinIntervalMs: policy.trigger.recentActivityMinIntervalMs,
			replyToBotCounts: policy.trigger.replyToBotCounts,
			stickerOnly: policy.trigger.stickerOnly,
		},
	};
}

const quietHoursAdjustSchema = z.strictObject({
	enabled: z.boolean(),
	endHour: z.number().int().min(0).max(23),
	startHour: z.number().int().min(0).max(23),
});

/** Strict, bounded model-facing patch: security, access, model, and capability fields never exist here. */
const adjustSchema = z.strictObject({
	antiRepetitionEnabled: z.boolean().optional(),
	burstMaxWaitMs: z.number().int().min(1_000).max(30_000).optional(),
	burstSettleMs: z.number().int().min(300).max(15_000).optional(),
	gateAmbientGroupReply: z.boolean().optional(),
	gateUndirectedGroupReply: z.boolean().optional(),
	groupMentionMode: z.enum(["always", "smart"]).optional(),
	imageOnly: z.enum(["lurk", "text-only", "ignore"]).optional(),
	maxRepliesPerMinute: z.number().int().min(1).max(20).optional(),
	narrationEnabled: z.boolean().optional(),
	posture: z.enum(["lurk_only", "quiet", "balanced", "active"]).optional(),
	quietHours: quietHoursAdjustSchema.optional(),
	quietMinutes: z.number().int().min(0).max(1_440).optional(),
	reason: z.string().trim().min(1).max(200),
	recentActivityEscalation: z.enum(["off", "throttled", "always"]).optional(),
	recentActivityMinIntervalMs: z.number().int().min(0).max(600_000).optional(),
	replyCooldownMs: z.number().int().min(0).max(300_000).optional(),
	replyDelayEnabled: z.boolean().optional(),
	replyDelayMaxMs: z.number().int().min(0).max(10_000).optional(),
	rhythmVarietyEnabled: z.boolean().optional(),
	stickerOnly: z.enum(["lurk", "text-only", "ignore"]).optional(),
	streamingLineFlushEnabled: z.boolean().optional(),
});

const noteSchema = z.strictObject({
	action: z.enum(["add", "list", "remove"]),
	id: z.string().trim().min(1).optional(),
	mode: z.enum(["next_turn", "ongoing"]).optional(),
	note: z.string().optional(),
	tag: z
		.string()
		.trim()
		.min(1)
		.max(48)
		.regex(/^[a-z0-9][a-z0-9_-]*$/i, "tag must be a slug")
		.optional(),
	ttlMinutes: z.number().int().min(1).max(1_440).optional(),
});

type AdjustInput = z.output<typeof adjustSchema>;

const PRESETS: Record<
	NonNullable<AdjustInput["posture"]>,
	{
		readonly gate?: NonNullable<ConversationPolicyPatch["gate"]>;
		readonly pacing?: NonNullable<ConversationPolicyPatch["pacing"]>;
		readonly trigger?: NonNullable<ConversationPolicyPatch["trigger"]>;
	}
> = {
	active: {
		pacing: { burstSettleMs: 1_000, replyCooldownMs: 0 },
		trigger: { recentActivityEscalation: "throttled", recentActivityMinIntervalMs: 20_000 },
	},
	balanced: {
		pacing: { burstSettleMs: 1_200, narrationEnabled: true, replyCooldownMs: 0 },
		trigger: { recentActivityEscalation: "throttled", recentActivityMinIntervalMs: 60_000 },
	},
	lurk_only: {
		gate: { ambientGroupReply: false },
		pacing: { narrationEnabled: false, replyCooldownMs: 15_000 },
		trigger: { imageOnly: "ignore", recentActivityEscalation: "off", stickerOnly: "ignore" },
	},
	quiet: {
		gate: { ambientGroupReply: false },
		pacing: { burstSettleMs: 2_500, narrationEnabled: false, replyCooldownMs: 10_000 },
		trigger: {
			imageOnly: "text-only",
			recentActivityEscalation: "off",
			stickerOnly: "text-only",
		},
	},
};

const GRANULAR_CHANGE_KEYS = [
	"recentActivityEscalation",
	"recentActivityMinIntervalMs",
	"replyCooldownMs",
	"maxRepliesPerMinute",
	"burstSettleMs",
	"burstMaxWaitMs",
	"narrationEnabled",
	"streamingLineFlushEnabled",
	"replyDelayEnabled",
	"replyDelayMaxMs",
	"stickerOnly",
	"imageOnly",
	"groupMentionMode",
	"quietHours",
	"antiRepetitionEnabled",
	"rhythmVarietyEnabled",
	"gateUndirectedGroupReply",
	"gateAmbientGroupReply",
] as const;

function buildPatch(
	input: AdjustInput,
	nowMs: number,
): {
	readonly patch: ConversationPolicyPatch;
	readonly quietUntilMs: number | null | undefined;
} {
	const preset = input.posture === undefined ? undefined : PRESETS[input.posture];
	const triggerPatch: NonNullable<ConversationPolicyPatch["trigger"]> = {
		...preset?.trigger,
	};
	const pacingPatch: NonNullable<ConversationPolicyPatch["pacing"]> = {
		...preset?.pacing,
	};
	const gatePatch: NonNullable<ConversationPolicyPatch["gate"]> = { ...preset?.gate };
	const humanizationPatch: NonNullable<ConversationPolicyPatch["humanization"]> = {};

	if (input.recentActivityEscalation !== undefined) {
		triggerPatch.recentActivityEscalation = input.recentActivityEscalation;
	}
	if (input.recentActivityMinIntervalMs !== undefined) {
		triggerPatch.recentActivityMinIntervalMs = input.recentActivityMinIntervalMs;
	}
	if (input.replyCooldownMs !== undefined) pacingPatch.replyCooldownMs = input.replyCooldownMs;
	if (input.maxRepliesPerMinute !== undefined) {
		pacingPatch.maxRepliesPerMinute = input.maxRepliesPerMinute;
	}
	if (input.burstSettleMs !== undefined) pacingPatch.burstSettleMs = input.burstSettleMs;
	if (input.burstMaxWaitMs !== undefined) pacingPatch.burstMaxWaitMs = input.burstMaxWaitMs;
	if (input.narrationEnabled !== undefined) pacingPatch.narrationEnabled = input.narrationEnabled;
	if (input.streamingLineFlushEnabled !== undefined) {
		pacingPatch.streamingLineFlushEnabled = input.streamingLineFlushEnabled;
	}
	if (input.replyDelayEnabled !== undefined)
		pacingPatch.replyDelayEnabled = input.replyDelayEnabled;
	if (input.replyDelayMaxMs !== undefined) pacingPatch.replyDelayMaxMs = input.replyDelayMaxMs;
	if (input.stickerOnly !== undefined) triggerPatch.stickerOnly = input.stickerOnly;
	if (input.imageOnly !== undefined) triggerPatch.imageOnly = input.imageOnly;
	if (input.groupMentionMode !== undefined) triggerPatch.groupMentionMode = input.groupMentionMode;
	if (input.quietHours !== undefined) pacingPatch.quietHours = input.quietHours;
	if (input.antiRepetitionEnabled !== undefined) {
		humanizationPatch.antiRepetitionEnabled = input.antiRepetitionEnabled;
	}
	if (input.rhythmVarietyEnabled !== undefined) {
		humanizationPatch.rhythmVarietyEnabled = input.rhythmVarietyEnabled;
	}
	if (input.gateUndirectedGroupReply !== undefined) {
		gatePatch.undirectedGroupReply = input.gateUndirectedGroupReply;
	}
	if (input.gateAmbientGroupReply !== undefined) {
		gatePatch.ambientGroupReply = input.gateAmbientGroupReply;
	}

	let quietUntilMs: number | null | undefined;
	if (input.quietMinutes === 0) {
		quietUntilMs = null;
		pacingPatch.quietUntilMs = null;
	} else if (input.quietMinutes !== undefined) {
		quietUntilMs = nowMs + input.quietMinutes * 60_000;
		pacingPatch.quietUntilMs = quietUntilMs;
	}

	const patch: ConversationPolicyPatch = {
		...(Object.keys(triggerPatch).length === 0 ? {} : { trigger: triggerPatch }),
		...(Object.keys(pacingPatch).length === 0 ? {} : { pacing: pacingPatch }),
		...(Object.keys(gatePatch).length === 0 ? {} : { gate: gatePatch }),
		...(Object.keys(humanizationPatch).length === 0 ? {} : { humanization: humanizationPatch }),
	};
	return { patch, quietUntilMs };
}

function noteSummary(hook: PromptHook) {
	const tag = typeof hook.metadata.tag === "string" ? hook.metadata.tag : null;
	return {
		createdAtMs: hook.createdAtMs,
		createdBy: hook.createdBy,
		dedupeKey: hook.dedupeKey,
		expiresAtMs: hook.expiresAtMs,
		id: hook.id,
		kind: hook.kind,
		note: hook.prompt,
		startsAtMs: hook.startsAtMs,
		status: hook.status,
		tag,
		targetSessionId: hook.targetSessionId,
	};
}

/**
 * Self-adjustment and durable context-note tools for ordinary chat turns.
 *
 * Every tool resolves the invocation's own domain session and always writes there. The adjust
 * surface is a strict, bounded subset of chat behavior: access, capabilities, model selection,
 * allowlists, peer bots, and workspace delegation are deliberately unreachable.
 */
export function createChatSelfTuneToolsExtension(
	options: ChatSelfTuneToolsOptions,
): DurableExtension {
	const nowMs = (): number => (options.now ?? Date.now)();

	const audit = async (entry: AuditEntry): Promise<void> => {
		try {
			await options.audit?.(entry);
		} catch (error) {
			options.logger.warn("chat self-tune audit failed", {
				error: error instanceof Error ? error.message : String(error),
				tool: entry.action,
			});
		}
	};

	const run = async (
		conversationId: string,
		body: (session: { readonly chatKind: string; readonly sessionId: string }) => Promise<unknown>,
	): Promise<
		| { output: { text: string; type: "text" }[] }
		| { isError: true; output: { text: string; type: "text" }[] }
	> => {
		try {
			const session = await options.resolveSession(conversationId);
			if (session === undefined || session.chatKind === "workspace") {
				return failure(new Error(CHAT_ONLY_ERROR));
			}
			return text(await body(session));
		} catch (error) {
			return failure(error);
		}
	};

	const activeNotes = async (sessionId: string): Promise<PromptHook[]> => {
		const hooks = await options.promptHooks.list({ includeFinished: false, sessionId });
		return hooks.filter(
			(hook) => hook.createdBy === AGENT_NOTE_CREATED_BY && hook.targetSessionId === sessionId,
		);
	};

	const addNote = async (input: Parameters<PromptHookService["add"]>[0]): Promise<PromptHook> => {
		try {
			return await options.promptHooks.add(input);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (input.dedupeKey === undefined || !message.includes("dedupe_key")) throw error;
			// A cancelled hook keeps its unique dedupe key. Keep the replacement tag in
			// metadata so tag-based list/remove/replace still work.
			const { dedupeKey: _dedupeKey, ...rest } = input;
			return await options.promptHooks.add(rest);
		}
	};

	const settingsGet = tool({
		description:
			"Read this chat's effective behavior settings (trigger, pacing, humanization, gate) plus the count of active agent context notes. Never exposes access, capabilities, models, or tool grants.",
		name: "chat_settings_get",
		parameters: z.toJSONSchema(z.strictObject({})),
		async execute(_args, api) {
			const conversationId = String(api.conversationId);
			return await run(conversationId, async (session) => {
				const [policy, notes] = await Promise.all([
					options.policy.effectivePolicy(session.sessionId),
					activeNotes(session.sessionId),
				]);
				return safeSettings(policy, notes.length, nowMs());
			});
		},
	});

	const settingsAdjust = tool({
		description:
			"Adjust this chat's own behavior: posture preset, temporary quiet minutes, or bounded granular trigger/pacing/humanization/gate fields. Requires a non-empty reason. Cannot change access, capabilities, allowed tools, models, peer bots, or workspace delegation.",
		name: "chat_settings_adjust",
		parameters: z.toJSONSchema(adjustSchema),
		async execute(args, api) {
			const conversationId = String(api.conversationId);
			return await run(conversationId, async (session) => {
				const input = adjustSchema.parse(args);
				const hasChange =
					input.posture !== undefined ||
					input.quietMinutes !== undefined ||
					GRANULAR_CHANGE_KEYS.some((key) => input[key] !== undefined);
				if (!hasChange) throw new Error("At least one chat setting change is required");
				const currentNowMs = nowMs();
				const { patch, quietUntilMs } = buildPatch(input, currentNowMs);
				const view = await options.policy.update({
					conversationId: session.sessionId,
					policy: patch,
					scope: "conversation",
				});
				if (input.quietMinutes !== undefined) {
					try {
						options.onQuietUntilChanged?.(conversationId, quietUntilMs ?? null);
					} catch (error) {
						options.logger.warn("chat quiet deadline notification failed", {
							conversationId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				await audit({
					action: "chat.self-tune",
					actorKind: "agent",
					payload: {
						conversationId: session.sessionId,
						patch,
						reason: input.reason,
					},
					result: "ok",
					targetId: session.sessionId,
					targetKind: "session",
				});
				const notes = await activeNotes(session.sessionId);
				return safeSettings(view.policy, notes.length, currentNowMs);
			});
		},
	});

	const contextNote = tool({
		description:
			"Add, list, or remove durable agent context notes for this chat. `next_turn` fires once on the next turn; `ongoing` applies every turn until it expires. A tag replaces the previous note with the same tag. System and restart hooks are never visible or removable here.",
		name: "chat_context_note",
		parameters: z.toJSONSchema(noteSchema),
		async execute(args, api) {
			const conversationId = String(api.conversationId);
			return await run(conversationId, async (session) => {
				const input = noteSchema.parse(args);
				if (input.action === "list") {
					const notes = await activeNotes(session.sessionId);
					return { count: notes.length, notes: notes.map(noteSummary) };
				}
				if (input.action === "remove") {
					const notes = await activeNotes(session.sessionId);
					let target: PromptHook | undefined;
					if (input.id !== undefined) {
						target = notes.find((hook) => hook.id === input.id);
					}
					if (target === undefined && input.tag !== undefined) {
						const dedupeKey = `agent-note:${session.sessionId}:${input.tag}`;
						target =
							notes.find((hook) => hook.dedupeKey === dedupeKey) ??
							notes.find((hook) => hook.metadata.tag === input.tag);
					}
					if (target === undefined) {
						throw new Error("No matching agent context note in this chat");
					}
					const cancelled = await options.promptHooks.cancel(target.id, "agent-note-removed");
					await audit({
						action: "chat.context-note",
						actorKind: "agent",
						payload: {
							action: "remove",
							conversationId: session.sessionId,
							hookId: target.id,
							...(input.tag === undefined ? {} : { tag: input.tag }),
						},
						result: "ok",
						targetId: session.sessionId,
						targetKind: "session",
					});
					return { cancelled, removedId: target.id };
				}

				const note = input.note?.trim();
				if (note === undefined || note.length === 0) {
					throw new Error("note is required for add");
				}
				if (note.length > 600) throw new Error("note must be at most 600 characters");
				const mode = input.mode ?? "next_turn";
				const kind = mode === "ongoing" ? "runtime" : "context";
				const currentNowMs = nowMs();
				const ttlMinutes = input.ttlMinutes ?? (mode === "ongoing" ? 60 : 24 * 60);
				const dedupeKey =
					input.tag === undefined ? undefined : `agent-note:${session.sessionId}:${input.tag}`;
				if (input.tag !== undefined) {
					// A cancelled hook keeps its unique dedupe key, so also clear any earlier
					// active note that carries the same metadata tag.
					const tagMatches = (await activeNotes(session.sessionId)).filter(
						(hook) => hook.metadata.tag === input.tag,
					);
					for (const previous of tagMatches) {
						await options.promptHooks.cancel(previous.id, "agent-note-replaced");
					}
				}
				if (dedupeKey !== undefined) {
					await options.promptHooks.cancelByDedupeKey(dedupeKey, "agent-note-replaced");
				}
				const notesBeforeAdd = await activeNotes(session.sessionId);
				if (notesBeforeAdd.length >= MAX_ACTIVE_AGENT_NOTES) {
					throw new Error(
						`At most ${MAX_ACTIVE_AGENT_NOTES} active agent context notes are allowed; remove an old note first`,
					);
				}
				const hook = await addNote({
					createdBy: AGENT_NOTE_CREATED_BY,
					...(dedupeKey === undefined ? {} : { dedupeKey }),
					expiresAtMs: currentNowMs + ttlMinutes * 60_000,
					kind,
					metadata: input.tag === undefined ? {} : { tag: input.tag },
					prompt: note,
					targetSessionId: session.sessionId,
				});
				await audit({
					action: "chat.context-note",
					actorKind: "agent",
					payload: {
						action: "add",
						conversationId: session.sessionId,
						hookId: hook.id,
						mode,
						...(input.tag === undefined ? {} : { tag: input.tag }),
					},
					result: "ok",
					targetId: session.sessionId,
					targetKind: "session",
				});
				return { note: noteSummary(hook) };
			});
		},
	});

	return {
		name: CHAT_SELF_TUNE_TOOLS_EXTENSION_NAME,
		tools: [settingsGet, settingsAdjust, contextNote],
	};
}
