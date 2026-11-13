"use client";

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
import { cn } from "@tsukaima/ui/lib/utils";
import { m } from "@/paraglide/messages";
import { formatDateTime, formatTimestamp } from "../../_modules/lib/format";

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

function MessageBody({ message }: { message: MessageSummary }) {
	const textParts = message.parts.filter((part) => part.type === "text" && part.text);
	const mediaParts = message.parts.filter((part) => part.type !== "text");
	return (
		<div className="space-y-1.5">
			{textParts.length > 0 ? (
				<p className="whitespace-pre-wrap break-words">
					{textParts.map((part) => (part.type === "text" ? part.text : "")).join("")}
				</p>
			) : null}
			{mediaParts.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{mediaParts.map((part, index) => (
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

export function MessageList({ messages }: { messages: readonly MessageSummary[] }) {
	return (
		<MessageScroller
			label={m.tab_chats()}
			followOutput
			smooth
			className="h-full min-h-0"
			viewportClassName="h-full"
			contentClassName="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-5 sm:px-6"
		>
			{messages.length === 0 ? (
				<div className="mx-auto flex max-w-sm flex-col items-center px-6 py-20 text-center">
					<div className="grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
						<StickyNote className="size-5" />
					</div>
					<p className="mt-3 text-sm font-medium">{m.messages_empty()}</p>
				</div>
			) : (
				messages.map((message) => {
					const self =
						message.senderExternalId === "webui-admin" ||
						(message.direction === "outbound" && message.senderKind !== "assistant");
					const assistant = message.senderKind === "assistant";
					return (
						<Message key={message.id} from={self ? "user" : "assistant"} className="gap-2.5">
							<MessageAvatar
								className={cn(assistant && "border border-primary/20 bg-primary/10 text-primary")}
							>
								{assistant ? "E" : senderName(message).slice(0, 1).toUpperCase()}
							</MessageAvatar>
							<MessageContent>
								<MessageHeader>
									<span className="font-medium text-foreground">{senderName(message)}</span>
									<span aria-hidden="true">·</span>
									<time dateTime={message.occurredAt} title={formatDateTime(message.occurredAt)}>
										{formatTimestamp(message.occurredAt)}
									</time>
								</MessageHeader>
								<MessageBubble variant={assistant ? "outline" : "soft"} className="max-w-full">
									<MessageBubbleContent className="max-w-[min(42rem,88%)]">
										<MessageBody message={message} />
									</MessageBubbleContent>
								</MessageBubble>
								{self ? (
									<MessageFooter>
										<span className={deliveryClass(message.deliveryStatus)}>
											{deliveryLabel(message.deliveryStatus)}
										</span>
									</MessageFooter>
								) : null}
							</MessageContent>
						</Message>
					);
				})
			)}
		</MessageScroller>
	);
}
