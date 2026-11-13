"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import type {
	ConversationPolicy,
	ConversationPolicyView,
	PersonaSummary,
	PolicyRevision,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { Modal } from "../../_modules/ui/modal";

const listValue = (values: readonly string[]): string => values.join(", ");
const splitValue = (value: string): string[] =>
	value
		.split(/[,\n]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

const fieldClass =
	"h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
const textareaClass =
	"min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({
	children,
	hint,
	label,
}: {
	children: React.ReactNode;
	hint?: string;
	label: string;
}) {
	return (
		<label className="flex flex-col gap-1.5 text-xs font-medium text-foreground">
			<span>{label}</span>
			{children}
			{hint ? <span className="font-normal leading-4 text-muted-foreground">{hint}</span> : null}
		</label>
	);
}

function Toggle({
	checked,
	label,
	onChange,
}: {
	checked: boolean;
	label: string;
	onChange: (value: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-2 text-xs text-foreground">
			<input
				type="checkbox"
				checked={checked}
				onChange={(event) => onChange(event.target.checked)}
				className="size-4 rounded border-border accent-primary"
			/>
			<span>{label}</span>
		</label>
	);
}

export function ConversationPolicyPanel({
	chatObjectId,
	sessionId,
}: {
	chatObjectId: string;
	sessionId: string;
}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<ConversationPolicy | undefined>();
	const [personaId, setPersonaId] = useState("");
	const [personaAliases, setPersonaAliases] = useState("");

	const policy = useQuery({
		...orpc.admin.policies.get.queryOptions({ input: { conversationId: sessionId } }),
		enabled: open,
	});
	const history = useQuery({
		...orpc.admin.policies.history.queryOptions({
			input: { conversationId: sessionId, scope: "conversation" },
		}),
		enabled: open,
	});
	const personas = useQuery({
		...orpc.admin.personas.list.queryOptions(),
		enabled: open,
	});
	const bindings = useQuery({
		...orpc.admin.personas.bindings.queryOptions(),
		enabled: open,
	});

	useEffect(() => {
		if (open && policy.data !== undefined) {
			setDraft(structuredClone(policy.data.policy));
		}
	}, [open, policy.data]);

	useEffect(() => {
		if (!open || personaId.length > 0 || bindings.data === undefined) return;
		const bound = bindings.data.find((binding) => binding.conversationId === sessionId);
		if (bound !== undefined) setPersonaId(bound.personaId);
	}, [bindings.data, open, personaId, sessionId]);

	useEffect(() => {
		const persona = personas.data?.find((entry) => entry.id === personaId);
		setPersonaAliases(persona === undefined ? "" : listValue(persona.selfAliases));
	}, [personaId, personas.data]);

	const save = useMutation(
		orpc.admin.policies.update.mutationOptions({
			onError: (error) => toast.error(m.policy_save_failed(), { description: errorMessage(error) }),
			onSuccess: async (view: ConversationPolicyView) => {
				setDraft(structuredClone(view.policy));
				toast.success(m.policy_saved());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.policies.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);
	const bind = useMutation(
		orpc.admin.personas.bind.mutationOptions({
			onError: (error) => toast.error(m.policy_bind_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.policy_bind_success());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.personas.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);
	const savePersona = useMutation(
		orpc.admin.personas.upsert.mutationOptions({
			onError: (error) => toast.error(m.policy_save_failed(), { description: errorMessage(error) }),
			onSuccess: async (persona: PersonaSummary) => {
				setPersonaId(persona.id);
				toast.success(m.policy_persona_saved());
				await queryClient.invalidateQueries({ queryKey: orpc.admin.personas.key() });
			},
		}),
	);

	const selectedPersona = personas.data?.find((entry) => entry.id === personaId);
	const updateTrigger = (patch: Partial<ConversationPolicy["trigger"]>) => {
		setDraft((current) =>
			current === undefined ? current : { ...current, trigger: { ...current.trigger, ...patch } },
		);
	};
	const updatePacing = (patch: Partial<ConversationPolicy["pacing"]>) => {
		setDraft((current) =>
			current === undefined ? current : { ...current, pacing: { ...current.pacing, ...patch } },
		);
	};

	return (
		<>
			<Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
				<Settings2 className="size-4" />
				{m.policy_action()}
			</Button>
			<Modal
				open={open}
				onOpenChange={setOpen}
				title={m.policy_title()}
				description={m.policy_description()}
				className="max-w-3xl"
			>
				{policy.isPending || draft === undefined ? (
					<p className="text-sm text-muted-foreground">{m.policy_loading()}</p>
				) : policy.isError ? (
					<p className="text-sm text-destructive">{errorMessage(policy.error)}</p>
				) : (
					<div className="max-h-[68vh] space-y-5 overflow-y-auto pr-1">
						<section className="space-y-3">
							<h3 className="text-sm font-semibold">{m.policy_section_trigger()}</h3>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label={m.policy_private_access()}>
									<select
										className={fieldClass}
										value={draft.trigger.privateAccess}
										onChange={(event) =>
											updateTrigger({
												privateAccess: event.target.value as ConversationPolicy["trigger"]["privateAccess"],
											})
										}
									>
										<option value="open">{m.access_open()}</option>
										<option value="allowlist">{m.access_allowlist()}</option>
										<option value="disabled">{m.access_disabled()}</option>
									</select>
								</Field>
								<Field label={m.policy_group_access()}>
									<select
										className={fieldClass}
										value={draft.trigger.groupAccess}
										onChange={(event) =>
											updateTrigger({
												groupAccess: event.target.value as ConversationPolicy["trigger"]["groupAccess"],
											})
										}
									>
										<option value="open">{m.access_open()}</option>
										<option value="allowlist">{m.access_allowlist()}</option>
										<option value="disabled">{m.access_disabled()}</option>
									</select>
								</Field>
								<Field label={m.policy_group_mentions()}>
									<select
										className={fieldClass}
										value={draft.trigger.groupMentionMode}
										onChange={(event) =>
											updateTrigger({
												groupMentionMode: event.target
													.value as ConversationPolicy["trigger"]["groupMentionMode"],
											})
										}
									>
										<option value="always">{m.mention_always()}</option>
										<option value="smart">{m.mention_smart()}</option>
										<option value="disabled">{m.mention_disabled()}</option>
									</select>
								</Field>
								<Field label={m.policy_sticker_only()}>
									<select
										className={fieldClass}
										value={draft.trigger.stickerOnly}
										onChange={(event) =>
											updateTrigger({
												stickerOnly: event.target
													.value as ConversationPolicy["trigger"]["stickerOnly"],
											})
										}
									>
										<option value="wake">{m.media_wake()}</option>
										<option value="text-only">{m.media_text_only()}</option>
										<option value="lurk">{m.media_lurk()}</option>
										<option value="ignore">{m.media_ignore()}</option>
									</select>
								</Field>
								<Field label={m.policy_image_only()}>
									<select
										className={fieldClass}
										value={draft.trigger.imageOnly}
										onChange={(event) =>
											updateTrigger({
												imageOnly: event.target
													.value as ConversationPolicy["trigger"]["imageOnly"],
											})
										}
									>
										<option value="wake">{m.media_wake()}</option>
										<option value="text-only">{m.media_text_only()}</option>
										<option value="lurk">{m.media_lurk()}</option>
										<option value="ignore">{m.media_ignore()}</option>
									</select>
								</Field>
							</div>
							<Toggle
								checked={draft.trigger.replyToBotCounts}
								label={m.policy_reply_to_bot()}
								onChange={(value) => updateTrigger({ replyToBotCounts: value })}
							/>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label={m.policy_allowlist()} hint={m.policy_allowlist_hint()}>
									<textarea
										className={textareaClass}
										value={listValue(draft.trigger.allowlist)}
										onChange={(event) =>
											updateTrigger({ allowlist: splitValue(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_keywords()} hint={m.policy_keywords_hint()}>
									<textarea
										className={textareaClass}
										value={listValue(draft.trigger.keywords)}
										onChange={(event) =>
											updateTrigger({ keywords: splitValue(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_self_aliases()} hint={m.policy_self_aliases_hint()}>
									<textarea
										className={textareaClass}
										value={listValue(draft.trigger.selfAliases)}
										onChange={(event) =>
											updateTrigger({ selfAliases: splitValue(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_peer_bots()} hint={m.policy_allowlist_hint()}>
									<textarea
										className={textareaClass}
										value={listValue(draft.trigger.peerBotIds)}
										onChange={(event) =>
											updateTrigger({ peerBotIds: splitValue(event.target.value) })
										}
									/>
								</Field>
							</div>
						</section>

						<section className="space-y-3 border-t border-border pt-4">
							<h3 className="text-sm font-semibold">{m.policy_section_pacing()}</h3>
							<div className="grid gap-3 sm:grid-cols-3">
								<Field label={m.policy_burst_settle()}>
									<input
										type="number"
										min={1}
										className={fieldClass}
										value={draft.pacing.burstSettleMs}
										onChange={(event) =>
											updatePacing({ burstSettleMs: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_burst_max_wait()}>
									<input
										type="number"
										min={1}
										className={fieldClass}
										value={draft.pacing.burstMaxWaitMs}
										onChange={(event) =>
											updatePacing({ burstMaxWaitMs: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_burst_max_messages()}>
									<input
										type="number"
										min={1}
										className={fieldClass}
										value={draft.pacing.burstMaxMessages}
										onChange={(event) =>
											updatePacing({ burstMaxMessages: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_long_message()}>
									<input
										type="number"
										min={1}
										className={fieldClass}
										value={draft.pacing.burstLongMessageThreshold}
										onChange={(event) =>
											updatePacing({ burstLongMessageThreshold: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_cooldown()}>
									<input
										type="number"
										min={0}
										className={fieldClass}
										value={draft.pacing.replyCooldownMs}
										onChange={(event) =>
											updatePacing({ replyCooldownMs: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_rate_limit()}>
									<input
										type="number"
										min={0}
										className={fieldClass}
										value={draft.pacing.maxRepliesPerMinute}
										onChange={(event) =>
											updatePacing({ maxRepliesPerMinute: Number(event.target.value) })
										}
									/>
								</Field>
							</div>
							<div className="flex flex-wrap gap-x-5 gap-y-2">
								<Toggle
									checked={draft.pacing.typingEnabled}
									label={m.policy_typing()}
									onChange={(value) => updatePacing({ typingEnabled: value })}
								/>
								<Toggle
									checked={draft.pacing.replyDelayEnabled}
									label={m.policy_reply_delay()}
									onChange={(value) => updatePacing({ replyDelayEnabled: value })}
								/>
								<Toggle
									checked={draft.pacing.stripMarkdown}
									label={m.policy_strip_markdown()}
									onChange={(value) => updatePacing({ stripMarkdown: value })}
								/>
							</div>
							<div className="grid gap-3 sm:grid-cols-3">
								<Field label={m.policy_reply_delay_max()}>
									<input
										type="number"
										min={0}
										className={fieldClass}
										value={draft.pacing.replyDelayMaxMs}
										onChange={(event) =>
											updatePacing({ replyDelayMaxMs: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_send_interval()}>
									<input
										type="number"
										min={0}
										className={fieldClass}
										value={draft.pacing.sendIntervalMs}
										onChange={(event) =>
											updatePacing({ sendIntervalMs: Number(event.target.value) })
										}
									/>
								</Field>
								<Field label={m.policy_max_immediate()}>
									<input
										type="number"
										min={1}
										className={fieldClass}
										value={draft.pacing.maxImmediateOutputMessages}
										onChange={(event) =>
											updatePacing({ maxImmediateOutputMessages: Number(event.target.value) })
										}
									/>
								</Field>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<Toggle
									checked={draft.pacing.quietHours?.enabled === true}
									label={m.policy_quiet_hours()}
									onChange={(value) =>
										updatePacing({
											quietHours: {
												enabled: value,
												endHour: draft.pacing.quietHours?.endHour ?? 7,
												startHour: draft.pacing.quietHours?.startHour ?? 22,
											},
										})
									}
								/>
								<Field label={m.policy_quiet_start()}>
									<input
										type="number"
										min={0}
										max={23}
										className={fieldClass}
										value={draft.pacing.quietHours?.startHour ?? 22}
										onChange={(event) =>
											updatePacing({
												quietHours: {
													enabled: draft.pacing.quietHours?.enabled ?? false,
													endHour: draft.pacing.quietHours?.endHour ?? 7,
													startHour: Number(event.target.value),
												},
											})
										}
									/>
								</Field>
								<Field label={m.policy_quiet_end()}>
									<input
										type="number"
										min={0}
										max={23}
										className={fieldClass}
										value={draft.pacing.quietHours?.endHour ?? 7}
										onChange={(event) =>
											updatePacing({
												quietHours: {
													enabled: draft.pacing.quietHours?.enabled ?? false,
													endHour: Number(event.target.value),
													startHour: draft.pacing.quietHours?.startHour ?? 22,
												},
											})
										}
									/>
								</Field>
							</div>
							<Field label={m.policy_allowed_tools()} hint={m.policy_allowed_tools_hint()}>
								<textarea
									className={textareaClass}
									value={listValue(draft.pacing.allowedTools ?? [])}
									onChange={(event) => {
										const values = splitValue(event.target.value);
										updatePacing({ allowedTools: values.length === 0 ? undefined : values });
									}}
								/>
							</Field>
						</section>

						<section className="space-y-3 border-t border-border pt-4">
							<h3 className="text-sm font-semibold">{m.policy_section_persona()}</h3>
							<div className="grid gap-3 sm:grid-cols-2">
								<Field label={m.policy_persona()}>
									<select
										className={fieldClass}
										value={personaId}
										onChange={(event) => setPersonaId(event.target.value)}
									>
										<option value="">{m.policy_no_persona()}</option>
										{(personas.data ?? []).map((persona) => (
											<option key={`${persona.id}:${persona.version}`} value={persona.id}>
												{persona.name} · v{persona.version}
											</option>
										))}
									</select>
								</Field>
								<Field label={m.policy_persona_aliases()} hint={m.policy_self_aliases_hint()}>
									<textarea
										className={textareaClass}
										value={personaAliases}
										disabled={selectedPersona === undefined}
										onChange={(event) => setPersonaAliases(event.target.value)}
									/>
								</Field>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={selectedPersona === undefined || savePersona.isPending}
									onClick={() => {
										if (selectedPersona === undefined) return;
										savePersona.mutate({
											id: selectedPersona.id,
											name: selectedPersona.name,
											prompt: selectedPersona.prompt,
											selfAliases: splitValue(personaAliases),
											summary: selectedPersona.summary,
										});
									}}
								>
									{m.policy_save_persona()}
								</Button>
								<Button
									size="sm"
									disabled={personaId.length === 0 || bind.isPending}
									onClick={() =>
										bind.mutate({
											conversationId: sessionId,
											personaId,
											scope: "conversation",
										})
									}
								>
									{m.policy_bind_persona()}
								</Button>
							</div>
						</section>

						<section className="space-y-2 border-t border-border pt-4">
							<h3 className="text-sm font-semibold">{m.policy_history()}</h3>
							{history.data === undefined || history.data.length === 0 ? (
								<p className="text-xs text-muted-foreground">{m.policy_history_empty()}</p>
							) : (
								<ul className="space-y-1.5">
									{history.data.map((revision: PolicyRevision) => (
										<li
											key={revision.id}
											className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs"
										>
											<span>
												{m.policy_version({ version: revision.policy.version })} ·{" "}
												{revision.createdAt}
											</span>
											<span className="text-muted-foreground">
												{revision.isActive ? m.policy_revision_active() : ""}
											</span>
										</li>
									))}
								</ul>
							)}
						</section>

						<div className="flex justify-end gap-2 border-t border-border pt-4">
							<Button variant="outline" size="sm" onClick={() => setOpen(false)}>
								{m.close()}
							</Button>
							<Button
								size="sm"
								disabled={save.isPending}
								onClick={() =>
									save.mutate({
										conversationId: sessionId,
										policy: draft,
										scope: "conversation",
									})
								}
							>
								{m.policy_save()}
							</Button>
						</div>
						<input type="hidden" value={chatObjectId} readOnly />
					</div>
				)}
			</Modal>
		</>
	);
}
