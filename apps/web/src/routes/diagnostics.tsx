import { createFileRoute } from "@tanstack/react-router";
import { DiagnosticsPage } from "@/pages/diagnostics-page";

export const Route = createFileRoute("/diagnostics")({ component: DiagnosticsPage });
