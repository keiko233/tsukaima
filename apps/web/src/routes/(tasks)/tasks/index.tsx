import { createFileRoute } from "@tanstack/react-router";
import { TasksIndexPage } from "../_modules/tasks-page";

export const Route = createFileRoute("/(tasks)/tasks/")({
	component: TasksIndexPage,
	validateSearch: (search: Record<string, unknown>): { sessionId?: string } =>
		typeof search.sessionId === "string" ? { sessionId: search.sessionId } : {},
});
