import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/src/pages/plugin-page";

export const Route = createFileRoute("/plugins")({ component: PluginPage });
