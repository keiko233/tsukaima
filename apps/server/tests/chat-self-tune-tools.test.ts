import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	chatObjects,
	conversations,
	migrateDomainDatabase,
	openDomainDatabase,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { DurableExtension } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../src/logging.ts";
import {
	AGENT_NOTE_CREATED_BY,
	CHAT_SELF_TUNE_TOOL_NAMES,
	CHAT_SELF_TUNE_TOOLS_EXTENSION_NAME,
	createChatSelfTuneToolsExtension,
} from "../src/services/chat-self-tune-tools.ts";
import { ConversationPolicyService } from "../src/services/conversation-policy.ts";
import { PromptHookService, type PromptHook } from "../src/services/prompt-hooks.ts";

const temporaryDirectories: string[] = [];
const NOW = 1_800_000_000_000;

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

const logger = {
	child: () => logger,
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	trace: () => undefined,
	warn: () => undefined,
} as unknown as Logger;

async function createHarness(): Promise<{
	readonly cleanup: () => Promise<void>;
	readonly database: TsukaimaDatabase;
}> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-chat-self-tune-"));
	temporaryDirectories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return {
		cleanup: async () => {
			try {
				database.$client.close();
			} catch {}
			await fs.rm(directory, { force: true, recursive: true });
		},
		database,
	};
}

async function seedConversation(
	database: TsukaimaDatabase,
	kind: "group" | "private" | "webui" | "workspace",
): Promise<{
	readonly durableConversationId: string;
	readonly sessionId: string;
}> {
	const durableConversationId = `durable-${randomUUID()}`;
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date(NOW).toISOString();
	await database.insert(chatObjects).values({
		channelId: "onebot",
		createdAt: now,
		id: chatId,
		kind,
		platformConversationId: `synthetic-${randomUUID()}`,
		title: "Synthetic self-tune chat",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "onebot",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind,
		platformConversationId: `synthetic-${randomUUID()}`,
		title: "Synthetic self-tune chat",
		updatedAt: now,
	});
	return { durableConversationId, sessionId };
}

function resultText(result: unknown): string {
	const output = (result as { readonly output?: readonly unknown[] }).output;
	for (const part of output ?? []) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			return part.text;
		}
	}
	return "";
}

function decodeResult(result: unknown): Record<string, any> {
	const parsed: unknown = JSON.parse(resultText(result));
	return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : {};
}

function extensionTool(extension: DurableExtension, name: string) {
	const found = (extension.tools ?? []).find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Tool ${name} missing from ${extension.name}`);
	return found;
}

async function invokeTool(
	extension: DurableExtension,
	name: string,
	args: Record<string, unknown>,
	durableConversationId: string,
) {
	const tool = extensionTool(extension, name);
	return await tool.execute(
		args,
		{ conversationId: durableConversationId } as unknown as Parameters<typeof tool.execute>[1],
		undefined as never,
	);
}

interface Harness {
	readonly audits: AuditEntry[];
	readonly extension: DurableExtension;
	readonly policy: ConversationPolicyService;
	readonly promptHooks: PromptHookService;
	readonly quietChanges: (number | null)[];
	readonly quietConversationIds: string[];
}

function createExtension(
	database: TsukaimaDatabase,
	options: { readonly now?: () => number } = {},
): Harness {
	const audits: AuditEntry[] = [];
	const quietChanges: (number | null)[] = [];
	const quietConversationIds: string[] = [];
	const policy = new ConversationPolicyService({
		database: () => database,
		host: () => undefined,
		logger,
	});
	const promptHooks = new PromptHookService({
		database: () => database,
		logger,
		now: options.now ?? (() => NOW),
	});
	const extension = createChatSelfTuneToolsExtension({
		audit: (entry) => {
			audits.push(entry);
		},
		logger,
		now: options.now ?? (() => NOW),
		policy,
		promptHooks,
		resolveSession: async (durableConversationId) => {
			const [row] = await database
				.select({
					chatKind: chatObjects.kind,
					sessionId: conversations.id,
					sessionKind: conversations.kind,
				})
				.from(conversations)
				.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
				.where(eq(conversations.durableConversationId, durableConversationId))
				.limit(1);
			if (row === undefined) return undefined;
			return {
				chatKind: row.chatKind ?? row.sessionKind,
				sessionId: row.sessionId,
			};
		},
		onQuietUntilChanged: (durableConversationId, quietUntilMs) => {
			quietConversationIds.push(durableConversationId);
			quietChanges.push(quietUntilMs);
		},
	});
	return { audits, extension, policy, promptHooks, quietChanges, quietConversationIds };
}

function addSystemHook(
	promptHooks: PromptHookService,
	input: {
		readonly kind: PromptHook["kind"];
		readonly prompt: string;
		readonly targetSessionId: string;
	},
): Promise<PromptHook> {
	return promptHooks.add({
		createdBy: "system",
		kind: input.kind,
		prompt: input.prompt,
		targetSessionId: input.targetSessionId,
	});
}

describe("chat self-tune extension surface", () => {
	test("registers exactly the three chat tools eagerly on the chat surface", async () => {
		expect(CHAT_SELF_TUNE_TOOLS_EXTENSION_NAME).toBe("tsukaima-chat-self-tune-tools");
		expect([...CHAT_SELF_TUNE_TOOL_NAMES]).toEqual([
			"chat_settings_get",
			"chat_settings_adjust",
			"chat_context_note",
		]);
		const harness = await createHarness();
		try {
			const { extension } = createExtension(harness.database);
			expect(extension.name).toBe(CHAT_SELF_TUNE_TOOLS_EXTENSION_NAME);
			expect(extension.tools?.map((tool) => tool.name)).toEqual([...CHAT_SELF_TUNE_TOOL_NAMES]);
			for (const tool of extension.tools ?? []) {
				expect((tool as { readonly surface?: string }).surface).toBe("chat");
				expect(tool.deferred).not.toBe(true);
			}
		} finally {
			await harness.cleanup();
		}
	});
});

describe("chat_settings_get", () => {
	test("returns safe chat behavior settings and omits sensitive policy fields", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension, policy, promptHooks } = createExtension(harness.database);
			await policy.update({
				conversationId: session.sessionId,
				scope: "conversation",
				policy: {
					capabilities: ["coding"],
					trigger: {
						allowlist: ["synthetic-user"],
						groupAccess: "allowlist",
						privateAccess: "allowlist",
					},
					pacing: { allowedTools: ["bash"] },
				},
			});
			await promptHooks.add({
				createdBy: AGENT_NOTE_CREATED_BY,
				kind: "runtime",
				prompt: "Stay concise.",
				targetSessionId: session.sessionId,
				expiresAtMs: NOW + 60_000,
			});
			const result = await invokeTool(
				extension,
				"chat_settings_get",
				{},
				session.durableConversationId,
			);
			expect(result.isError).toBeUndefined();
			const decoded = decodeResult(result);
			expect(decoded.activeContextNotes).toBe(1);
			expect(decoded.trigger).toMatchObject({
				groupMentionMode: "always",
				imageOnly: "lurk",
				recentActivityEscalation: "throttled",
				recentActivityMinIntervalMs: 60_000,
				replyToBotCounts: true,
				stickerOnly: "lurk",
			});
			expect(decoded.pacing).toMatchObject({
				burstMaxWaitMs: 5_000,
				burstSettleMs: 1_200,
				maxRepliesPerMinute: 20,
				narrationEnabled: true,
				quietHours: null,
				quietRemainingMinutes: null,
				quietUntilMs: null,
				replyCooldownMs: 0,
				replyDelayEnabled: false,
				replyDelayMaxMs: 2_000,
				streamingLineFlushEnabled: true,
			});
			expect(decoded.humanization).toEqual({
				antiRepetitionEnabled: true,
				rhythmVarietyEnabled: true,
			});
			expect(decoded.gate).toEqual({
				ambientGroupReply: false,
				enabled: false,
				undirectedGroupReply: true,
			});
			for (const key of ["capabilities", "workspaceDelegationEnabled", "model", "thinking"]) {
				expect(decoded).not.toHaveProperty(key);
			}
			for (const key of [
				"allowlist",
				"privateAccess",
				"groupAccess",
				"peerBotIds",
				"selfAliases",
			]) {
				expect(decoded.trigger).not.toHaveProperty(key);
			}
			expect(decoded.pacing).not.toHaveProperty("allowedTools");
		} finally {
			await harness.cleanup();
		}
	});
});

describe("chat_settings_adjust", () => {
	test("applies posture presets and lets explicit fields override them", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { audits, extension, policy } = createExtension(harness.database);

			const quiet = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ posture: "quiet", reason: "Synthetic quiet preset" },
				session.durableConversationId,
			);
			expect(quiet.isError).toBeUndefined();
			let effective = await policy.effectivePolicy(session.sessionId);
			expect(effective.trigger.recentActivityEscalation).toBe("off");
			expect(effective.trigger.stickerOnly).toBe("text-only");
			expect(effective.trigger.imageOnly).toBe("text-only");
			expect(effective.pacing.burstSettleMs).toBe(2_500);
			expect(effective.pacing.narrationEnabled).toBe(false);
			expect(effective.pacing.replyCooldownMs).toBe(10_000);
			expect(effective.gate.ambientGroupReply).toBe(false);
			expect(audits.at(-1)).toMatchObject({
				action: "chat.self-tune",
				actorKind: "agent",
				result: "ok",
				targetId: session.sessionId,
				targetKind: "session",
			});

			const lurkOnly = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ posture: "lurk_only", reason: "Synthetic lurk preset" },
				session.durableConversationId,
			);
			expect(lurkOnly.isError).toBeUndefined();
			effective = await policy.effectivePolicy(session.sessionId);
			expect(effective.trigger.recentActivityEscalation).toBe("off");
			expect(effective.trigger.stickerOnly).toBe("ignore");
			expect(effective.trigger.imageOnly).toBe("ignore");
			expect(effective.pacing.replyCooldownMs).toBe(15_000);
			expect(effective.pacing.narrationEnabled).toBe(false);
			expect(effective.gate.ambientGroupReply).toBe(false);

			const balanced = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ posture: "balanced", reason: "Synthetic balanced preset" },
				session.durableConversationId,
			);
			expect(balanced.isError).toBeUndefined();
			effective = await policy.effectivePolicy(session.sessionId);
			expect(effective.trigger.recentActivityEscalation).toBe("throttled");
			expect(effective.trigger.recentActivityMinIntervalMs).toBe(60_000);
			expect(effective.pacing.burstSettleMs).toBe(1_200);
			expect(effective.pacing.narrationEnabled).toBe(true);
			expect(effective.pacing.replyCooldownMs).toBe(0);

			const overridden = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ posture: "active", reason: "Synthetic explicit override" },
				session.durableConversationId,
			);
			expect(overridden.isError).toBeUndefined();
			expect(decodeResult(overridden).trigger.recentActivityMinIntervalMs).toBe(20_000);
			effective = await policy.effectivePolicy(session.sessionId);
			expect(effective.pacing.burstSettleMs).toBe(1_000);
			expect(effective.pacing.replyCooldownMs).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	test("quietMinutes sets and clears the pacing deadline and notifies the host", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension, policy, promptHooks, quietChanges, quietConversationIds } =
				createExtension(harness.database);
			const set = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ quietMinutes: 30, reason: "Synthetic temporary quiet" },
				session.durableConversationId,
			);
			expect(set.isError).toBeUndefined();
			expect(decodeResult(set).pacing.quietUntilMs).toBe(NOW + 30 * 60_000);
			expect(decodeResult(set).pacing.quietRemainingMinutes).toBe(30);
			expect(await policy.effectivePolicy(session.sessionId)).toMatchObject({
				pacing: { quietUntilMs: NOW + 30 * 60_000 },
			});
			expect(quietChanges).toEqual([NOW + 30 * 60_000]);
			expect(quietConversationIds).toEqual([session.durableConversationId]);

			const clear = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ quietMinutes: 0, reason: "Synthetic clear quiet" },
				session.durableConversationId,
			);
			expect(clear.isError).toBeUndefined();
			expect(decodeResult(clear).pacing.quietUntilMs).toBeNull();
			expect(decodeResult(clear).pacing.quietRemainingMinutes).toBeNull();
			expect((await policy.effectivePolicy(session.sessionId)).pacing.quietUntilMs).toBeUndefined();
			expect(quietChanges).toEqual([NOW + 30 * 60_000, null]);
			expect(promptHooks).toBeDefined();
		} finally {
			await harness.cleanup();
		}
	});

	test("applies bounded granular fields and persists them to the conversation policy", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { audits, extension, policy } = createExtension(harness.database);
			const result = await invokeTool(
				extension,
				"chat_settings_adjust",
				{
					antiRepetitionEnabled: false,
					burstMaxWaitMs: 4_000,
					burstSettleMs: 700,
					gateAmbientGroupReply: true,
					gateUndirectedGroupReply: false,
					groupMentionMode: "smart",
					imageOnly: "ignore",
					maxRepliesPerMinute: 3,
					narrationEnabled: false,
					quietHours: { enabled: true, endHour: 5, startHour: 1 },
					recentActivityEscalation: "always",
					recentActivityMinIntervalMs: 1_234,
					reason: "Synthetic granular tuning",
					replyCooldownMs: 500,
					replyDelayEnabled: true,
					replyDelayMaxMs: 3_000,
					rhythmVarietyEnabled: false,
					stickerOnly: "text-only",
					streamingLineFlushEnabled: false,
				},
				session.durableConversationId,
			);
			expect(result.isError).toBeUndefined();
			const effective = await policy.effectivePolicy(session.sessionId);
			expect(effective.trigger).toMatchObject({
				groupMentionMode: "smart",
				imageOnly: "ignore",
				recentActivityEscalation: "always",
				recentActivityMinIntervalMs: 1_234,
				stickerOnly: "text-only",
			});
			expect(effective.pacing).toMatchObject({
				burstMaxWaitMs: 4_000,
				burstSettleMs: 700,
				maxRepliesPerMinute: 3,
				narrationEnabled: false,
				quietHours: { enabled: true, endHour: 5, startHour: 1 },
				replyCooldownMs: 500,
				replyDelayEnabled: true,
				replyDelayMaxMs: 3_000,
				streamingLineFlushEnabled: false,
			});
			expect(effective.humanization).toMatchObject({
				antiRepetitionEnabled: false,
				rhythmVarietyEnabled: false,
			});
			expect(effective.gate).toMatchObject({
				ambientGroupReply: true,
				undirectedGroupReply: false,
			});
			const audit = audits.findLast((entry) => entry.action === "chat.self-tune");
			expect(audit).toMatchObject({
				action: "chat.self-tune",
				actorKind: "agent",
				result: "ok",
				payload: {
					conversationId: session.sessionId,
					reason: "Synthetic granular tuning",
				},
				targetId: session.sessionId,
				targetKind: "session",
			});
			expect(decodeResult(result)).toMatchObject({
				pacing: { quietHours: { enabled: true, endHour: 5, startHour: 1 } },
				trigger: { recentActivityMinIntervalMs: 1_234 },
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("rejects workspace sessions on every tool", async () => {
		const harness = await createHarness();
		try {
			const workspace = await seedConversation(harness.database, "workspace");
			const { extension } = createExtension(harness.database);
			for (const [name, args] of [
				["chat_settings_get", {}],
				["chat_settings_adjust", { quietMinutes: 10, reason: "Synthetic workspace" }],
				["chat_context_note", { action: "list" }],
			] as const) {
				const result = await invokeTool(extension, name, args, workspace.durableConversationId);
				expect(result.isError).toBe(true);
				expect(resultText(result)).toContain(
					"Chat self-tune tools are only available in chat conversations",
				);
			}
		} finally {
			await harness.cleanup();
		}
	});

	test("rejects unknown and forbidden security, access, capability, and model fields", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension, policy } = createExtension(harness.database);
			const before = await policy.effectivePolicy(session.sessionId);
			for (const forbidden of [
				{ capabilities: ["coding"] },
				{ groupAccess: "open" },
				{ workspaceDelegationEnabled: true },
				{ model: "synthetic-model" },
				{ pacing: { allowedTools: ["bash"] } },
				{ trigger: { allowlist: ["synthetic-user"] } },
			]) {
				const result = await invokeTool(
					extension,
					"chat_settings_adjust",
					{ ...forbidden, reason: "Synthetic forbidden field" },
					session.durableConversationId,
				);
				expect(result.isError).toBe(true);
			}
			for (const forbiddenValue of [
				{ stickerOnly: "wake" },
				{ imageOnly: "wake" },
				{ groupMentionMode: "disabled" },
			]) {
				const result = await invokeTool(
					extension,
					"chat_settings_adjust",
					{ ...forbiddenValue, reason: "Synthetic forbidden value" },
					session.durableConversationId,
				);
				expect(result.isError).toBe(true);
			}
			expect(await policy.effectivePolicy(session.sessionId)).toEqual(before);

			const noChange = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ reason: "Synthetic no-op reason" },
				session.durableConversationId,
			);
			expect(noChange.isError).toBe(true);
			expect(resultText(noChange)).toContain("At least one chat setting change is required");

			const emptyReason = await invokeTool(
				extension,
				"chat_settings_adjust",
				{ quietMinutes: 5, reason: "   " },
				session.durableConversationId,
			);
			expect(emptyReason.isError).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("chat_context_note", () => {
	test("adds next-turn and ongoing notes scoped to the current session", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { audits, extension, promptHooks } = createExtension(harness.database);

			const nextTurn = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "  Stay concise this turn.  ", mode: "next_turn" },
				session.durableConversationId,
			);
			expect(nextTurn.isError).toBeUndefined();
			const nextNote = decodeResult(nextTurn).note;
			expect(nextNote).toMatchObject({
				kind: "context",
				note: "Stay concise this turn.",
				status: "pending",
				tag: null,
			});
			expect(nextNote.expiresAtMs).toBe(NOW + 24 * 60 * 60_000);

			const ongoing = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Ongoing style cue.", mode: "ongoing", ttlMinutes: 5 },
				session.durableConversationId,
			);
			expect(ongoing.isError).toBeUndefined();
			const ongoingNote = decodeResult(ongoing).note;
			expect(ongoingNote).toMatchObject({
				kind: "runtime",
				note: "Ongoing style cue.",
				status: "pending",
			});
			expect(ongoingNote.expiresAtMs).toBe(NOW + 5 * 60_000);

			const stored = await promptHooks.list({
				includeFinished: true,
				sessionId: session.sessionId,
			});
			expect(stored.find((hook) => hook.id === nextNote.id)).toMatchObject({
				createdBy: AGENT_NOTE_CREATED_BY,
				kind: "context",
				status: "pending",
				targetSessionId: session.sessionId,
			});
			expect(stored.find((hook) => hook.id === ongoingNote.id)).toMatchObject({
				createdBy: AGENT_NOTE_CREATED_BY,
				kind: "runtime",
				targetSessionId: session.sessionId,
			});
			expect(audits.filter((entry) => entry.action === "chat.context-note")).toHaveLength(2);
			for (const entry of audits.filter((item) => item.action === "chat.context-note")) {
				expect(entry).toMatchObject({
					actorKind: "agent",
					result: "ok",
					targetId: session.sessionId,
					targetKind: "session",
				});
			}
		} finally {
			await harness.cleanup();
		}
	});

	test("a tag replaces the previous active note with the same tag", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension, promptHooks } = createExtension(harness.database);
			const first = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "First tagged note.", tag: "mood" },
				session.durableConversationId,
			);
			expect(first.isError).toBeUndefined();
			const second = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Second tagged note.", tag: "mood" },
				session.durableConversationId,
			);
			expect(second.isError).toBeUndefined();
			const listed = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "list" },
				session.durableConversationId,
			);
			const notes = decodeResult(listed).notes as Record<string, unknown>[];
			expect(notes).toHaveLength(1);
			expect(notes[0]).toMatchObject({ note: "Second tagged note.", tag: "mood" });
			const all = await promptHooks.list({
				includeFinished: true,
				sessionId: session.sessionId,
			});
			expect(all.find((hook) => hook.id === decodeResult(first).note.id)).toMatchObject({
				status: "cancelled",
			});
			expect(all.find((hook) => hook.id === decodeResult(second).note.id)).toMatchObject({
				status: "pending",
			});
		} finally {
			await harness.cleanup();
		}
	});

	test("list isolates this session's agent notes from system hooks and other sessions", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const other = await seedConversation(harness.database, "private");
			const { extension, promptHooks } = createExtension(harness.database);
			await addSystemHook(promptHooks, {
				kind: "context",
				prompt: "Synthetic system hook.",
				targetSessionId: session.sessionId,
			});
			await promptHooks.add({
				createdBy: AGENT_NOTE_CREATED_BY,
				kind: "runtime",
				prompt: "Other session agent note.",
				targetSessionId: other.sessionId,
			});
			const own = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Own session note." },
				session.durableConversationId,
			);
			expect(own.isError).toBeUndefined();
			const listed = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "list" },
				session.durableConversationId,
			);
			const notes = decodeResult(listed).notes as Record<string, unknown>[];
			expect(notes).toHaveLength(1);
			expect(notes[0]).toMatchObject({
				id: decodeResult(own).note.id,
				note: "Own session note.",
			});
			expect(decodeResult(listed).count).toBe(1);
		} finally {
			await harness.cleanup();
		}
	});

	test("removes agent notes by id or tag but refuses to cancel system hooks", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension, promptHooks } = createExtension(harness.database);
			const added = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Removable note.", tag: "temp" },
				session.durableConversationId,
			);
			expect(added.isError).toBeUndefined();
			const addedId = decodeResult(added).note.id as string;
			const removedById = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "remove", id: addedId },
				session.durableConversationId,
			);
			expect(removedById.isError).toBeUndefined();
			expect(decodeResult(removedById).removedId).toBe(addedId);
			expect(decodeResult(removedById).cancelled).toBe(true);

			const addedAgain = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Removable tagged note.", tag: "temp" },
				session.durableConversationId,
			);
			expect(addedAgain.isError).toBeUndefined();
			const removedByTag = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "remove", tag: "temp" },
				session.durableConversationId,
			);
			expect(removedByTag.isError).toBeUndefined();
			expect(decodeResult(removedByTag).removedId).toBe(decodeResult(addedAgain).note.id);

			const listed = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "list" },
				session.durableConversationId,
			);
			expect(decodeResult(listed).notes).toEqual([]);

			const systemHook = await addSystemHook(promptHooks, {
				kind: "resume",
				prompt: "Synthetic restart hook.",
				targetSessionId: session.sessionId,
			});
			const refusesSystem = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "remove", id: systemHook.id },
				session.durableConversationId,
			);
			expect(refusesSystem.isError).toBe(true);
			expect(resultText(refusesSystem)).toContain("No matching agent context note in this chat");
			const after = await promptHooks.list({
				includeFinished: true,
				sessionId: session.sessionId,
			});
			expect(after.find((hook) => hook.id === systemHook.id)).toMatchObject({
				status: "scheduled",
			});

			const missingSelector = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "remove" },
				session.durableConversationId,
			);
			expect(missingSelector.isError).toBe(true);
		} finally {
			await harness.cleanup();
		}
	});

	test("caps active agent notes at eight and allows tag replacement at the cap", async () => {
		const harness = await createHarness();
		try {
			const session = await seedConversation(harness.database, "group");
			const { extension } = createExtension(harness.database);
			for (let index = 0; index < 8; index += 1) {
				const result = await invokeTool(
					extension,
					"chat_context_note",
					{
						action: "add",
						note: `Active note number ${index}.`,
						...(index === 0 ? { tag: "replaceable" } : {}),
						mode: "ongoing",
					},
					session.durableConversationId,
				);
				expect(result.isError).toBeUndefined();
			}
			const listed = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "list" },
				session.durableConversationId,
			);
			expect(decodeResult(listed).count).toBe(8);

			const ninth = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "add", note: "Ninth active note." },
				session.durableConversationId,
			);
			expect(ninth.isError).toBe(true);
			expect(resultText(ninth)).toContain("remove an old note first");

			const replacement = await invokeTool(
				extension,
				"chat_context_note",
				{
					action: "add",
					note: "Replacement active note.",
					tag: "replaceable",
				},
				session.durableConversationId,
			);
			expect(replacement.isError).toBeUndefined();
			const after = await invokeTool(
				extension,
				"chat_context_note",
				{ action: "list" },
				session.durableConversationId,
			);
			expect(decodeResult(after).count).toBe(8);
		} finally {
			await harness.cleanup();
		}
	});
});
