import { createFileRoute } from "@tanstack/react-router";
import { ChatPage } from "./_modules/chat-page";

export const Route = createFileRoute("/(messaging)/chat/$sessionId")({
	component: ChatSessionRoute,
});

function ChatSessionRoute() {
	const { sessionId } = Route.useParams();
	return <ChatPage sessionId={sessionId} />;
}
