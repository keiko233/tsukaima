import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, like, lte, or, sql, type SQL } from "drizzle-orm";
import type { ConversationPolicy, MemoryScope, MemoryStatus } from "@elaina/contracts";
import { conversations, memories, messages, type ElainaDatabase } from "@elaina/db";
import type { AuditEntry, PluginPermission, PluginTask } from "@elaina/sdk";
import type { Logger } from "../logging.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import type { PluginTaskService } from "./plugin-task-service.ts";

export const MEMORY_PLUGIN_ID = "memory";
export const MEMORY_SERVICE_BINDING = "elaina.memory.service";
export const MEMORY_EXTRACTION_PROMPT_VERSION = "memory-extract-v1";
export const MEMORY_COMPACTION_PROMPT_VERSION = "memory-compact-v1";

const RECENT_LIVE_WINDOW = 20;
const EXTRACTION_MESSAGE_LIMIT = 30;
const CANDIDATE_LIMIT = 120;
const KEYWORD_CANDIDATES_PER_TOKEN = 30;
const MAX_QUERY_TOKENS = 8;
const MEMORY_TASK_PERMISSIONS: readonly PluginPermission[] = [
	"tasks.create",
	"tasks.get",
	"tasks.list",
	"tasks.cancel",
	"tasks.watch",
];

type MemoryRow = typeof memories.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export type MemoryRecord = MemoryRow;

export interface MemoryCreateInput {
	readonly confidence?: number | undefined;
	readonly content?: string | undefined;
	readonly conversationId?: string | undefined;
	readonly createdBy?: "agent" | "user" | "migration" | "system" | "task" | undefined;
	readonly dedupeKey?: string | undefined;
	readonly evidence?: Record<string, unknown> | undefined;
	readonly evidenceJson?: string | undefined;
	readonly expiresAt?: string | undefined;
	readonly extractionModel?: string | undefined;
	readonly extractionPromptVersion?: string | undefined;
	readonly importance?: number | undefined;
	readonly kind: string;
	readonly pinned?: boolean | undefined;
	readonly projectId?: string | undefined;
	readonly scope: MemoryScope;
	readonly sourceActivityId?: string | undefined;
	readonly sourceConversationId?: string | undefined;
	readonly sourceEntryId?: string | undefined;
	readonly sourceMessageId?: string | undefined;
	readonly status?: MemoryStatus | undefined;
	readonly subjectUserId?: string | undefined;
	readonly summary: string;
	readonly supersedes?: readonly string[] | undefined;
	readonly visibility?: string | undefined;
}

export interface MemoryUpdateInput {
	readonly confidence?: number | undefined;
	readonly content?: string | undefined;
	readonly dedupeKey?: string | null | undefined;
	readonly expiresAt?: string | null | undefined;
	readonly id: string;
	readonly importance?: number | undefined;
	readonly kind?: string | undefined;
	readonly pinned?: boolean | undefined;
	readonly status?: MemoryStatus | undefined;
	readonly summary?: string | undefined;
	readonly supersedes?: readonly string[] | undefined;
	readonly visibility?: string | undefined;
}

export interface MemoryListFilters {
	readonly conversationId?: string | undefined;
	readonly kind?: string | undefined;
	readonly limit?: number | undefined;
	readonly offset?: number | undefined;
	readonly query?: string | undefined;
	readonly scope?: MemoryScope | undefined;
	readonly status?: MemoryStatus | undefined;
	readonly subjectUserId?: string | undefined;
}

export interface MemoryRecallInput {
	readonly conversationId?: string | undefined;
	readonly limit?: number | undefined;
	readonly query?: string | undefined;
	readonly scopeFilter?: SQL | undefined;
}

export interface RankedMemory {
	readonly lexical: number;
	readonly memory: MemoryRow;
	readonly recency: number;
	readonly score: number;
	readonly vector: number;
}

export interface MemoryCompactInput {
	readonly conversationId: string;
	readonly throughMessageId?: string | undefined;
}

export interface MemoryCompactOutput {
	readonly created: boolean;
	readonly memory: MemoryRow | undefined;
}

export interface MemoryEmbeddingOutput {
	readonly modelId: string;
	readonly vectors: readonly (readonly number[])[];
}

export interface MemoryServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void>;
	readonly complete?: (prompt: string, modelId?: string) => Promise<string | undefined>;
	readonly database: () => ElainaDatabase | undefined;
	readonly embed?: (texts: readonly string[]) => Promise<MemoryEmbeddingOutput | undefined>;
	readonly id?: () => string;
	readonly llmEnabled?: () => boolean;
	readonly logger: Logger;
	readonly now?: () => Date;
	readonly policyService?: ConversationPolicyService;
	readonly tasks?: PluginTaskService;
}

interface ExtractionCandidate {
	readonly confidence: number;
	readonly content: string;
	readonly expiresAt?: string;
	readonly importance: number;
	readonly kind: string;
	readonly scope?: MemoryScope;
	readonly summary: string;
}

const STOPWORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"and",
	"are",
	"because",
	"been",
	"but",
	"can",
	"could",
	"for",
	"from",
	"have",
	"just",
	"like",
	"not",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"was",
	"were",
	"what",
	"when",
	"will",
	"with",
	"would",
	"you",
	"your",
]);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function nowIso(date: Date): string {
	return date.toISOString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function combine(conditions: readonly (SQL | undefined)[]): SQL {
	const filtered = conditions.filter((condition): condition is SQL => condition !== undefined);
	if (filtered.length === 0) return sql`1 = 1`;
	return and(...filtered) ?? sql`1 = 1`;
}

/** Deterministic dedupe key: normalized scope + subject + kind + canonical fact stem. */
export function computeMemoryDedupeKey(input: {
	readonly conversationId?: string | null | undefined;
	readonly kind: string;
	readonly projectId?: string | null | undefined;
	readonly scope: string;
	readonly subjectUserId?: string | null | undefined;
	readonly text: string;
}): string {
	const stem = canonicalTextStem(input.text);
	const subject = input.subjectUserId ?? input.conversationId ?? input.projectId ?? "";
	return createHash("sha256")
		.update([input.scope, subject, input.kind.toLowerCase(), stem].join("|"), "utf8")
		.digest("hex")
		.slice(0, 40);
}

export function canonicalTextStem(text: string): string {
	const tokens = text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/u)
		.filter((token) => token.length > 1 && !STOPWORDS.has(token) && !/^\p{P}+$/u.test(token));
	return tokens.slice(0, 16).join(" ");
}

export function extractMemoryTokens(text: string, limit = MAX_QUERY_TOKENS): string[] {
	const tokens = new Set<string>();
	for (const raw of text
		.toLowerCase()
		.normalize("NFKC")
		.split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 2 || STOPWORDS.has(raw)) continue;
		if (CJK.test(raw)) {
			if (raw.length <= 4) tokens.add(raw);
			else {
				for (let index = 0; index + 2 <= raw.length; index += 1) {
					tokens.add(raw.slice(index, index + 2));
				}
			}
		} else {
			tokens.add(raw.slice(0, 32));
		}
		if (tokens.size >= limit) break;
	}
	return [...tokens].slice(0, limit);
}

function polarity(text: string): "negative" | "positive" {
	return /\b(?:not|never|no|dislike|dislikes|hate|hates|don't|doesn't|dont|讨厌|不喜欢|别)\b/iu.test(
		text,
	)
		? "negative"
		: "positive";
}

function textOverlap(left: string, right: string): number {
	const leftTokens = new Set(extractMemoryTokens(left, 32));
	const rightTokens = new Set(extractMemoryTokens(right, 32));
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let shared = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
	return shared / Math.max(leftTokens.size, rightTokens.size);
}

function parseEvidence(value: string | null): Record<string, unknown> {
	if (value === null || value.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function mergeEvidence(
	existing: string | null,
	next: Record<string, unknown> | undefined,
	now: string,
): string | null {
	if (next === undefined) return existing;
	const previous = parseEvidence(existing);
	const occurrences =
		typeof previous.occurrences === "number" ? Math.max(1, previous.occurrences) : 1;
	return JSON.stringify({
		...previous,
		...next,
		mergedAt: now,
		occurrences: occurrences + 1,
	});
}

function snippet(text: string, limit = 160): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function cosine(left: readonly number[], right: readonly number[]): number {
	const length = Math.min(left.length, right.length);
	if (length === 0) return 0;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < length; index += 1) {
		const l = left[index] ?? 0;
		const r = right[index] ?? 0;
		dot += l * r;
		leftMagnitude += l * l;
		rightMagnitude += r * r;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function recencyScore(updatedAt: string, now: Date): number {
	const timestamp = Date.parse(updatedAt);
	if (!Number.isFinite(timestamp)) return 0;
	const ageDays = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
	return 1 / (1 + ageDays / 30);
}

function lexicalScore(
	memory: Pick<MemoryRow, "content" | "summary">,
	tokens: readonly string[],
): number {
	if (tokens.length === 0) return 0;
	const haystack = `${memory.summary}\n${memory.content}`.toLowerCase();
	let hits = 0;
	for (const token of tokens) if (haystack.includes(token)) hits += 1;
	return hits / tokens.length;
}

function pinnedValue(value: boolean | undefined): number {
	return value === true ? 1 : 0;
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function parseDate(value: string): string | undefined {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return undefined;
	return new Date(timestamp).toISOString();
}

function inferExpiry(text: string, now: Date, kind: string): string | undefined {
	const iso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(text);
	if (iso?.[1] !== undefined) {
		return parseDate(`${iso[1]}T23:59:59.000Z`);
	}
	const lower = text.toLowerCase();
	const dayMs = 86_400_000;
	if (/后天/u.test(lower)) return new Date(now.getTime() + 2 * dayMs).toISOString();
	if (/明天|tomorrow/u.test(lower)) return new Date(now.getTime() + dayMs).toISOString();
	if (/今天|today|tonight/u.test(lower)) return new Date(now.getTime() + dayMs).toISOString();
	if (/下周|next week/u.test(lower)) return new Date(now.getTime() + 7 * dayMs).toISOString();
	if (kind === "todo" || kind === "event") return new Date(now.getTime() + 7 * dayMs).toISOString();
	return undefined;
}

function heuristicCandidates(
	rows: readonly MessageRow[],
	now: Date,
): { candidates: ExtractionCandidate[]; messageIds: string[] } {
	const candidates: ExtractionCandidate[] = [];
	const messageIds = rows.map((row) => row.id);
	const seen = new Set<string>();
	for (const row of rows) {
		if (row.direction !== "inbound") continue;
		const content = row.contentText?.trim();
		if (content === undefined || content.length === 0) continue;
		for (const sentence of content.split(/[\n.!?。！？]+/u)) {
			const line = sentence.trim();
			if (line.length < 3) continue;
			const push = (candidate: ExtractionCandidate) => {
				const key = canonicalTextStem(`${candidate.kind}:${candidate.summary}`);
				if (key.length === 0 || seen.has(key)) return;
				seen.add(key);
				candidates.push(candidate);
			};
			const likesMatch = /^(?:i\s+)?(?:really\s+)?(?:like|love|prefer|enjoy)\s+(.+)/iu.exec(line);
			if (likesMatch?.[1] !== undefined) {
				push({
					confidence: 0.72,
					content: line,
					importance: 0.6,
					kind: "preference",
					summary: `Prefers ${snippet(likesMatch[1])}`,
				});
				continue;
			}
			const dislike = /^i\s+(?:don't|do not|dislike|hate)\s+(?:like\s+)?(.+)/iu.exec(line);
			if (dislike?.[1] !== undefined) {
				push({
					confidence: 0.72,
					content: line,
					importance: 0.6,
					kind: "preference",
					summary: `Dislikes ${snippet(dislike[1])}`,
				});
				continue;
			}
			const named = /^(?:my name is|call me)\s+(.+)/iu.exec(line);
			if (named?.[1] !== undefined) {
				push({
					confidence: 0.8,
					content: line,
					importance: 0.75,
					kind: "person",
					summary: `Is called ${snippet(named[1])}`,
				});
				continue;
			}
			const remember = /^(?:remember(?: that)?|note that)\s+(.+)/iu.exec(line);
			if (remember?.[1] !== undefined) {
				push({
					confidence: 0.68,
					content: line,
					importance: 0.65,
					kind: "fact",
					summary: snippet(remember[1]),
				});
				continue;
			}
			const todo = /^(?:todo|task)\s*[:-]\s*(.+)/iu.exec(line);
			if (todo?.[1] !== undefined) {
				const expiresAt = inferExpiry(line, now, "todo");
				push({
					confidence: 0.75,
					content: line,
					...(expiresAt === undefined ? {} : { expiresAt }),
					importance: 0.65,
					kind: "todo",
					summary: `Todo: ${snippet(todo[1])}`,
				});
				continue;
			}
			const need = /^(?:i\s+need to|i\s+have to|remind me to)\s+(.+)/iu.exec(line);
			if (need?.[1] !== undefined) {
				const expiresAt = inferExpiry(line, now, "todo");
				push({
					confidence: 0.66,
					content: line,
					...(expiresAt === undefined ? {} : { expiresAt }),
					importance: 0.6,
					kind: "todo",
					summary: `Todo: ${snippet(need[1])}`,
				});
				continue;
			}
			const chineseLike = /^我(?:很)?(?:喜欢|爱|偏好)(.+)/u.exec(line);
			if (chineseLike?.[1] !== undefined) {
				push({
					confidence: 0.72,
					content: line,
					importance: 0.6,
					kind: "preference",
					summary: `喜欢 ${snippet(chineseLike[1])}`,
				});
				continue;
			}
			const chineseRemember = /^记住[：:\s]*(.+)/u.exec(line);
			if (chineseRemember?.[1] !== undefined) {
				push({
					confidence: 0.7,
					content: line,
					importance: 0.65,
					kind: "fact",
					summary: snippet(chineseRemember[1]),
				});
				continue;
			}
			const chineseTodo = /^(?:待办|任务)[：:\s]*(.+)/u.exec(line);
			if (chineseTodo?.[1] !== undefined) {
				const expiresAt = inferExpiry(line, now, "todo");
				push({
					confidence: 0.72,
					content: line,
					...(expiresAt === undefined ? {} : { expiresAt }),
					importance: 0.65,
					kind: "todo",
					summary: `待办：${snippet(chineseTodo[1])}`,
				});
			}
		}
	}
	return { candidates, messageIds };
}

function llmCandidateSchema(value: unknown): ExtractionCandidate | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.summary !== "string" ||
		record.summary.trim().length === 0 ||
		typeof record.kind !== "string" ||
		record.kind.trim().length === 0
	) {
		return undefined;
	}
	const confidence =
		typeof record.confidence === "number" && record.confidence >= 0 && record.confidence <= 1
			? record.confidence
			: 0.6;
	const importance =
		typeof record.importance === "number" && record.importance >= 0 && record.importance <= 1
			? record.importance
			: 0.5;
	const expiresAt =
		typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))
			? new Date(record.expiresAt).toISOString()
			: undefined;
	const content = typeof record.content === "string" ? record.content : record.summary;
	const scope =
		record.scope === "global" ||
		record.scope === "persona" ||
		record.scope === "user" ||
		record.scope === "conversation" ||
		record.scope === "project" ||
		record.scope === "ephemeral"
			? record.scope
			: undefined;
	return {
		confidence,
		content,
		...(expiresAt === undefined ? {} : { expiresAt }),
		importance,
		kind: record.kind.trim().toLowerCase(),
		...(scope === undefined ? {} : { scope }),
		summary: snippet(record.summary, 1_000),
	};
}

function parseLlmCandidates(text: string): ExtractionCandidate[] {
	const trimmed = text.trim();
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start === -1 || end <= start) return [];
	try {
		const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(llmCandidateSchema)
			.filter((candidate): candidate is ExtractionCandidate => candidate !== undefined);
	} catch {
		return [];
	}
}

/**
 * Owns memory lifecycle, review transitions, deduplication, expiry, hybrid recall, additive
 * compaction, and background extraction. Raw memory or chat content is never logged here.
 */
export class MemoryService {
	readonly #audit: ((entry: AuditEntry) => Promise<void>) | undefined;
	readonly #complete:
		| ((prompt: string, modelId?: string) => Promise<string | undefined>)
		| undefined;
	readonly #database: () => ElainaDatabase | undefined;
	readonly #embed:
		| ((texts: readonly string[]) => Promise<MemoryEmbeddingOutput | undefined>)
		| undefined;
	readonly #id: () => string;
	readonly #llmEnabled: () => boolean;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #policyService: ConversationPolicyService | undefined;
	readonly #tasks: PluginTaskService | undefined;
	#schedulerStarted = false;

	constructor(options: MemoryServiceOptions) {
		this.#audit = options.audit;
		this.#complete = options.complete;
		this.#database = options.database;
		this.#embed = options.embed;
		this.#id = options.id ?? randomUUID;
		this.#llmEnabled = options.llmEnabled ?? (() => false);
		this.#logger = options.logger.child("elaina::server::memory");
		this.#now = options.now ?? (() => new Date());
		this.#policyService = options.policyService;
		this.#tasks = options.tasks;
	}

	#db(): ElainaDatabase {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		return database;
	}

	async list(filters: MemoryListFilters = {}): Promise<MemoryRow[]> {
		const database = this.#db();
		const conditions: (SQL | undefined)[] = [];
		if (filters.status !== undefined) conditions.push(eq(memories.status, filters.status));
		if (filters.scope !== undefined) conditions.push(eq(memories.scope, filters.scope));
		if (filters.kind !== undefined) conditions.push(eq(memories.kind, filters.kind));
		if (filters.conversationId !== undefined) {
			conditions.push(eq(memories.conversationId, filters.conversationId));
		}
		if (filters.subjectUserId !== undefined) {
			conditions.push(eq(memories.subjectUserId, filters.subjectUserId));
		}
		if (filters.query !== undefined && filters.query.trim().length > 0) {
			const pattern = `%${filters.query.trim()}%`;
			conditions.push(
				or(
					like(memories.summary, pattern),
					like(memories.content, pattern),
					like(memories.dedupeKey, pattern),
				),
			);
		}
		return database
			.select()
			.from(memories)
			.where(combine(conditions))
			.orderBy(desc(memories.pinned), desc(memories.updatedAt), asc(memories.id))
			.limit(Math.max(1, filters.limit ?? 100))
			.offset(Math.max(0, filters.offset ?? 0));
	}

	async get(id: string): Promise<MemoryRow | undefined> {
		const [row] = await this.#db().select().from(memories).where(eq(memories.id, id)).limit(1);
		return row;
	}

	/** Resolve a durable conversation id (model/tool context) to its domain session. */
	async sessionByDurableId(
		durableConversationId: string,
	): Promise<{ id: string; kind: string } | undefined> {
		const [row] = await this.#db()
			.select({ id: conversations.id, kind: conversations.kind })
			.from(conversations)
			.where(eq(conversations.durableConversationId, durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		return row;
	}

	async policyForConversation(conversationId: string): Promise<ConversationPolicy | undefined> {
		return this.#policyService?.effectivePolicy(conversationId);
	}

	async create(input: MemoryCreateInput): Promise<{ memory: MemoryRow; merged: boolean }> {
		const database = this.#db();
		const nowDate = this.#now();
		const now = nowIso(nowDate);
		const id = this.#id();
		const dedupeKey =
			input.dedupeKey ??
			computeMemoryDedupeKey({
				conversationId: input.conversationId,
				kind: input.kind,
				projectId: input.projectId,
				scope: input.scope,
				subjectUserId: input.subjectUserId,
				text: input.summary,
			});
		const evidence =
			input.evidence ??
			(input.evidenceJson === undefined ? undefined : parseEvidence(input.evidenceJson));
		{
			const [existing] = await database
				.select()
				.from(memories)
				.where(eq(memories.dedupeKey, dedupeKey))
				.limit(1);
			if (existing !== undefined) {
				const status =
					existing.status === "revoked" || existing.status === "rejected"
						? (input.status ?? "active")
						: input.status === "active"
							? "active"
							: existing.status;
				const confidence =
					input.confidence === undefined
						? existing.confidence
						: 1 - (1 - existing.confidence) * (1 - input.confidence);
				const [updated] = await database
					.update(memories)
					.set({
						confidence,
						content: input.content ?? existing.content,
						evidenceJson: mergeEvidence(existing.evidenceJson, evidence ?? {}, now),
						expiresAt: input.expiresAt ?? existing.expiresAt,
						importance: Math.max(existing.importance, input.importance ?? 0),
						pinned: Math.max(existing.pinned, pinnedValue(input.pinned)),
						revokedAt: null,
						status,
						summary: input.summary,
						updatedAt: now,
					})
					.where(eq(memories.id, existing.id))
					.returning();
				const memory = updated ?? existing;
				await this.#recordAudit("memory.merge", memory, "ok");
				return { memory, merged: true };
			}
		}
		const superseded = await this.#supersedeConflicts({
			conversationId: input.conversationId ?? null,
			excludeId: id,
			kind: input.kind,
			projectId: input.projectId ?? null,
			scope: input.scope,
			subjectUserId: input.subjectUserId ?? null,
			supersedes: input.supersedes,
			supersededBy: id,
			text: `${input.summary}\n${input.content ?? ""}`,
		});
		const [row] = await database
			.insert(memories)
			.values({
				confidence: input.confidence ?? 0.8,
				content: input.content ?? input.summary,
				conversationId: input.conversationId ?? null,
				createdAt: now,
				createdBy: input.createdBy ?? "agent",
				dedupeKey,
				...(evidence === undefined ? {} : { evidenceJson: JSON.stringify(evidence) }),
				expiresAt: input.expiresAt ?? null,
				...(input.extractionModel === undefined ? {} : { extractionModel: input.extractionModel }),
				...(input.extractionPromptVersion === undefined
					? {}
					: { extractionPromptVersion: input.extractionPromptVersion }),
				id,
				importance: input.importance ?? 0.5,
				kind: input.kind,
				pinned: pinnedValue(input.pinned),
				projectId: input.projectId ?? null,
				revokedAt: null,
				scope: input.scope,
				sourceActivityId: input.sourceActivityId ?? null,
				sourceConversationId: input.sourceConversationId ?? input.conversationId ?? null,
				sourceEntryId: input.sourceEntryId ?? null,
				sourceMessageId: input.sourceMessageId ?? null,
				status: input.status ?? "active",
				subjectUserId: input.subjectUserId ?? null,
				summary: input.summary,
				updatedAt: now,
				visibility: input.visibility ?? "private",
			})
			.returning();
		if (row === undefined) throw new Error("Memory insert did not return a row");
		await this.#recordAudit("memory.create", row, "ok");
		if (superseded.length > 0) {
			this.#logger.info("memory superseded stale rows", {
				count: superseded.length,
				memoryId: row.id,
			});
		}
		return { memory: row, merged: false };
	}

	async update(input: MemoryUpdateInput): Promise<MemoryRow> {
		const database = this.#db();
		const existing = await this.get(input.id);
		if (existing === undefined) throw new Error("Memory not found");
		const nowDate = this.#now();
		const now = nowIso(nowDate);
		const textChanged =
			(input.summary !== undefined && input.summary !== existing.summary) ||
			(input.content !== undefined && input.content !== existing.content);
		const dedupeKey =
			input.dedupeKey === null
				? null
				: (input.dedupeKey ??
					(textChanged
						? computeMemoryDedupeKey({
								conversationId: existing.conversationId,
								kind: input.kind ?? existing.kind,
								projectId: existing.projectId,
								scope: existing.scope,
								subjectUserId: existing.subjectUserId,
								text: input.summary ?? existing.summary,
							})
						: existing.dedupeKey));
		const summary = input.summary ?? existing.summary;
		const content = input.content ?? existing.content;
		const superseded = await this.#supersedeConflicts({
			conversationId: existing.conversationId,
			excludeId: existing.id,
			kind: input.kind ?? existing.kind,
			projectId: existing.projectId,
			scope: existing.scope,
			subjectUserId: existing.subjectUserId,
			supersedes: input.supersedes,
			supersededBy: existing.id,
			text: `${summary}\n${content}`,
		});
		const status = input.status ?? existing.status;
		const [row] = await database
			.update(memories)
			.set({
				confidence: input.confidence ?? existing.confidence,
				content,
				dedupeKey,
				...(textChanged ? { embeddingJson: null, embeddingModel: null } : {}),
				...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
				importance: input.importance ?? existing.importance,
				kind: input.kind ?? existing.kind,
				pinned: input.pinned === undefined ? existing.pinned : pinnedValue(input.pinned),
				revokedAt: status === "revoked" ? (existing.revokedAt ?? now) : null,
				status,
				summary,
				updatedAt: now,
				visibility: input.visibility ?? existing.visibility,
			})
			.where(eq(memories.id, existing.id))
			.returning();
		if (row === undefined) throw new Error("Memory update did not return a row");
		await this.#recordAudit("memory.update", row, "ok");
		if (superseded.length > 0) {
			this.#logger.info("memory update superseded stale rows", {
				count: superseded.length,
				memoryId: row.id,
			});
		}
		return row;
	}

	async approve(id: string): Promise<MemoryRow> {
		const existing = await this.get(id);
		if (existing === undefined) throw new Error("Memory not found");
		if (existing.status !== "pending" && existing.status !== "active") {
			throw new Error(`Only pending memories can be approved (current: ${existing.status})`);
		}
		return this.#setStatus(id, "active");
	}

	async reject(id: string): Promise<MemoryRow> {
		const existing = await this.get(id);
		if (existing === undefined) throw new Error("Memory not found");
		if (existing.status !== "pending") {
			throw new Error(`Only pending memories can be rejected (current: ${existing.status})`);
		}
		return this.#setStatus(id, "rejected");
	}

	async revoke(id: string): Promise<MemoryRow> {
		const existing = await this.get(id);
		if (existing === undefined) throw new Error("Memory not found");
		const now = nowIso(this.#now());
		const [row] = await this.#db()
			.update(memories)
			.set({ revokedAt: existing.revokedAt ?? now, status: "revoked", updatedAt: now })
			.where(eq(memories.id, id))
			.returning();
		if (row === undefined) throw new Error("Memory revoke did not return a row");
		await this.#recordAudit("memory.revoke", row, "ok");
		return row;
	}

	async pin(id: string, pinned: boolean): Promise<MemoryRow> {
		const existing = await this.get(id);
		if (existing === undefined) throw new Error("Memory not found");
		const [row] = await this.#db()
			.update(memories)
			.set({ pinned: pinnedValue(pinned), updatedAt: nowIso(this.#now()) })
			.where(eq(memories.id, id))
			.returning();
		if (row === undefined) throw new Error("Memory pin did not return a row");
		await this.#recordAudit(pinned ? "memory.pin" : "memory.unpin", row, "ok");
		return row;
	}

	async expireDue(): Promise<number> {
		const now = nowIso(this.#now());
		const rows = await this.#db()
			.update(memories)
			.set({ status: "expired", updatedAt: now })
			.where(
				and(
					inArray(memories.status, ["active", "pending"]),
					lte(memories.expiresAt, now),
					isNull(memories.revokedAt),
				),
			)
			.returning({ id: memories.id });
		if (rows.length > 0) {
			await this.#recordAudit(
				"memory.expire",
				{
					id: rows.map((row) => row.id).join(","),
					kind: "sweep",
					scope: "global",
					status: "expired",
				},
				"ok",
			);
		}
		if (rows.length > 0) this.#logger.info("expired due memories", { count: rows.length });
		return rows.length;
	}

	/** Hybrid recall: lexical + cached embeddings + importance/recency/pin, bounded by `limit`. */
	async recall(input: MemoryRecallInput = {}): Promise<RankedMemory[]> {
		const database = this.#db();
		const nowDate = this.#now();
		const now = nowIso(nowDate);
		const conditions: (SQL | undefined)[] = [
			eq(memories.status, "active"),
			isNull(memories.revokedAt),
			or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
		];
		if (input.scopeFilter !== undefined) conditions.push(input.scopeFilter);
		const base = combine(conditions);
		const tokens = extractMemoryTokens(input.query ?? "");
		const byId = new Map<string, MemoryRow>();
		for (const token of tokens) {
			const pattern = `%${token}%`;
			const rows = await database
				.select()
				.from(memories)
				.where(
					combine([base, or(like(memories.summary, pattern), like(memories.content, pattern))]),
				)
				.orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.updatedAt))
				.limit(KEYWORD_CANDIDATES_PER_TOKEN);
			for (const row of rows) byId.set(row.id, row);
		}
		const baseline = await database
			.select()
			.from(memories)
			.where(base)
			.orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.updatedAt))
			.limit(CANDIDATE_LIMIT);
		for (const row of baseline) byId.set(row.id, row);
		const candidates = [...byId.values()];
		const vectors = await this.#embedCandidates(input.query ?? "", candidates);
		const ranked = candidates.map((memory) => {
			const lexical = lexicalScore(memory, tokens);
			const vector =
				vectors.query === undefined || vectors.byId.get(memory.id) === undefined
					? 0
					: Math.max(0, cosine(vectors.query, vectors.byId.get(memory.id) ?? []));
			const recency = recencyScore(memory.updatedAt, nowDate);
			const pinned = memory.pinned === 1 ? 0.2 : 0;
			const score =
				lexical * 0.55 + vector * 0.3 + memory.importance * 0.1 + recency * 0.05 + pinned;
			return { lexical, memory, recency, score, vector };
		});
		ranked.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			if (left.memory.pinned !== right.memory.pinned) {
				return right.memory.pinned - left.memory.pinned;
			}
			if (right.memory.importance !== left.memory.importance) {
				return right.memory.importance - left.memory.importance;
			}
			return right.memory.updatedAt.localeCompare(left.memory.updatedAt);
		});
		return ranked.slice(0, Math.max(1, input.limit ?? 10));
	}

	/**
	 * Additive compaction: older turns become one immutable `summary` row with warm state.
	 * `messages` rows are read only; the watermark makes repeated runs idempotent.
	 */
	async compactSession(input: MemoryCompactInput): Promise<MemoryCompactOutput> {
		const database = this.#db();
		const session = await this.#session(input.conversationId);
		if (session === undefined) throw new Error("Conversation not found");
		const all = await database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, session.id))
			.orderBy(asc(messages.occurredAt), asc(messages.id));
		const previous = await database
			.select()
			.from(memories)
			.where(
				and(
					eq(memories.conversationId, session.id),
					eq(memories.kind, "summary"),
					eq(memories.status, "active"),
				),
			)
			.orderBy(desc(memories.updatedAt))
			.limit(5);
		const watermark = previous
			.map((row) => parseEvidence(row.evidenceJson).compactedThroughMessageId)
			.find((value): value is string => typeof value === "string");
		if (input.throughMessageId !== undefined && input.throughMessageId === watermark) {
			return { created: false, memory: previous[0] };
		}
		const watermarkIndex =
			watermark === undefined ? -1 : all.findIndex((row) => row.id === watermark);
		let end = all.length - RECENT_LIVE_WINDOW;
		if (input.throughMessageId !== undefined) {
			const requested = all.findIndex((row) => row.id === input.throughMessageId);
			if (requested !== -1) end = Math.min(end, requested + 1);
		}
		const start = watermarkIndex + 1;
		if (end <= start) return { created: false, memory: previous[0] };
		const slice = all.slice(start, end);
		const through = slice.at(-1);
		if (through === undefined) return { created: false, memory: previous[0] };
		const nowDate = this.#now();
		const now = nowIso(nowDate);
		const warm = this.#warmState(slice);
		const evidence = {
			compactedThroughAt: through.occurredAt,
			compactedThroughMessageId: through.id,
			compactedThroughMessageIndex: end - 1,
			createdAt: now,
			decisions: warm.decisions,
			messageCount: slice.length,
			model: "deterministic",
			openThreads: warm.openThreads,
			promptVersion: MEMORY_COMPACTION_PROMPT_VERSION,
			rangeHash: hashText(slice.map((row) => `${row.id}:${row.occurredAt}`).join("|")),
			startMessageId: slice[0]?.id,
			todos: warm.todos,
			topic: warm.topic,
		};
		const summaryParts = [
			`Warm session summary through ${through.occurredAt}.`,
			warm.topic.length > 0 ? `Topic: ${warm.topic}.` : "",
			warm.decisions.length > 0 ? `Decisions: ${warm.decisions.join("; ")}.` : "",
			warm.todos.length > 0 ? `Todos: ${warm.todos.join("; ")}.` : "",
			warm.openThreads.length > 0 ? `Open threads: ${warm.openThreads.join("; ")}.` : "",
		].filter((part) => part.length > 0);
		const result = await this.create({
			confidence: 0.82,
			content: summaryParts.join(" "),
			conversationId: session.id,
			createdBy: "task",
			dedupeKey: `summary:${session.id}:${through.id}`,
			evidence,
			extractionModel: "deterministic",
			extractionPromptVersion: MEMORY_COMPACTION_PROMPT_VERSION,
			importance: 0.65,
			kind: "summary",
			scope: "conversation",
			sourceConversationId: session.id,
			sourceEntryId: through.id,
			sourceMessageId: through.id,
			status: "active",
			summary: summaryParts.join(" "),
			visibility: "private",
		});
		await this.#recordAudit("memory.compact", result.memory, "ok");
		this.#logger.info("conversation compacted additively", {
			conversationId: session.id,
			messageCount: slice.length,
			memoryId: result.memory.id,
		});
		return { created: true, memory: result.memory };
	}

	/** Warm summary/state row for prompt injection: latest active `summary` memory. */
	async warmState(conversationId: string): Promise<
		| {
				readonly evidence: Record<string, unknown>;
				readonly memory: MemoryRow;
		  }
		| undefined
	> {
		const [row] = await this.#db()
			.select()
			.from(memories)
			.where(
				and(
					eq(memories.conversationId, conversationId),
					eq(memories.kind, "summary"),
					eq(memories.status, "active"),
					isNull(memories.revokedAt),
				),
			)
			.orderBy(desc(memories.updatedAt))
			.limit(1);
		if (row === undefined) return undefined;
		return { evidence: parseEvidence(row.evidenceJson), memory: row };
	}

	async recordSearch(conversationId: string | undefined, query: string, limit = 10) {
		const scopeFilter =
			conversationId === undefined
				? undefined
				: combine([
						or(
							eq(memories.scope, "global"),
							and(
								eq(memories.scope, "persona"),
								or(eq(memories.conversationId, conversationId), isNull(memories.conversationId)),
							),
							and(eq(memories.scope, "conversation"), eq(memories.conversationId, conversationId)),
						),
					]);
		return this.recall({
			...(conversationId === undefined ? {} : { conversationId }),
			limit,
			query,
			...(scopeFilter === undefined ? {} : { scopeFilter }),
		});
	}

	async scheduleExtraction(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
		readonly entryId?: string;
		readonly activityId?: string;
	}): Promise<void> {
		try {
			const session = await this.#resolveSessionInput(input);
			if (session === undefined || this.#policyService === undefined) return;
			const policy = await this.#policyService.effectivePolicy(session.id);
			if (policy.memoryEnabled === false) return;
			const sourceKey = input.entryId ?? input.activityId ?? "latest";
			await this.#createTask({
				conversationId: session.id,
				dedupeKey: `extract:${session.id}:${sourceKey}`,
				kind: "memory.extract",
				payload: {
					activityId: input.activityId,
					entryId: input.entryId,
					conversationId: session.id,
				},
			});
		} catch (error) {
			this.#logger.warn("memory extraction scheduling failed", {
				error: errorMessage(error),
			});
		}
	}

	async scheduleCompaction(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
	}): Promise<void> {
		try {
			const session = await this.#resolveSessionInput(input);
			if (session === undefined || this.#policyService === undefined) return;
			const policy = await this.#policyService.effectivePolicy(session.id);
			if (policy.memoryEnabled === false || policy.memoryCompactionEnabled === false) return;
			await this.#createTask({
				conversationId: session.id,
				dedupeKey: `compact:${session.id}`,
				kind: "memory.compact",
				payload: { conversationId: session.id },
			});
		} catch (error) {
			this.#logger.warn("memory compaction scheduling failed", {
				error: errorMessage(error),
			});
		}
	}

	/** Install durable task handlers. Actions are idempotent so retries are safe. */
	registerTaskHandlers(tasks: PluginTaskService): void {
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.expire", async () => {
			const expired = await this.expireDue();
			return { outcome: { expired } };
		});
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.extract", async (task) =>
			this.#handleExtractionTask(task),
		);
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.compact", async (task) =>
			this.#handleCompactionTask(task),
		);
	}

	async start(): Promise<void> {
		if (this.#schedulerStarted || this.#tasks === undefined) return;
		this.#schedulerStarted = true;
		const tasks = this.#tasks;
		const existing = await tasks.list(MEMORY_PLUGIN_ID, {
			kind: "memory.expire",
			status: ["pending", "running"],
		});
		if (existing.length === 0) {
			await this.#createTask({
				dedupeKey: "expire-periodic",
				intervalMs: 3_600_000,
				kind: "memory.expire",
				payload: {},
			});
		}
	}

	async #handleExtractionTask(task: PluginTask): Promise<{ outcome?: unknown; logs?: string[] }> {
		const conversationId =
			task.conversationId ??
			(typeof task.payload === "object" && task.payload !== null
				? (task.payload as { conversationId?: unknown }).conversationId
				: undefined);
		if (typeof conversationId !== "string") return { outcome: { skipped: "no-conversation" } };
		const result = await this.extractForConversation(conversationId);
		return {
			logs: [`extracted ${result.written} memories`],
			outcome: { candidates: result.candidates, written: result.written },
		};
	}

	async #handleCompactionTask(task: PluginTask): Promise<{ outcome?: unknown }> {
		const conversationId =
			task.conversationId ??
			(typeof task.payload === "object" && task.payload !== null
				? (task.payload as { conversationId?: unknown }).conversationId
				: undefined);
		if (typeof conversationId !== "string") return { outcome: { skipped: "no-conversation" } };
		const policy =
			this.#policyService === undefined
				? undefined
				: await this.#policyService.effectivePolicy(conversationId);
		if (policy?.memoryEnabled === false || policy?.memoryCompactionEnabled === false) {
			return { outcome: { skipped: "disabled" } };
		}
		const result = await this.compactSession({ conversationId });
		return { outcome: { created: result.created, memoryId: result.memory?.id } };
	}

	/**
	 * Extract memories for one conversation. Structured LLM output is preferred; a deterministic
	 * heuristic keeps offline/test behavior useful. Every failure is isolated from replies.
	 */
	async extractForConversation(
		conversationId: string,
	): Promise<{ candidates: number; written: number }> {
		const database = this.#db();
		const session = await this.#session(conversationId);
		if (session === undefined || this.#policyService === undefined) {
			return { candidates: 0, written: 0 };
		}
		const policy = await this.#policyService.effectivePolicy(session.id);
		if (policy.memoryEnabled === false) return { candidates: 0, written: 0 };
		const rows = await database
			.select()
			.from(messages)
			.where(eq(messages.conversationId, session.id))
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(EXTRACTION_MESSAGE_LIMIT);
		const chronological = rows.toReversed();
		if (chronological.length === 0) return { candidates: 0, written: 0 };
		let candidates: ExtractionCandidate[] = [];
		let extractor: "heuristic" | "llm" = "heuristic";
		let extractionModel = "deterministic";
		const useLlm =
			this.#complete !== undefined &&
			(policy.memoryExtractModel !== undefined || this.#llmEnabled());
		if (useLlm) {
			try {
				const llm = await this.#llmExtract(policy, chronological);
				if (llm.length > 0) {
					candidates = llm;
					extractor = "llm";
					extractionModel = policy.memoryExtractModel ?? "default";
				}
			} catch (error) {
				this.#logger.warn("memory llm extraction failed; using heuristic fallback", {
					error: errorMessage(error),
				});
			}
		}
		if (candidates.length === 0) {
			const heuristic = heuristicCandidates(chronological, this.#now());
			candidates = heuristic.candidates;
		}
		const groupShared = session.kind === "group";
		const canWriteShared = groupShared && policy.sharedMemoryWriteEnabled !== false;
		const reviewRequired = policy.memoryReviewRequired === true || (groupShared && !canWriteShared);
		let written = 0;
		for (const candidate of candidates) {
			if (written >= policy.memoryMaxWritesPerActivity) break;
			if (candidate.confidence < policy.memoryMinConfidence) continue;
			if (policy.sharedMemoryEnabled === false && candidate.scope === "global") continue;
			const scope: MemoryScope = candidate.scope ?? (canWriteShared ? "global" : "conversation");
			const status: MemoryStatus = reviewRequired ? "pending" : "active";
			const messageIds = chronological.map((row) => row.id);
			const source = chronological.at(-1);
			const result = await this.create({
				confidence: candidate.confidence,
				content: candidate.content,
				...(scope === "conversation" ? { conversationId: session.id } : {}),
				createdBy: "task",
				...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
				evidence: {
					extractor,
					messageIds,
					range: { endMessageId: messageIds.at(-1), startMessageId: messageIds[0] },
					sourceMessageId: source?.id,
				},
				extractionModel,
				extractionPromptVersion:
					extractor === "heuristic"
						? MEMORY_EXTRACTION_PROMPT_VERSION
						: policy.memoryExtractionPromptVersion,
				importance: candidate.importance,
				kind: candidate.kind,
				scope,
				...(source === undefined ? {} : { sourceMessageId: source.id }),
				status,
				summary: candidate.summary,
				...(scope === "global" ? { visibility: "shared" } : { visibility: "private" }),
			});
			written += 1;
			await this.#recordAudit(
				status === "pending" ? "memory.extract.pending" : "memory.extract",
				result.memory,
				"ok",
			);
		}
		return { candidates: candidates.length, written };
	}

	async #llmExtract(
		policy: ConversationPolicy,
		rows: readonly MessageRow[],
	): Promise<ExtractionCandidate[]> {
		if (this.#complete === undefined) return [];
		const transcript = rows
			.filter((row) => row.contentText !== null)
			.map((row) => `${row.direction}: ${snippet(row.contentText ?? "", 500)}`)
			.join("\n");
		const prompt = [
			"Extract durable memories from this conversation excerpt.",
			"Return ONLY a JSON array. Each item has: kind (fact|summary|setting|person|preference|style|glossary|todo|event|relationship|observation), summary (short), content, confidence (0..1), importance (0..1), optional expiresAt ISO date, optional scope.",
			`Prompt version: ${policy.memoryExtractionPromptVersion}.`,
			"Conversation:",
			transcript,
		].join("\n");
		const text = await this.#complete(prompt, policy.memoryExtractModel);
		if (text === undefined) return [];
		return parseLlmCandidates(text);
	}

	async #createTask(input: {
		readonly conversationId?: string;
		readonly dedupeKey: string;
		readonly intervalMs?: number;
		readonly kind: string;
		readonly payload: unknown;
	}): Promise<void> {
		if (this.#tasks === undefined) return;
		await this.#tasks.create(
			MEMORY_PLUGIN_ID,
			{
				dedupeKey: input.dedupeKey,
				kind: input.kind,
				payload: input.payload,
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
				...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
			},
			MEMORY_TASK_PERMISSIONS,
		);
	}

	async #resolveSessionInput(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
	}): Promise<{ id: string; kind: string } | undefined> {
		if (input.conversationId !== undefined) return this.#session(input.conversationId);
		if (input.durableConversationId === undefined) return undefined;
		const [row] = await this.#db()
			.select({ id: conversations.id, kind: conversations.kind })
			.from(conversations)
			.where(eq(conversations.durableConversationId, input.durableConversationId))
			.orderBy(desc(conversations.updatedAt))
			.limit(1);
		return row;
	}

	async #session(conversationId: string): Promise<{ id: string; kind: string } | undefined> {
		const [row] = await this.#db()
			.select({ id: conversations.id, kind: conversations.kind })
			.from(conversations)
			.where(eq(conversations.id, conversationId))
			.limit(1);
		return row;
	}

	async #setStatus(id: string, status: MemoryStatus): Promise<MemoryRow> {
		const now = nowIso(this.#now());
		const [row] = await this.#db()
			.update(memories)
			.set({
				revokedAt: status === "revoked" ? now : null,
				status,
				updatedAt: now,
			})
			.where(eq(memories.id, id))
			.returning();
		if (row === undefined) throw new Error("Memory status update did not return a row");
		await this.#recordAudit(`memory.${status}`, row, "ok");
		return row;
	}

	async #supersedeConflicts(input: {
		readonly conversationId: string | null;
		readonly excludeId: string;
		readonly kind: string;
		readonly projectId: string | null;
		readonly scope: string;
		readonly subjectUserId: string | null;
		readonly supersedes: readonly string[] | undefined;
		readonly supersededBy: string;
		readonly text: string;
	}): Promise<string[]> {
		const database = this.#db();
		const now = nowIso(this.#now());
		const targets = new Map<string, MemoryRow>();
		if (input.supersedes !== undefined && input.supersedes.length > 0) {
			const rows = await database
				.select()
				.from(memories)
				.where(
					or(
						inArray(memories.id, [...input.supersedes]),
						inArray(memories.dedupeKey, [...input.supersedes]),
					),
				);
			for (const row of rows) if (row.id !== input.excludeId) targets.set(row.id, row);
		}
		if (
			!["fact", "preference", "setting", "person", "relationship", "style"].includes(input.kind)
		) {
			return this.#applySupersede([...targets.values()], input.supersededBy, now);
		}
		const candidates = await database
			.select()
			.from(memories)
			.where(
				and(
					eq(memories.status, "active"),
					eq(memories.scope, input.scope as MemoryScope),
					eq(memories.kind, input.kind),
					isNull(memories.revokedAt),
				),
			)
			.limit(200);
		const textPolarity = polarity(input.text);
		for (const candidate of candidates) {
			if (candidate.id === input.excludeId) continue;
			if (
				candidate.conversationId !== input.conversationId ||
				candidate.subjectUserId !== input.subjectUserId ||
				candidate.projectId !== input.projectId
			) {
				continue;
			}
			const overlap = textOverlap(input.text, `${candidate.summary}\n${candidate.content}`);
			if (overlap >= 0.5 && polarity(candidate.content) !== textPolarity) {
				targets.set(candidate.id, candidate);
			}
		}
		return this.#applySupersede([...targets.values()], input.supersededBy, now);
	}

	async #applySupersede(
		targets: readonly MemoryRow[],
		supersededBy: string,
		now: string,
	): Promise<string[]> {
		if (targets.length === 0) return [];
		const database = this.#db();
		for (const target of targets) {
			const evidence = mergeEvidence(target.evidenceJson, { supersededBy }, now);
			await database
				.update(memories)
				.set({
					evidenceJson: evidence,
					revokedAt: now,
					status: "revoked",
					updatedAt: now,
				})
				.where(eq(memories.id, target.id));
		}
		return targets.map((target) => target.id);
	}

	async #embedCandidates(
		query: string,
		candidates: readonly MemoryRow[],
	): Promise<{ byId: Map<string, readonly number[]>; query?: readonly number[] }> {
		const byId = new Map<string, readonly number[]>();
		if (this.#embed === undefined || query.trim().length === 0) return { byId };
		try {
			const queryEmbedding = await this.#embed([query]);
			const queryVector = queryEmbedding?.vectors[0];
			if (queryEmbedding === undefined || queryVector === undefined) return { byId };
			const modelId = queryEmbedding.modelId;
			const missing: MemoryRow[] = [];
			for (const memory of candidates) {
				const cached = this.#cachedEmbedding(memory, modelId);
				if (cached !== undefined) byId.set(memory.id, cached);
				else missing.push(memory);
			}
			if (missing.length > 0) {
				const embeddings = await this.#embed(missing.map((row) => row.summary));
				if (embeddings !== undefined && embeddings.modelId === modelId) {
					for (const [index, memory] of missing.entries()) {
						const vector = embeddings.vectors[index];
						if (vector === undefined) continue;
						byId.set(memory.id, vector);
						await this.#db()
							.update(memories)
							.set({
								embeddingJson: JSON.stringify(vector),
								embeddingModel: modelId,
							})
							.where(eq(memories.id, memory.id));
					}
				}
			}
			return { byId, query: queryVector };
		} catch (error) {
			this.#logger.debug("memory embedding unavailable; using lexical ranking", {
				error: errorMessage(error),
			});
			return { byId };
		}
	}

	#cachedEmbedding(memory: MemoryRow, modelId: string): readonly number[] | undefined {
		if (memory.embeddingModel !== modelId || memory.embeddingJson === null) return undefined;
		try {
			const parsed: unknown = JSON.parse(memory.embeddingJson);
			return Array.isArray(parsed) && parsed.every((value) => typeof value === "number")
				? (parsed as number[])
				: undefined;
		} catch {
			return undefined;
		}
	}

	#warmState(rows: readonly MessageRow[]): {
		readonly decisions: string[];
		readonly openThreads: string[];
		readonly todos: string[];
		readonly topic: string;
	} {
		const texts = rows
			.map((row) => row.contentText)
			.filter((text): text is string => text !== null && text.trim().length > 0);
		const frequencies = new Map<string, number>();
		for (const text of texts) {
			for (const token of extractMemoryTokens(text, 12)) {
				frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			}
		}
		const topic = [...frequencies.entries()]
			.toSorted((left, right) => right[1] - left[1])
			.slice(0, 4)
			.map(([token]) => token)
			.join(", ");
		const decisions: string[] = [];
		const todos: string[] = [];
		const openThreads: string[] = [];
		for (const text of texts) {
			for (const line of text.split(/[\n。！？!?]+/u)) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				if (/(?:decided|decision|we will|let's|agreed|决定|确定)/iu.test(trimmed)) {
					decisions.push(snippet(trimmed, 120));
				}
				if (/(?:todo|need to|should|remind|待办|需要|记得)/iu.test(trimmed)) {
					todos.push(snippet(trimmed, 120));
				}
				if (trimmed.endsWith("?") || trimmed.endsWith("？")) {
					openThreads.push(snippet(trimmed, 120));
				}
			}
		}
		return {
			decisions: decisions.slice(0, 5),
			openThreads: openThreads.slice(-4),
			todos: todos.slice(0, 6),
			topic,
		};
	}

	async #recordAudit(
		action: string,
		memory: Pick<MemoryRow, "id" | "kind" | "scope" | "status">,
		result: "ok" | "denied" | "failed",
		reason?: string,
	): Promise<void> {
		try {
			await this.#audit?.({
				action,
				actorKind: "system",
				payload: {
					kind: memory.kind,
					memoryId: memory.id,
					scope: memory.scope,
					status: memory.status,
				},
				result,
				...(reason === undefined ? {} : { reason }),
				targetId: memory.id,
				targetKind: "memory",
			});
		} catch {
			// Auditing failure must never break a memory write or a chat turn.
		}
	}
}
