"use client";

import { useQuery } from "@tanstack/react-query";
import { m } from "@/paraglide/messages";
import { api } from "@/lib/api";
import { MessageBubble } from "@/components/agents/message-bubble";
import { MessageBubbleContent } from "@/components/agents/message-bubble";

export function ConversationPage() {
	const conversationsQuery = useQuery({
		queryFn: api.conversations.list,
		queryKey: ["admin", "conversations"],
	});

	if (conversationsQuery.isPending) {
		return <div className="text-sm text-muted-foreground">{m.conversation_empty()}</div>;
	}

	if (conversationsQuery.isError) {
		return (
			<MessageBubble variant="danger">
				<MessageBubbleContent>{conversationsQuery.error.message}</MessageBubbleContent>
			</MessageBubble>
		);
	}

	const conversations = conversationsQuery.data ?? [];

	if (conversations.length === 0) {
		return (
			<div className="text-sm text-muted-foreground">{m.conversation_empty()}</div>
		);
	}

	return (
		<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
			<MessageBubble align="start">
				<MessageBubbleContent>{m.conversation_system_message()}</MessageBubbleContent>
			</MessageBubble>
			{conversations.map((conversation) => (
				<MessageBubble key={conversation.id} variant="soft" align="start">
					<MessageBubbleContent>
						<div className="grid gap-1 text-sm">
							<span className="font-medium">{conversation.title ?? conversation.id}</span>
							<span className="text-muted-foreground">
								{m.conversation_state()} {conversation.status}
							</span>
							<span className="text-muted-foreground">
								{m.conversation_kind()} {conversation.kind}
							</span>
							<span className="text-muted-foreground">
								{m.conversation_channel()} {conversation.channelId ?? "-"}
							</span>
							<span className="text-muted-foreground">
								{m.conversation_updated()} {conversation.updatedAt}
							</span>
						</div>
					</MessageBubbleContent>
				</MessageBubble>
			))}
		</div>
	);
}
