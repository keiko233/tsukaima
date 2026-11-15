"use client";

import {
	type ConversationCompactionPreset,
	type ConversationPolicy,
	conversationCompactionPresets,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { m } from "@/paraglide/messages";

export const fieldClass =
	"h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const textareaClass =
	"min-h-16 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function Field({
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

export function Toggle({
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

type DraftChange = (updater: (current: ConversationPolicy) => ConversationPolicy) => void;

interface PolicyFieldsProps {
	draft: ConversationPolicy;
	onChange: DraftChange;
}

const compactionPresetLabels: Record<ConversationCompactionPreset, () => string> = {
	aggressive: () => m.policy_compaction_preset_aggressive(),
	balanced: () => m.policy_compaction_preset_balanced(),
	conservative: () => m.policy_compaction_preset_conservative(),
};

export function PolicyPacingFields({ draft, onChange }: PolicyFieldsProps) {
	const updatePacing = (patch: Partial<ConversationPolicy["pacing"]>) => {
		onChange((current) => ({ ...current, pacing: { ...current.pacing, ...patch } }));
	};

	return (
		<>
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
						onChange={(event) => updatePacing({ maxRepliesPerMinute: Number(event.target.value) })}
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
					value={(draft.pacing.allowedTools ?? []).join(", ")}
					onChange={(event) => {
						const values = event.target.value
							.split(/[,\n]/u)
							.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0);
						updatePacing({ allowedTools: values.length === 0 ? undefined : values });
					}}
				/>
			</Field>
		</>
	);
}

export function PolicySidechatFields({ draft, onChange }: PolicyFieldsProps) {
	const updateSidechat = (patch: Partial<ConversationPolicy["sidechat"]>) => {
		onChange((current) => ({ ...current, sidechat: { ...current.sidechat, ...patch } }));
	};

	return (
		<>
			<Toggle
				checked={draft.sidechat.enabled}
				label={m.policy_sidechat_enabled()}
				onChange={(value) => updateSidechat({ enabled: value })}
			/>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_sidechat_hint()}</p>
			<Field label={m.policy_sidechat_model()}>
				<input
					type="text"
					className={fieldClass}
					value={draft.sidechat.model ?? ""}
					onChange={(event) => {
						const value = event.target.value.trim();
						updateSidechat(value.length === 0 ? { model: undefined } : { model: value });
					}}
				/>
			</Field>
			<div className="grid grid-cols-3 gap-2.5">
				<Field label={m.policy_sidechat_timeout()}>
					<input
						type="number"
						min={100}
						className={fieldClass}
						value={draft.sidechat.timeoutMs}
						onChange={(event) => updateSidechat({ timeoutMs: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_sidechat_confidence()}>
					<input
						type="number"
						min={0}
						max={1}
						step={0.05}
						className={fieldClass}
						value={draft.sidechat.minConfidence}
						onChange={(event) => updateSidechat({ minConfidence: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_sidechat_interrupts()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.sidechat.maxInterruptsPerMinute}
						onChange={(event) =>
							updateSidechat({ maxInterruptsPerMinute: Number(event.target.value) })
						}
					/>
				</Field>
			</div>
		</>
	);
}

export function PolicyCompactionFields({ draft, onChange }: PolicyFieldsProps) {
	const updateCompaction = (patch: Partial<ConversationPolicy["compaction"]>) => {
		onChange((current) => ({
			...current,
			compaction: { ...current.compaction, ...patch },
		}));
	};
	const presetActive = (id: ConversationCompactionPreset): boolean => {
		const preset = conversationCompactionPresets[id];
		return (
			draft.compaction.enabled &&
			draft.compaction.triggerTokens === preset.triggerTokens &&
			draft.compaction.reserveTokens === preset.reserveTokens &&
			draft.compaction.keepRecentTokens === preset.keepRecentTokens &&
			draft.compaction.backgroundTokens === preset.backgroundTokens
		);
	};

	return (
		<>
			<Toggle
				checked={draft.compaction.enabled}
				label={m.policy_compaction_enabled()}
				onChange={(value) => updateCompaction({ enabled: value })}
			/>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_compaction_hint()}</p>
			<div className="grid grid-cols-2 gap-2.5">
				<Field hint={m.policy_compaction_trigger_hint()} label={m.policy_compaction_trigger()}>
					<input
						type="number"
						min={0}
						step={1000}
						className={fieldClass}
						value={draft.compaction.triggerTokens}
						onChange={(event) => updateCompaction({ triggerTokens: Number(event.target.value) })}
					/>
				</Field>
				<Field
					hint={
						draft.compaction.triggerTokens > 0 ? m.policy_compaction_reserve_inactive() : undefined
					}
					label={m.policy_compaction_reserve()}
				>
					<input
						type="number"
						min={0}
						step={1024}
						className={fieldClass}
						disabled={draft.compaction.triggerTokens > 0}
						value={draft.compaction.reserveTokens}
						onChange={(event) => updateCompaction({ reserveTokens: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_compaction_keep_recent()}>
					<input
						type="number"
						min={0}
						step={1000}
						className={fieldClass}
						value={draft.compaction.keepRecentTokens}
						onChange={(event) => updateCompaction({ keepRecentTokens: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_compaction_background()}>
					<input
						type="number"
						min={0}
						step={1024}
						className={fieldClass}
						value={draft.compaction.backgroundTokens}
						onChange={(event) => updateCompaction({ backgroundTokens: Number(event.target.value) })}
					/>
				</Field>
			</div>
			<div className="space-y-1.5">
				<span className="text-[11px] font-medium text-foreground">
					{m.policy_compaction_preset()}
				</span>
				<div className="flex flex-wrap gap-1.5">
					{(Object.keys(conversationCompactionPresets) as ConversationCompactionPreset[]).map(
						(id) => (
							<Button
								key={id}
								type="button"
								size="xs"
								variant={presetActive(id) ? "secondary" : "outline"}
								onClick={() =>
									updateCompaction({ ...conversationCompactionPresets[id], enabled: true })
								}
							>
								{compactionPresetLabels[id]()}
							</Button>
						),
					)}
				</div>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.policy_compaction_preset_hint()}
				</p>
			</div>
		</>
	);
}
