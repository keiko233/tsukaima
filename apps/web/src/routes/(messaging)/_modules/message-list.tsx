"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	File as FileIcon,
	FileAudio,
	FileText,
	Image as ImageIcon,
	ImageOff,
	Smile,
	StickyNote,
	Video,
} from "lucide-react";
import {
	Message,
	MessageAvatar,
	MessageBubble,
	MessageBubbleContent,
	MessageContent,
	MessageFooter,
	MessageHeader,
	MessageScroller,
} from "@tsukaima/ui/components/agents/message";
import type { DeliveryStatus, MessageDeliveryMode, MessageSummary } from "@/lib/api";
import type { LiveRunState, RunSegmentSummary } from "@tsukaima/contracts";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { buildConversationTimeline } from "@/lib/conversation-timeline";
import { runtimeUrl } from "@/lib/runtime-url";
import { formatDateTime, formatTimestamp } from "../../_modules/lib/format";
import { LiveRunMessage } from "./live-run-message";
import { MessageText } from "./message-text";
import { RunSegmentCard, RunSteps } from "./run-steps";

function deliveryLabel(status: DeliveryStatus): string {
	switch (status) {
		case "received":
			return m.delivery_received();
		case "pending":
			return m.delivery_pending();
		case "accepted":
			return m.delivery_accepted();
		case "sent":
			return m.delivery_sent();
		case "failed":
			return m.delivery_failed();
		case "uncertain":
			return m.delivery_uncertain();
	}
}

function deliveryClass(status: DeliveryStatus): string {
	if (status === "failed") return "text-destructive";
	if (status === "uncertain") return "text-warning";
	if (status === "pending") return "text-muted-foreground";
	return "text-muted-foreground";
}

function deliveryModeLabel(mode: MessageDeliveryMode): string {
	switch (mode) {
		case "steer":
			return m.message_delivery_steer();
		case "follow-up":
			return m.message_delivery_follow_up();
		case "interrupt":
			return m.message_delivery_interrupt();
	}
}

function deliveryModeClass(mode: MessageDeliveryMode): string {
	switch (mode) {
		case "steer":
			return "border-primary/20 bg-primary/10 text-primary";
		case "follow-up":
			return "border-border bg-muted text-muted-foreground";
		case "interrupt":
			return "border-destructive/20 bg-destructive/10 text-destructive";
	}
}

/** A small tell for why this user message arrived mid-turn. */
function DeliveryModeBadge({ mode }: { mode: MessageDeliveryMode }) {
	return (
		<span
			title={m.delivery_mode()}
			className={cn(
				"inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] leading-4 font-medium",
				deliveryModeClass(mode),
			)}
		>
			{deliveryModeLabel(mode)}
		</span>
	);
}

function senderName(message: MessageSummary): string {
	if (message.senderKind === "assistant") return m.message_sender_tsukaima();
	if (message.senderExternalId === "webui-admin") return m.message_sender_webui();
	if (message.senderDisplayName.trim().length === 0) return m.message_sender_unknown();
	return message.senderDisplayName;
}

function PartIcon({ type }: { type: MessageSummary["parts"][number]["type"] }) {
	switch (type) {
		case "image":
			return <ImageIcon className="size-3.5" />;
		case "sticker":
			return <Smile className="size-3.5" />;
		case "audio":
			return <FileAudio className="size-3.5" />;
		case "video":
			return <Video className="size-3.5" />;
		case "file":
			return <FileText className="size-3.5" />;
		case "channel-native":
			return <FileIcon className="size-3.5" />;
		default:
			return <StickyNote className="size-3.5" />;
	}
}

function partLabel(part: MessageSummary["parts"][number]): string {
	switch (part.type) {
		case "image":
			return part.previewText ? `${m.message_image()} · ${part.previewText}` : m.message_image();
		case "sticker":
			return part.previewText
				? `${m.message_sticker()} · ${part.previewText}`
				: m.message_sticker();
		case "audio":
			return part.transcript?.trim()
				? `Voice · ${part.transcript.trim()}`
				: (part.previewText ?? "Voice message");
		case "video":
			return part.previewText ?? "Video";
		case "file":
			return `File · ${part.fileName}`;
		case "channel-native":
			return part.summary?.trim() ? part.summary : `[${part.nativeType}]`;
		default:
			return "";
	}
}

type MediaPart = Extract<MessageSummary["parts"][number], { type: "image" | "sticker" }>;

/** Images and stickers render as pictures; the rest stay labelled chips. */
function isInlineImage(part: MessageSummary["parts"][number]): part is MediaPart {
	return (part.type === "image" || part.type === "sticker") && part.mediaId !== undefined;
}

/** An image/sticker with no local bytes after ingestion: honest unavailable state, not a bare label. */
function isUnavailableMedia(part: MessageSummary["parts"][number]): part is MediaPart {
	return (
		(part.type === "image" || part.type === "sticker") &&
		part.mediaId === undefined &&
		part.mediaUnavailableReason !== undefined
	);
}

function MediaUnavailable({ part }: { part: MediaPart }) {
	return (
		<span
			title={m.message_media_unavailable_hint()}
			className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border/70 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground"
		>
			<ImageOff className="size-3.5" />
			{part.type === "sticker" ? m.message_sticker_unavailable() : m.message_image_unavailable()}
		</span>
	);
}

function InlineMedia({ part }: { part: MediaPart }) {
	const [failed, setFailed] = useState(false);
	if (part.mediaId === undefined) return null;
	if (failed) return <MediaUnavailable part={part} />;
	const alt = partLabel(part);
	return (
		// Not `next/image`: the bytes are served by the host with an immutable cache header, and
		// the intrinsic size is unknown until the fetch lands.
		<img
			src={runtimeUrl(`/media/${encodeURIComponent(part.mediaId)}`)}
			alt={alt}
			loading="lazy"
			onError={() => setFailed(true)}
			className="h-auto w-auto max-h-64 max-w-full rounded-lg border border-border object-contain"
			{...(part.width !== undefined && part.height !== undefined
				? { height: part.height, width: part.width }
				: {})}
		/>
	);
}

function ReplyPreview({
	message,
	onJumpToMessage,
}: {
	message: MessageSummary;
	onJumpToMessage?: ((messageId: string) => void) | undefined;
}) {
	const replyTo = message.replyTo;
	if (replyTo === undefined && message.replyToMessageId === null) return null;
	const replySender =
		replyTo?.fromSelf === true
			? m.message_sender_tsukaima()
			: replyTo?.senderDisplayName?.trim()
				? replyTo.senderDisplayName
				: m.message_sender_unknown();
	const replyParts = replyTo?.parts ?? [];
	const inlineMedia = replyParts.find((part) => isInlineImage(part));
	const nonTextLabel = replyParts
		.filter((part) => part.type !== "text")
		.map((part) => partLabel(part))
		.filter((label) => label.length > 0)
		.join(" · ");
	const textPreview = replyTo?.contentText.trim() ?? "";
	const bodyPreview =
		textPreview.length > 0
			? textPreview
			: nonTextLabel.length > 0
				? nonTextLabel
				: m.message_reply_unavailable();
	const jumpTargetId = replyTo?.messageId ?? message.replyToMessageId;
	const clickable = onJumpToMessage !== undefined && jumpTargetId !== null;
	const content = (
		<div className="flex min-w-0 items-center gap-2 border-l-2 border-primary/45 bg-background/45 px-2 py-1 rounded-r-md text-left">
			{inlineMedia !== undefined && inlineMedia.mediaId !== undefined ? (
				<img
					src={runtimeUrl(`/media/${encodeURIComponent(inlineMedia.mediaId)}`)}
					alt={partLabel(inlineMedia)}
					loading="lazy"
					className="size-8 shrink-0 rounded object-cover border border-border/60"
				/>
			) : null}
			<div className="min-w-0 flex-1">
				{replyTo !== undefined ? (
					<div className="truncate text-[11px] font-medium text-foreground/75">{replySender}</div>
				) : null}
				<div className="line-clamp-2 break-words text-[11px] text-muted-foreground">
					{bodyPreview}
				</div>
			</div>
		</div>
	);
	if (!clickable) return content;
	return (
		<button
			type="button"
			onClick={() => onJumpToMessage(jumpTargetId)}
			className="block w-full cursor-pointer rounded-r-md transition-colors hover:bg-background/70"
		>
			{content}
		</button>
	);
}

function MessageBody({
	message,
	markdown,
	onJumpToMessage,
}: {
	message: MessageSummary;
	markdown: boolean;
	onJumpToMessage?: ((messageId: string) => void) | undefined;
}) {
	const textParts = message.parts.filter((part) => part.type === "text" && part.text);
	const mediaParts = message.parts.filter((part) => part.type !== "text");
	const inlineParts = mediaParts.filter((part) => isInlineImage(part));
	const unavailableParts = mediaParts.filter((part) => isUnavailableMedia(part));
	const chipParts = mediaParts.filter((part) => !isInlineImage(part) && !isUnavailableMedia(part));
	return (
		<div className="space-y-1.5">
			<ReplyPreview message={message} onJumpToMessage={onJumpToMessage} />
			{textParts.length > 0 ? (
				<MessageText
					markdown={markdown}
					text={textParts.map((part) => (part.type === "text" ? part.text : "")).join("")}
				/>
			) : null}
			{inlineParts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{inlineParts.map((part, index) => (
						<InlineMedia key={`${part.type}-${index}`} part={part} />
					))}
				</div>
			) : null}
			{unavailableParts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{unavailableParts.map((part, index) => (
						<MediaUnavailable key={`${part.type}-unavailable-${index}`} part={part} />
					))}
				</div>
			) : null}
			{chipParts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{chipParts.map((part, index) => (
						<span
							key={`${part.type}-${index}`}
							className="inline-flex items-center gap-1 rounded-lg bg-background/60 px-2 py-1 text-[11px] text-muted-foreground"
						>
							<PartIcon type={part.type} />
							{partLabel(part)}
						</span>
					))}
				</div>
			) : null}
			{textParts.length === 0 && mediaParts.length === 0 ? (
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<StickyNote className="size-3.5" />
					{m.message_unsupported()}
				</div>
			) : null}
		</div>
	);
}

const LOAD_OLDER_THRESHOLD = 320;

function sameSender(left: MessageSummary, right: MessageSummary): boolean {
	return (
		left.senderKind === right.senderKind &&
		left.senderExternalId === right.senderExternalId &&
		left.senderDisplayName === right.senderDisplayName
	);
}

function MessageRow({
	grouped,
	markdown,
	message,
	onJumpToMessage,
	segment,
	sessionId,
}: {
	/** Follows an earlier message from the same sender, so the identity chrome is skipped. */
	grouped: boolean;
	markdown: boolean;
	message: MessageSummary;
	onJumpToMessage?: ((messageId: string) => void) | undefined;
	/** Persisted run segment attached to this answer, including its round-grouped steps. */
	segment?: RunSegmentSummary | undefined;
	/** Session the message belongs to, needed to expand a turn's steps. */
	sessionId: string;
}) {
	const assistant = message.senderKind === "assistant";
	// Only the WebUI operator sits on the right: it drives the bot directly, so its turns read
	// as "mine". Everyone else — the assistant and the people in the chat — stays on the left.
	const self = message.senderKind === "system";
	return (
		<Message
			from={self ? "user" : "assistant"}
			// The operator's own turns sit on the right, the assistant on the left; `from` keeps
			// its semantic meaning for the aria label and bubble variant.
			align={self ? "end" : "start"}
			className="gap-2"
		>
			<MessageAvatar
				placeholder={grouped}
				className={cn(
					"size-6 text-[10px] [&_svg]:size-3",
					assistant && "border border-primary/20 bg-primary/10 text-primary",
				)}
			>
				{assistant ? "E" : senderName(message).slice(0, 1).toUpperCase()}
			</MessageAvatar>
			<MessageContent className="gap-1">
				{grouped ? null : (
					<MessageHeader className="gap-1 px-0.5">
						<span className={cn("font-medium text-foreground/85", !self && "text-[11px]")}>
							{senderName(message)}
						</span>
						<span aria-hidden="true" className="text-muted-foreground/40">
							·
						</span>
						<time dateTime={message.occurredAt} title={formatDateTime(message.occurredAt)}>
							{formatTimestamp(message.occurredAt)}
						</time>
					</MessageHeader>
				)}
				{!assistant && message.deliveryMode !== null ? (
					<DeliveryModeBadge mode={message.deliveryMode} />
				) : null}
				{/* Steps come first: they explain the answer rather than trailing it. */}
				{assistant && segment !== undefined ? (
					<RunSteps
						answerText={message.contentText}
						entryId={message.durableEntryId ?? undefined}
						markdown={markdown}
						runId={message.runId ?? undefined}
						segment={segment}
						sessionId={sessionId}
					/>
				) : null}
				{message.kind === "reply-lurk" ? (
					<p className="text-xs text-muted-foreground">{m.reply_decision_lurk()}</p>
				) : (
					<MessageBubble
						variant={assistant ? "ghost" : "soft"}
						className={cn("max-w-full", self && "items-end")}
					>
						<MessageBubbleContent
							className={cn(
								assistant ? "max-w-[46rem]" : "max-w-[min(32rem,80%)] rounded-lg px-2.5 py-1.5",
							)}
						>
							<MessageBody
								markdown={assistant && markdown}
								message={message}
								onJumpToMessage={onJumpToMessage}
							/>
						</MessageBubbleContent>
					</MessageBubble>
				)}
				{message.replyDecision ? (
					<details className="max-w-full px-0.5 text-xs text-muted-foreground">
						<summary className="cursor-pointer">
							{message.triggerClassification === "ambient"
								? m.reply_decision_ambient()
								: m.reply_decision_show()}
						</summary>
						<ul className="mt-1 space-y-1 ps-3">
							<li>{m.reply_decision_trigger({ reason: message.replyDecision.reason })}</li>
							{message.replyDecision.gate ? (
								<li>
									{message.replyDecision.gate.source === "fallback"
										? m.reply_decision_gate_fallback()
										: message.replyDecision.gate.decision === "SKIP"
											? m.reply_decision_gate_skip()
											: m.reply_decision_gate_reply()}
									{message.replyDecision.gate.modelId ? (
										<span> · {message.replyDecision.gate.modelId}</span>
									) : null}
									{message.replyDecision.gate.confidence !== undefined ? (
										<span>
											{" "}
											·{" "}
											{m.reply_decision_confidence({
												percent: Math.round(message.replyDecision.gate.confidence * 100),
											})}
										</span>
									) : null}
									{message.replyDecision.gate.reason ? (
										<div>{message.replyDecision.gate.reason}</div>
									) : null}
								</li>
							) : null}
							{message.replyDecision.cooldownMs > 0 ? (
								<li>
									{m.reply_decision_cooldown({
										seconds: Math.ceil(message.replyDecision.cooldownMs / 1000),
									})}
								</li>
							) : null}
						</ul>
					</details>
				) : null}
				{self ? (
					<MessageFooter className="min-h-4 px-0.5 text-[10px]">
						<span className={deliveryClass(message.deliveryStatus)}>
							{deliveryLabel(message.deliveryStatus)}
						</span>
					</MessageFooter>
				) : null}
			</MessageContent>
		</Message>
	);
}

export function MessageList({
	messages,
	runSegments,
	markdown = false,
	liveRun,
	now,
	sessionId,
	hasOlder,
	loadingOlder,
	onLoadOlder,
}: {
	messages: readonly MessageSummary[];
	/** Persisted run segments already merged across every loaded cursor page. */
	runSegments: readonly RunSegmentSummary[];
	markdown?: boolean;
	/** Session the messages belong to, needed to expand a turn's steps. */
	sessionId: string;
	/** In-flight assistant turn, interleaved at its own timeline anchor. */
	liveRun?: LiveRunState | undefined;
	/** Wall clock used for the live run's elapsed label. */
	now: number;
	/** Whether a cursor page older than the first row still exists. */
	hasOlder: boolean;
	/** The older page request is in flight. */
	loadingOlder: boolean;
	/** Request the page before the current oldest message. */
	onLoadOlder: () => void;
}) {
	const viewportRef = useRef<HTMLElement>(null);
	const loadOlderRef = useRef(onLoadOlder);
	const loadingOlderRef = useRef(loadingOlder);
	useEffect(() => {
		loadOlderRef.current = onLoadOlder;
	}, [onLoadOlder]);
	useEffect(() => {
		loadingOlderRef.current = loadingOlder;
	}, [loadingOlder]);

	const timeline = useMemo(
		() => buildConversationTimeline({ liveRun, messages, runSegments }),
		[liveRun, messages, runSegments],
	);
	// Assistant bubbles that appeared while this run was working: narration, immediate
	// stickers/files, and flushed stream lines. Match by run/segment when the server gives us
	// those ids; the timestamp fallback only covers a legacy run with no anchor at all.
	const deliveredTexts =
		liveRun === undefined
			? []
			: messages.flatMap((message) => {
					if (message.senderKind !== "assistant") return [];
					if (liveRun.runId !== undefined && message.runId !== null) {
						if (message.runId !== liveRun.runId) return [];
						if (
							liveRun.segmentIndex !== undefined &&
							message.segmentIndex !== null &&
							message.segmentIndex !== liveRun.segmentIndex
						) {
							return [];
						}
					} else {
						const occurredAtMs = Date.parse(message.occurredAt);
						if (!Number.isFinite(occurredAtMs) || occurredAtMs < liveRun.startedAtMs) return [];
					}
					const text = message.contentText.trim();
					return text.length === 0 ? [] : [text];
				});
	const virtualizer = useVirtualizer({
		// The transcript is chat-shaped: newest content lives at the bottom. `anchorTo` keeps the
		// row under the reader pinned when an older page is prepended, and follows the live edge
		// when content is appended or a streaming turn grows.
		anchorTo: "end",
		count: timeline.length,
		estimateSize: (index) => {
			const item = timeline[index];
			if (item?.kind === "segment") return 96;
			if (item?.kind === "live-run") return 140;
			return 76;
		},
		followOnAppend: "auto",
		gap: 10,
		getItemKey: (index) => timeline[index]?.key ?? `timeline-missing-${index}`,
		getScrollElement: () => viewportRef.current,
		overscan: 8,
		paddingEnd: 14,
		paddingStart: 12,
	});

	const requestOlder = () => {
		const viewport = viewportRef.current;
		if (viewport === null || viewport.scrollTop > LOAD_OLDER_THRESHOLD) return;
		if (!hasOlder || loadingOlderRef.current) return;
		loadingOlderRef.current = true;
		loadOlderRef.current();
	};

	// A short transcript can leave the viewport with no scroll range, so `onScroll` alone would
	// never request the next page. Keep filling until the list is scrollable or history ends.
	useEffect(() => {
		if (!hasOlder || loadingOlder) return;
		const viewport = viewportRef.current;
		if (viewport === null) return;
		if (viewport.scrollHeight <= viewport.clientHeight + LOAD_OLDER_THRESHOLD) {
			loadingOlderRef.current = true;
			loadOlderRef.current();
		}
	}, [hasOlder, loadingOlder, timeline.length]);

	const empty = timeline.length === 0;
	const jumpToMessage = (targetId: string) => {
		const index = timeline.findIndex(
			(item) =>
				item.kind === "message" &&
				(item.message.id === targetId || item.message.platformMessageId === targetId),
		);
		if (index >= 0) {
			virtualizer.scrollToIndex(index, { align: "center" });
		}
	};
	return (
		<div className="relative h-full min-h-0">
			<MessageScroller
				label={m.tab_chats()}
				followOutput
				smooth
				className="h-full min-h-0"
				viewportClassName="h-full"
				contentClassName="mx-auto w-full max-w-4xl px-3 sm:px-5"
				viewportRef={viewportRef}
				viewportProps={{ onScroll: requestOlder }}
			>
				{empty ? (
					<div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
						<div className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground">
							<StickyNote className="size-4" />
						</div>
						<p className="mt-2.5 text-[12.5px] font-medium">{m.messages_empty()}</p>
					</div>
				) : (
					<div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const item = timeline[virtualItem.index];
							const previous = timeline[virtualItem.index - 1];
							return (
								<div
									key={virtualItem.key}
									data-index={virtualItem.index}
									ref={virtualizer.measureElement}
									className="absolute top-0 left-0 w-full"
									style={{ transform: `translateY(${virtualItem.start}px)` }}
								>
									{item === undefined ? null : item.kind === "message" ? (
										<MessageRow
											grouped={
												previous?.kind === "message" && sameSender(previous.message, item.message)
											}
											markdown={markdown}
											message={item.message}
											onJumpToMessage={jumpToMessage}
											segment={item.segment}
											sessionId={sessionId}
										/>
									) : item.kind === "segment" ? (
										<RunSegmentCard
											liveRun={item.liveRun}
											markdown={markdown}
											now={now}
											segment={item.segment}
										/>
									) : (
										<LiveRunMessage
											deliveredTexts={deliveredTexts}
											markdown={markdown}
											now={now}
											run={item.run}
										/>
									)}
								</div>
							);
						})}
					</div>
				)}
			</MessageScroller>
			{loadingOlder ? (
				<div
					role="status"
					className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
				>
					<span className="rounded-full border border-border bg-card/90 px-2.5 py-0.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
						{m.loading()}
					</span>
				</div>
			) : null}
		</div>
	);
}
