import { createFileRoute } from "@tanstack/react-router";
import { SystemPage } from "./_modules/page-header";
import { PromptSettings } from "./_modules/prompt-settings";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/(system)/settings/prompts")({
	component: () => (
		<SystemPage title={m.prompts_title()} description={m.prompts_description()}>
			<PromptSettings />
		</SystemPage>
	),
});
