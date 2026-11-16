import { and, eq, inArray } from "drizzle-orm";
import { identities, users, type TsukaimaDatabase } from "@tsukaima/db";

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

/**
 * Resolve mention ids to display names inside the given channel accounts.
 *
 * `platformAccountId` is the same channel id `conversations.channel_id` stores, which keeps
 * ids from one bot account from borrowing another account's naming. Ids with no known
 * identity (someone who never spoke in this account) are simply absent from the map and stay
 * as numbers.
 */
export async function loadMentionLabels(
	database: TsukaimaDatabase,
	platformAccountIds: readonly string[],
	externalIds: Iterable<string>,
): Promise<Map<string, string>> {
	const accountIds = [...new Set(platformAccountIds)].filter((id) => id.length > 0);
	const ids = [...new Set(externalIds)];
	if (accountIds.length === 0 || ids.length === 0) return new Map();
	const rows = await database
		.select({
			externalId: identities.externalId,
			identityDisplayName: identities.displayName,
			userDisplayName: users.displayName,
		})
		.from(identities)
		.innerJoin(users, eq(users.id, identities.canonicalUserId))
		.where(
			and(
				eq(identities.kind, "user"),
				inArray(identities.externalId, ids),
				inArray(identities.platformAccountId, accountIds),
			),
		);
	const labels = new Map<string, string>();
	for (const row of rows) {
		// `users.display_name` is refreshed from every inbound envelope; the identity copy is
		// only a fallback for rows written before that refresh existed.
		const label = (row.userDisplayName ?? "").trim() || (row.identityDisplayName ?? "").trim();
		if (label.length === 0 || labels.has(row.externalId)) continue;
		labels.set(row.externalId, label);
	}
	return labels;
}
