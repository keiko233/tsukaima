"use client";

import type {
	ConversationPolicy,
	ModelCatalogEntry,
	PersonaSummary,
	PolicyRevision,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { m } from "@/paraglide/messages";
import {
	Field,
	PolicyCompactionFields,
	PolicyCrossSessionFields,
	PolicyGateFields,
	PolicyGenerationFields,
	PolicyHumanizationFields,
	PolicyMemoryConsolidationFields,
	PolicyPacingFields,
	PolicySandboxWorkspaceField,
	PolicySidechatFields,
	PolicySocialFields,
	PolicyWorkspaceDelegationField,
	Toggle,
	fieldClass,
	textareaClass,
} from "../../_modules/policy/conversation-policy-fields";
import { InlineError } from "../../_modules/shell/primitives";

export const listValue = (values: readonly string[]): string => values.join(", ");
export const splitValue = (value: string): string[] =>
	value
		.split(/[,\n]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

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
		return (
			<div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
				{m.policy_loading()}
			</div>
		);
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
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={saving}
									onClick={onDiscard}
								>
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
	/** Models plugins advertise for sidechat; the policy editor offers them as overrides. */
	sidechatModels?: readonly ModelCatalogEntry[];
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
	const updateNotices = (patch: Partial<ConversationPolicy["notices"]>) => {
		onChange((current) => ({ ...current, notices: { ...current.notices, ...patch } }));
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
										privateAccess: event.target
											.value as ConversationPolicy["trigger"]["privateAccess"],
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

					<div className="grid grid-cols-2 gap-2.5">
						<Field label={m.policy_recent_activity()} hint={m.policy_recent_activity_hint()}>
							<select
								className={fieldClass}
								value={draft.trigger.recentActivityEscalation}
								onChange={(event) =>
									updateTrigger({
										recentActivityEscalation: event.target
											.value as ConversationPolicy["trigger"]["recentActivityEscalation"],
									})
								}
							>
								<option value="off">{m.recent_activity_off()}</option>
								<option value="throttled">{m.recent_activity_throttled()}</option>
								<option value="always">{m.recent_activity_always()}</option>
							</select>
						</Field>
						<Field label={m.policy_recent_activity_interval()}>
							<input
								type="number"
								min={0}
								className={fieldClass}
								value={draft.trigger.recentActivityMinIntervalMs}
								onChange={(event) =>
									updateTrigger({ recentActivityMinIntervalMs: Number(event.target.value) })
								}
							/>
						</Field>
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<Toggle
							checked={draft.notices.pokeObserve}
							label={m.policy_poke_observe()}
							onChange={(value) => updateNotices({ pokeObserve: value })}
						/>
						<Toggle
							checked={draft.notices.pokeWake}
							label={m.policy_poke_wake()}
							onChange={(value) => updateNotices({ pokeWake: value })}
						/>
						<Field label={m.policy_poke_cooldown()}>
							<input
								type="number"
								min={0}
								className={fieldClass}
								value={draft.notices.pokeWakeCooldownMs}
								onChange={(event) =>
									updateNotices({ pokeWakeCooldownMs: Number(event.target.value) })
								}
							/>
						</Field>
					</div>

					<div className="border-t border-border/60 pt-2.5">
						<PolicyWorkspaceDelegationField draft={draft} onChange={onChange} />
						<PolicySandboxWorkspaceField draft={draft} onChange={onChange} />
					</div>

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
	sidechatModels,
}: PolicyDraftTabProps) {
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
					<PolicyPacingFields draft={draft} onChange={onChange} />

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">{m.policy_section_sidechat()}</h3>
						<PolicySidechatFields draft={draft} models={sidechatModels} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_compaction()}
						</h3>
						<PolicyCompactionFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_generation()}
						</h3>
						<PolicyGenerationFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_cross_session()}
						</h3>
						<PolicyCrossSessionFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_memory_consolidation()}
						</h3>
						<PolicyMemoryConsolidationFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_social()}
						</h3>
						<PolicySocialFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">
							{m.policy_section_humanization()}
						</h3>
						<PolicyHumanizationFields draft={draft} onChange={onChange} />
					</div>

					<div className="space-y-2 border-t border-border/60 pt-2.5">
						<h3 className="text-xs font-semibold text-foreground">{m.policy_section_gate()}</h3>
						<PolicyGateFields draft={draft} onChange={onChange} />
					</div>
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
