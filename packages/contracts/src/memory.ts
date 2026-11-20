import { z } from "zod";

/**
 * Structured warm state of one chat conversation, produced by the background semantic
 * consolidation pass and stored as the `evidenceJson` of the conversation's `summary` memory.
 * Each pass merges the settled message delta into the previous state instead of appending, so
 * every list is keyed and bounded.
 */
export const WARM_STATE_SCHEMA_VERSION = 2;

// Schemas strip unknown keys instead of rejecting them: consolidation output comes from a
// model, and an extra field should not count as a failed batch.

export const warmStatePersonCardSchema = z.object({
	/** Canonical key: the domain user id when known, otherwise a normalized display name. */
	key: z.string().min(1).max(200),
	name: z.string().min(1).max(120),
	aliases: z.array(z.string().min(1).max(120)).max(8).default([]),
	/** Short third-person notes about this person as seen in this chat. */
	notes: z.array(z.string().min(1).max(240)).max(8).default([]),
	lastSeenAt: z.string().optional(),
});
export type WarmStatePersonCard = z.infer<typeof warmStatePersonCardSchema>;

export const warmStateGlossaryEntrySchema = z.object({
	term: z.string().min(1).max(80),
	meaning: z.string().min(1).max(240),
});
export type WarmStateGlossaryEntry = z.infer<typeof warmStateGlossaryEntrySchema>;

export const warmStateCommitmentSchema = z.object({
	/** Stable key so a later pass can update or close the same commitment. */
	key: z.string().min(1).max(120),
	text: z.string().min(1).max(240),
	/** Person card key of the owner, or `self` for the assistant. */
	owner: z.string().min(1).max(200).optional(),
	status: z.enum(["open", "done", "cancelled"]).default("open"),
	expiresAt: z.string().optional(),
});
export type WarmStateCommitment = z.infer<typeof warmStateCommitmentSchema>;

/** A question the assistant already answered, kept for QA consistency recall. */
export const warmStateAnswerSchema = z.object({
	key: z.string().min(1).max(120),
	question: z.string().min(1).max(240),
	answer: z.string().min(1).max(400),
	answeredAt: z.string().optional(),
});
export type WarmStateAnswer = z.infer<typeof warmStateAnswerSchema>;

export const warmStatePayloadSchema = z.object({
	version: z.literal(WARM_STATE_SCHEMA_VERSION),
	/** Bounded rolling summary of the conversation so far. */
	summary: z.string().max(8_000).default(""),
	/** Current topics, most active first. */
	topics: z.array(z.string().min(1).max(80)).max(6).default([]),
	people: z.array(warmStatePersonCardSchema).max(100).default([]),
	/** One or two sentences on the room's mood, in-jokes, and conventions. */
	atmosphere: z.string().max(400).default(""),
	glossary: z.array(warmStateGlossaryEntrySchema).max(30).default([]),
	commitments: z.array(warmStateCommitmentSchema).max(20).default([]),
	answers: z.array(warmStateAnswerSchema).max(30).default([]),
});
export type WarmStatePayload = z.infer<typeof warmStatePayloadSchema>;

export const emptyWarmState: WarmStatePayload = {
	answers: [],
	atmosphere: "",
	commitments: [],
	glossary: [],
	people: [],
	summary: "",
	topics: [],
	version: WARM_STATE_SCHEMA_VERSION,
};

/** Durable long-term memory proposed by a consolidation pass. */
export const consolidationMemoryCandidateSchema = z.object({
	kind: z.enum([
		"fact",
		"preference",
		"person",
		"relationship",
		"event",
		"todo",
		"glossary",
		"style",
	]),
	summary: z.string().min(1).max(400),
	content: z.string().max(1_000).optional(),
	/** Person card key the memory is about, when it is about one participant. */
	subject: z.string().min(1).max(200).optional(),
	confidence: z.number().min(0).max(1).default(0.6),
	importance: z.number().min(0).max(1).default(0.5),
	expiresAt: z.string().optional(),
});
export type ConsolidationMemoryCandidate = z.infer<typeof consolidationMemoryCandidateSchema>;

/**
 * JSON object a consolidation model must return. `state` is the complete merged warm state
 * (not a diff); `memories` are new durable facts worth keeping beyond this conversation window.
 */
export const memoryConsolidationOutputSchema = z.object({
	state: warmStatePayloadSchema.omit({ version: true }),
	memories: z.array(consolidationMemoryCandidateSchema).max(20).default([]),
});
export type MemoryConsolidationOutput = z.infer<typeof memoryConsolidationOutputSchema>;
