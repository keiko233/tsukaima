import { createFileRoute } from "@tanstack/react-router";
import { TaskDetailPage } from "../_modules/tasks-page";

export const Route = createFileRoute("/(tasks)/tasks/$scheduleId")({
	component: TaskDetailPage,
});
