import { createHash, randomUUID } from "node:crypto";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	like,
	lte,
	ne,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import type {
	ConversationPolicy,
	MemoryConsolidationOutput,
	MemoryScope,
	MemoryStatus,
	WarmStateAnswer,
	WarmStatePayload,
} from "@tsukaima/contracts";
import {
	conversations,
	memories,
	memoryConsolidationState,
	messages,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { AuditEntry, PluginPermission, PluginTask } from "@tsukaima/sdk";
import { previewText, type Logger } from "../logging.ts";
import { isRecord } from "../records.ts";
import type { ConversationPolicyService } from "./conversation-policy.ts";
import {
	consolidationBatchKey,
	deterministicWarmState,
	isPhaticMessage,
	MEMORY_CONSOLIDATION_PROMPT_VERSION,
	mergeWarmState,
	nextConsolidationRunAt,
	parseConsolidationOutputDetailed,
	parseWarmState,
	renderConsolidationPrompt,
	renderWarmStateLines,
	WARM_STATE_EVIDENCE_KEY,
	type ConsolidationMessage,
} from "./memory-consolidation.ts";
import type { PluginTaskService } from "./plugin-task-service.ts";

export const MEMORY_PLUGIN_ID = "memory";
export const MEMORY_SERVICE_BINDING = "tsukaima.memory.service";
export const MEMORY_EXTRACTION_PROMPT_VERSION = "memory-extract-v1";
import { DEFAULT_PROMPTS } from "./prompt-defaults.ts";

/** @deprecated Pre-Batch-5 regex compaction version; consolidation uses its own version. */
export const MEMORY_COMPACTION_PROMPT_VERSION = "memory-compact-v1";

/** First retry delay of a failed consolidation batch; doubles per failure. */
const CONSOLIDATION_RETRY_BASE_MS = 30_000;
/** Hard ceiling for one consolidation model call, independent of provider behavior. */
const CONSOLIDATION_TIMEOUT_MS = 90_000;
const QA_RECALL_LIMIT = 2;
/**
 * Tuned on synthetic English and CJK recurring-question pairs: questions that share a subject
 * and intent land around 0.4-0.8, while unrelated small talk stays below it.
 */
const QA_MATCH_THRESHOLD = 0.35;
const EXTRACTION_MESSAGE_LIMIT = 30;
const CANDIDATE_LIMIT = 120;
const KEYWORD_CANDIDATES_PER_TOKEN = 30;
const MAX_QUERY_TOKENS = 24;
/**
 * Recall blend. Lexical evidence leads, stored vectors add semantic signal, and prior
 * importance/recency only break ties: prompt rendering must not be dominated by old rows.
 */
const RECALL_WEIGHTS = {
	importance: 0.1,
	lexical: 0.5,
	recency: 0.05,
	vector: 0.35,
} as const;
/** Strongest lexical hits whose stored embeddings form the local recall centroid. */
const LOCAL_VECTOR_SEEDS = 3;
const EMBED_BATCH_SIZE = 32;
const EMBED_BACKFILL_DELAY_MS = 5_000;
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

export type MemoryConsolidationResult =
	| {
			readonly status: "consolidated";
			readonly memoryId: string;
			readonly messageCount: number;
			readonly written: number;
	  }
	| {
			readonly status: "skipped" | "failed" | "dropped";
			readonly reason: string;
	  };

interface ConsolidationCursor {
	readonly droppedBatches: number;
	readonly failedBatchKey: string | null;
	readonly failureCount: number;
	readonly pendingSince: string | null;
	readonly watermarkMessageId: string | null;
	readonly watermarkOccurredAt: string | null;
}

/** Durable memory proposed by a consolidation pass (model or deterministic fallback). */
interface ConsolidatedMemoryInput {
	readonly confidence: number;
	readonly content?: string;
	readonly expiresAt?: string;
	readonly importance: number;
	readonly kind: string;
	readonly subject?: string;
	readonly summary: string;
}

export interface MemoryEmbeddingOutput {
	readonly modelId: string;
	readonly vectors: readonly (readonly number[])[];
}

export interface MemoryServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void>;
	readonly complete?: (
		prompt: string,
		modelId?: string,
		signal?: AbortSignal,
	) => Promise<string | undefined>;
	/**
	 * Default consolidation model id (runtime `memoryModelId`), separate from the chat persona
	 * model. `ConversationPolicy.memoryExtractModel` overrides it per conversation.
	 */
	readonly defaultModelId?: () => Promise<string | undefined>;
	readonly extractionPrompt?: () => Promise<string>;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly embed?: (texts: readonly string[]) => Promise<MemoryEmbeddingOutput | undefined>;
	/** Model the embedding provider currently uses; rows embedded with another model are refreshed. */
	readonly embeddingModelId?: () => Promise<string | undefined>;
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
			if (raw.length <= 12) tokens.add(raw);
			if (raw.length > 4) {
				for (let index = 0; index + 2 <= raw.length && tokens.size < limit; index += 1) {
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

/** Interrogative stems carry the intent of a recurring question even when the wording shifts. */
const QUESTION_STEMS =
	/(?:when|where|who|what|which|how|why|time|date|几点|什么时候|哪天|哪里|谁|什么|怎么|为什么|多少)/gu;

/**
 * Similarity for QA consistency. Token overlap handles reordered English phrasing, while a
 * character-bigram containment check keeps short CJK questions comparable without a model.
 */
function shortBigrams(text: string): Set<string> {
	const stripped = text.replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, "");
	if (stripped.length < 2) return new Set(stripped.length === 1 ? [stripped] : []);
	return new Set(
		Array.from({ length: stripped.length - 1 }, (_, index) => stripped.slice(index, index + 2)),
	);
}

function questionOverlap(left: string, right: string): number {
	const tokenOverlap = textOverlap(left, right);
	const normalizedLeft = left.toLowerCase().normalize("NFKC");
	const normalizedRight = right.toLowerCase().normalize("NFKC");
	const leftBigrams = shortBigrams(normalizedLeft);
	const rightBigrams = shortBigrams(normalizedRight);
	let bigramOverlap = 0;
	if (leftBigrams.size > 0 && rightBigrams.size > 0) {
		let shared = 0;
		for (const bigram of leftBigrams) if (rightBigrams.has(bigram)) shared += 1;
		bigramOverlap = shared / Math.max(leftBigrams.size, rightBigrams.size);
	}
	const leftHasQuestionStem = QUESTION_STEMS.test(normalizedLeft);
	QUESTION_STEMS.lastIndex = 0;
	const rightHasQuestionStem = QUESTION_STEMS.test(normalizedRight);
	QUESTION_STEMS.lastIndex = 0;
	const stemBoost = leftHasQuestionStem && rightHasQuestionStem ? 0.1 : 0;
	return Math.min(1, Math.max(tokenOverlap, bigramOverlap) + stemBoost);
}

function parseEvidence(value: string | null): Record<string, unknown> {
	if (value === null || value.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
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

/** Canonical comparison key for person-card keys and display names. */
function memoryPersonKey(value: string): string {
	return value.trim().toLowerCase().normalize("NFKC");
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
	if (hits === 0) return 0;
	// Any keyword match should strongly outrank unrelated pinned/high-importance memories.
	return Math.min(1, 0.55 + 0.45 * (hits / Math.max(1, Math.min(tokens.length, 6))));
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
	rows: readonly {
		readonly contentText: string | null;
		readonly direction: string;
		readonly id: string;
	}[],
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
	return {
		confidence,
		content,
		...(expiresAt === undefined ? {} : { expiresAt }),
		importance,
		kind: record.kind.trim().toLowerCase(),
		summary: snippet(record.summary, 1_000),
	};
}

function parseLlmCandidates(text: string): ExtractionCandidate[] | undefined {
	const trimmed = text.trim();
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start === -1 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
		if (!Array.isArray(parsed)) return undefined;
		const candidates = parsed
			.map(llmCandidateSchema)
			.filter((candidate): candidate is ExtractionCandidate => candidate !== undefined);
		return parsed.length > 0 && candidates.length === 0 ? undefined : candidates;
	} catch {
		return undefined;
	}
}

/**
 * Owns memory lifecycle, review transitions, deduplication, expiry, hybrid recall, additive
 * compaction, and background extraction. Raw memory or chat content is never logged here.
 */
export class MemoryService {
	readonly #audit: ((entry: AuditEntry) => Promise<void>) | undefined;
	readonly #complete:
		| ((prompt: string, modelId?: string, signal?: AbortSignal) => Promise<string | undefined>)
		| undefined;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #extractionPrompt: MemoryServiceOptions["extractionPrompt"];
	readonly #embed:
		| ((texts: readonly string[]) => Promise<MemoryEmbeddingOutput | undefined>)
		| undefined;
	readonly #embeddingModelId: MemoryServiceOptions["embeddingModelId"];
	readonly #id: () => string;
	readonly #llmEnabled: () => boolean;
	readonly #logger: Logger;
	readonly #now: () => Date;
	readonly #policyService: ConversationPolicyService | undefined;
	readonly #tasks: PluginTaskService | undefined;
	readonly #defaultModelId: MemoryServiceOptions["defaultModelId"];
	readonly #consolidating = new Set<string>();
	readonly #noting = new Map<string, Promise<void>>();
	#schedulerStarted = false;

	constructor(options: MemoryServiceOptions) {
		this.#audit = options.audit;
		this.#complete = options.complete;
		this.#database = options.database;
		this.#extractionPrompt = options.extractionPrompt;
		this.#embed = options.embed;
		this.#embeddingModelId = options.embeddingModelId;
		this.#id = options.id ?? randomUUID;
		this.#llmEnabled = options.llmEnabled ?? (() => false);
		this.#logger = options.logger.child("tsukaima::server::memory");
		this.#now = options.now ?? (() => new Date());
		this.#policyService = options.policyService;
		this.#tasks = options.tasks;
		this.#defaultModelId = options.defaultModelId;
	}

	#db(): TsukaimaDatabase {
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
				this.#logger.debug("memory merged", {
					kind: memory.kind,
					memoryId: memory.id,
					scope: memory.scope,
					status: memory.status,
				});
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
		void this.scheduleEmbeddingBackfill();
		if (superseded.length > 0) {
			this.#logger.info("memory superseded stale rows", {
				count: superseded.length,
				memoryId: row.id,
			});
		}
		this.#logger.debug("memory created", {
			kind: row.kind,
			memoryId: row.id,
			scope: row.scope,
			status: row.status,
		});
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
		if (textChanged) void this.scheduleEmbeddingBackfill();
		if (superseded.length > 0) {
			this.#logger.info("memory update superseded stale rows", {
				count: superseded.length,
				memoryId: row.id,
			});
		}
		this.#logger.debug("memory updated", {
			kind: row.kind,
			memoryId: row.id,
			scope: row.scope,
			status: row.status,
		});
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
		this.#logger.debug("memory revoked", {
			kind: row.kind,
			memoryId: row.id,
			scope: row.scope,
		});
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

	/**
	 * Hybrid recall on the prompt-render hot path: lexical + already-stored embeddings +
	 * importance/recency/pin, bounded by `limit`. It performs no network calls; embeddings are
	 * computed in the background by `memory.embed` (see {@link embedPending}).
	 */
	async recall(input: MemoryRecallInput = {}): Promise<RankedMemory[]> {
		const startedAt = performance.now();
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
		this.#logger.trace("memory recall started", {
			conversationId: input.conversationId,
			limit: input.limit ?? 10,
			queryPreview: previewText(input.query ?? ""),
			tokens,
		});
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
		const lexicalById = new Map(
			candidates.map((memory) => [memory.id, lexicalScore(memory, tokens)] as const),
		);
		const vectors = this.#localVectorScores(candidates, lexicalById);
		const ranked = candidates.map((memory) => {
			const lexical = lexicalById.get(memory.id) ?? 0;
			const vector = vectors.get(memory.id) ?? 0;
			const recency = recencyScore(memory.updatedAt, nowDate);
			const pinned = memory.pinned === 1 ? 0.2 : 0;
			const score =
				lexical * RECALL_WEIGHTS.lexical +
				vector * RECALL_WEIGHTS.vector +
				memory.importance * RECALL_WEIGHTS.importance +
				recency * RECALL_WEIGHTS.recency +
				pinned;
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
		const selected = ranked.slice(0, Math.max(1, input.limit ?? 10));
		this.#logger.debug("memory recall completed", {
			candidateCount: candidates.length,
			conversationId: input.conversationId,
			durationMs: Math.round(performance.now() - startedAt),
			returnedCount: selected.length,
			tokenCount: tokens.length,
			usedEmbeddings: vectors.size > 0,
		});
		return selected;
	}

	/**
	 * Admin "compact now": run one consolidation pass immediately (bypassing the idle debounce)
	 * and return the conversation's merged warm-state row. `messages` rows are read only.
	 */
	async compactSession(input: MemoryCompactInput): Promise<MemoryCompactOutput> {
		const session = await this.#session(input.conversationId);
		if (session === undefined) throw new Error("Conversation not found");
		// Coding sessions are isolated from the chat memory graph in both directions.
		if (session.kind === "workspace") return { created: false, memory: undefined };
		const result = await this.consolidateConversation(
			session.id,
			input.throughMessageId === undefined ? {} : { throughMessageId: input.throughMessageId },
		);
		const warm = await this.warmState(session.id);
		return { created: result.status === "consolidated", memory: warm?.memory };
	}

	/** Warm summary/state row for prompt injection: latest active `summary` memory. */
	async warmState(conversationId: string): Promise<
		| {
				readonly evidence: Record<string, unknown>;
				readonly memory: MemoryRow;
				/** Structured merged state; `undefined` for pre-Batch-5 regex rows. */
				readonly state: WarmStatePayload | undefined;
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
		const evidence = parseEvidence(row.evidenceJson);
		return { evidence, memory: row, state: parseWarmState(evidence) };
	}

	/**
	 * QA consistency recall: earlier answers to questions similar to `query`, taken from the
	 * merged warm state. Local and synchronous with the turn; no model or network call.
	 */
	async recallAnsweredQuestions(
		conversationId: string,
		query: string,
		limit = QA_RECALL_LIMIT,
	): Promise<WarmStateAnswer[]> {
		if (query.trim().length === 0) return [];
		const warm = await this.warmState(conversationId);
		const answers = warm?.state?.answers ?? [];
		return answers
			.map((answer) => ({ answer, overlap: questionOverlap(answer.question, query) }))
			.filter((entry) => entry.overlap >= QA_MATCH_THRESHOLD)
			.toSorted((left, right) => {
				if (right.overlap !== left.overlap) return right.overlap - left.overlap;
				const leftAt =
					left.answer.answeredAt === undefined ? 0 : Date.parse(left.answer.answeredAt);
				const rightAt =
					right.answer.answeredAt === undefined ? 0 : Date.parse(right.answer.answeredAt);
				return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
			})
			.slice(0, Math.max(0, limit))
			.map((entry) => entry.answer);
	}

	async recordSearch(
		conversationId: string | undefined,
		query: string,
		limit = 10,
		filters?: { readonly kind?: string | undefined; readonly scope?: MemoryScope | undefined },
	) {
		const scopeCondition =
			conversationId === undefined
				? undefined
				: or(
						eq(memories.scope, "global"),
						and(
							eq(memories.scope, "persona"),
							or(eq(memories.conversationId, conversationId), isNull(memories.conversationId)),
						),
						and(eq(memories.scope, "conversation"), eq(memories.conversationId, conversationId)),
					);
		const extraConditions: (SQL | undefined)[] = [scopeCondition];
		if (filters?.kind !== undefined) extraConditions.push(eq(memories.kind, filters.kind));
		if (filters?.scope !== undefined) extraConditions.push(eq(memories.scope, filters.scope));
		const scopeFilter = combine(extraConditions);
		return this.recall({
			...(conversationId === undefined ? {} : { conversationId }),
			limit,
			query,
			scopeFilter,
		});
	}

	/**
	 * Single post-turn trigger for background memory work. Cheap and idempotent: it counts the
	 * unconsolidated messages and (re)schedules one idle-debounced `memory.consolidate` task per
	 * conversation. It never calls a model, so firing it from several lifecycle events (reply
	 * delivered, activity window closed) still yields at most one consolidation run per window.
	 */
	async noteConversationActivity(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
	}): Promise<void> {
		try {
			const session = await this.#resolveSessionInput(input);
			if (session === undefined || this.#policyService === undefined) return;
			if (session.kind === "workspace") return;
			const policy = await this.#policyService.effectivePolicy(session.id);
			if (policy.memoryEnabled === false || policy.memoryCompactionEnabled === false) return;
			// Serialize notes per conversation so concurrent hooks cannot create two pending tasks.
			const previous = this.#noting.get(session.id) ?? Promise.resolve();
			const next = previous
				.catch(() => undefined)
				.then(() => this.#noteActivity(session.id, policy));
			this.#noting.set(session.id, next);
			try {
				await next;
			} finally {
				if (this.#noting.get(session.id) === next) this.#noting.delete(session.id);
			}
		} catch (error) {
			this.#logger.warn("memory consolidation scheduling failed", {
				error: errorMessage(error),
			});
		}
	}

	/** @deprecated Use {@link noteConversationActivity}; kept for plugin/test callers. */
	async scheduleExtraction(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
		readonly entryId?: string;
		readonly activityId?: string;
	}): Promise<void> {
		await this.noteConversationActivity({
			...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
			...(input.durableConversationId === undefined
				? {}
				: { durableConversationId: input.durableConversationId }),
		});
	}

	/** @deprecated Use {@link noteConversationActivity}; kept for plugin/test callers. */
	async scheduleCompaction(input: {
		readonly conversationId?: string;
		readonly durableConversationId?: string;
	}): Promise<void> {
		await this.noteConversationActivity(input);
	}

	/**
	 * One background semantic consolidation pass: read the settled delta after the watermark,
	 * merge it with the previous warm state (model when available, deterministic otherwise),
	 * write the merged state and durable memories, then advance the watermark. A batch whose
	 * model output fails `maxFailures` times is dropped and audited instead of retried forever.
	 */
	async consolidateConversation(
		conversationId: string,
		options: { readonly throughMessageId?: string } = {},
	): Promise<MemoryConsolidationResult> {
		const startedAt = performance.now();
		const session = await this.#session(conversationId);
		if (session === undefined || this.#policyService === undefined) {
			return { reason: "no-session", status: "skipped" };
		}
		if (session.kind === "workspace") return { reason: "workspace", status: "skipped" };
		const policy = await this.#policyService.effectivePolicy(session.id);
		if (policy.memoryEnabled === false || policy.memoryCompactionEnabled === false) {
			return { reason: "disabled", status: "skipped" };
		}
		// Never two overlapping passes (and model calls) for the same conversation window.
		if (this.#consolidating.has(session.id)) return { reason: "busy", status: "skipped" };
		this.#consolidating.add(session.id);
		try {
			const config = policy.memoryConsolidation;
			const cursor = await this.#consolidationCursor(session.id);
			const throughLimit =
				options.throughMessageId === undefined
					? undefined
					: await this.#messageCursor(session.id, options.throughMessageId);
			if (options.throughMessageId !== undefined && throughLimit === undefined) {
				return { reason: "through-missing", status: "skipped" };
			}
			const delta = await this.#settledDelta(
				session.id,
				cursor,
				config.maxBatchMessages,
				throughLimit,
			);
			const through = delta.at(-1);
			const batchKey = consolidationBatchKey(delta);
			if (through === undefined || batchKey === undefined) {
				await this.#saveConsolidationState(session.id, { pendingMessages: 0, pendingSince: null });
				return { reason: "empty", status: "skipped" };
			}
			const nowDate = this.#now();
			const now = nowIso(nowDate);
			const previous = (await this.warmState(session.id))?.state;
			const substantive = delta.some(
				(message) => message.direction === "inbound" && !isPhaticMessage(message.text),
			);
			const useModel =
				substantive &&
				this.#complete !== undefined &&
				(policy.memoryExtractModel !== undefined || this.#llmEnabled());
			let state: WarmStatePayload;
			let candidates: ConsolidatedMemoryInput[];
			let model = "deterministic";
			if (useModel && this.#complete !== undefined) {
				const modelId = policy.memoryExtractModel ?? (await this.#defaultModelId?.());
				let output: MemoryConsolidationOutput | undefined;
				let failure = "malformed consolidation output";
				try {
					const prompt = renderConsolidationPrompt({
						chatKind: session.kind,
						delta,
						instructions:
							(await this.#extractionPrompt?.()) ?? DEFAULT_PROMPTS["memory-extraction"],
						nowIso: now,
						policy: config,
						previous,
					});
					const text = await this.#completeConsolidationPrompt(prompt, modelId);
					if (text === undefined) {
						failure = "empty consolidation model response";
					} else {
						const parseResult = parseConsolidationOutputDetailed(text);
						if (parseResult.ok) {
							output = parseResult.data;
						} else {
							failure = parseResult.error;
							this.#logger.warn("failed to parse memory consolidation output", {
								conversationId: session.id,
								error: parseResult.error,
							});
						}
					}
				} catch (error) {
					failure = errorMessage(error);
				}
				if (output === undefined) {
					return await this.#recordConsolidationFailure({
						batchKey,
						config,
						conversationId: session.id,
						cursor,
						delta,
						error: failure,
						policy,
						session,
						through,
					});
				}
				state = mergeWarmState({ next: output.state, nowIso: now, policy: config, previous });
				candidates = output.memories.map((memory) => ({
					confidence: memory.confidence,
					...(memory.content === undefined ? {} : { content: memory.content }),
					...(memory.expiresAt === undefined ? {} : { expiresAt: memory.expiresAt }),
					importance: memory.importance,
					kind: memory.kind,
					...(memory.subject === undefined ? {} : { subject: memory.subject }),
					summary: memory.summary,
				}));
				model = modelId ?? "default";
			} else {
				state = deterministicWarmState({ delta, policy: config, previous });
				// Only explicit statements ("remember …", "my name is …", "todo: …") survive offline.
				candidates = heuristicCandidates(
					delta.map((message) => ({
						contentText: message.text,
						direction: message.direction,
						id: message.id,
					})),
					nowDate,
				).candidates;
			}
			const warm = await this.#writeWarmState(session.id, state, { delta, model, through });
			const written = await this.#writeConsolidatedMemories(session, policy, candidates, {
				delta,
				extractor: model === "deterministic" ? "heuristic" : "llm",
				model,
				state,
			});
			const remaining = await this.#countPending(session.id, {
				watermarkMessageId: through.id,
				watermarkOccurredAt: through.occurredAt,
			});
			await this.#saveConsolidationState(session.id, {
				failedBatchKey: null,
				failureCount: 0,
				lastError: null,
				lastRunAt: now,
				pendingMessages: remaining,
				pendingSince: remaining > 0 ? now : null,
				watermarkMessageId: through.id,
				watermarkOccurredAt: through.occurredAt,
			});
			if (remaining > 0) {
				await this.#scheduleConsolidationTask(
					session.id,
					nextConsolidationRunAt({
						nowMs: nowDate.getTime(),
						pendingMessages: remaining,
						pendingSinceMs: nowDate.getTime(),
						policy: config,
					}),
				);
			}
			this.#logger.debug("memory consolidation completed", {
				conversationId: session.id,
				durationMs: Math.round(performance.now() - startedAt),
				messageCount: delta.length,
				model,
				remaining,
				written,
			});
			return {
				memoryId: warm.id,
				messageCount: delta.length,
				status: "consolidated",
				written,
			};
		} finally {
			this.#consolidating.delete(session.id);
		}
	}

	/**
	 * Bounded model call: the provider receives an AbortSignal and the pass also races a hard
	 * timeout, so a provider that ignores the signal cannot hold the conversation's pass forever.
	 */
	async #completeConsolidationPrompt(
		prompt: string,
		modelId: string | undefined,
	): Promise<string | undefined> {
		const complete = this.#complete;
		if (complete === undefined) return undefined;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`consolidation model timed out after ${CONSOLIDATION_TIMEOUT_MS}ms`));
			}, CONSOLIDATION_TIMEOUT_MS);
			timer.unref?.();
		});
		try {
			return await Promise.race([complete(prompt, modelId, controller.signal), timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Install durable task handlers. Actions are idempotent so retries are safe. */
	registerTaskHandlers(tasks: PluginTaskService): void {
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.expire", async () => {
			const expired = await this.expireDue();
			return { outcome: { expired } };
		});
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.embed", async () => ({
			outcome: await this.embedPending(),
		}));
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.consolidate", async (task) =>
			this.#handleConsolidationTask(task),
		);
		// Pre-Batch-5 task kinds that may still be queued after an upgrade.
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.extract", async (task) =>
			this.#handleConsolidationTask(task),
		);
		tasks.registerHandler(MEMORY_PLUGIN_ID, "memory.compact", async (task) =>
			this.#handleConsolidationTask(task),
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
		await this.scheduleEmbeddingBackfill();
	}

	async #handleConsolidationTask(task: PluginTask): Promise<{ outcome?: unknown }> {
		const conversationId =
			task.conversationId ??
			(typeof task.payload === "object" && task.payload !== null
				? (task.payload as { conversationId?: unknown }).conversationId
				: undefined);
		if (typeof conversationId !== "string") return { outcome: { skipped: "no-conversation" } };
		return { outcome: await this.consolidateConversation(conversationId) };
	}

	async #noteActivity(conversationId: string, policy: ConversationPolicy): Promise<void> {
		const cursor = await this.#consolidationCursor(conversationId);
		const pending = await this.#countPending(conversationId, cursor);
		if (pending === 0) return;
		const nowDate = this.#now();
		const pendingSince = cursor.pendingSince ?? nowIso(nowDate);
		await this.#saveConsolidationState(conversationId, { pendingMessages: pending, pendingSince });
		const pendingSinceMs = Date.parse(pendingSince);
		await this.#scheduleConsolidationTask(
			conversationId,
			nextConsolidationRunAt({
				nowMs: nowDate.getTime(),
				pendingMessages: pending,
				pendingSinceMs: Number.isFinite(pendingSinceMs) ? pendingSinceMs : nowDate.getTime(),
				policy: policy.memoryConsolidation,
			}),
		);
	}

	/** Move the one pending consolidation task to `runAtMs`, or create it. */
	async #scheduleConsolidationTask(conversationId: string, runAtMs: number): Promise<void> {
		if (this.#tasks === undefined) return;
		const [pending] = await this.#tasks.list(
			MEMORY_PLUGIN_ID,
			{ conversationId, kind: "memory.consolidate", limit: 1, status: "pending" },
			MEMORY_TASK_PERMISSIONS,
		);
		if (pending !== undefined) {
			if (pending.nextRunAtMs !== runAtMs) {
				await this.#tasks.update(
					MEMORY_PLUGIN_ID,
					pending.id,
					{ nextRunAtMs: runAtMs },
					MEMORY_TASK_PERMISSIONS,
				);
			}
			return;
		}
		// No dedupe key: a running pass must not swallow the follow-up for newer messages.
		await this.#createTask({
			conversationId,
			kind: "memory.consolidate",
			// Failures are tracked per batch in `memory_consolidation_state`, not by task retries.
			maxAttempts: 1,
			nextRunAtMs: runAtMs,
			payload: { conversationId },
		});
	}

	async #recordConsolidationFailure(input: {
		readonly batchKey: string;
		readonly config: ConversationPolicy["memoryConsolidation"];
		readonly conversationId: string;
		readonly cursor: ConsolidationCursor;
		readonly delta: readonly ConsolidationMessage[];
		readonly error: string;
		readonly policy: ConversationPolicy;
		readonly session: { readonly id: string; readonly kind: string };
		readonly through: ConsolidationMessage;
	}): Promise<MemoryConsolidationResult> {
		const prior = input.cursor.failedBatchKey === input.batchKey ? input.cursor.failureCount : 0;
		const failures = prior + 1;
		const now = this.#now();
		if (failures >= input.config.maxFailures) {
			const previous = (await this.warmState(input.conversationId))?.state;
			const fallbackState = deterministicWarmState({
				delta: input.delta,
				policy: input.config,
				previous,
			});
			const fallbackCandidates = heuristicCandidates(
				input.delta.map((message) => ({
					contentText: message.text,
					direction: message.direction,
					id: message.id,
				})),
				now,
			).candidates;
			await this.#writeWarmState(input.conversationId, fallbackState, {
				delta: input.delta,
				model: "deterministic-fallback",
				through: input.through,
			});
			await this.#writeConsolidatedMemories(input.session, input.policy, fallbackCandidates, {
				delta: input.delta,
				extractor: "heuristic",
				model: "deterministic-fallback",
				state: fallbackState,
			});
			// Drop the batch: advance the watermark past it so it can never loop.
			await this.#saveConsolidationState(input.conversationId, {
				droppedBatches: input.cursor.droppedBatches + 1,
				failedBatchKey: null,
				failureCount: 0,
				lastError: input.error.slice(0, 500),
				lastRunAt: nowIso(now),
				pendingMessages: 0,
				pendingSince: null,
				watermarkMessageId: input.through.id,
				watermarkOccurredAt: input.through.occurredAt,
			});
			await this.#recordAudit(
				"memory.consolidate.drop",
				{
					id: input.conversationId,
					kind: "consolidation",
					scope: "conversation",
					status: "rejected",
				},
				"failed",
				input.error.slice(0, 200),
			);
			this.#logger.warn("memory consolidation batch dropped after repeated failures", {
				conversationId: input.conversationId,
				error: input.error,
				failures,
			});
			const remaining = await this.#countPending(input.conversationId, {
				watermarkMessageId: input.through.id,
				watermarkOccurredAt: input.through.occurredAt,
			});
			await this.#saveConsolidationState(input.conversationId, {
				pendingMessages: remaining,
				pendingSince: remaining > 0 ? nowIso(now) : null,
			});
			if (remaining > 0) {
				await this.#scheduleConsolidationTask(
					input.conversationId,
					nextConsolidationRunAt({
						nowMs: now.getTime(),
						pendingMessages: remaining,
						pendingSinceMs: now.getTime(),
						policy: input.config,
					}),
				);
			}
			return { reason: "max-failures", status: "dropped" };
		}
		await this.#saveConsolidationState(input.conversationId, {
			failedBatchKey: input.batchKey,
			failureCount: failures,
			lastError: input.error.slice(0, 500),
			lastRunAt: nowIso(now),
		});
		await this.#scheduleConsolidationTask(
			input.conversationId,
			now.getTime() + CONSOLIDATION_RETRY_BASE_MS * 2 ** (failures - 1),
		);
		this.#logger.warn("memory consolidation failed; retry scheduled", {
			conversationId: input.conversationId,
			error: input.error.slice(0, 200),
			failures,
		});
		return { reason: input.error, status: "failed" };
	}

	/**
	 * Durable cursor of one conversation. Without a state row, the watermark of the newest
	 * pre-Batch-5 compaction summary is adopted so an upgrade does not re-read old history.
	 */
	async #consolidationCursor(conversationId: string): Promise<ConsolidationCursor> {
		const database = this.#db();
		const [row] = await database
			.select()
			.from(memoryConsolidationState)
			.where(eq(memoryConsolidationState.conversationId, conversationId))
			.limit(1);
		if (row !== undefined) {
			return {
				droppedBatches: row.droppedBatches,
				failedBatchKey: row.failedBatchKey,
				failureCount: row.failureCount,
				pendingSince: row.pendingSince,
				watermarkMessageId: row.watermarkMessageId,
				watermarkOccurredAt: row.watermarkOccurredAt,
			};
		}
		const legacy = await this.warmState(conversationId);
		const legacyId = legacy?.evidence.compactedThroughMessageId;
		const legacyAt = legacy?.evidence.compactedThroughAt;
		// `ChatSnapshotService` deletes this row when it restores a transcript, so a restored
		// conversation never keeps a watermark past its restored history.
		return {
			droppedBatches: 0,
			failedBatchKey: null,
			failureCount: 0,
			pendingSince: null,
			watermarkMessageId: typeof legacyId === "string" ? legacyId : null,
			watermarkOccurredAt: typeof legacyAt === "string" ? legacyAt : null,
		};
	}

	/** Forget the consolidation cursor, e.g. after a chat snapshot rewrites the transcript. */
	async resetConsolidationState(conversationId: string): Promise<void> {
		await this.#db()
			.delete(memoryConsolidationState)
			.where(eq(memoryConsolidationState.conversationId, conversationId));
	}

	async #saveConsolidationState(
		conversationId: string,
		patch: Partial<Omit<typeof memoryConsolidationState.$inferInsert, "conversationId">>,
	): Promise<void> {
		const updatedAt = nowIso(this.#now());
		await this.#db()
			.insert(memoryConsolidationState)
			.values({ ...patch, conversationId, updatedAt })
			.onConflictDoUpdate({
				set: { ...patch, updatedAt },
				target: memoryConsolidationState.conversationId,
			});
	}

	#deltaCondition(
		conversationId: string,
		cursor: Pick<ConsolidationCursor, "watermarkMessageId" | "watermarkOccurredAt">,
		through?: { readonly id: string; readonly occurredAt: string },
	): SQL {
		const after =
			cursor.watermarkOccurredAt === null || cursor.watermarkMessageId === null
				? undefined
				: or(
						gt(messages.occurredAt, cursor.watermarkOccurredAt),
						and(
							eq(messages.occurredAt, cursor.watermarkOccurredAt),
							gt(messages.id, cursor.watermarkMessageId),
						),
					);
		const before =
			through === undefined
				? undefined
				: or(
						lte(messages.occurredAt, through.occurredAt),
						and(eq(messages.occurredAt, through.occurredAt), lte(messages.id, through.id)),
					);
		return combine([
			eq(messages.conversationId, conversationId),
			ne(messages.kind, "tool"),
			inArray(messages.direction, ["inbound", "outbound"]),
			after,
			before,
		]);
	}

	/** Load the cursor of an explicit `compactSession` upper bound, scoped to the conversation. */
	async #messageCursor(
		conversationId: string,
		messageId: string,
	): Promise<{ readonly id: string; readonly occurredAt: string } | undefined> {
		const [row] = await this.#db()
			.select({ id: messages.id, occurredAt: messages.occurredAt })
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
			.limit(1);
		return row;
	}

	async #countPending(
		conversationId: string,
		cursor: Pick<ConsolidationCursor, "watermarkMessageId" | "watermarkOccurredAt">,
	): Promise<number> {
		const [row] = await this.#db()
			.select({ value: sql<number>`count(*)` })
			.from(messages)
			.where(this.#deltaCondition(conversationId, cursor));
		return Number(row?.value ?? 0);
	}

	/**
	 * Settled messages after the watermark, oldest first. The very first pass (no watermark)
	 * takes the newest `limit` messages instead of crawling an imported backlog.
	 */
	async #settledDelta(
		conversationId: string,
		cursor: ConsolidationCursor,
		limit: number,
		through?: { readonly id: string; readonly occurredAt: string },
	): Promise<ConsolidationMessage[]> {
		const condition = this.#deltaCondition(conversationId, cursor, through);
		const first = cursor.watermarkMessageId === null;
		const rows = await this.#db()
			.select({
				contentText: messages.contentText,
				direction: messages.direction,
				id: messages.id,
				occurredAt: messages.occurredAt,
				senderDisplayName: messages.senderDisplayName,
				senderExternalId: messages.senderExternalId,
				senderUserId: messages.senderUserId,
			})
			.from(messages)
			.where(condition)
			.orderBy(
				first ? desc(messages.occurredAt) : asc(messages.occurredAt),
				first ? desc(messages.id) : asc(messages.id),
			)
			.limit(Math.max(1, limit));
		const ordered = first ? rows.toReversed() : rows;
		return ordered.map((row) => ({
			direction: row.direction,
			id: row.id,
			occurredAt: row.occurredAt,
			senderDisplayName: row.senderDisplayName,
			senderExternalId: row.senderExternalId,
			senderUserId: row.senderUserId,
			text: row.contentText ?? "",
		}));
	}

	/**
	 * Merge-not-append storage: one warm-state `summary` row per conversation, updated in place.
	 * Pre-Batch-5 summary rows are superseded the first time a structured state is written.
	 */
	async #writeWarmState(
		conversationId: string,
		state: WarmStatePayload,
		context: {
			readonly delta: readonly ConsolidationMessage[];
			readonly model: string;
			readonly through: ConsolidationMessage;
		},
	): Promise<MemoryRow> {
		const database = this.#db();
		const now = nowIso(this.#now());
		const dedupeKey = `warm:${conversationId}`;
		const evidence = {
			[WARM_STATE_EVIDENCE_KEY]: state,
			compactedThroughAt: context.through.occurredAt,
			compactedThroughMessageId: context.through.id,
			messageCount: context.delta.length,
			model: context.model,
			promptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
			rangeHash: hashText(context.delta.map((row) => `${row.id}:${row.occurredAt}`).join("|")),
			startMessageId: context.delta[0]?.id,
		};
		const summary =
			state.summary.length > 0
				? snippet(state.summary, 1_000)
				: `Warm session state through ${context.through.occurredAt}.`;
		const content = renderWarmStateLines(state).join("\n") || summary;
		const [existing] = await database
			.select()
			.from(memories)
			.where(eq(memories.dedupeKey, dedupeKey))
			.limit(1);
		if (existing !== undefined) {
			const [row] = await database
				.update(memories)
				.set({
					content,
					embeddingJson: null,
					embeddingModel: null,
					evidenceJson: JSON.stringify(evidence),
					extractionModel: context.model,
					extractionPromptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
					revokedAt: null,
					sourceMessageId: context.through.id,
					status: "active",
					summary,
					updatedAt: now,
				})
				.where(eq(memories.id, existing.id))
				.returning();
			const memory = row ?? existing;
			await this.#recordAudit("memory.consolidate", memory, "ok");
			void this.scheduleEmbeddingBackfill();
			return memory;
		}
		const { memory } = await this.create({
			confidence: 0.82,
			content,
			conversationId,
			createdBy: "task",
			dedupeKey,
			evidence,
			extractionModel: context.model,
			extractionPromptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
			importance: 0.65,
			kind: "summary",
			scope: "conversation",
			sourceConversationId: conversationId,
			sourceMessageId: context.through.id,
			status: "active",
			summary,
			visibility: "private",
		});
		const legacy = await database
			.select()
			.from(memories)
			.where(
				and(
					eq(memories.conversationId, conversationId),
					eq(memories.kind, "summary"),
					eq(memories.status, "active"),
					ne(memories.id, memory.id),
				),
			);
		await this.#applySupersede(legacy, memory.id, now);
		await this.#recordAudit("memory.consolidate", memory, "ok");
		return memory;
	}

	async #writeConsolidatedMemories(
		session: { readonly id: string; readonly kind: string },
		policy: ConversationPolicy,
		candidates: readonly ConsolidatedMemoryInput[],
		context: {
			readonly delta: readonly ConsolidationMessage[];
			readonly extractor: "heuristic" | "llm";
			readonly model: string;
			readonly state: WarmStatePayload;
		},
	): Promise<number> {
		const reviewRequired =
			policy.memoryReviewRequired || (session.kind === "group" && !policy.sharedMemoryWriteEnabled);
		// Resolve person-card keys back to canonical user ids. A fact about a participant can
		// then live in the cross-conversation `user` scope instead of only this chat.
		const speakerIds = new Set(
			context.delta
				.map((message) => message.senderUserId)
				.filter((id): id is string => id !== null),
		);
		const personIds = new Map<string, string>();
		for (const message of context.delta) {
			if (message.senderUserId === null) continue;
			const name = message.senderDisplayName?.trim();
			personIds.set(memoryPersonKey(message.senderUserId), message.senderUserId);
			if (message.senderExternalId !== null && message.senderExternalId !== undefined) {
				personIds.set(memoryPersonKey(message.senderExternalId), message.senderUserId);
			}
			if (name !== undefined && name.length > 0) {
				personIds.set(memoryPersonKey(name), message.senderUserId);
				personIds.set(memoryPersonKey(`name:${name}`), message.senderUserId);
			}
		}
		for (const card of context.state.people) {
			const direct = speakerIds.has(card.key)
				? card.key
				: (personIds.get(memoryPersonKey(card.key)) ?? personIds.get(memoryPersonKey(card.name)));
			if (direct === undefined) continue;
			personIds.set(memoryPersonKey(card.key), direct);
			for (const alias of card.aliases) personIds.set(memoryPersonKey(alias), direct);
		}
		const userScopeKinds = new Set([
			"fact",
			"preference",
			"person",
			"relationship",
			"style",
			"glossary",
		]);
		const source = context.delta.at(-1);
		let written = 0;
		for (const candidate of candidates) {
			if (written >= policy.memoryMaxWritesPerActivity) break;
			if (candidate.confidence < policy.memoryMinConfidence) continue;
			const expiresAt =
				candidate.expiresAt === undefined ? undefined : parseDate(candidate.expiresAt);
			// Only a subject that actually spoke in this batch is linked; never invent user ids.
			const subjectUserId =
				candidate.subject === undefined
					? undefined
					: personIds.get(memoryPersonKey(candidate.subject));
			// Facts learned in a private chat stay conversation-scoped: promoting them to `user`
			// scope would bypass `crossSession.privateToGroup` and surface private details in a
			// group chat. Only group conversations may promote a participant-scoped fact.
			const userScoped =
				session.kind === "group" &&
				subjectUserId !== undefined &&
				policy.sharedMemoryWriteEnabled &&
				userScopeKinds.has(candidate.kind);
			const status: MemoryStatus = reviewRequired ? "pending" : "active";
			const result = await this.create({
				confidence: candidate.confidence,
				content: candidate.content ?? candidate.summary,
				...(userScoped ? {} : { conversationId: session.id }),
				createdBy: "task",
				evidence: {
					extractor: context.extractor,
					range: {
						endMessageId: source?.id,
						startMessageId: context.delta[0]?.id,
					},
					sourceMessageId: source?.id,
				},
				...(expiresAt === undefined ? {} : { expiresAt }),
				extractionModel: context.model,
				extractionPromptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
				importance: candidate.importance,
				kind: candidate.kind,
				scope: userScoped ? "user" : "conversation",
				sourceConversationId: session.id,
				...(source === undefined ? {} : { sourceMessageId: source.id }),
				status,
				...(subjectUserId === undefined ? {} : { subjectUserId }),
				summary: snippet(candidate.summary, 1_000),
				visibility: userScoped ? "shared" : "private",
			});
			written += 1;
			await this.#recordAudit(
				status === "pending" ? "memory.extract.pending" : "memory.extract",
				result.memory,
				"ok",
			);
		}
		return written;
	}

	/**
	 * Extract memories for one conversation. Structured LLM output is preferred; a deterministic
	 * heuristic keeps offline/test behavior useful. Every failure is isolated from replies.
	 */
	async extractForConversation(
		conversationId: string,
	): Promise<{ candidates: number; written: number }> {
		const startedAt = performance.now();
		const database = this.#db();
		const session = await this.#session(conversationId);
		if (session === undefined || this.#policyService === undefined) {
			return { candidates: 0, written: 0 };
		}
		if (session.kind === "workspace") return { candidates: 0, written: 0 };
		const policy = await this.#policyService.effectivePolicy(session.id);
		if (policy.memoryEnabled === false) return { candidates: 0, written: 0 };
		const rows = await database
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, session.id), ne(messages.kind, "tool")))
			.orderBy(desc(messages.occurredAt), desc(messages.id))
			.limit(EXTRACTION_MESSAGE_LIMIT);
		const chronological = rows.toReversed();
		if (chronological.length === 0) return { candidates: 0, written: 0 };
		let candidates: ExtractionCandidate[] | undefined;
		let extractor: "heuristic" | "llm" = "heuristic";
		let extractionModel = "deterministic";
		const useLlm =
			this.#complete !== undefined &&
			(policy.memoryExtractModel !== undefined || this.#llmEnabled());
		if (useLlm) {
			try {
				const llm = await this.#llmExtract(policy, chronological);
				if (llm !== undefined) {
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
		if (candidates === undefined) {
			const heuristic = heuristicCandidates(chronological, this.#now());
			candidates = heuristic.candidates;
		}
		const reviewRequired =
			policy.memoryReviewRequired || (session.kind === "group" && !policy.sharedMemoryWriteEnabled);
		let written = 0;
		for (const candidate of candidates) {
			if (written >= policy.memoryMaxWritesPerActivity) break;
			if (candidate.confidence < policy.memoryMinConfidence) continue;
			const status: MemoryStatus = reviewRequired ? "pending" : "active";
			const messageIds = chronological.map((row) => row.id);
			const source = chronological.at(-1);
			const result = await this.create({
				confidence: candidate.confidence,
				content: candidate.content,
				conversationId: session.id,
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
				scope: "conversation",
				sourceConversationId: session.id,
				...(source === undefined ? {} : { sourceMessageId: source.id }),
				status,
				summary: candidate.summary,
				visibility: "private",
			});
			written += 1;
			await this.#recordAudit(
				status === "pending" ? "memory.extract.pending" : "memory.extract",
				result.memory,
				"ok",
			);
		}
		this.#logger.debug("memory extraction completed", {
			candidates: candidates.length,
			conversationId: session.id,
			durationMs: Math.round(performance.now() - startedAt),
			extractor,
			messageCount: chronological.length,
			written,
		});
		return { candidates: candidates.length, written };
	}

	async #llmExtract(
		policy: ConversationPolicy,
		rows: readonly MessageRow[],
	): Promise<ExtractionCandidate[] | undefined> {
		if (this.#complete === undefined) return undefined;
		const transcript = rows
			.filter((row) => row.contentText !== null)
			.map((row) => `${row.direction}: ${snippet(row.contentText ?? "", 500)}`)
			.join("\n");
		const prompt = [
			(await this.#extractionPrompt?.()) ?? DEFAULT_PROMPTS["memory-extraction"],
			"Keep only durable information supported by the conversation. Omit speculation, transient banter, and claims inferred solely from assistant replies. Memory stays in this conversation.",
			"Return ONLY a JSON array. Each item has: kind (fact|summary|setting|person|preference|style|glossary|todo|event|relationship|observation), summary (short), content, confidence (0..1), importance (0..1), optional expiresAt ISO date.",
			`Prompt version: ${policy.memoryExtractionPromptVersion}.`,
			"Conversation:",
			transcript,
		].join("\n");
		const text = await this.#complete(prompt, policy.memoryExtractModel);
		if (text === undefined) return undefined;
		return parseLlmCandidates(text);
	}

	async #createTask(input: {
		readonly conversationId?: string;
		readonly dedupeKey?: string;
		readonly intervalMs?: number;
		readonly kind: string;
		readonly maxAttempts?: number;
		readonly nextRunAtMs?: number;
		readonly payload: unknown;
	}): Promise<void> {
		if (this.#tasks === undefined) return;
		await this.#tasks.create(
			MEMORY_PLUGIN_ID,
			{
				...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
				kind: input.kind,
				payload: input.payload,
				...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
				...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
				...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
				...(input.nextRunAtMs === undefined ? {} : { nextRunAtMs: input.nextRunAtMs }),
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

	/**
	 * Semantic signal without a query embedding: the centroid of the stored embeddings of the
	 * strongest lexical hits stands in for the query (pseudo-relevance feedback), and every other
	 * embedded candidate is scored by cosine similarity to it. Rows without a stored embedding,
	 * or a pool without any embedded lexical hit, score 0 and fall back to lexical ranking.
	 */
	#localVectorScores(
		candidates: readonly MemoryRow[],
		lexicalById: ReadonlyMap<string, number>,
	): Map<string, number> {
		const scores = new Map<string, number>();
		const counts = new Map<string, number>();
		for (const memory of candidates) {
			if (memory.embeddingModel === null || memory.embeddingJson === null) continue;
			counts.set(memory.embeddingModel, (counts.get(memory.embeddingModel) ?? 0) + 1);
		}
		const modelId = [...counts.entries()].toSorted((left, right) => right[1] - left[1])[0]?.[0];
		if (modelId === undefined) return scores;
		const vectors = new Map<string, readonly number[]>();
		for (const memory of candidates) {
			const vector = this.#cachedEmbedding(memory, modelId);
			if (vector !== undefined) vectors.set(memory.id, vector);
		}
		const seeds = candidates
			.filter((memory) => (lexicalById.get(memory.id) ?? 0) > 0 && vectors.has(memory.id))
			.toSorted((left, right) => (lexicalById.get(right.id) ?? 0) - (lexicalById.get(left.id) ?? 0))
			.slice(0, LOCAL_VECTOR_SEEDS);
		if (seeds.length === 0) return scores;
		const dimensions = vectors.get(seeds[0]?.id ?? "")?.length ?? 0;
		const centroid = Array.from({ length: dimensions }, () => 0);
		for (const seed of seeds) {
			const vector = vectors.get(seed.id) ?? [];
			for (let index = 0; index < dimensions; index += 1) {
				centroid[index] = (centroid[index] ?? 0) + (vector[index] ?? 0) / seeds.length;
			}
		}
		// The candidate pool is already capped by `CANDIDATE_LIMIT`; only rows of one model are
		// parsed, so vector scoring stays bounded even on a large memory store.
		for (const [id, vector] of vectors) scores.set(id, Math.max(0, cosine(centroid, vector)));
		return scores;
	}

	/**
	 * Background embedding backfill: embeds active memories that have no embedding for the
	 * current model. Runs from the `memory.embed` task, never on the prompt-render path.
	 */
	async embedPending(limit = EMBED_BATCH_SIZE): Promise<{ embedded: number; modelId?: string }> {
		if (this.#embed === undefined) return { embedded: 0 };
		const database = this.#db();
		const currentModel = await this.#embeddingModelId?.().catch(() => undefined);
		// Rows with no vector, and rows embedded by a previously configured model, are both
		// backfilled. A provider failure leaves every row untouched for the next scheduled run.
		const embeddingCondition =
			currentModel === undefined
				? isNull(memories.embeddingJson)
				: or(isNull(memories.embeddingJson), ne(memories.embeddingModel, currentModel));
		const rows = await database
			.select()
			.from(memories)
			.where(and(eq(memories.status, "active"), isNull(memories.revokedAt), embeddingCondition))
			.orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.updatedAt))
			.limit(Math.max(1, limit));
		if (rows.length === 0) return { embedded: 0 };
		try {
			const result = await this.#embed(rows.map((row) => row.summary));
			if (result === undefined) return { embedded: 0 };
			let embedded = 0;
			for (const [index, row] of rows.entries()) {
				const vector = result.vectors[index];
				if (vector === undefined) continue;
				await database
					.update(memories)
					.set({ embeddingJson: JSON.stringify(vector), embeddingModel: result.modelId })
					.where(eq(memories.id, row.id));
				embedded += 1;
			}
			if (rows.length === Math.max(1, limit)) await this.scheduleEmbeddingBackfill();
			return { embedded, modelId: result.modelId };
		} catch (error) {
			this.#logger.debug("memory embedding backfill unavailable", { error: errorMessage(error) });
			return { embedded: 0 };
		}
	}

	/** Coalesced, delayed `memory.embed` task; safe to call on every memory write. */
	async scheduleEmbeddingBackfill(): Promise<void> {
		if (this.#embed === undefined) return;
		try {
			await this.#createTask({
				dedupeKey: "embed-backfill",
				kind: "memory.embed",
				nextRunAtMs: this.#now().getTime() + EMBED_BACKFILL_DELAY_MS,
				payload: {},
			});
		} catch (error) {
			this.#logger.debug("memory embedding scheduling failed", { error: errorMessage(error) });
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
