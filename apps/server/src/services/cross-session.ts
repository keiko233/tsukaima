import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import type { CrossSessionPolicy } from "@tsukaima/contracts";
import { conversations, messages, type TsukaimaDatabase } from "@tsukaima/db";

/**
 * Derived, read-only cross-session awareness: where the current speaker talked recently in
 * other chats. Nothing is stored; every call is one bounded indexed query
 * (`messages_sender_time_idx`). Privacy is fail-closed:
 *
 * - an unknown speaker (no canonical `senderUserId`) yields no context at all;
 * - only the speaker's own lines are ever quoted, never other participants';
 * - a group prompt never sees private chat text unless `privateToGroup` is `text`, and with
 *   `indicator` it learns only that a recent private chat exists (no title, no text);
 * - only ordinary chat surfaces (`private`, `group`) are sources; workspace, task, and plugin
 *   conversations never are.
 */

const SOURCE_KINDS = ["private", "group"] as const;
/** Rows scanned per entry before grouping; keeps the query bounded on chatty speakers. */
const ROWS_PER_ENTRY = 6;
const SNIPPETS_PER_ENTRY = 2;
const SNIPPET_CHARS = 80;

export interface CrossSessionRequest {
	readonly currentKind: string;
	readonly currentSessionId: string;
	readonly nowMs: number;
	readonly policy: CrossSessionPolicy;
	/** Canonical domain user id of the current speaker; `undefined` fails closed. */
	readonly speakerUserId: string | undefined;
	/**
	 * Optional per-source gate (e.g. the source conversation disabled memory or cross-session
	 * sharing). Sources it rejects are omitted entirely.
	 */
	readonly sourceAllowed?: (conversationId: string) => Promise<boolean>;
}

export interface CrossSessionEntry {
	readonly conversationId: string;
	readonly kind: "private" | "group";
	readonly lastAt: string;
	readonly messageCount: number;
	/** Speaker's own recent lines; empty when redacted. */
	readonly snippets: readonly string[];
	/** Display title of the other chat; `null` when unknown or redacted. */
	readonly title: string | null;
	readonly redacted: boolean;
}

function snippet(text: string): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, SNIPPET_CHARS);
}

export async function queryCrossSession(
	database: TsukaimaDatabase,
	request: CrossSessionRequest,
): Promise<CrossSessionEntry[]> {
	const { policy } = request;
	if (!policy.enabled || policy.maxEntries === 0 || policy.maxChars === 0) return [];
	if (request.speakerUserId === undefined) return [];
	if (request.currentKind !== "private" && request.currentKind !== "group") return [];
	const cutoff = new Date(request.nowMs - policy.windowMinutes * 60_000).toISOString();
	const rows = await database
		.select({
			contentText: messages.contentText,
			conversationId: messages.conversationId,
			kind: conversations.kind,
			occurredAt: messages.occurredAt,
			title: conversations.title,
		})
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(messages.senderUserId, request.speakerUserId),
				eq(messages.direction, "inbound"),
				ne(messages.conversationId, request.currentSessionId),
				ne(messages.kind, "tool"),
				gte(messages.occurredAt, cutoff),
				inArray(conversations.kind, [...SOURCE_KINDS]),
			),
		)
		.orderBy(desc(messages.occurredAt))
		.limit(policy.maxEntries * ROWS_PER_ENTRY);
	const grouped = new Map<
		string,
		{
			kind: "private" | "group";
			lastAt: string;
			lines: string[];
			count: number;
			title: string | null;
		}
	>();
	for (const row of rows) {
		if (row.kind !== "private" && row.kind !== "group") continue;
		const entry = grouped.get(row.conversationId) ?? {
			count: 0,
			kind: row.kind,
			lastAt: row.occurredAt,
			lines: [],
			title: row.title,
		};
		entry.count += 1;
		const text = snippet(row.contentText ?? "");
		if (text.length > 0 && entry.lines.length < SNIPPETS_PER_ENTRY) entry.lines.push(text);
		grouped.set(row.conversationId, entry);
	}
	const entries: CrossSessionEntry[] = [];
	for (const [conversationId, entry] of grouped) {
		if (entries.length >= policy.maxEntries) break;
		if (request.sourceAllowed !== undefined && !(await request.sourceAllowed(conversationId))) {
			continue;
		}
		const privateIntoGroup = request.currentKind === "group" && entry.kind === "private";
		if (privateIntoGroup && policy.privateToGroup === "none") continue;
		const redacted = privateIntoGroup && policy.privateToGroup !== "text";
		entries.push({
			conversationId,
			kind: entry.kind,
			lastAt: entry.lastAt,
			messageCount: entry.count,
			redacted,
			snippets: redacted ? [] : entry.lines.toReversed(),
			title: redacted ? null : entry.title,
		});
	}
	// Same-user group-to-group continuity is intentionally enabled by default (matching DSH):
	// only the speaker's own lines are quoted, so one group's text never attributes another
	// participant. There is no separate group switch; `privateToGroup` governs the only
	// privacy-sensitive direction. A bot-only private chat with no inbound row in the window
	// is not recent contact and is omitted.
	return entries;
}

/** Model-facing block for the ephemeral turn context, bounded by `policy.maxChars`. */
export function renderCrossSession(
	entries: readonly CrossSessionEntry[],
	input: {
		readonly formatTime: (iso: string) => string;
		readonly maxChars: number;
		readonly speakerName: string;
	},
): string | undefined {
	if (entries.length === 0) return undefined;
	const header = `${input.speakerName} recently in other chats:`;
	const lines: string[] = [header];
	let used = header.length;
	for (const entry of entries) {
		const where = entry.redacted
			? "a private chat with you"
			: entry.kind === "private"
				? "your private chat"
				: `group ${entry.title ?? "(untitled)"}`;
		const said = entry.snippets.length === 0 ? "" : ` — ${entry.snippets.join(" / ")}`;
		const line = `- ${input.formatTime(entry.lastAt)} in ${where}${said}`;
		if (used + line.length + 1 > input.maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	return lines.length > 1 ? lines.join("\n") : undefined;
}
