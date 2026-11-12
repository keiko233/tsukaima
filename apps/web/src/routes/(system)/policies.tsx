import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage } from "./_modules/policy-page";

export const Route = createFileRoute("/(system)/policies")({ component: PolicyPage });
