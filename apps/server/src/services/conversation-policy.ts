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
	type PersonaSummary,
	type PolicyRevision,
} from "@elaina/contracts";
import type { PiDurableConversationHost } from "@elaina/core";
import {
	chatObjects,
	conversations,
	personaBindings,
	personas,
	policies,
	type ElainaDatabase,
} from "@elaina/db";
import type { Logger } from "../logging.ts";

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
): T => {
	if (patch === undefined) return { ...base };
	const next: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) next[key] = value;
	}
	return next as T;
};

export function mergeConversationPolicy(
	base: ConversationPolicy,
	patch: ConversationPolicyPatch,
): ConversationPolicy {
	const pacingPatch = patch.pacing;
	const triggerPatch = patch.trigger;
	const pacing = mergeSection<ConversationPacingPolicy>(base.pacing, pacingPatch);
	if (pacingPatch?.allowedTools === null) delete pacing.allowedTools;
	const trigger = mergeSection<ConversationTriggerPolicy>(base.trigger, triggerPatch);
	return conversationPolicySchema.parse({
		...base,
		...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
		...(patch.followUpWhenBusy === undefined ? {} : { followUpWhenBusy: patch.followUpWhenBusy }),
		...(patch.steerWhenBusy === undefined ? {} : { steerWhenBusy: patch.steerWhenBusy }),
		...(patch.version === undefined ? {} : { version: patch.version }),
		pacing,
		trigger,
	});
}

export interface ConversationPolicyServiceOptions {
	readonly database: () => ElainaDatabase | undefined;
	readonly host: () => PiDurableConversationHost | undefined;
	readonly logger: Logger;
}

/**
 * Owns effective conversation policy resolution, revision history, durable-document sync,
 * and persona binding precedence. Channel plugins never see or duplicate these rules.
 */
export class ConversationPolicyService {
	readonly #database: () => ElainaDatabase | undefined;
	readonly #host: () => PiDurableConversationHost | undefined;
	readonly #logger: Logger;
	readonly #synced = new Map<string, string>();

	constructor(options: ConversationPolicyServiceOptions) {
		this.#database = options.database;
		this.#host = options.host;
		this.#logger = options.logger.child("elaina::server::policy");
	}

	#db(): ElainaDatabase {
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
		const version =
			(Math.max(
				0,
				...(
					await database
						.select({ policyJson: policies.policyJson })
						.from(policies)
						.where(
							input.scope === "global"
								? eq(policies.scope, "global")
								: and(
										eq(policies.scope, "conversation"),
										eq(policies.conversationId, input.conversationId ?? ""),
									),
						)
				).map((row) => parsePolicy(row.policyJson).version),
			) ?? 0) + 1;
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
	 * Sync the durable `elaina.conversationPolicy` document before an inbound append. The
	 * signature cache avoids a durable commit on every message while still reflecting global
	 * or conversation changes on the next turn.
	 */
	async ensureHostPolicy(
		conversationId: string,
		durableConversationId = conversationId,
	): Promise<ConversationPolicy> {
		const policy = await this.effectivePolicy(conversationId);
		const signature = JSON.stringify(policy);
		const key = `${conversationId}\0${durableConversationId}`;
		if (this.#synced.get(key) === signature) return policy;
		try {
			const host = this.#host();
			if (host !== undefined) {
				await host.updatePolicy(durableConversationId, policy);
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
			await this.#host()?.updatePolicy(session.durableConversationId, policy);
			this.#synced.set(
				`${conversationId}\0${session.durableConversationId}`,
				JSON.stringify(policy),
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

	async #resolvePersona(
		database: ElainaDatabase,
		session: { chatKind: string; chatObjectId: string | null; conversationId: string },
	): Promise<PersonaSummary | undefined> {
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
		return persona === undefined ? undefined : toPersonaSummary(persona);
	}

	async listPersonas(): Promise<PersonaSummary[]> {
		const rows = await this.#db()
			.select()
			.from(personas)
			.orderBy(desc(personas.createdAt), desc(personas.version));
		return rows.map(toPersonaSummary);
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
		const existing = await database
			.select()
			.from(personas)
			.where(eq(personas.id, id))
			.orderBy(desc(personas.version));
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
		await database.transaction((tx) => {
			if (isActive) {
				tx.update(personas)
					.set({ isActive: 0 })
					.where(and(eq(personas.id, id), sql`${personas.version} <> ${version}`))
					.run();
			}
			tx.insert(personas)
				.values({
					aliasesJson: JSON.stringify(aliases),
					behaviorJson: behavior,
					createdAt: now,
					createdBy: "webui-admin",
					id,
					isActive: isActive ? 1 : 0,
					name: input.name,
					promptJson: JSON.stringify(input.prompt),
					summary: input.summary,
					version,
				})
				.run();
		});
		return toPersonaSummary({
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
