import { createFileRoute } from "@tanstack/react-router";
import { ConversationPage } from "@/src/pages/conversation-page";

export const Route = createFileRoute("/")({ component: ConversationPage });
