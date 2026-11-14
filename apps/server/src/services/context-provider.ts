import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { ContextPromptProvider } from "@elaina/core";
import type { ConversationPolicy } from "@elaina/contracts";
import {
	conversationMembers,
	conversations,
	memories,
	messages,
	type ElainaDatabase,
} from "@elaina/db";
import { previewText, type Logger } from "../logging.ts";
import { ConversationPolicyService } from "./conversation-policy.ts";
import { MemoryService, type RankedMemory } from "./memory-service.ts";

/**
 * Combined persona + memory character budget for one request, in characters (not tokens,
 * so it stays independent of any tokenizer). The persona takes the first
 * `PERSONA_BUDGET_FRACTION`; memories may use the rest, so the combined text never exceeds
 * this budget.
 */
export const PROMPT_BUDGET_CHARS = 4_000;
/** Persona's share of {@link PROMPT_BUDGET_CHARS}; memories get the remainder. */
const PERSONA_BUDGET_FRACTION = 0.4;
const DEFAULT_MEMORY_TOP_K = 10;
const RECENT_MESSAGE_LIMIT = 6;
const RECENT_TIER_MIN_BUDGET = 260;
const MEMORY_SNIPPET_LIMIT = 180;
const RECENT_SNIPPET_LIMIT = 120;
const PERSONA_TRUNCATION_NOTE = "[persona truncated to fit the context budget]";
const MEMORY_TRUNCATION_NOTE = "[memories truncated to fit the context budget]";
const RECENT_HEADER = "Recent conversation window:";
const WARM_HEADER = "Warm session state:";
const LONG_TERM_HEADER = "Known memories, most relevant first:";

/**
 * Resolves the persona and memory text for one durable conversation and keeps it inside a
 * character budget. Every failure degrades to `undefined` (the section is omitted) — prompt
 * rendering must never break a model run — and memory content is never written to logs.
 *
 * Memory retrieval is tiered: a bounded recent-message window, the latest additive warm
 * summary (`kind = 'summary'`), then hybrid-ranked long-term memories. Conversation policy
 * gates long-term recall and prevents private/group scope leakage.
 */
export interface DrizzleContextProviderOptions {
	readonly database: () => ElainaDatabase | undefined;
	readonly logger: Logger;
	/** Combined persona + memory budget override; mainly for tests. */
	readonly budgetChars?: number;
	/** Maximum memories injected per request; mainly for tests. */
	readonly memoryTopK?: number;
	/** Shared policy resolution; a database-backed service is created when omitted. */
	readonly policyService?: ConversationPolicyService;
	/** Shared memory service (hybrid recall, warm state); created internally when omitted. */
	readonly memoryService?: MemoryService;
}

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function truncateChars(text: string, max: number, note: string): string {
	if (text.length <= max) return text;
	const suffix = `\n${note}`;
	if (suffix.length >= max) return suffix.slice(0, max);
	return `${text.slice(0, max - suffix.length)}${suffix}`;
}

function personaText(persona: {
	readonly name: string;
	readonly prompt: string;
	readonly summary: string;
}): string | undefined {
	const prompt = persona.prompt.trim();
	if (prompt.length > 0) return prompt;
	const summary = persona.summary.trim();
	if (summary.length > 0) return `${persona.name}: ${summary}`;
	return persona.name.trim().length > 0 ? persona.name.trim() : undefined;
}

function snippet(text: string, limit: number): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function combine(conditions: readonly (SQL | undefined)[]): SQL {
	const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
	if (filtered.length === 0) return sql`1 = 1`;
	return and(...filtered) ?? sql`1 = 1`;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
		: [];
}

export interface ContextMemoryInspectionItem {
	readonly id: string | null;
	readonly kind: string;
	readonly scope: string;
	readonly summary: string;
	readonly tier: "recent" | "warm" | "long-term";
}

export interface ContextInspectionDetails {
	readonly memories: {
		readonly enabled: boolean;
		readonly items: ContextMemoryInspectionItem[];
		readonly recentCount: number;
		readonly warmTopics: string[];
	};
	readonly personaName: string | null;
}

export class DrizzleContextProvider implements ContextPromptProvider {
	readonly #budgetChars: number;
	readonly #database: () => ElainaDatabase | undefined;
	readonly #logger: Logger;
	readonly #memoryService: MemoryService;
	readonly #memoryTopK: number;
	readonly #personaBudget: number;
	readonly #policyService: ConversationPolicyService;

	constructor(options: DrizzleContextProviderOptions) {
		this.#database = options.database;
		this.#logger = options.logger.child("elaina::server::context");
		this.#budgetChars = options.budgetChars ?? PROMPT_BUDGET_CHARS;
		this.#memoryTopK = options.memoryTopK ?? DEFAULT_MEMORY_TOP_K;
		this.#personaBudget = Math.floor(this.#budgetChars * PERSONA_BUDGET_FRACTION);
		this.#policyService =
			options.policyService ??
			new ConversationPolicyService({
				database: options.database,
				host: () => undefined,
				logger: options.logger,
			});
		this.#memoryService =
			options.memoryService ??
			new MemoryService({
				database: options.database,
				logger: options.logger,
				policyService: this.#policyService,
			});
	}

	async renderPersona(durableConversationId: string): Promise<string | undefined> {
		try {
			const database = this.#database();
			if (database === undefined) return undefined;
			const session = await this.#resolveSession(database, durableConversationId);
			if (session === undefined) return undefined;
			const persona = await this.#policyService.personaForSession({
				...session,
				conversationId: session.sessionId,
			});
			if (persona === undefined) return undefined;
			const text = personaText(persona);
			if (text === undefined) return undefined;
			const rendered = truncateChars(text, this.#personaBudget, PERSONA_TRUNCATION_NOTE);
			this.#logger.debug("rendered persona context", {
				durableConversationId,
				personaName: persona.name,
				renderedChars: rendered.length,
				truncated: rendered.length < text.length,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("persona context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * Compact identity + conversation contract. It names only user-visible behavior and never
	 * leaks plugin/package/database/transport internals into the prompt.
	 */
	async renderPolicy(durableConversationId: string): Promise<string | undefined> {
		try {
			const database = this.#database();
			if (database === undefined) return undefined;
			const session = await this.#resolveSession(database, durableConversationId);
			if (session === undefined) return undefined;
			const [policy, persona] = await Promise.all([
				this.#policyService.effectivePolicy(session.sessionId),
				this.#policyService.personaForSession({ ...session, conversationId: session.sessionId }),
			]);
			const lines = ["Conversation contract:"];
			if (persona !== undefined) lines.push(`- Speak as: ${persona.name}`);
			lines.push(
				`- Access: private ${policy.trigger.privateAccess}, group ${policy.trigger.groupAccess}`,
				`- Group mentions: ${policy.trigger.groupMentionMode}`,
				`- Reply pacing: settle ${policy.pacing.burstSettleMs} ms, wait at most ${policy.pacing.burstMaxWaitMs} ms, cooldown ${policy.pacing.replyCooldownMs} ms`,
				`- Output: up to ${policy.pacing.maxImmediateOutputMessages} immediate messages, ${policy.pacing.sendIntervalMs} ms apart, markdown ${policy.pacing.stripMarkdown ? "stripped" : "kept"}`,
			);
			if (policy.trigger.keywords.length > 0) {
				lines.push(`- Wake keywords: ${policy.trigger.keywords.join(", ")}`);
			}
			const aliases = [
				...new Set([...policy.trigger.selfAliases, ...(persona?.selfAliases ?? [])]),
			];
			if (aliases.length > 0) lines.push(`- Self aliases: ${aliases.join(", ")}`);
			lines.push("- If a reply would be noise, answer with exactly ELAINA_LURK.");
			const rendered = lines.join("\n");
			this.#logger.debug("rendered policy context", {
				aliasCount: aliases.length,
				durableConversationId,
				renderedChars: rendered.length,
				sessionId: session.sessionId,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("policy context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	async renderMemories(durableConversationId: string): Promise<string | undefined> {
		try {
			const collected = await this.#collectMemories(durableConversationId);
			if (collected === undefined || !collected.enabled) {
				this.#logger.debug("memory context skipped", {
					durableConversationId,
					enabled: collected?.enabled ?? false,
				});
				return undefined;
			}
			const rendered = this.#format({
				policy: collected.policy,
				ranked: collected.longTerm,
				recent: collected.recent,
				warm: collected.warm,
			});
			this.#logger.debug("rendered memory context", {
				durableConversationId,
				hasWarm: collected.warm !== undefined,
				longTermCount: collected.longTerm.length,
				recentCount: collected.recent.length,
				renderedChars: rendered?.length ?? 0,
			});
			return rendered;
		} catch (error) {
			this.#logger.warn("memory context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * Read-only inspection of the persona binding and memory recall tiers for a durable
	 * conversation, matching the exact filters used by {@link renderPersona} and {@link renderMemories}.
	 */
	async inspectContext(durableConversationId: string): Promise<ContextInspectionDetails> {
		const empty: ContextInspectionDetails = {
			memories: { enabled: false, items: [], recentCount: 0, warmTopics: [] },
			personaName: null,
		};
		try {
			const database = this.#database();
			if (database === undefined) return empty;
			const session = await this.#resolveSession(database, durableConversationId);
			const persona =
				session === undefined
					? undefined
					: await this.#policyService.personaForSession({
							...session,
							conversationId: session.sessionId,
						});
			const personaName = persona?.name ?? null;
			const collected = await this.#collectMemories(durableConversationId, session);
			if (collected === undefined || !collected.enabled) {
				return {
					memories: { enabled: false, items: [], recentCount: 0, warmTopics: [] },
					personaName,
				};
			}

			const warmTopics =
				collected.warm === undefined
					? []
					: (() => {
							const listed = stringList(collected.warm.evidence.topic);
							if (listed.length > 0) return listed;
							const raw = String(collected.warm.evidence.topic ?? "").trim();
							return raw.length > 0 ? [raw] : [];
						})();

			const items: ContextMemoryInspectionItem[] = [];
			if (collected.warm !== undefined) {
				const warmSummary =
					collected.warm.memory.summary.trim() ||
					collected.warm.memory.content.trim() ||
					warmTopics.join(", ");
				if (warmSummary.length > 0) {
					items.push({
						id: collected.warm.memory.id,
						kind: collected.warm.memory.kind,
						scope: collected.warm.memory.scope,
						summary: warmSummary.replace(/\s+/gu, " ").slice(0, MEMORY_SNIPPET_LIMIT),
						tier: "warm",
					});
				}
			}
			for (const entry of collected.longTerm.slice(0, this.#memoryTopK)) {
				const summary = (entry.memory.summary.trim() || entry.memory.content.trim())
					.replace(/\s+/gu, " ")
					.slice(0, MEMORY_SNIPPET_LIMIT);
				if (summary.length === 0) continue;
				items.push({
					id: entry.memory.id,
					kind: entry.memory.kind,
					scope: entry.memory.scope,
					summary,
					tier: "long-term",
				});
			}
			const nonEmptyRecent = collected.recent.filter(
				(row) => (row.contentText ?? "").trim().length > 0,
			);
			const memoryBudget = this.#budgetChars - this.#personaBudget;
			if (memoryBudget >= RECENT_TIER_MIN_BUDGET) {
				for (const row of nonEmptyRecent) {
					const text = snippet(row.contentText ?? "", RECENT_SNIPPET_LIMIT);
					if (text.length === 0) continue;
					items.push({
						id: row.id,
						kind: row.direction,
						scope: "recent",
						summary: text,
						tier: "recent",
					});
				}
			}

			return {
				memories: {
					enabled: true,
					items,
					recentCount: nonEmptyRecent.length,
					warmTopics,
				},
				personaName,
			};
		} catch (error) {
			this.#logger.warn("context inspection unavailable", { error: errorMessage(error) });
			return empty;
		}
	}

	async #collectMemories(
		durableConversationId: string,
		resolvedSession?: { chatKind: string; chatObjectId: string | null; sessionId: string },
	) {
		const database = this.#database();
		if (database === undefined) return undefined;
		const session =
			resolvedSession ?? (await this.#resolveSession(database, durableConversationId));
		const policy =
			session === undefined
				? await this.#policyService.effectivePolicy()
				: await this.#policyService.effectivePolicy(session.sessionId);
		if (policy.memoryEnabled === false) {
			return { enabled: false as const, policy };
		}
		const recent = await this.#recentMessages(database, session?.sessionId);
		const warm =
			session === undefined ? undefined : await this.#memoryService.warmState(session.sessionId);
		const scopeFilter = await this.#scopeFilter(database, session, policy);
		const query = [
			...recent.map((row) => row.contentText ?? ""),
			...(warm === undefined ? [] : [String(warm.evidence.topic ?? "")]),
		].join("\n");
		this.#logger.trace("collecting memories for context", {
			durableConversationId,
			hasScopeFilter: scopeFilter !== undefined,
			queryPreview: previewText(query),
			recentCount: recent.length,
			sessionId: session?.sessionId,
		});
		const ranked =
			scopeFilter === undefined
				? []
				: await this.#memoryService.recall({
						...(session === undefined ? {} : { conversationId: session.sessionId }),
						limit: Math.max(this.#memoryTopK * 3, this.#memoryTopK),
						query,
						scopeFilter,
					});
		const longTerm = ranked.filter((entry) => entry.memory.id !== warm?.memory.id);
		return { enabled: true as const, longTerm, policy, recent, warm };
	}

	async #scopeFilter(
		database: ElainaDatabase,
		session: { chatKind: string; chatObjectId: string | null; sessionId: string } | undefined,
		policy: ConversationPolicy,
	): Promise<SQL | undefined> {
		const scopes: SQL[] = [eq(memories.scope, "global")];
		if (session !== undefined) {
			scopes.push(
				combine([
					eq(memories.scope, "conversation"),
					eq(memories.conversationId, session.sessionId),
				]),
			);
			if (
				(await this.#policyService.personaForSession({
					...session,
					conversationId: session.sessionId,
				})) !== undefined
			) {
				scopes.push(
					combine([eq(memories.scope, "persona"), eq(memories.conversationId, session.sessionId)]),
				);
			}
			const participants = await this.#resolveParticipants(database, session.sessionId);
			if (participants.length > 0) {
				scopes.push(
					combine([eq(memories.scope, "user"), inArray(memories.subjectUserId, participants)]),
				);
			}
		}
		const scopeCondition = or(...scopes);
		if (scopeCondition === undefined) return undefined;
		if (session?.chatKind === "group" && policy.sharedMemoryEnabled === false) {
			return and(scopeCondition, ne(memories.visibility, "shared"));
		}
		return scopeCondition;
	}

	async #resolveSession(
		database: ElainaDatabase,
		durableConversationId: string,
	): Promise<{ chatKind: string; chatObjectId: string | null; sessionId: string } | undefined> {
		const [session] = await database
			.select({
				chatKind: conversations.kind,
				chatObjectId: conversations.chatObjectId,
				id: conversations.id,
			})
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) return undefined;
		return {
			chatKind: session.chatKind,
			chatObjectId: session.chatObjectId,
			sessionId: session.id,
		};
	}

	/**
	 * Conversation participants for `scope = 'user'` memories: recorded members plus recent
	 * inbound senders. Private chats have no member rows today, so the sender set carries them.
	 */
	async #resolveParticipants(database: ElainaDatabase, sessionId: string): Promise<string[]> {
		const [memberRows, senderRows] = await Promise.all([
			database
				.select({ userId: conversationMembers.userId })
				.from(conversationMembers)
				.where(eq(conversationMembers.conversationId, sessionId)),
			database
				.select({ userId: messages.senderUserId })
				.from(messages)
				.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "inbound")))
				.orderBy(desc(messages.occurredAt))
				.limit(50),
		]);
		const participants = new Set<string>();
		for (const row of [...memberRows, ...senderRows]) {
			if (row.userId !== null) participants.add(row.userId);
		}
		return [...participants];
	}

	async #recentMessages(
		database: ElainaDatabase,
		sessionId: string | undefined,
	): Promise<{ contentText: string | null; direction: string; id: string }[]> {
		if (sessionId === undefined) return [];
		const recent = await database
			.select({
				contentText: messages.contentText,
				direction: messages.direction,
				id: messages.id,
			})
			.from(messages)
			.where(eq(messages.conversationId, sessionId))
			.orderBy(desc(messages.occurredAt))
			.limit(RECENT_MESSAGE_LIMIT);
		return recent.toReversed();
	}

	#format(input: {
		readonly policy: ConversationPolicy;
		readonly ranked: readonly RankedMemory[];
		readonly recent: readonly { contentText: string | null; direction: string }[];
		readonly warm: { readonly evidence: Record<string, unknown> } | undefined;
	}): string | undefined {
		const memoryBudget = this.#budgetChars - this.#personaBudget;
		const lines: string[] = [];
		let used = 0;
		const push = (line: string): boolean => {
			if (used + line.length + 1 > memoryBudget) return false;
			lines.push(line);
			used += line.length + 1;
			return true;
		};
		const includeRecent =
			memoryBudget >= RECENT_TIER_MIN_BUDGET &&
			input.recent.some((row) => (row.contentText ?? "").trim().length > 0);
		if (includeRecent) {
			if (push(RECENT_HEADER)) {
				for (const row of input.recent) {
					const text = snippet(row.contentText ?? "", RECENT_SNIPPET_LIMIT);
					if (text.length === 0) continue;
					if (!push(`- ${row.direction}: ${text}`)) break;
				}
			}
		}
		if (input.warm !== undefined) {
			if (push(WARM_HEADER)) {
				const topic = stringList(input.warm.evidence.topic).join(", ");
				const topicText = topic.length > 0 ? topic : String(input.warm.evidence.topic ?? "").trim();
				if (topicText.length > 0) push(`- Topic: ${snippet(topicText, 140)}`);
				for (const [label, key] of [
					["Decisions", "decisions"],
					["Todos", "todos"],
					["Open threads", "openThreads"],
				] as const) {
					const values = stringList(input.warm.evidence[key]);
					if (values.length === 0) continue;
					push(`- ${label}: ${values.map((value) => snippet(value, 120)).join("; ")}`);
				}
			}
		}
		const pool = input.ranked.slice(0, this.#memoryTopK);
		if (pool.length > 0) {
			if (push(LONG_TERM_HEADER)) {
				let shown = 0;
				for (const entry of pool) {
					const summary = (entry.memory.summary.trim() || entry.memory.content.trim())
						.replace(/\s+/gu, " ")
						.slice(0, MEMORY_SNIPPET_LIMIT);
					if (!push(`- [${entry.memory.scope}/${entry.memory.kind}] ${summary}`)) break;
					shown += 1;
				}
				if (shown < pool.length) {
					push(`- (+${pool.length - shown} more not shown)`);
				}
			}
		}
		if (lines.length === 0) return undefined;
		const text = lines.join("\n");
		return text.length > memoryBudget
			? truncateChars(text, memoryBudget, MEMORY_TRUNCATION_NOTE)
			: text;
	}
}
