import { createFileRoute } from "@tanstack/react-router";
import { ChatEmptyState } from "./_modules/chat-page";

export const Route = createFileRoute("/(messaging)/")({ component: ChatEmptyState });
