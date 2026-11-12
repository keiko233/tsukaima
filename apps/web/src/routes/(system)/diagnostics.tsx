import { createFileRoute } from "@tanstack/react-router";
import { DiagnosticsPage } from "./_modules/diagnostics-page";

export const Route = createFileRoute("/(system)/diagnostics")({ component: DiagnosticsPage });
