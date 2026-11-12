import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage } from "@/src/pages/policy-page";

export const Route = createFileRoute("/policies")({ component: PolicyPage });
