import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import type { PersonaSummary, PromptKey } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tsukaima/ui/components/motion/card";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";

const labels: Record<PromptKey, () => string> = {
	"chat-system": m.prompts_chat,
	"coding-system": m.prompts_coding,
	"memory-extraction": m.prompts_memory,
	"workspace-task": m.prompts_workspace,
	sidechat: m.prompts_sidechat,
};

function PromptCard({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{title}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-2">{children}</CardContent>
		</Card>
	);
}

function PromptText({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (text: string) => void;
}) {
	const id = useId();
	return (
		<div className="space-y-1">
			<label htmlFor={id} className="text-xs font-medium">
				{label}
			</label>
			<textarea
				id={id}
				className="block min-h-32 w-full rounded-md border bg-background p-2 font-mono text-xs"
				maxLength={20_000}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
		</div>
	);
}

function ErrorText({ error }: { error: Error | null }) {
	return (
		error && (
			<p role="alert" className="text-xs text-destructive">
				{error.message}
			</p>
		)
	);
}

function TemplateEditor({
	promptKey,
	defaultText,
	override,
}: {
	promptKey: PromptKey;
	defaultText: string;
	override: string | null;
}) {
	const client = useQueryClient();
	const [draft, setDraft] = useState<{ text: string; expected: string | null }>();
	const mutation = useMutation(
		orpc.admin.prompts.update.mutationOptions({
			onSuccess: async () => {
				await Promise.all([
					client.invalidateQueries({ queryKey: orpc.admin.prompts.list.key() }),
					client.invalidateQueries({ queryKey: orpc.admin.sessions.contextStats.key() }),
				]);
				setDraft(undefined);
			},
		}),
	);
	const title = labels[promptKey]();
	return (
		<PromptCard title={title}>
			<PromptText
				label={m.prompts_text()}
				value={draft?.text ?? override ?? defaultText}
				onChange={(text) =>
					setDraft({ text, expected: draft?.expected === undefined ? override : draft.expected })
				}
			/>
			<details className="text-xs">
				<summary>{m.prompts_builtin()}</summary>
				<pre className="mt-2 whitespace-pre-wrap break-words">
					{defaultText || m.prompts_empty()}
				</pre>
			</details>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={!draft || mutation.isPending}
					onClick={() => {
						if (draft)
							mutation.mutate({
								key: promptKey,
								expectedOverride: draft.expected,
								override: draft.text,
							});
					}}
				>
					{m.prompts_save()}
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={override === null || mutation.isPending}
					onClick={() =>
						mutation.mutate({ key: promptKey, expectedOverride: override, override: null })
					}
				>
					{m.prompts_reset()}
				</Button>
				{draft && (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setDraft(undefined);
							mutation.reset();
							void client.invalidateQueries({ queryKey: orpc.admin.prompts.list.key() });
						}}
					>
						{m.prompts_reload()}
					</Button>
				)}
			</div>
			<ErrorText error={mutation.error} />
		</PromptCard>
	);
}

function PersonaEditor({ persona, isGlobal }: { persona: PersonaSummary; isGlobal: boolean }) {
	const client = useQueryClient();
	const [draft, setDraft] = useState<{ text: string; version: number }>();
	const refresh = () => client.invalidateQueries({ queryKey: orpc.admin.personas.key() });
	const save = useMutation(
		orpc.admin.personas.updatePrompt.mutationOptions({
			onSuccess: async () => {
				await refresh();
				setDraft(undefined);
			},
		}),
	);
	const bind = useMutation(orpc.admin.personas.bindPersona.mutationOptions({ onSuccess: refresh }));
	return (
		<PromptCard title={persona.name}>
			<p className="text-xs text-muted-foreground">
				{m.prompts_persona_version({ version: String(persona.version) })}
				{isGlobal && ` · ${m.prompts_global()}`}
			</p>
			<PromptText
				label={m.prompts_persona()}
				value={draft?.text ?? persona.prompt}
				onChange={(text) => setDraft({ text, version: draft?.version ?? persona.version })}
			/>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					disabled={!draft?.text.trim() || draft.text === persona.prompt || save.isPending}
					onClick={() => {
						if (draft) save.mutate({ id: persona.id, version: draft.version, prompt: draft.text });
					}}
				>
					{m.prompts_save()}
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={isGlobal || bind.isPending}
					onClick={() => bind.mutate({ personaId: persona.id, scope: "global" })}
				>
					{m.prompts_bind_global()}
				</Button>
				{draft && (
					<Button
						size="sm"
						variant="ghost"
						disabled={save.isPending}
						onClick={() => {
							setDraft(undefined);
							save.reset();
							void refresh();
						}}
					>
						{m.prompts_reload()}
					</Button>
				)}
			</div>
			<ErrorText error={save.error ?? bind.error} />
		</PromptCard>
	);
}

function NewPersona() {
	const client = useQueryClient();
	const [name, setName] = useState("");
	const [summary, setSummary] = useState("");
	const [prompt, setPrompt] = useState("");
	const create = useMutation(
		orpc.admin.personas.upsert.mutationOptions({
			onSuccess: async () => {
				setName("");
				setSummary("");
				setPrompt("");
				await client.invalidateQueries({ queryKey: orpc.admin.personas.key() });
			},
		}),
	);
	return (
		<PromptCard title={m.prompts_create_persona()}>
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate({ name, summary, prompt });
				}}
			>
				<label className="block text-xs">
					{m.prompts_persona_name()}
					<input
						className="block w-full rounded-md border bg-background p-2"
						required
						maxLength={120}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label className="block text-xs">
					{m.prompts_persona_summary()}
					<input
						className="block w-full rounded-md border bg-background p-2"
						required
						maxLength={1_000}
						value={summary}
						onChange={(event) => setSummary(event.target.value)}
					/>
				</label>
				<PromptText label={m.prompts_persona()} value={prompt} onChange={setPrompt} />
				<Button type="submit" size="sm" disabled={create.isPending || !prompt.trim()}>
					{m.prompts_create_persona()}
				</Button>
				<ErrorText error={create.error} />
			</form>
		</PromptCard>
	);
}

export function PromptSettings() {
	const client = useQueryClient();
	const prompts = useQuery(orpc.admin.prompts.list.queryOptions());
	const access = useQuery(orpc.admin.prompts.agentAccess.queryOptions());
	const personas = useQuery(orpc.admin.personas.list.queryOptions());
	const bindings = useQuery(orpc.admin.personas.bindings.queryOptions());
	const setAccess = useMutation(
		orpc.admin.prompts.setAgentAccess.mutationOptions({
			onSuccess: () => client.invalidateQueries({ queryKey: orpc.admin.prompts.agentAccess.key() }),
		}),
	);
	const globalPersona = bindings.data?.find((binding) => binding.isActive && binding.isGlobal);
	return (
		<div className="space-y-4">
			<PromptCard title={m.prompts_agent_access()}>
				<label className="flex items-start gap-2 text-xs">
					<input
						type="checkbox"
						checked={access.data ?? false}
						disabled={access.data === undefined || setAccess.isPending}
						onChange={(event) => setAccess.mutate(event.target.checked)}
					/>
					{m.prompts_agent_description()}
				</label>
				<ErrorText error={access.error ?? setAccess.error} />
			</PromptCard>
			<ErrorText error={prompts.error ?? personas.error ?? bindings.error} />
			{prompts.data?.map(({ key, ...view }) => (
				<TemplateEditor key={key} promptKey={key} {...view} />
			))}
			{personas.data
				?.filter((persona) => persona.isActive)
				.map((persona) => (
					<PersonaEditor
						key={persona.id}
						persona={persona}
						isGlobal={globalPersona?.personaId === persona.id}
					/>
				))}
			<NewPersona />
		</div>
	);
}
