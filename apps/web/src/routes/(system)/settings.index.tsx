import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "./_modules/settings-page";

export const Route = createFileRoute("/(system)/settings/")({ component: SettingsPage });
