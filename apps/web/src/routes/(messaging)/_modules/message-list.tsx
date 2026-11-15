"use client";

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	File as FileIcon,
	FileAudio,
	FileText,
	Image as ImageIcon,
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
import type { DeliveryStatus, MessageSummary } from "@/lib/api";
import type { LiveRunState } from "@tsukaima/contracts";
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { runtimeUrl } from "@/lib/runtime-url";
import { formatDateTime, formatTimestamp } from "../../_modules/lib/format";
import { LiveRunMessage } from "./live-run-message";
import { RunSteps } from "./run-steps";

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
			return part.previewText ? `${m.message_sticker()} · ${part.previewText}` : m.message_sticker();
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

function InlineMedia({ part }: { part: MediaPart }) {
	const [failed, setFailed] = useState(false);
	if (part.mediaId === undefined) return null;
	if (failed) {
		return (
			<span className="inline-flex items-center gap-1 rounded-lg bg-background/60 px-2 py-1 text-[11px] text-muted-foreground">
				<PartIcon type={part.type} />
				{partLabel(part)}
			</span>
		);
	}
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

function MessageBody({ message }: { message: MessageSummary }) {
	const textParts = message.parts.filter((part) => part.type === "text" && part.text);
	const mediaParts = message.parts.filter((part) => part.type !== "text");
	const inlineParts = mediaParts.filter((part) => isInlineImage(part));
	const chipParts = mediaParts.filter((part) => !isInlineImage(part));
	return (
		<div className="space-y-1.5">
			{textParts.length > 0 ? (
				<p className="whitespace-pre-wrap break-words">
					{textParts.map((part) => (part.type === "text" ? part.text : "")).join("")}
				</p>
			) : null}
			{inlineParts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{inlineParts.map((part, index) => (
						<InlineMedia key={`${part.type}-${index}`} part={part} />
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
	message,
	sessionId,
}: {
	/** Follows an earlier message from the same sender, so the identity chrome is skipped. */
	grouped: boolean;
	message: MessageSummary;
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
				{/* Steps come first: they explain the answer rather than trailing it. */}
				{assistant && message.durableEntryId !== null ? (
					<RunSteps entryId={message.durableEntryId} sessionId={sessionId} />
				) : null}
				<MessageBubble
					variant={assistant ? "ghost" : "soft"}
					className={cn("max-w-full", self && "items-end")}
				>
					<MessageBubbleContent
						className={cn(
							assistant ? "max-w-[46rem]" : "max-w-[min(32rem,80%)] rounded-lg px-2.5 py-1.5",
						)}
					>
						<MessageBody message={message} />
					</MessageBubbleContent>
				</MessageBubble>
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
	liveRun,
	now,
	sessionId,
	hasOlder,
	loadingOlder,
	onLoadOlder,
}: {
	messages: readonly MessageSummary[];
	/** Session the messages belong to, needed to expand a turn's steps. */
	sessionId: string;
	/** In-flight assistant turn, appended below the persisted transcript. */
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

	const count = messages.length + (liveRun === undefined ? 0 : 1);
	const virtualizer = useVirtualizer({
		// The transcript is chat-shaped: newest content lives at the bottom. `anchorTo` keeps the
		// row under the reader pinned when an older page is prepended, and follows the live edge
		// when content is appended or a streaming turn grows.
		anchorTo: "end",
		count,
		estimateSize: (index) => (index === messages.length ? 140 : 76),
		followOnAppend: "auto",
		gap: 10,
		getItemKey: (index) =>
			messages[index]?.id ?? `live-run:${liveRun?.startedAtMs ?? "none"}`,
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
	}, [hasOlder, loadingOlder, messages.length]);

	const empty = messages.length === 0 && liveRun === undefined;
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
					<div
						className="relative w-full"
						style={{ height: `${virtualizer.getTotalSize()}px` }}
					>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const message = messages[virtualItem.index];
							return (
								<div
									key={virtualItem.key}
									data-index={virtualItem.index}
									ref={virtualizer.measureElement}
									className="absolute top-0 left-0 w-full"
									style={{ transform: `translateY(${virtualItem.start}px)` }}
								>
									{message === undefined ? (
										liveRun === undefined ? null : <LiveRunMessage now={now} run={liveRun} />
									) : (
										<MessageRow
											grouped={
												messages[virtualItem.index - 1] !== undefined &&
												sameSender(messages[virtualItem.index - 1]!, message)
											}
											message={message}
											sessionId={sessionId}
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
