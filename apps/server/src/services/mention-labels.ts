import { and, eq, inArray, sql } from "drizzle-orm";
import { identities, messages, users, type TsukaimaDatabase } from "@tsukaima/db";

/**
 * OneBot `at` segments carry only the platform id, so transcripts persist mentions as
 * `@<id>` text (see `atPart` in the napcat normalizer). Those ids are stable handles, but
 * nobody recognises them in the WebUI. Reading surfaces therefore swap known ids for the
 * display name at render time instead of rewriting stored rows: history keeps the id the
 * channel actually sent, and renames show up immediately once identities are refreshed.
 */

/** QQ ids are 5–12 digits; the lookahead keeps a longer number from matching partially. */
const MENTION_ID_PATTERN = /@(\d{5,12})(?![0-9A-Za-z_.])/gu;

/** Characters that make `@12345` part of an address such as `user@12345.example`. */
const ADDRESS_CHARACTER_PATTERN = /[0-9A-Za-z._%+-]/u;

/** A conversation and the channel account that owns its identities. */
export interface MentionLabelScope {
	readonly conversationId: string;
	readonly platformAccountId: string;
}

/** Labels for the mentions of one conversation, keyed by platform id. */
export type MentionLabelMap = ReadonlyMap<string, string>;

/** Labels per conversation. A person can have a different group card in each group. */
export type MentionLabelsByConversation = ReadonlyMap<string, MentionLabelMap>;

const EMPTY_LABELS: MentionLabelMap = new Map();

/** Collect every id a message mentions as `@<id>` text. Duplicates are folded. */
export function collectMentionIds(
	text: string,
	into: Set<string> = new Set<string>(),
): Set<string> {
	if (!text.includes("@")) return into;
	for (const match of text.matchAll(MENTION_ID_PATTERN)) {
		if (match[1] !== undefined) into.add(match[1]);
	}
	return into;
}

/** Replace `@<id>` with `@<name>` for ids that have a known display name. */
export function replaceMentionIds(text: string, labels: ReadonlyMap<string, string>): string {
	if (labels.size === 0 || !text.includes("@")) return text;
	return text.replace(MENTION_ID_PATTERN, (match, id: string, offset: number) => {
		const label = labels.get(id);
		if (label === undefined) return match;
		// The capture is one id, but `String.replace` types it as `string`.
		const previous = offset === 0 ? "" : text[offset - 1];
		if (previous !== undefined && ADDRESS_CHARACTER_PATTERN.test(previous)) return match;
		return `@${label}`;
	});
}

/** The labels belonging to one transcript row's conversation. */
export function mentionLabelsForConversation(
	labels: MentionLabelsByConversation,
	conversationId: string,
): MentionLabelMap {
	return labels.get(conversationId) ?? EMPTY_LABELS;
}

const accountKey = (accountId: string, externalId: string): string =>
	`${accountId}\u0000${externalId}`;

const nonEmpty = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Read the group card out of a stored envelope when present.
 *
 * Ingestion stores the whole envelope in `raw_ref_json`, including the raw OneBot event. A
 * stored envelope with no `sender.card` only proves the platform showed a nickname there, not a
 * group card, so it must not outrank `users.display_name`. Rows written without a usable
 * envelope fall back to `sender_display_name`, which the normalizer chose as card > nickname.
 */
function senderCardFromRaw(
	rawRefJson: string | null,
	storedName: string | null,
): string | undefined {
	if (rawRefJson === null) return nonEmpty(storedName);
	try {
		const parsed: unknown = JSON.parse(rawRefJson);
		if (typeof parsed !== "object" || parsed === null) return nonEmpty(storedName);
		const raw = (parsed as Record<string, unknown>).raw;
		if (typeof raw !== "object" || raw === null) return nonEmpty(storedName);
		const sender = (raw as Record<string, unknown>).sender;
		if (typeof sender !== "object" || sender === null) return nonEmpty(storedName);
		return nonEmpty((sender as Record<string, unknown>).card);
	} catch {
		return nonEmpty(storedName);
	}
}

/**
 * The freshest name observed in one conversation for each mentioned id.
 *
 * Only inbound rows qualify: outbound/system rows carry the operator or a notice actor, not a
 * group member. The window picks the newest row per `(conversation, sender)` so a chatty member
 * cannot make the result arbitrarily large.
 */
async function recentConversationNames(
	database: TsukaimaDatabase,
	conversationIds: readonly string[],
	externalIds: readonly string[],
): Promise<Map<string, Map<string, string>>> {
	const ranked = database
		.select({
			conversationId: messages.conversationId,
			rawRefJson: messages.rawRefJson,
			senderDisplayName: messages.senderDisplayName,
			senderExternalId: messages.senderExternalId,
			rank: sql<number>`row_number() over (partition by ${messages.conversationId}, ${messages.senderExternalId} order by ${messages.occurredAt} desc, ${messages.id} desc)`.as(
				"mention_sender_rank",
			),
		})
		.from(messages)
		.where(
			and(
				eq(messages.direction, "inbound"),
				inArray(messages.conversationId, conversationIds),
				inArray(messages.senderExternalId, externalIds),
			),
		)
		.as("ranked_mention_senders");
	const rows = await database
		.select({
			conversationId: ranked.conversationId,
			rawRefJson: ranked.rawRefJson,
			senderDisplayName: ranked.senderDisplayName,
			senderExternalId: ranked.senderExternalId,
		})
		.from(ranked)
		.where(eq(ranked.rank, 1));

	const byConversation = new Map<string, Map<string, string>>();
	for (const row of rows) {
		if (row.senderExternalId === null) continue;
		const name = senderCardFromRaw(row.rawRefJson, row.senderDisplayName);
		if (name === undefined) continue;
		const names = byConversation.get(row.conversationId) ?? new Map<string, string>();
		names.set(row.senderExternalId, name);
		byConversation.set(row.conversationId, names);
	}
	return byConversation;
}

/**
 * Resolve mention ids to display names, scoped per conversation and channel account.
 *
 * Precedence is deliberate:
 *   1. the current group card seen in this conversation's recent inbound messages, because a
 *      card is per group and an older nickname elsewhere must not override it;
 *   2. `users.display_name`, refreshed from every inbound envelope;
 *   3. `identities.display_name`, which is now kept in sync but can still be stale for rows
 *      written before that refresh existed.
 *
 * Ids with no known name (someone who never spoke in this account and was not resolved by the
 * channel hook) are absent from the map and stay as numbers.
 */
export async function loadMentionLabels(
	database: TsukaimaDatabase,
	scopes: readonly MentionLabelScope[],
	externalIds: Iterable<string>,
): Promise<MentionLabelsByConversation> {
	const accountByConversation = new Map<string, string>();
	const accountIds = new Set<string>();
	for (const scope of scopes) {
		if (scope.conversationId.length === 0 || scope.platformAccountId.length === 0) continue;
		accountByConversation.set(scope.conversationId, scope.platformAccountId);
		accountIds.add(scope.platformAccountId);
	}
	const ids = [...new Set(externalIds)];
	if (accountByConversation.size === 0 || ids.length === 0) return new Map();
	const conversationIds = [...accountByConversation.keys()];

	const [identityRows, conversationNames] = await Promise.all([
		database
			.select({
				externalId: identities.externalId,
				identityDisplayName: identities.displayName,
				platformAccountId: identities.platformAccountId,
				userDisplayName: users.displayName,
			})
			.from(identities)
			.innerJoin(users, eq(users.id, identities.canonicalUserId))
			.where(
				and(
					eq(identities.kind, "user"),
					inArray(identities.externalId, ids),
					inArray(identities.platformAccountId, [...accountIds]),
				),
			),
		recentConversationNames(database, conversationIds, ids),
	]);

	const identityLabels = new Map<string, string>();
	for (const row of identityRows) {
		const label = nonEmpty(row.userDisplayName) ?? nonEmpty(row.identityDisplayName);
		if (label === undefined) continue;
		const key = accountKey(row.platformAccountId, row.externalId);
		if (!identityLabels.has(key)) identityLabels.set(key, label);
	}

	const labelsByConversation = new Map<string, MentionLabelMap>();
	for (const [conversationId, accountId] of accountByConversation) {
		const cardNames = conversationNames.get(conversationId);
		const labels = new Map<string, string>();
		for (const id of ids) {
			const label = cardNames?.get(id) ?? identityLabels.get(accountKey(accountId, id));
			if (label !== undefined) labels.set(id, label);
		}
		if (labels.size > 0) labelsByConversation.set(conversationId, labels);
	}
	return labelsByConversation;
}
