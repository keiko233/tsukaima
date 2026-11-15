"use client";

import type {
	ConversationPolicy,
	PersonaSummary,
	PolicyRevision,
} from "@elaina/contracts";
import { Button } from "@elaina/ui/components/motion/button";
import { m } from "@/paraglide/messages";
import { InlineError } from "../../_modules/shell/primitives";

export const listValue = (values: readonly string[]): string => values.join(", ");
export const splitValue = (value: string): string[] =>
	value
		.split(/[,\n]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

const fieldClass =
	"h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const textareaClass =
	"min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

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
		<label className="flex flex-col gap-1 text-[11px] font-medium text-foreground">
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
				className="size-3.5 rounded border-border accent-primary"
			/>
			<span>{label}</span>
		</label>
	);
}

function PolicyTabShell({
	children,
	dirty,
	errorMessage,
	isError,
	isPending,
	onDiscard,
	onRetry,
	onSave,
	saving,
}: {
	children: React.ReactNode;
	dirty: boolean;
	errorMessage?: string;
	isError?: boolean;
	isPending?: boolean;
	onDiscard?: () => void;
	onRetry?: () => void;
	onSave?: () => void;
	saving?: boolean;
}) {
	if (isPending) {
		return <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">{m.policy_loading()}</div>;
	}
	if (isError) {
		return (
			<div className="px-3 py-4">
				<InlineError
					message={errorMessage ?? m.error_generic()}
					onRetry={onRetry ?? (() => {})}
					retryLabel={m.retry()}
				/>
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pt-2.5 pb-3">{children}</div>
			{onSave ? (
				<div className="shrink-0 border-t border-border/70 bg-background/80 px-3 py-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-[11px] text-muted-foreground">
							{dirty ? m.policy_unsaved() : ""}
						</span>
						<div className="flex items-center gap-1.5">
							{dirty && onDiscard ? (
								<Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
									{m.policy_reset_draft()}
								</Button>
							) : null}
							<Button type="button" size="sm" disabled={saving} onClick={onSave}>
								{m.policy_save()}
							</Button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

export interface PolicyDraftTabProps {
	dirty: boolean;
	draft: ConversationPolicy | undefined;
	errorMessage?: string;
	isError?: boolean;
	isPending?: boolean;
	onChange: (updater: (current: ConversationPolicy) => ConversationPolicy) => void;
	onDiscard: () => void;
	onRetry: () => void;
	onSave: () => void;
	saving?: boolean;
}

export function PolicyTriggerTabView({
	dirty,
	draft,
	errorMessage,
	isError = false,
	isPending = false,
	onChange,
	onDiscard,
	onRetry,
	onSave,
	saving = false,
}: PolicyDraftTabProps) {
	const updateTrigger = (patch: Partial<ConversationPolicy["trigger"]>) => {
		onChange((current) => ({ ...current, trigger: { ...current.trigger, ...patch } }));
	};

	return (
		<PolicyTabShell
			dirty={dirty}
			errorMessage={errorMessage}
			isError={isError}
			isPending={isPending || draft === undefined}
			onDiscard={onDiscard}
			onRetry={onRetry}
			onSave={onSave}
			saving={saving}
		>
			{draft === undefined ? null : (
				<>
					<div className="space-y-0.5">
						<h3 className="text-xs font-semibold text-foreground">{m.policy_section_trigger()}</h3>
						<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_description()}</p>
					</div>

					<div className="grid grid-cols-2 gap-2.5">
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
					</div>

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

					<div className="grid grid-cols-2 gap-2.5">
						<Field label={m.policy_sticker_only()}>
							<select
								className={fieldClass}
								value={draft.trigger.stickerOnly}
								onChange={(event) =>
									updateTrigger({
										stickerOnly: event.target.value as ConversationPolicy["trigger"]["stickerOnly"],
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
										imageOnly: event.target.value as ConversationPolicy["trigger"]["imageOnly"],
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

					<Field label={m.policy_allowlist()} hint={m.policy_allowlist_hint()}>
						<textarea
							className={textareaClass}
							value={listValue(draft.trigger.allowlist)}
							onChange={(event) => updateTrigger({ allowlist: splitValue(event.target.value) })}
						/>
					</Field>
					<Field label={m.policy_keywords()} hint={m.policy_keywords_hint()}>
						<textarea
							className={textareaClass}
							value={listValue(draft.trigger.keywords)}
							onChange={(event) => updateTrigger({ keywords: splitValue(event.target.value) })}
						/>
					</Field>
					<Field label={m.policy_self_aliases()} hint={m.policy_self_aliases_hint()}>
						<textarea
							className={textareaClass}
							value={listValue(draft.trigger.selfAliases)}
							onChange={(event) => updateTrigger({ selfAliases: splitValue(event.target.value) })}
						/>
					</Field>
					<Field label={m.policy_peer_bots()} hint={m.policy_allowlist_hint()}>
						<textarea
							className={textareaClass}
							value={listValue(draft.trigger.peerBotIds)}
							onChange={(event) => updateTrigger({ peerBotIds: splitValue(event.target.value) })}
						/>
					</Field>
				</>
			)}
		</PolicyTabShell>
	);
}

export function PolicyPacingTabView({
	dirty,
	draft,
	errorMessage,
	isError = false,
	isPending = false,
	onChange,
	onDiscard,
	onRetry,
	onSave,
	saving = false,
}: PolicyDraftTabProps) {
	const updatePacing = (patch: Partial<ConversationPolicy["pacing"]>) => {
		onChange((current) => ({ ...current, pacing: { ...current.pacing, ...patch } }));
	};

	return (
		<PolicyTabShell
			dirty={dirty}
			errorMessage={errorMessage}
			isError={isError}
			isPending={isPending || draft === undefined}
			onDiscard={onDiscard}
			onRetry={onRetry}
			onSave={onSave}
			saving={saving}
		>
			{draft === undefined ? null : (
				<>
					<h3 className="text-xs font-semibold text-foreground">{m.policy_section_pacing()}</h3>

					<div className="grid grid-cols-2 gap-2.5">
						<Field label={m.policy_burst_settle()}>
							<input
								type="number"
								min={1}
								className={fieldClass}
								value={draft.pacing.burstSettleMs}
								onChange={(event) => updatePacing({ burstSettleMs: Number(event.target.value) })}
							/>
						</Field>
						<Field label={m.policy_burst_max_wait()}>
							<input
								type="number"
								min={1}
								className={fieldClass}
								value={draft.pacing.burstMaxWaitMs}
								onChange={(event) => updatePacing({ burstMaxWaitMs: Number(event.target.value) })}
							/>
						</Field>
						<Field label={m.policy_burst_max_messages()}>
							<input
								type="number"
								min={1}
								className={fieldClass}
								value={draft.pacing.burstMaxMessages}
								onChange={(event) => updatePacing({ burstMaxMessages: Number(event.target.value) })}
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
								onChange={(event) => updatePacing({ replyCooldownMs: Number(event.target.value) })}
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
						<Field label={m.policy_reply_delay_max()}>
							<input
								type="number"
								min={0}
								className={fieldClass}
								value={draft.pacing.replyDelayMaxMs}
								onChange={(event) => updatePacing({ replyDelayMaxMs: Number(event.target.value) })}
							/>
						</Field>
						<Field label={m.policy_send_interval()}>
							<input
								type="number"
								min={0}
								className={fieldClass}
								value={draft.pacing.sendIntervalMs}
								onChange={(event) => updatePacing({ sendIntervalMs: Number(event.target.value) })}
							/>
						</Field>
					</div>

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

					<div className="space-y-2 border-t border-border/60 pt-2.5">
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

					<div className="space-y-2 border-t border-border/60 pt-2.5">
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
						<div className="grid grid-cols-2 gap-2.5">
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
				</>
			)}
		</PolicyTabShell>
	);
}

export interface PolicyPersonaTabViewProps {
	binding?: boolean;
	errorMessage?: string;
	history: readonly PolicyRevision[] | undefined;
	isError?: boolean;
	isPending?: boolean;
	onBindPersona: () => void;
	onChangePersonaAliases: (value: string) => void;
	onChangePersonaId: (value: string) => void;
	onRetry: () => void;
	onSavePersona: () => void;
	personaAliases: string;
	personaId: string;
	personas: readonly PersonaSummary[];
	savingPersona?: boolean;
}

export function PolicyPersonaTabView({
	binding = false,
	errorMessage,
	history,
	isError = false,
	isPending = false,
	onBindPersona,
	onChangePersonaAliases,
	onChangePersonaId,
	onRetry,
	onSavePersona,
	personaAliases,
	personaId,
	personas,
	savingPersona = false,
}: PolicyPersonaTabViewProps) {
	const selectedPersona = personas.find((entry) => entry.id === personaId);

	return (
		<PolicyTabShell
			dirty={false}
			errorMessage={errorMessage}
			isError={isError}
			isPending={isPending}
			onRetry={onRetry}
		>
			<section className="space-y-3">
				<h3 className="text-xs font-semibold text-foreground">{m.policy_section_persona()}</h3>
				<Field label={m.policy_persona()}>
					<select
						className={fieldClass}
						value={personaId}
						onChange={(event) => onChangePersonaId(event.target.value)}
					>
						<option value="">{m.policy_no_persona()}</option>
						{personas.map((persona) => (
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
						onChange={(event) => onChangePersonaAliases(event.target.value)}
					/>
				</Field>
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={selectedPersona === undefined || savingPersona}
						onClick={onSavePersona}
					>
						{m.policy_save_persona()}
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={personaId.length === 0 || binding}
						onClick={onBindPersona}
					>
						{m.policy_bind_persona()}
					</Button>
				</div>
			</section>

			<section className="space-y-2 border-t border-border/60 pt-3">
				<h3 className="text-xs font-semibold text-foreground">{m.policy_history()}</h3>
				{history === undefined || history.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">{m.policy_history_empty()}</p>
				) : (
					<ul className="space-y-1.5">
						{history.map((revision) => (
							<li
								key={revision.id}
								className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5 text-[11px]"
							>
								<span className="min-w-0 truncate">
									{m.policy_version({ version: revision.policy.version })} · {revision.createdAt}
								</span>
								{revision.isActive ? (
									<span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
										{m.policy_revision_active()}
									</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</PolicyTabShell>
	);
}
