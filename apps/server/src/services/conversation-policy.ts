import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
	type ConversationPacingPolicy,
	type ConversationPolicy,
	type ConversationPolicyPatch,
	type ConversationPolicyView,
	type ConversationTriggerPolicy,
	conversationPolicySchema,
	defaultConversationPolicy,
	type PersonaBinding,
	type personaPromptUpdateSchema,
	type PersonaSummary,
	type PolicyRevision,
} from "@tsukaima/contracts";
import type { ConversationAgentSettings, PiDurableConversationHost } from "@tsukaima/core";
import {
	chatObjects,
	conversations,
	personaBindings,
	personas,
	policies,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { Logger } from "../logging.ts";
import { readRuntimeSettings } from "../runtime-settings.ts";
import { isUndefined, omit, omitBy } from "es-toolkit";
import type { z } from "zod";
import { PromptConflictError } from "./prompts.ts";

const nowIso = (): string => new Date().toISOString();

const parsePolicy = (value: string): ConversationPolicy => {
	try {
		const parsed = conversationPolicySchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : defaultConversationPolicy;
	} catch {
		return defaultConversationPolicy;
	}
};

const parseAliases = (value: string | null): string[] => {
	if (value === null) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
			: [];
	} catch {
		return [];
	}
};

type PersonaRow = typeof personas.$inferSelect;
type BindingRow = typeof personaBindings.$inferSelect;

/**
 * Persona behavior settings stored in `personas.behavior_json`. Imported DSH personas carry
 * `complete` (the persona is a complete system prompt, so the shared chat base prompt is
 * omitted) and `includeRuntimeContext` (`false` drops runtime facts such as the clock from the
 * turn context). Unknown keys are ignored and `null` means "use the default".
 */
export interface PersonaBehavior {
	readonly complete: boolean;
	readonly includeRuntimeContext: boolean;
}

export const DEFAULT_PERSONA_BEHAVIOR: PersonaBehavior = {
	complete: false,
	includeRuntimeContext: true,
};

export function parsePersonaBehavior(json: string | null | undefined): PersonaBehavior {
	if (json === null || json === undefined || json.trim().length === 0) {
		return DEFAULT_PERSONA_BEHAVIOR;
	}
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return DEFAULT_PERSONA_BEHAVIOR;
		}
		const record = parsed as Record<string, unknown>;
		return {
			complete:
				typeof record.complete === "boolean" ? record.complete : DEFAULT_PERSONA_BEHAVIOR.complete,
			includeRuntimeContext:
				typeof record.includeRuntimeContext === "boolean"
					? record.includeRuntimeContext
					: DEFAULT_PERSONA_BEHAVIOR.includeRuntimeContext,
		};
	} catch {
		return DEFAULT_PERSONA_BEHAVIOR;
	}
}

const toPersonaSummary = (row: PersonaRow): PersonaSummary => {
	let prompt = "";
	try {
		const parsed: unknown = JSON.parse(row.promptJson);
		prompt = typeof parsed === "string" ? parsed : row.promptJson;
	} catch {
		prompt = row.promptJson;
	}
	return {
		createdAt: row.createdAt,
		id: row.id,
		isActive: row.isActive === 1,
		name: row.name,
		prompt,
		selfAliases: parseAliases(row.aliasesJson),
		summary: row.summary,
		version: row.version,
	};
};

const toBinding = (row: BindingRow): PersonaBinding => ({
	chatKind: row.chatKind ?? null,
	chatObjectId: row.chatObjectId ?? null,
	conversationId: row.conversationId ?? null,
	createdAt: row.createdAt,
	id: row.id,
	isActive: row.isActive === 1,
	isGlobal: row.isGlobal === 1,
	personaId: row.personaId,
});

const toRevision = (row: typeof policies.$inferSelect): PolicyRevision => ({
	conversationId: row.conversationId ?? null,
	createdAt: row.createdAt,
	id: row.id,
	isActive: row.isActive === 1,
	policy: parsePolicy(row.policyJson),
	scope: row.scope === "conversation" ? "conversation" : "global",
	updatedAt: row.updatedAt,
});

const mergeSection = <T extends Record<string, unknown>>(
	base: T,
	patch: Record<string, unknown> | undefined,
): T => (patch === undefined ? { ...base } : { ...base, ...omitBy(patch, isUndefined) }) as T;

export function mergeConversationPolicy(
	base: ConversationPolicy,
	patch: ConversationPolicyPatch,
): ConversationPolicy {
	const pacingPatch = patch.pacing;
	const triggerPatch = patch.trigger;
	const sidechatPatch = patch.sidechat;
	const pacing = mergeSection<ConversationPacingPolicy>(base.pacing, pacingPatch);
	if (pacingPatch?.allowedTools === null) delete pacing.allowedTools;
	if (pacingPatch?.quietUntilMs === null) delete pacing.quietUntilMs;
	const trigger = mergeSection<ConversationTriggerPolicy>(base.trigger, triggerPatch);
	const sidechat = mergeSection<ConversationPolicy["sidechat"]>(base.sidechat, sidechatPatch);
	if (sidechatPatch?.model === null) delete sidechat.model;
	if (sidechatPatch?.interjectModel === null) delete sidechat.interjectModel;
	const compaction = mergeSection<ConversationPolicy["compaction"]>(
		base.compaction,
		patch.compaction,
	);
	const notices = mergeSection<ConversationPolicy["notices"]>(base.notices, patch.notices);
	const generationPatch = patch.generation;
	const generation = mergeSection<ConversationPolicy["generation"]>(
		base.generation,
		generationPatch,
	);
	// `null` clears a sampling override so the provider model's own value applies again.
	if (generationPatch?.temperature === null) delete generation.temperature;
	if (generationPatch?.topP === null) delete generation.topP;
	if (generationPatch?.stop === null) delete generation.stop;
	const crossSession = mergeSection<ConversationPolicy["crossSession"]>(
		base.crossSession,
		patch.crossSession,
	);
	const memoryConsolidation = mergeSection<ConversationPolicy["memoryConsolidation"]>(
		base.memoryConsolidation,
		patch.memoryConsolidation,
	);
	const social = mergeSection<ConversationPolicy["social"]>(base.social, patch.social);
	const humanization = mergeSection<ConversationPolicy["humanization"]>(
		base.humanization,
		patch.humanization,
	);
	const gatePatch = patch.gate;
	const gate = mergeSection<ConversationPolicy["gate"]>(base.gate, gatePatch);
	if (gatePatch?.model === null) delete gate.model;
	const memoryExtractModel =
		patch.memoryExtractModel === null
			? undefined
			: (patch.memoryExtractModel ?? base.memoryExtractModel);
	const model = patch.model === null ? undefined : (patch.model ?? base.model);
	const thinking = patch.thinking === null ? undefined : (patch.thinking ?? base.thinking);
	const baseRest = omit(base, ["memoryExtractModel", "model", "thinking"]);
	const topLevelPatch = omitBy(
		{
			capabilities: patch.capabilities,
			enabled: patch.enabled,
			followUpWhenBusy: patch.followUpWhenBusy,
			memoryCompactionEnabled: patch.memoryCompactionEnabled,
			memoryEnabled: patch.memoryEnabled,
			memoryExtractModel,
			memoryExtractionPromptVersion: patch.memoryExtractionPromptVersion,
			memoryMaxWritesPerActivity: patch.memoryMaxWritesPerActivity,
			memoryMinConfidence: patch.memoryMinConfidence,
			memoryReviewRequired: patch.memoryReviewRequired,
			model,
			sandboxWorkspaceEnabled: patch.sandboxWorkspaceEnabled,
			sharedMemoryEnabled: patch.sharedMemoryEnabled,
			sharedMemoryWriteEnabled: patch.sharedMemoryWriteEnabled,
			steerWhenBusy: patch.steerWhenBusy,
			thinking,
			version: patch.version,
			workspaceDelegationEnabled: patch.workspaceDelegationEnabled,
		},
		isUndefined,
	);
	return conversationPolicySchema.parse({
		...baseRest,
		...topLevelPatch,
		compaction,
		crossSession,
		gate,
		generation,
		humanization,
		memoryConsolidation,
		notices,
		pacing,
		sidechat,
		social,
		trigger,
	});
}

export interface ConversationPolicyServiceOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
	/** Called after a policy revision is synced to the durable host so tool access refreshes immediately. */
	readonly onPolicySynced?: (
		durableConversationId: string,
		policy: ConversationPolicy,
	) => Promise<void> | void;
}

/**
 * Owns effective conversation policy resolution, revision history, durable-document sync,
 * and persona binding precedence. Channel plugins never see or duplicate these rules.
 */
export class ConversationPolicyService {
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #logger: Logger;
	readonly #onPolicySynced: ConversationPolicyServiceOptions["onPolicySynced"];
	readonly #synced = new Map<string, string>();

	constructor(options: ConversationPolicyServiceOptions) {
		this.#database = options.database;
		this.#host = options.host;
		this.#logger = options.logger.child("tsukaima::server::policy");
		this.#onPolicySynced = options.onPolicySynced;
	}

	#db(): TsukaimaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async globalRevision(): Promise<PolicyRevision | undefined> {
		const rows = await this.#db()
			.select()
			.from(policies)
			.where(and(eq(policies.scope, "global"), eq(policies.isActive, 1)))
			.orderBy(desc(policies.createdAt), desc(policies.id));
		return rows.map(toRevision).toSorted((a, b) => b.policy.version - a.policy.version)[0];
	}

	async conversationRevision(conversationId: string): Promise<PolicyRevision | undefined> {
		const rows = await this.#db()
			.select()
			.from(policies)
			.where(
				and(
					eq(policies.scope, "conversation"),
					eq(policies.conversationId, conversationId),
					eq(policies.isActive, 1),
				),
			)
			.orderBy(desc(policies.createdAt), desc(policies.id));
		return rows.map(toRevision).toSorted((a, b) => b.policy.version - a.policy.version)[0];
	}

	async resolveConversationId(input: {
		chatObjectId?: string;
		conversationId?: string;
	}): Promise<string | undefined> {
		if (input.conversationId !== undefined) return input.conversationId;
		if (input.chatObjectId === undefined) return undefined;
		const database = this.#db();
		const [receiving] = await database
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.chatObjectId, input.chatObjectId),
					eq(conversations.isReceiving, 1),
					eq(conversations.status, "active"),
				),
			)
			.limit(1);
		if (receiving !== undefined) return receiving.id;
		const [latest] = await database
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(eq(conversations.chatObjectId, input.chatObjectId), eq(conversations.status, "active")),
			)
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		return latest?.id;
	}

	async effectivePolicy(conversationId?: string): Promise<ConversationPolicy> {
		const global = await this.globalRevision();
		const base = global?.policy ?? defaultConversationPolicy;
		if (conversationId === undefined) return base;
		const conversation = await this.conversationRevision(conversationId);
		return conversation?.policy ?? base;
	}

	/**
	 * Copy an active conversation-scoped policy override to a newly opened session under the same
	 * chat so per-chat settings survive daily rollover or manual session creation.
	 */
	async inheritConversationPolicy(
		sourceConversationId: string,
		targetConversationId: string,
	): Promise<boolean> {
		if (sourceConversationId === targetConversationId) return false;
		const source = await this.conversationRevision(sourceConversationId);
		if (source === undefined) return false;
		const existing = await this.conversationRevision(targetConversationId);
		if (existing !== undefined) return false;
		const now = nowIso();
		await this.#db()
			.insert(policies)
			.values({
				conversationId: targetConversationId,
				createdAt: now,
				id: randomUUID(),
				isActive: 1,
				policyJson: JSON.stringify(source.policy),
				scope: "conversation",
				updatedAt: now,
			});
		return true;
	}

	/**
	 * Agent model and effort for one conversation. A conversation override wins, then the
	 * matching runtime default (workspace vs. chat), then the active provider's default.
	 * `null` deliberately resets the durable agent setting to that final fallback.
	 */
	async agentSettingsForConversation(
		conversationId: string,
		policy?: ConversationPolicy,
	): Promise<ConversationAgentSettings> {
		const database = this.#db();
		const [row] = await database
			.select({ chatKind: chatObjects.kind, sessionKind: conversations.kind })
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.id, conversationId))
			.limit(1);
		const surface =
			(row?.chatKind ?? row?.sessionKind) === "workspace"
				? ("workspace" as const)
				: ("chat" as const);
		const settings = await readRuntimeSettings(database);
		const effective = policy ?? (await this.effectivePolicy(conversationId));
		const model =
			effective.model ?? (surface === "workspace" ? settings.workspaceModel : settings.chatModel);
		const thinking =
			effective.thinking ??
			(surface === "workspace" ? settings.workspaceThinking : settings.chatThinking);
		return {
			model: model ?? null,
			thinkingLevel: thinking ?? null,
		};
	}

	/** Explicit capability grants for a domain conversation id. */
	async capabilities(conversationId?: string): Promise<readonly string[]> {
		const policy = await this.effectivePolicy(conversationId);
		return policy.capabilities;
	}

	/**
	 * Resolve capabilities from the durable conversation id the model/tool runtime uses.
	 * Unknown conversations deliberately get no capabilities.
	 */
	async capabilitiesForDurableConversation(
		durableConversationId: string,
	): Promise<readonly string[]> {
		const database = this.#db();
		const [row] = await database
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.limit(1);
		if (row === undefined) {
			const [direct] = await database
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, durableConversationId))
				.limit(1);
			return direct === undefined ? [] : this.capabilities(direct.id);
		}
		return this.capabilities(row.id);
	}

	/**
	 * Execution role of a durable conversation (`workspace`, `webui`, `private`, `group`, ...).
	 * `undefined` means the conversation is not (or not yet) in the domain database.
	 */
	async roleForDurableConversation(durableConversationId: string): Promise<string | undefined> {
		const database = this.#db();
		const [row] = await database
			.select({ chatKind: chatObjects.kind, sessionKind: conversations.kind })
			.from(conversations)
			.leftJoin(chatObjects, eq(chatObjects.id, conversations.chatObjectId))
			.where(eq(conversations.durableConversationId, durableConversationId))
			.limit(1);
		return row?.chatKind ?? row?.sessionKind;
	}

	async view(
		input: { chatObjectId?: string; conversationId?: string } = {},
	): Promise<ConversationPolicyView> {
		const conversationId = await this.resolveConversationId(input);
		const [global, conversation] = await Promise.all([
			this.globalRevision(),
			conversationId === undefined
				? Promise.resolve(undefined)
				: this.conversationRevision(conversationId),
		]);
		const policy = conversation?.policy ?? global?.policy ?? defaultConversationPolicy;
		const source =
			conversation !== undefined
				? {
						conversationId: conversation.conversationId,
						revisionId: conversation.id,
						scope: "conversation" as const,
						version: conversation.policy.version,
					}
				: global !== undefined
					? {
							conversationId: conversationId ?? null,
							revisionId: global.id,
							scope: "global" as const,
							version: global.policy.version,
						}
					: {
							conversationId: conversationId ?? null,
							revisionId: null,
							scope: "default" as const,
							version: policy.version,
						};
		return {
			conversation: conversation ?? null,
			global: global ?? null,
			policy,
			source,
		};
	}

	async update(input: {
		conversationId?: string;
		policy: ConversationPolicyPatch;
		scope: "global" | "conversation";
	}): Promise<ConversationPolicyView> {
		if (input.scope === "conversation" && input.conversationId === undefined) {
			throw new Error("conversationId is required for a conversation policy update");
		}
		if (input.conversationId !== undefined) {
			const [session] = await this.#db()
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, input.conversationId))
				.limit(1);
			if (session === undefined) throw new Error("Conversation not found");
		}
		const base =
			input.scope === "global"
				? ((await this.globalRevision())?.policy ?? defaultConversationPolicy)
				: await this.effectivePolicy(input.conversationId);
		const merged = mergeConversationPolicy(base, input.policy);
		const database = this.#db();
		const version = await this.#nextPolicyVersion(input);
		const next = conversationPolicySchema.parse({ ...merged, version });
		const now = nowIso();
		const id = randomUUID();
		await database.transaction((tx) => {
			tx.update(policies)
				.set({ isActive: 0, updatedAt: now })
				.where(
					input.scope === "global"
						? and(eq(policies.scope, "global"), eq(policies.isActive, 1))
						: and(
								eq(policies.scope, "conversation"),
								eq(policies.conversationId, input.conversationId ?? ""),
								eq(policies.isActive, 1),
							),
				)
				.run();
			tx.insert(policies)
				.values({
					conversationId: input.scope === "conversation" ? input.conversationId : null,
					createdAt: now,
					id,
					isActive: 1,
					policyJson: JSON.stringify(next),
					scope: input.scope,
					updatedAt: now,
				})
				.run();
		});
		if (input.scope === "global") {
			await this.syncAllHosts();
		} else if (input.conversationId !== undefined) {
			await this.syncHostPolicy(input.conversationId, next);
		}
		this.#logger.info("conversation policy updated", {
			conversationId: input.conversationId,
			revision: id,
			scope: input.scope,
			version: next.version,
		});
		return this.view(
			input.conversationId === undefined ? {} : { conversationId: input.conversationId },
		);
	}

	/**
	 * Save the patch as the new global default, then replace every conversation policy with
	 * that exact snapshot. Unlike a normal global update, this deliberately removes existing
	 * per-conversation overrides so one action can align every session.
	 */
	async overrideAll(input: {
		policy: ConversationPolicyPatch;
	}): Promise<{ updated: number; view: ConversationPolicyView }> {
		const view = await this.update({ policy: input.policy, scope: "global" });
		const rows = await this.#db().select({ id: conversations.id }).from(conversations);
		for (const row of rows) {
			await this.#replaceConversationPolicy(row.id, view.policy);
		}
		this.#logger.info("conversation policy overridden for all conversations", {
			conversations: rows.length,
			version: view.policy.version,
		});
		return { updated: rows.length, view };
	}

	async #nextPolicyVersion(input: {
		conversationId?: string;
		scope: "global" | "conversation";
	}): Promise<number> {
		const rows = await this.#db()
			.select({ policyJson: policies.policyJson })
			.from(policies)
			.where(
				input.scope === "global"
					? eq(policies.scope, "global")
					: and(
							eq(policies.scope, "conversation"),
							eq(policies.conversationId, input.conversationId ?? ""),
						),
			);
		return (Math.max(0, ...rows.map((row) => parsePolicy(row.policyJson).version)) ?? 0) + 1;
	}

	async #replaceConversationPolicy(
		conversationId: string,
		policy: ConversationPolicy,
	): Promise<void> {
		const database = this.#db();
		const version = await this.#nextPolicyVersion({ conversationId, scope: "conversation" });
		const next = conversationPolicySchema.parse({ ...policy, version });
		const now = nowIso();
		const id = randomUUID();
		await database.transaction((tx) => {
			tx.update(policies)
				.set({ isActive: 0, updatedAt: now })
				.where(
					and(
						eq(policies.scope, "conversation"),
						eq(policies.conversationId, conversationId),
						eq(policies.isActive, 1),
					),
				)
				.run();
			tx.insert(policies)
				.values({
					conversationId,
					createdAt: now,
					id,
					isActive: 1,
					policyJson: JSON.stringify(next),
					scope: "conversation",
					updatedAt: now,
				})
				.run();
		});
		await this.syncHostPolicy(conversationId, next);
	}

	async history(input: {
		conversationId?: string;
		scope: "global" | "conversation";
	}): Promise<PolicyRevision[]> {
		const rows = await this.#db()
			.select()
			.from(policies)
			.where(
				input.scope === "global"
					? eq(policies.scope, "global")
					: and(
							eq(policies.scope, "conversation"),
							eq(policies.conversationId, input.conversationId ?? ""),
						),
			)
			.orderBy(desc(policies.createdAt), desc(policies.id));
		return rows.map(toRevision);
	}

	/**
	 * Sync the durable `tsukaima.conversationPolicy` document before an inbound append. The
	 * signature cache avoids a durable commit on every message while still reflecting global
	 * or conversation changes on the next turn.
	 */
	async ensureHostPolicy(
		conversationId: string,
		durableConversationId = conversationId,
	): Promise<ConversationPolicy> {
		const policy = await this.effectivePolicy(conversationId);
		const agentSettings = await this.agentSettingsForConversation(conversationId, policy);
		const signature = JSON.stringify({ agentSettings, policy });
		const key = `${conversationId}\0${durableConversationId}`;
		if (this.#synced.get(key) === signature) return policy;
		try {
			const host = this.#host();
			if (host !== undefined) {
				await host.updatePolicy(durableConversationId, policy, agentSettings);
				await this.#onPolicySynced?.(durableConversationId, policy);
				this.#synced.set(key, signature);
			}
		} catch (error) {
			this.#logger.warn("durable policy sync failed", {
				conversationId,
				durableConversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return policy;
	}

	private async syncHostPolicy(conversationId: string, policy: ConversationPolicy): Promise<void> {
		try {
			const [session] = await this.#db()
				.select({ durableConversationId: conversations.durableConversationId })
				.from(conversations)
				.where(eq(conversations.id, conversationId))
				.limit(1);
			if (session === undefined) return;
			const agentSettings = await this.agentSettingsForConversation(conversationId, policy);
			await this.#host()?.updatePolicy(session.durableConversationId, policy, agentSettings);
			await this.#onPolicySynced?.(session.durableConversationId, policy);
			this.#synced.set(
				`${conversationId}\0${session.durableConversationId}`,
				JSON.stringify({ agentSettings, policy }),
			);
		} catch (error) {
			this.#logger.warn("durable policy revision sync failed", {
				conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async syncAllHosts(): Promise<void> {
		const rows = await this.#db()
			.select({
				durableConversationId: conversations.durableConversationId,
				id: conversations.id,
			})
			.from(conversations);
		for (const row of rows) {
			await this.ensureHostPolicy(row.id, row.durableConversationId);
		}
	}

	/** Re-apply effective agent settings after a runtime default or provider change. */
	async refreshAgentSettings(): Promise<void> {
		this.#synced.clear();
		await this.syncAllHosts();
	}

	/** Merge policy aliases with the active bound persona aliases for trigger classification. */
	async selfAliases(conversationId: string, policy: ConversationPolicy): Promise<string[]> {
		const aliases = new Set(policy.trigger.selfAliases);
		try {
			const database = this.#db();
			const [session] = await database
				.select({
					chatId: conversations.chatObjectId,
					id: conversations.id,
					kind: conversations.kind,
				})
				.from(conversations)
				.where(eq(conversations.id, conversationId))
				.limit(1);
			if (session === undefined) return [...aliases];
			const persona = await this.#resolvePersona(database, {
				chatKind: session.kind,
				chatObjectId: session.chatId,
				conversationId: session.id,
			});
			if (persona?.name !== undefined && persona.name.trim().length > 0) {
				aliases.add(persona.name.trim());
			}
			for (const alias of persona?.selfAliases ?? []) aliases.add(alias);
		} catch (error) {
			this.#logger.warn("persona alias resolution failed", {
				conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return [...aliases];
	}

	async personaForSession(session: {
		chatKind: string;
		chatObjectId: string | null;
		conversationId: string;
	}): Promise<PersonaSummary | undefined> {
		return this.#resolvePersona(this.#db(), session);
	}

	/** The bound persona together with its stored behavior settings. */
	async personaProfileForSession(session: {
		chatKind: string;
		chatObjectId: string | null;
		conversationId: string;
	}): Promise<{ behavior: PersonaBehavior; persona: PersonaSummary } | undefined> {
		const row = await this.#resolvePersonaRow(this.#db(), session);
		return row === undefined
			? undefined
			: { behavior: parsePersonaBehavior(row.behaviorJson), persona: toPersonaSummary(row) };
	}

	async #resolvePersona(
		database: TsukaimaDatabase,
		session: { chatKind: string; chatObjectId: string | null; conversationId: string },
	): Promise<PersonaSummary | undefined> {
		const row = await this.#resolvePersonaRow(database, session);
		return row === undefined ? undefined : toPersonaSummary(row);
	}

	async #resolvePersonaRow(
		database: TsukaimaDatabase,
		session: { chatKind: string; chatObjectId: string | null; conversationId: string },
	): Promise<PersonaRow | undefined> {
		const active = await database
			.select()
			.from(personaBindings)
			.where(eq(personaBindings.isActive, 1))
			.orderBy(desc(personaBindings.createdAt));
		const conversation =
			active.find((row) => row.conversationId === session.conversationId) ?? undefined;
		const chatObject =
			session.chatObjectId === null
				? undefined
				: active.find((row) => row.chatObjectId === session.chatObjectId);
		const chatKind = active.find(
			(row) =>
				row.isGlobal === 0 &&
				row.chatKind !== null &&
				row.chatKind === session.chatKind &&
				row.chatObjectId === null &&
				row.conversationId === null,
		);
		const global = active.find((row) => row.isGlobal === 1);
		const binding = conversation ?? chatObject ?? chatKind ?? global;
		if (binding === undefined) return undefined;
		const [persona] = await database
			.select()
			.from(personas)
			.where(and(eq(personas.id, binding.personaId), eq(personas.isActive, 1)))
			.orderBy(desc(personas.version))
			.limit(1);
		return persona;
	}

	async listPersonas(): Promise<PersonaSummary[]> {
		const rows = await this.#db()
			.select()
			.from(personas)
			.orderBy(desc(personas.createdAt), desc(personas.version));
		return rows.map(toPersonaSummary);
	}

	updatePersonaPrompt(input: z.infer<typeof personaPromptUpdateSchema>, actor: "agent" | "user") {
		return this.#db().transaction((tx) => {
			const rows = tx
				.select()
				.from(personas)
				.where(eq(personas.id, input.id))
				.orderBy(desc(personas.version))
				.all();
			const active = rows.find((row) => row.isActive === 1);
			const latest = rows[0];
			if (active === undefined || latest === undefined || active.version !== input.version) {
				throw new PromptConflictError();
			}
			const next = {
				...active,
				createdAt: nowIso(),
				createdBy: actor === "agent" ? "agent" : "webui-admin",
				promptJson: JSON.stringify(input.prompt),
				version: latest.version + 1,
			};
			tx.update(personas).set({ isActive: 0 }).where(eq(personas.id, input.id)).run();
			tx.insert(personas).values(next).run();
			return toPersonaSummary(next);
		});
	}

	async upsertPersona(input: {
		id?: string;
		isActive?: boolean;
		name: string;
		prompt: string;
		selfAliases?: string[];
		summary: string;
		version?: number;
	}): Promise<PersonaSummary> {
		const database = this.#db();
		const id = input.id ?? randomUUID();
		return database.transaction((tx) => {
			const existing = tx
				.select()
				.from(personas)
				.where(eq(personas.id, id))
				.orderBy(desc(personas.version))
				.all();
			const highest = existing[0];
			const maxVersion = highest?.version ?? 0;
			let version = input.version ?? maxVersion + 1;
			if (existing.some((row) => row.version === version)) version = maxVersion + 1;
			const isActive = input.isActive ?? true;
			const aliases = [
				...new Set(
					input.selfAliases ?? (highest === undefined ? [] : parseAliases(highest.aliasesJson)),
				),
			];
			const now = nowIso();
			const behavior = highest?.behaviorJson ?? "{}";
			const row = {
				aliasesJson: JSON.stringify(aliases),
				behaviorJson: behavior,
				createdAt: now,
				createdBy: "webui-admin",
				id,
				isActive: isActive ? 1 : 0,
				modelPolicyId: null,
				name: input.name,
				promptJson: JSON.stringify(input.prompt),
				summary: input.summary,
				version,
			};
			if (isActive) {
				tx.update(personas)
					.set({ isActive: 0 })
					.where(and(eq(personas.id, id), sql`${personas.version} <> ${version}`))
					.run();
			}
			tx.insert(personas).values(row).run();
			return toPersonaSummary(row);
		});
	}

	async bindPersona(input: {
		chatKind?: "private" | "group";
		chatObjectId?: string;
		conversationId?: string;
		personaId: string;
		scope: "global" | "chat-kind" | "chat-object" | "conversation";
	}): Promise<PersonaBinding> {
		const database = this.#db();
		const [persona] = await database
			.select()
			.from(personas)
			.where(and(eq(personas.id, input.personaId), eq(personas.isActive, 1)))
			.limit(1);
		if (persona === undefined) throw new Error("Active persona not found");
		if (input.scope === "chat-kind" && input.chatKind === undefined) {
			throw new Error("chatKind is required for a chat-kind binding");
		}
		if (input.scope === "chat-object" && input.chatObjectId === undefined) {
			throw new Error("chatObjectId is required for a chat-object binding");
		}
		if (input.scope === "conversation" && input.conversationId === undefined) {
			throw new Error("conversationId is required for a conversation binding");
		}
		if (input.chatObjectId !== undefined) {
			const [chat] = await database
				.select({ id: chatObjects.id })
				.from(chatObjects)
				.where(eq(chatObjects.id, input.chatObjectId))
				.limit(1);
			if (chat === undefined) throw new Error("Chat object not found");
		}
		if (input.conversationId !== undefined) {
			const [session] = await database
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, input.conversationId))
				.limit(1);
			if (session === undefined) throw new Error("Conversation not found");
		}
		const id = randomUUID();
		const now = nowIso();
		const isGlobal = input.scope === "global" ? 1 : 0;
		const chatKind = input.scope === "chat-kind" ? (input.chatKind ?? null) : null;
		const chatObjectId = input.scope === "chat-object" ? (input.chatObjectId ?? null) : null;
		const conversationId = input.scope === "conversation" ? (input.conversationId ?? null) : null;
		await database.transaction((tx) => {
			const scopeCondition =
				input.scope === "global"
					? eq(personaBindings.isGlobal, 1)
					: input.scope === "chat-kind"
						? and(
								eq(personaBindings.isGlobal, 0),
								eq(personaBindings.chatKind, input.chatKind ?? "private"),
								isNull(personaBindings.chatObjectId),
								isNull(personaBindings.conversationId),
							)
						: input.scope === "chat-object"
							? and(
									eq(personaBindings.isGlobal, 0),
									eq(personaBindings.chatObjectId, input.chatObjectId ?? ""),
								)
							: and(
									eq(personaBindings.isGlobal, 0),
									eq(personaBindings.conversationId, input.conversationId ?? ""),
								);
			tx.update(personaBindings)
				.set({ isActive: 0 })
				.where(and(eq(personaBindings.isActive, 1), scopeCondition))
				.run();
			tx.insert(personaBindings)
				.values({
					chatKind,
					chatObjectId,
					conversationId,
					createdAt: now,
					id,
					isActive: 1,
					isGlobal,
					personaId: input.personaId,
				})
				.run();
		});
		return {
			chatKind,
			chatObjectId,
			conversationId,
			createdAt: now,
			id,
			isActive: true,
			isGlobal: isGlobal === 1,
			personaId: input.personaId,
		};
	}

	async listBindings(): Promise<PersonaBinding[]> {
		const rows = await this.#db()
			.select()
			.from(personaBindings)
			.where(eq(personaBindings.isActive, 1))
			.orderBy(desc(personaBindings.createdAt));
		return rows.map(toBinding);
	}
}
