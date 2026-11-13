import { createFileRoute } from "@tanstack/react-router";
import { MemoriesPage } from "./_modules/memories-page";

export const Route = createFileRoute("/(system)/memories")({ component: MemoriesPage });
