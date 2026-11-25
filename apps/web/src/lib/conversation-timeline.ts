import type { LiveRunState, MessageSummary, RunSegmentSummary } from "@tsukaima/contracts";
import { compareRunSegmentOrder, mergeRunSegments } from "./message-pages";

export interface TimelineMessageItem {
	readonly kind: "message";
	readonly key: string;
	readonly seq: number;
	readonly message: MessageSummary;
	/** Segment whose rounds belong to this row, if it has one. */
	readonly segment?: RunSegmentSummary;
}

export interface TimelineSegmentItem {
	readonly kind: "segment";
	readonly key: string;
	readonly seq: number;
	readonly segment: RunSegmentSummary;
	/** In-flight state overlaid on the persisted segment while it keeps streaming. */
	readonly liveRun?: LiveRunState;
}

export interface TimelineLiveRunItem {
	readonly kind: "live-run";
	readonly key: string;
	readonly seq: number;
	readonly run: LiveRunState;
}

export type ConversationTimelineItem =
	| TimelineMessageItem
	| TimelineSegmentItem
	| TimelineLiveRunItem;

function hasSegmentActivity(segment: RunSegmentSummary): boolean {
	return (
		segment.rounds.length > 0 || segment.status === "failed" || segment.status === "interrupted"
	);
}

function dedupeMessages(messages: readonly MessageSummary[]): MessageSummary[] {
	const byId = new Map<string, MessageSummary>();
	for (const message of messages) byId.set(message.id, message);
	return [...byId.values()];
}

function matchesLiveSegment(segment: RunSegmentSummary, run: LiveRunState): boolean {
	if (run.segmentId !== undefined) return run.segmentId === segment.id;
	if (run.runId === undefined || run.runId !== segment.runId) return false;
	return run.segmentIndex === undefined || run.segmentIndex === segment.segmentIndex;
}

function itemTimestamp(item: ConversationTimelineItem): string {
	switch (item.kind) {
		case "message":
			return item.message.occurredAt;
		case "segment":
			return item.segment.startedAt;
		case "live-run":
			return new Date(item.run.startedAtMs).toISOString();
	}
}

/**
 * Tie-break inside one `seq`:
 * 0. the user message that started the work,
 * 1. the run segment / live run it started,
 * 2. the assistant answer that closed the segment.
 */
function itemRank(item: ConversationTimelineItem): number {
	if (item.kind === "segment" || item.kind === "live-run") return 1;
	return item.message.senderKind === "assistant" ? 2 : 0;
}

/**
 * Total order for the unified timeline.
 *
 * `seq` is the durable ordering shared by user messages and run segments. Legacy rows with no
 * `seq` stay before every sequenced row and keep their old `(occurredAt, id)` order, matching
 * the server's paging comparator. Equal sequenced positions are resolved so a steering message
 * sits between the frozen segment and its continuation instead of inside the assistant reply.
 */
export function compareTimelineOrder(
	a: ConversationTimelineItem,
	b: ConversationTimelineItem,
): number {
	const group = (a.seq > 0 ? 1 : 0) - (b.seq > 0 ? 1 : 0);
	if (group !== 0) return group;
	if (a.seq !== b.seq) return a.seq - b.seq;
	if (a.seq > 0) {
		const rank = itemRank(a) - itemRank(b);
		if (rank !== 0) return rank;
	}
	const at = itemTimestamp(a);
	const bt = itemTimestamp(b);
	if (at !== bt) return at < bt ? -1 : 1;
	if (a.key === b.key) return 0;
	return a.key < b.key ? -1 : 1;
}

/**
 * Interleave persisted messages, persisted run segments, and the active live run into one
 * strictly ordered timeline.
 *
 * Segments that produced a final assistant message attach to that row instead of rendering a
 * second card. Segments without a final message (steered away, interrupted, suppressed, failed,
 * or still running) stay anchored at their own `seq`. An active live run overlays its persisted
 * segment in place; only a run that has no segment yet is inserted at its own `seq`.
 */
export function buildConversationTimeline(input: {
	readonly messages: readonly MessageSummary[];
	readonly runSegments: readonly RunSegmentSummary[];
	readonly liveRun?: LiveRunState | undefined;
}): ConversationTimelineItem[] {
	const messages = dedupeMessages(input.messages).toSorted((a, b) =>
		a.id === b.id ? 0 : a.id < b.id ? -1 : 1,
	);
	const messageById = new Map(messages.map((message) => [message.id, message]));
	const segments = mergeRunSegments(input.runSegments).toSorted(compareRunSegmentOrder);
	const liveRun = input.liveRun;
	const liveActive = liveRun !== undefined && !liveRun.settled;
	const liveSegment = liveActive
		? segments.find((segment) => matchesLiveSegment(segment, liveRun))
		: undefined;
	const overlaidSegmentIds = new Set<string>(liveSegment === undefined ? [] : [liveSegment.id]);

	const attachedByMessageId = new Map<string, RunSegmentSummary>();
	const standalone: RunSegmentSummary[] = [];
	for (const segment of segments) {
		const finalMessageId = segment.finalMessageId;
		if (
			finalMessageId !== null &&
			messageById.has(finalMessageId) &&
			!overlaidSegmentIds.has(segment.id) &&
			!attachedByMessageId.has(finalMessageId)
		) {
			attachedByMessageId.set(finalMessageId, segment);
			continue;
		}
		standalone.push(segment);
	}

	const items: ConversationTimelineItem[] = [];
	for (const message of messages) {
		let segment = attachedByMessageId.get(message.id);
		// A message whose final row is not loaded yet can still explain itself through its run
		// segment. Never borrow a segment that already has its own card or final answer row:
		// that would show the same rounds twice.
		if (
			segment === undefined &&
			message.senderKind === "assistant" &&
			message.runId !== null &&
			message.segmentIndex !== null
		) {
			const resolved = segments.find(
				(candidate) =>
					candidate.runId === message.runId &&
					candidate.segmentIndex === message.segmentIndex &&
					!overlaidSegmentIds.has(candidate.id) &&
					hasSegmentActivity(candidate) &&
					candidate.finalMessageId !== null &&
					!messageById.has(candidate.finalMessageId),
			);
			if (resolved !== undefined) segment = resolved;
		}
		items.push({
			...(segment === undefined ? {} : { segment }),
			key: `message:${message.id}`,
			kind: "message",
			message,
			seq: message.seq,
		});
	}

	for (const segment of standalone) {
		items.push({
			...(liveSegment?.id === segment.id && liveRun !== undefined ? { liveRun } : {}),
			key: `segment:${segment.id}`,
			kind: "segment",
			segment,
			seq: segment.seq,
		});
	}

	if (liveRun !== undefined && liveActive && liveSegment === undefined) {
		items.push({
			key: `live-run:${liveRun.runId ?? liveRun.segmentId ?? liveRun.startedAtMs}`,
			kind: "live-run",
			run: liveRun,
			seq: liveRun.seq ?? Number.MAX_SAFE_INTEGER,
		});
	} else if (
		liveRun !== undefined &&
		!liveActive &&
		liveRun.failure !== undefined &&
		liveSegment === undefined
	) {
		// A failed run keeps its partial work after settling. If no durable segment replaced it,
		// leave the failure anchored where the run started rather than dropping it silently.
		items.push({
			key: `live-run:${liveRun.runId ?? liveRun.segmentId ?? liveRun.startedAtMs}`,
			kind: "live-run",
			run: liveRun,
			seq: liveRun.seq ?? Number.MAX_SAFE_INTEGER,
		});
	}

	return items.toSorted(compareTimelineOrder);
}
