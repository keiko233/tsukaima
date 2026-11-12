import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "./_modules/plugin-page";

export const Route = createFileRoute("/(system)/plugins")({ component: PluginPage });
