import type { MessageQuote } from "@tsukaima/contracts";

/**
 * Model-facing rendering of inbound envelopes. The output is persisted as the durable user
 * message, so it carries only conversation content: local time, speaker, resolved mention
 * labels, and the quoted reply. Routing/trigger telemetry never belongs here; it travels to the
 * ephemeral turn context instead.
 */

/** Structural subset of a stored `MessageEnvelope` the renderer reads; every field is optional. */
export interface RenderableEnvelope {
	readonly conversationKey?: { readonly kind?: string };
	readonly mentions?: readonly {
		readonly id?: string;
		readonly all?: boolean;
		readonly label?: string;
	}[];
	readonly sender?: {
		readonly id?: string;
		readonly displayName?: string;
		readonly platformId?: string;
		readonly isBot?: boolean;
	};
	readonly source?: { readonly timestampMs?: number; readonly receivedAtMs?: number };
	readonly target?: { readonly quote?: MessageQuote };
}

export interface TurnFormatOptions {
	/** IANA time zone for clock labels; defaults to the host process zone. */
	readonly timeZone?: string;
}

/** Longest quote excerpt rendered into a turn; storage allows more. */
const QUOTE_RENDER_MAX_CHARS = 120;

const pad = (value: number): string => String(value).padStart(2, "0");

function zonedParts(ms: number, timeZone: string | undefined) {
	const formatter = new Intl.DateTimeFormat("en-US", {
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23",
		minute: "2-digit",
		month: "2-digit",
		weekday: "long",
		year: "numeric",
		...(timeZone === undefined ? {} : { timeZone }),
	});
	const parts: Record<string, string> = {};
	for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
	return parts;
}

/** `HH:mm` in the configured zone. */
export function formatLocalClock(ms: number, options: TurnFormatOptions = {}): string {
	if (options.timeZone === undefined) {
		const date = new Date(ms);
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	const parts = zonedParts(ms, options.timeZone);
	return `${parts.hour ?? "00"}:${parts.minute ?? "00"}`;
}

/** `YYYY-MM-DD HH:mm Weekday` in the configured zone, for the turn-context clock. */
export function formatLocalDateTime(ms: number, options: TurnFormatOptions = {}): string {
	const parts = zonedParts(ms, options.timeZone);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.weekday}`;
}

/** Local observation time of an envelope, falling back to the platform timestamp. */
export function envelopeTimeMs(envelope: RenderableEnvelope): number | undefined {
	const received = envelope.source?.receivedAtMs;
	if (typeof received === "number" && received > 0) return received;
	const platform = envelope.source?.timestampMs;
	return typeof platform === "number" && platform > 0 ? platform : undefined;
}

/** Speaker label: display name, plus a compact platform id in group chats. */
export function envelopeSpeaker(envelope: RenderableEnvelope): string {
	const id = envelope.sender?.platformId?.trim() || envelope.sender?.id?.trim();
	const name = envelope.sender?.displayName?.trim() || id || "Unknown";
	if (envelope.conversationKey?.kind !== "group" || id === undefined || id === "" || id === name) {
		return name;
	}
	return `${name}(${id})`;
}

/**
 * Replace `@<id>` tokens with `@<label>` for mentions resolved on ingest. Channels that already
 * inline the display name leave nothing to replace.
 */
export function applyMentionLabels(text: string, mentions: RenderableEnvelope["mentions"]): string {
	if (mentions === undefined || mentions.length === 0 || !text.includes("@")) return text;
	let result = text;
	for (const mention of mentions) {
		if (mention.id === undefined || mention.label === undefined) continue;
		const label = mention.label.trim();
		if (label.length === 0 || label === mention.id) continue;
		const escaped = mention.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		result = result.replace(new RegExp(`@${escaped}(?![0-9A-Za-z_])`, "gu"), `@${label}`);
	}
	return result;
}

/** `[reply to Name: "excerpt"]`, or `undefined` when nothing useful is known. */
export function formatQuote(quote: MessageQuote | undefined): string | undefined {
	if (quote === undefined) return undefined;
	const id = quote.senderPlatformId?.trim() || quote.senderId?.trim();
	const name = quote.senderDisplayName?.trim();
	const who =
		quote.fromSelf === true
			? "you"
			: id !== undefined && id !== "" && name !== undefined && name !== "" && name !== id
				? `${name}(${id})`
				: (name ?? id);
	const excerpt = quote.excerpt?.replace(/\s+/gu, " ").trim();
	const clipped =
		excerpt === undefined || excerpt.length === 0
			? undefined
			: excerpt.length > QUOTE_RENDER_MAX_CHARS
				? `${excerpt.slice(0, QUOTE_RENDER_MAX_CHARS - 1)}…`
				: excerpt;
	if (who === undefined && clipped === undefined) return "[reply]";
	if (clipped === undefined) return `[reply to ${who}]`;
	return who === undefined ? `[reply: "${clipped}"]` : `[reply to ${who}: "${clipped}"]`;
}

/** `[HH:mm] Speaker` with an optional quote marker; the caller appends `: content`. */
export function envelopeHeader(
	envelope: RenderableEnvelope,
	options: TurnFormatOptions = {},
): string {
	const at = envelopeTimeMs(envelope);
	const clock = at === undefined ? "" : `[${formatLocalClock(at, options)}] `;
	const quote = formatQuote(envelope.target?.quote);
	return `${clock}${envelopeSpeaker(envelope)}${quote === undefined ? "" : ` ${quote}`}`;
}

/** One durable transcript line for an envelope whose content text is already rendered. */
export function formatEnvelopeLine(
	envelope: RenderableEnvelope,
	content: string,
	options: TurnFormatOptions = {},
): string {
	return `${envelopeHeader(envelope, options)}: ${applyMentionLabels(content, envelope.mentions)}`;
}
