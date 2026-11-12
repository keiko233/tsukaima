import { MessageBubble } from "@/components/agents/message-bubble";
import { MessageBubbleContent } from "@/components/agents/message-bubble";

export function ConversationPage() {
	return (
		<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
			<MessageBubble align="start">
				<MessageBubbleContent>Fake runtime is wired to the conversation host.</MessageBubbleContent>
			</MessageBubble>
		</div>
	);
}
