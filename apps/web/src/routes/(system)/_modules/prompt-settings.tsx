"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import type { PersonaSummary, PromptKey } from "@tsukaima/contracts";
import {
	Disclosure,
	DisclosurePanel,
	DisclosureTrigger,
	EditorialGroup,
	EditorialSwitch,
	PreferenceRow,
	cn,
} from "@tsukaima/ui";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc } from "@/lib/api";
import { m } from "@/paraglide/messages";

const labels: Record<PromptKey, () => string> = {
	"chat-system": m.prompts_chat,
	"chat-compaction": m.prompts_chat_compaction,
	"coding-system": m.prompts_coding,
	"memory-extraction": m.prompts_memory,
	"workspace-task": m.prompts_workspace,
	sidechat: m.prompts_sidechat,
};

const PROMPT_KEYS: readonly PromptKey[] = [
	"chat-system",
	"chat-compaction",
	"coding-system",
	"workspace-task",
	"sidechat",
	"memory-extraction",
];

const inputClass =
	"h-8 w-full rounded-sm border border-border bg-paper px-2.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Selection =
	| { kind: "template"; key: PromptKey }
	| { kind: "persona"; id: string }
	| { kind: "new" };

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
		<div className="space-y-1.5">
			<label
				htmlFor={id}
				className="block text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase"
			>
				{label}
			</label>
			<textarea
				id={id}
				className="block min-h-72 w-full resize-y rounded-sm border border-border bg-paper p-3 font-mono text-xs leading-5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

function EditorHeading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-baseline justify-between gap-2">
			<h2 className="font-serif text-lg text-ink">{children}</h2>
			{meta == null ? null : <span className="text-xs text-muted-foreground">{meta}</span>}
		</div>
	);
}

function ActionBar({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">{children}</div>
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
	return (
		<div className="space-y-4">
			<EditorHeading>{labels[promptKey]()}</EditorHeading>
			<PromptText
				label={m.prompts_text()}
				value={draft?.text ?? override ?? defaultText}
				onChange={(text) =>
					setDraft({ text, expected: draft?.expected === undefined ? override : draft.expected })
				}
			/>
			<Disclosure>
				<DisclosureTrigger className="text-xs text-muted-foreground">
					{m.prompts_builtin()}
				</DisclosureTrigger>
				<DisclosurePanel>
					<pre className="font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
						{defaultText || m.prompts_empty()}
					</pre>
				</DisclosurePanel>
			</Disclosure>
			<ActionBar>
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
			</ActionBar>
			<ErrorText error={mutation.error} />
		</div>
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
		<div className="space-y-4">
			<EditorHeading
				meta={
					<>
						{m.prompts_persona_version({ version: String(persona.version) })}
						{isGlobal && ` · ${m.prompts_global()}`}
					</>
				}
			>
				{persona.name}
			</EditorHeading>
			<PromptText
				label={m.prompts_persona()}
				value={draft?.text ?? persona.prompt}
				onChange={(text) => setDraft({ text, version: draft?.version ?? persona.version })}
			/>
			<ActionBar>
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
			</ActionBar>
			<ErrorText error={save.error ?? bind.error} />
		</div>
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
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				create.mutate({ name, summary, prompt });
			}}
		>
			<EditorHeading>{m.prompts_create_persona()}</EditorHeading>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1.5 text-xs">
					<span className="block text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
						{m.prompts_persona_name()}
					</span>
					<input
						className={inputClass}
						required
						maxLength={120}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label className="space-y-1.5 text-xs">
					<span className="block text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
						{m.prompts_persona_summary()}
					</span>
					<input
						className={inputClass}
						required
						maxLength={1_000}
						value={summary}
						onChange={(event) => setSummary(event.target.value)}
					/>
				</label>
			</div>
			<PromptText label={m.prompts_persona()} value={prompt} onChange={setPrompt} />
			<ActionBar>
				<Button type="submit" size="sm" disabled={create.isPending || !prompt.trim()}>
					{m.prompts_create_persona()}
				</Button>
			</ActionBar>
			<ErrorText error={create.error} />
		</form>
	);
}

function SelectorGroup({ children, title }: { children: ReactNode; title: string }) {
	return (
		<div>
			<h3 className="px-3 pb-1 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
				{title}
			</h3>
			<ul>{children}</ul>
		</div>
	);
}

function SelectorItem({
	children,
	onClick,
	selected,
}: {
	children: ReactNode;
	onClick: () => void;
	selected: boolean;
}) {
	return (
		<li>
			<button
				type="button"
				aria-current={selected ? "true" : undefined}
				onClick={onClick}
				className={cn(
					"flex w-full items-center border-s-2 border-transparent py-2 pe-2 ps-3 text-start text-[13px] text-muted-foreground transition-colors",
					"hover:bg-accent-soft hover:text-ink focus-visible:bg-accent-soft focus-visible:text-ink focus-visible:outline-none",
					selected && "border-accent-ink bg-accent-soft font-medium text-ink",
				)}
			>
				<span className="min-w-0 truncate">{children}</span>
			</button>
		</li>
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
	const [selection, setSelection] = useState<Selection>({
		kind: "template",
		key: "chat-system",
	});
	const accessId = useId();
	const globalPersona = bindings.data?.find((binding) => binding.isActive && binding.isGlobal);
	const activePersonas = (personas.data ?? []).filter((persona) => persona.isActive);
	const selectedTemplate =
		selection.kind === "template"
			? prompts.data?.find((entry) => entry.key === selection.key)
			: undefined;
	const selectedPersona =
		selection.kind === "persona"
			? activePersonas.find((persona) => persona.id === selection.id)
			: undefined;

	return (
		<div className="space-y-6">
			<EditorialGroup>
				<PreferenceRow
					label={m.prompts_agent_access()}
					hint={m.prompts_agent_description()}
					htmlFor={accessId}
				>
					<EditorialSwitch
						id={accessId}
						checked={access.data ?? false}
						disabled={access.data === undefined || setAccess.isPending}
						onCheckedChange={(checked) => setAccess.mutate(checked)}
					/>
				</PreferenceRow>
				<ErrorText error={access.error ?? setAccess.error} />
			</EditorialGroup>
			<ErrorText error={prompts.error ?? personas.error ?? bindings.error} />
			<div className="grid gap-5 md:grid-cols-[13.5rem_minmax(0,1fr)] md:gap-0">
				<nav
					aria-label={m.prompts_title()}
					className="flex flex-col gap-4 md:border-e md:border-border md:pe-4"
				>
					<SelectorGroup title={m.prompts_title()}>
						{PROMPT_KEYS.map((key) => (
							<SelectorItem
								key={key}
								selected={selection.kind === "template" && selection.key === key}
								onClick={() => setSelection({ kind: "template", key })}
							>
								{labels[key]()}
							</SelectorItem>
						))}
					</SelectorGroup>
					<SelectorGroup title={m.prompts_persona()}>
						{activePersonas.map((persona) => (
							<SelectorItem
								key={persona.id}
								selected={selection.kind === "persona" && selection.id === persona.id}
								onClick={() => setSelection({ kind: "persona", id: persona.id })}
							>
								{persona.name}
							</SelectorItem>
						))}
						<SelectorItem
							selected={selection.kind === "new"}
							onClick={() => setSelection({ kind: "new" })}
						>
							+ {m.prompts_create_persona()}
						</SelectorItem>
					</SelectorGroup>
				</nav>
				<div className="min-w-0 md:ps-5">
					{selectedTemplate === undefined ? null : (
						<TemplateEditor
							key={selectedTemplate.key}
							promptKey={selectedTemplate.key}
							defaultText={selectedTemplate.defaultText}
							override={selectedTemplate.override}
						/>
					)}
					{selectedPersona === undefined ? null : (
						<PersonaEditor
							key={selectedPersona.id}
							persona={selectedPersona}
							isGlobal={globalPersona?.personaId === selectedPersona.id}
						/>
					)}
					{selection.kind === "new" ? <NewPersona /> : null}
				</div>
			</div>
		</div>
	);
}
