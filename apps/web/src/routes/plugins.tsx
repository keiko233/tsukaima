import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/pages/plugin-page";

export const Route = createFileRoute("/plugins")({ component: PluginPage });
