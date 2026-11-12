import { and, desc, eq, gt, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { ContextPromptProvider } from "@tsukaima/core";
import {
	conversationMembers,
	conversations,
	memories,
	messages,
	personaBindings,
	personas,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { Logger } from "../logging.ts";

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
const MAX_QUERY_TOKENS = 6;
const RECENT_MESSAGE_LIMIT = 8;
const CANDIDATE_LIMIT = 100;
const KEYWORD_CANDIDATES_PER_TOKEN = 25;
const MEMORY_SNIPPET_LIMIT = 180;
const PERSONA_TRUNCATION_NOTE = "[persona truncated to fit the context budget]";
const MEMORY_TRUNCATION_NOTE = "[memories truncated to fit the context budget]";

/**
 * Resolves the persona and memory text for one durable conversation and keeps it inside a
 * character budget. Every failure degrades to `undefined` (the section is omitted) — prompt
 * rendering must never break a model run — and memory content is never written to logs.
 *
 * Retrieval uses only SQLite capabilities (no embeddings, no new dependencies): scoped
 * candidates from `memories`, keyword/LIKE recall from the newest inbound messages, then
 * ranking by keyword hits, importance, and recency. `scope = 'persona'` has no persona
 * foreign key in the schema, so persona memories are associated through the conversation
 * they were recorded in and only surface while a persona binding is active.
 */
export interface DrizzleContextProviderOptions {
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	/** Combined persona + memory budget override; mainly for tests. */
	readonly budgetChars?: number;
	/** Maximum memories injected per request; mainly for tests. */
	readonly memoryTopK?: number;
}

type MemoryRow = {
	readonly content: string;
	readonly id: string;
	readonly importance: number;
	readonly kind: string;
	readonly scope: string;
	readonly summary: string;
	readonly updatedAt: string;
};

type RankedMemory = MemoryRow & { readonly hits: number };

const memoryColumns = {
	content: memories.content,
	id: memories.id,
	importance: memories.importance,
	kind: memories.kind,
	scope: memories.scope,
	summary: memories.summary,
	updatedAt: memories.updatedAt,
} as const;

/** `and()`/`or()` can type as `undefined`; a query always needs one concrete condition. */
function combine(conditions: readonly (SQL | undefined)[]): SQL {
	const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
	if (filtered.length === 0) return sql`1 = 0`;
	return and(...filtered) ?? sql`1 = 0`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Query tokens from recent inbound text: ASCII words stay whole; CJK runs become character
 * bigrams so partial matches recall without a tokenizer or embeddings.
 */
function extractTokens(text: string, limit = MAX_QUERY_TOKENS): string[] {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 2) continue;
		if (CJK.test(raw)) {
			if (raw.length <= 4) tokens.add(raw);
			else {
				for (let index = 0; index + 2 <= raw.length; index += 1)
					tokens.add(raw.slice(index, index + 2));
			}
		} else {
			tokens.add(raw.slice(0, 32));
		}
		if (tokens.size >= limit) break;
	}
	return [...tokens].slice(0, limit);
}

function truncateChars(text: string, max: number, note: string): string {
	if (text.length <= max) return text;
	const suffix = `\n${note}`;
	if (suffix.length >= max) return suffix.slice(0, max);
	return `${text.slice(0, max - suffix.length)}${suffix}`;
}

/** Prompt text from `personas.prompt_json`; tolerates raw strings and common object shapes. */
function personaPromptText(promptJson: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(promptJson);
	} catch {
		const raw = promptJson.trim();
		return raw.length > 0 ? raw : undefined;
	}
	if (typeof parsed === "string" && parsed.trim().length > 0) return parsed.trim();
	if (parsed !== null && typeof parsed === "object") {
		for (const key of ["prompt", "system", "instructions", "text"] as const) {
			const value = (parsed as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim().length > 0) return value.trim();
		}
	}
	return undefined;
}

function personaText(persona: {
	readonly name: string;
	readonly promptJson: string;
	readonly summary: string;
}): string | undefined {
	const prompt = personaPromptText(persona.promptJson);
	if (prompt !== undefined) return prompt;
	const summary = persona.summary.trim();
	if (summary.length > 0) return `${persona.name}: ${summary}`;
	return persona.name.trim().length > 0 ? persona.name.trim() : undefined;
}

export class DrizzleContextProvider implements ContextPromptProvider {
	readonly #budgetChars: number;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #memoryTopK: number;
	readonly #personaBudget: number;

	constructor(options: DrizzleContextProviderOptions) {
		this.#database = options.database;
		this.#logger = options.logger.child("tsukaima::server::context");
		this.#budgetChars = options.budgetChars ?? PROMPT_BUDGET_CHARS;
		this.#memoryTopK = options.memoryTopK ?? DEFAULT_MEMORY_TOP_K;
		this.#personaBudget = Math.floor(this.#budgetChars * PERSONA_BUDGET_FRACTION);
	}

	async renderPersona(durableConversationId: string): Promise<string | undefined> {
		try {
			const database = this.#database();
			if (database === undefined) return undefined;
			const session = await this.#resolveSession(database, durableConversationId);
			const binding = session?.personaBinding;
			if (binding === undefined) return undefined;
			const [persona] = await database
				.select({
					name: personas.name,
					promptJson: personas.promptJson,
					summary: personas.summary,
				})
				.from(personas)
				.where(and(eq(personas.id, binding.personaId), eq(personas.isActive, 1)))
				.orderBy(desc(personas.version))
				.limit(1);
			if (persona === undefined) return undefined;
			const text = personaText(persona);
			if (text === undefined) return undefined;
			return truncateChars(text, this.#personaBudget, PERSONA_TRUNCATION_NOTE);
		} catch (error) {
			this.#logger.warn("persona context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	async renderMemories(durableConversationId: string): Promise<string | undefined> {
		try {
			const database = this.#database();
			if (database === undefined) return undefined;
			const session = await this.#resolveSession(database, durableConversationId);
			const now = new Date().toISOString();
			const base: (SQL | undefined)[] = [
				isNull(memories.revokedAt),
				or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
			];
			const scopes: SQL[] = [combine([eq(memories.scope, "global")])];
			let participants: string[] = [];
			if (session !== undefined) {
				scopes.push(
					combine([
						eq(memories.scope, "conversation"),
						eq(memories.conversationId, session.sessionId),
					]),
				);
				if (session.personaBinding !== undefined) {
					scopes.push(
						combine([
							eq(memories.scope, "persona"),
							eq(memories.conversationId, session.sessionId),
						]),
					);
				}
				participants = await this.#resolveParticipants(database, session.sessionId);
				if (participants.length > 0) {
					scopes.push(
						combine([eq(memories.scope, "user"), inArray(memories.subjectUserId, participants)]),
					);
				}
			}
			base.push(or(...scopes));
			const candidates = await this.#collectCandidates(database, base, session?.sessionId);
			if (candidates.length === 0) return undefined;
			const ranked = this.#rank(candidates);
			return this.#format(ranked);
		} catch (error) {
			this.#logger.warn("memory context unavailable", { error: errorMessage(error) });
			return undefined;
		}
	}

	async #resolveSession(
		database: TsukaimaDatabase,
		durableConversationId: string,
	): Promise<
		{ personaBinding?: { readonly personaId: string }; readonly sessionId: string } | undefined
	> {
		const [session] = await database
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		if (session === undefined) return undefined;
		const personaBinding = await this.#resolvePersonaBinding(database, session.id);
		return {
			sessionId: session.id,
			...(personaBinding === undefined ? {} : { personaBinding }),
		};
	}

	async #resolvePersonaBinding(
		database: TsukaimaDatabase,
		sessionId: string,
	): Promise<{ readonly personaId: string } | undefined> {
		const [conversationBinding] = await database
			.select({ personaId: personaBindings.personaId })
			.from(personaBindings)
			.where(and(eq(personaBindings.conversationId, sessionId), eq(personaBindings.isActive, 1)))
			.orderBy(desc(personaBindings.createdAt))
			.limit(1);
		if (conversationBinding !== undefined) return conversationBinding;
		const [globalBinding] = await database
			.select({ personaId: personaBindings.personaId })
			.from(personaBindings)
			.where(and(eq(personaBindings.isGlobal, 1), eq(personaBindings.isActive, 1)))
			.orderBy(desc(personaBindings.createdAt))
			.limit(1);
		return globalBinding;
	}

	/**
	 * Conversation participants for `scope = 'user'` memories: recorded members plus recent
	 * inbound senders. Private chats have no member rows today, so the sender set carries them.
	 */
	async #resolveParticipants(database: TsukaimaDatabase, sessionId: string): Promise<string[]> {
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

	/** Keyword recall from recent inbound text, plus the most important scoped memories. */
	async #collectCandidates(
		database: TsukaimaDatabase,
		base: readonly (SQL | undefined)[],
		sessionId: string | undefined,
	): Promise<RankedMemory[]> {
		const byId = new Map<string, MemoryRow>();
		const recent =
			sessionId === undefined
				? []
				: await database
						.select({ contentText: messages.contentText })
						.from(messages)
						.where(and(eq(messages.conversationId, sessionId), eq(messages.direction, "inbound")))
						.orderBy(desc(messages.occurredAt))
						.limit(RECENT_MESSAGE_LIMIT);
		const tokens = extractTokens(recent.map((row) => row.contentText ?? "").join("\n"));
		for (const token of tokens) {
			const pattern = `%${token}%`;
			const rows = await database
				.select(memoryColumns)
				.from(memories)
				.where(
					combine([...base, or(like(memories.summary, pattern), like(memories.content, pattern))]),
				)
				.orderBy(desc(memories.importance), desc(memories.updatedAt))
				.limit(KEYWORD_CANDIDATES_PER_TOKEN);
			for (const row of rows) byId.set(row.id, row);
		}
		const baseline = await database
			.select(memoryColumns)
			.from(memories)
			.where(combine(base))
			.orderBy(desc(memories.importance), desc(memories.updatedAt))
			.limit(CANDIDATE_LIMIT);
		for (const row of baseline) byId.set(row.id, row);
		return [...byId.values()].map((row) => ({ ...row, hits: countHits(row, tokens) }));
	}

	#rank(candidates: readonly RankedMemory[]): RankedMemory[] {
		return [...candidates].toSorted((left, right) => {
			if (left.hits !== right.hits) return right.hits - left.hits;
			if (left.importance !== right.importance) return right.importance - left.importance;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	}

	#format(ranked: readonly RankedMemory[]): string | undefined {
		const memoryBudget = this.#budgetChars - this.#personaBudget;
		const header = "Known memories, most relevant first:";
		const lines: string[] = [header];
		let used = header.length + 1;
		const pool = ranked.slice(0, this.#memoryTopK);
		for (const memory of pool) {
			const summary = (memory.summary.trim() || memory.content.trim())
				.replace(/\s+/g, " ")
				.slice(0, MEMORY_SNIPPET_LIMIT);
			const line = `- [${memory.scope}/${memory.kind}] ${summary}`;
			if (used + line.length + 1 > memoryBudget) break;
			lines.push(line);
			used += line.length + 1;
		}
		const omitted = pool.length - (lines.length - 1);
		if (omitted > 0) lines.push(`- (+${omitted} more not shown)`);
		else if (lines.length === 1) return undefined;
		const text = lines.join("\n");
		return text.length > memoryBudget
			? truncateChars(text, memoryBudget, MEMORY_TRUNCATION_NOTE)
			: text;
	}
}

function countHits(memory: MemoryRow, tokens: readonly string[]): number {
	const haystack = `${memory.summary}\n${memory.content}`.toLowerCase();
	let hits = 0;
	for (const token of tokens) {
		if (haystack.includes(token)) hits += 1;
	}
	return hits;
}
