import { createFileRoute } from "@tanstack/react-router";
import { DiagnosticsPage } from "@/src/pages/diagnostics-page";

export const Route = createFileRoute("/diagnostics")({ component: DiagnosticsPage });
