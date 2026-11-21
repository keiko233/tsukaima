"use client";

import {
	type ConversationCompactionPreset,
	type ConversationPolicy,
	conversationCompactionPresets,
	type ModelCatalogEntry,
	type ModelSelection,
	type ThinkingLevel,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@tsukaima/ui/components/motion/select";
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

/** Sentinel option that clears `sidechat.model` so settings decide the model. */
export const POLICY_DEFAULT_MODEL = "__policy_default__";

/**
 * Label for a model in a select. The stored value is the bare id, so the provider is shown to
 * make cross-provider entries distinguishable.
 */
export function modelOptionLabel(model: ModelCatalogEntry): string {
	const name =
		model.name === undefined || model.name === model.id ? model.id : `${model.name} · ${model.id}`;
	return `${name} · ${model.providerId}`;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function thinkingLevelLabel(level: ThinkingLevel): string {
	switch (level) {
		case "off":
			return m.effort_off();
		case "minimal":
			return m.effort_minimal();
		case "low":
			return m.effort_low();
		case "medium":
			return m.effort_medium();
		case "high":
			return m.effort_high();
		case "xhigh":
			return m.effort_xhigh();
		case "max":
			return m.effort_max();
	}
}

/** Stable select value for a provider-scoped model. */
export function modelSelectionKey(model: ModelSelection): string {
	return JSON.stringify([model.providerId, model.modelId]);
}

export function parseModelSelectionKey(value: string): ModelSelection | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === "string" &&
			typeof parsed[1] === "string"
		) {
			return { modelId: parsed[1], providerId: parsed[0] };
		}
	} catch {}
	return undefined;
}

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

			<div className="grid grid-cols-2 gap-2.5">
				<Field label={m.policy_active_burst_window()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.pacing.activeBurstWindowMs}
						onChange={(event) => updatePacing({ activeBurstWindowMs: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_narration_interval()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.pacing.narrationMinIntervalMs}
						onChange={(event) =>
							updatePacing({ narrationMinIntervalMs: Number(event.target.value) })
						}
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
					checked={draft.pacing.directFlushEnabled}
					label={m.policy_direct_flush()}
					onChange={(value) => updatePacing({ directFlushEnabled: value })}
				/>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.policy_direct_flush_hint()}
				</p>
				<Toggle
					checked={draft.pacing.narrationEnabled}
					label={m.policy_narration()}
					onChange={(value) => updatePacing({ narrationEnabled: value })}
				/>
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

export function PolicySidechatFields({
	draft,
	models = [],
	onChange,
}: PolicyFieldsProps & { models?: readonly ModelCatalogEntry[] }) {
	const updateSidechat = (patch: Partial<ConversationPolicy["sidechat"]>) => {
		onChange((current) => ({ ...current, sidechat: { ...current.sidechat, ...patch } }));
	};
	const selected = draft.sidechat.model ?? POLICY_DEFAULT_MODEL;
	const missing =
		draft.sidechat.model !== undefined &&
		draft.sidechat.model.length > 0 &&
		!models.some((model) => model.id === draft.sidechat.model);

	return (
		<>
			<Toggle
				checked={draft.sidechat.enabled}
				label={m.policy_sidechat_enabled()}
				onChange={(value) => updateSidechat({ enabled: value })}
			/>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_sidechat_hint()}</p>
			<Field label={m.policy_sidechat_model()} hint={m.policy_sidechat_model_hint()}>
				<Select
					value={selected}
					onValueChange={(value) =>
						updateSidechat({ model: value === POLICY_DEFAULT_MODEL ? undefined : value })
					}
				>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={m.policy_sidechat_model_default()} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={POLICY_DEFAULT_MODEL}>
							{m.policy_sidechat_model_default()}
						</SelectItem>
						{models.map((model) => (
							<SelectItem key={model.id} value={model.id}>
								{modelOptionLabel(model)}
							</SelectItem>
						))}
						{missing ? (
							<SelectItem value={draft.sidechat.model ?? ""}>
								{`${draft.sidechat.model} · ${m.policy_sidechat_model_unavailable()}`}
							</SelectItem>
						) : null}
					</SelectContent>
				</Select>
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

export function PolicyGenerationFields({ draft, onChange }: PolicyFieldsProps) {
	const updateGeneration = (patch: Partial<ConversationPolicy["generation"]>) => {
		onChange((current) => ({
			...current,
			generation: { ...current.generation, ...patch },
		}));
	};
	const updateOptionalNumber = (key: "temperature" | "topP", raw: string) => {
		onChange((current) => {
			const next = { ...current.generation };
			const parsed = raw.trim().length === 0 ? undefined : Number(raw);
			if (parsed === undefined || !Number.isFinite(parsed)) delete next[key];
			else next[key] = parsed;
			return { ...current, generation: next };
		});
	};
	return (
		<>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_generation_hint()}</p>
			<div className="grid grid-cols-2 gap-2.5">
				<Field label={m.policy_length_truncation()}>
					<select
						className={fieldClass}
						value={draft.generation.lengthTruncation}
						onChange={(event) =>
							updateGeneration({
								lengthTruncation: event.target
									.value as ConversationPolicy["generation"]["lengthTruncation"],
							})
						}
					>
						<option value="continue">{m.policy_length_truncation_continue()}</option>
						<option value="surface">{m.policy_length_truncation_surface()}</option>
					</select>
				</Field>
				<Field label={m.policy_max_length_continuations()}>
					<input
						type="number"
						min={0}
						max={3}
						className={fieldClass}
						value={draft.generation.maxLengthContinuations}
						onChange={(event) =>
							updateGeneration({ maxLengthContinuations: Number(event.target.value) })
						}
					/>
				</Field>
			</div>
			<div className="grid grid-cols-2 gap-2.5">
				<Field label={m.policy_temperature()}>
					<input
						type="number"
						min={0}
						max={2}
						step={0.05}
						className={fieldClass}
						value={draft.generation.temperature ?? ""}
						placeholder="0.7"
						onChange={(event) => updateOptionalNumber("temperature", event.target.value)}
					/>
				</Field>
				<Field label={m.policy_top_p()}>
					<input
						type="number"
						min={0.01}
						max={1}
						step={0.01}
						className={fieldClass}
						value={draft.generation.topP ?? ""}
						placeholder="1"
						onChange={(event) => updateOptionalNumber("topP", event.target.value)}
					/>
				</Field>
			</div>
			<Field label={m.policy_stop_sequences()} hint={m.policy_stop_sequences_hint()}>
				<textarea
					className={textareaClass}
					value={(draft.generation.stop ?? []).join("\n")}
					onChange={(event) => {
						const values = event.target.value
							.split(/\n/u)
							.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0)
							.slice(0, 4);
						updateGeneration({ stop: values.length === 0 ? undefined : values });
					}}
				/>
			</Field>
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

export function PolicyCrossSessionFields({ draft, onChange }: PolicyFieldsProps) {
	const updateCrossSession = (patch: Partial<ConversationPolicy["crossSession"]>) => {
		onChange((current) => ({
			...current,
			crossSession: { ...current.crossSession, ...patch },
		}));
	};
	return (
		<>
			<Toggle
				checked={draft.crossSession.enabled}
				label={m.policy_cross_session_enabled()}
				onChange={(value) => updateCrossSession({ enabled: value })}
			/>
			<p className="text-[11px] leading-4 text-muted-foreground">{m.policy_cross_session_hint()}</p>
			<div className="grid grid-cols-3 gap-2.5">
				<Field label={m.policy_cross_session_window()}>
					<input
						type="number"
						min={1}
						className={fieldClass}
						value={draft.crossSession.windowMinutes}
						onChange={(event) => updateCrossSession({ windowMinutes: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_cross_session_entries()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.crossSession.maxEntries}
						onChange={(event) => updateCrossSession({ maxEntries: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_cross_session_chars()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.crossSession.maxChars}
						onChange={(event) => updateCrossSession({ maxChars: Number(event.target.value) })}
					/>
				</Field>
			</div>
			<Field hint={m.policy_cross_session_private_hint()} label={m.policy_cross_session_private()}>
				<select
					className={fieldClass}
					value={draft.crossSession.privateToGroup}
					onChange={(event) =>
						updateCrossSession({
							privateToGroup: event.target
								.value as ConversationPolicy["crossSession"]["privateToGroup"],
						})
					}
				>
					<option value="none">{m.policy_cross_session_privacy_none()}</option>
					<option value="indicator">{m.policy_cross_session_privacy_indicator()}</option>
					<option value="text">{m.policy_cross_session_privacy_text()}</option>
				</select>
			</Field>
		</>
	);
}

export function PolicyMemoryConsolidationFields({ draft, onChange }: PolicyFieldsProps) {
	const updateConsolidation = (patch: Partial<ConversationPolicy["memoryConsolidation"]>) => {
		onChange((current) => ({
			...current,
			memoryConsolidation: { ...current.memoryConsolidation, ...patch },
		}));
	};
	return (
		<>
			<p className="text-[11px] leading-4 text-muted-foreground">
				{m.policy_memory_consolidation_hint()}
			</p>
			<div className="grid grid-cols-2 gap-2.5">
				<Field label={m.policy_memory_consolidation_idle()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.memoryConsolidation.idleMs}
						onChange={(event) => updateConsolidation({ idleMs: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_min_messages()}>
					<input
						type="number"
						min={1}
						className={fieldClass}
						value={draft.memoryConsolidation.minNewMessages}
						onChange={(event) =>
							updateConsolidation({ minNewMessages: Number(event.target.value) })
						}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_max_delay()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.memoryConsolidation.maxDelayMs}
						onChange={(event) => updateConsolidation({ maxDelayMs: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_batch()}>
					<input
						type="number"
						min={1}
						className={fieldClass}
						value={draft.memoryConsolidation.maxBatchMessages}
						onChange={(event) =>
							updateConsolidation({ maxBatchMessages: Number(event.target.value) })
						}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_failures()}>
					<input
						type="number"
						min={1}
						className={fieldClass}
						value={draft.memoryConsolidation.maxFailures}
						onChange={(event) => updateConsolidation({ maxFailures: Number(event.target.value) })}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_summary()}>
					<input
						type="number"
						min={100}
						className={fieldClass}
						value={draft.memoryConsolidation.summaryMaxChars}
						onChange={(event) =>
							updateConsolidation({ summaryMaxChars: Number(event.target.value) })
						}
					/>
				</Field>
				<Field label={m.policy_memory_consolidation_people()}>
					<input
						type="number"
						min={0}
						className={fieldClass}
						value={draft.memoryConsolidation.maxPersonCards}
						onChange={(event) =>
							updateConsolidation({ maxPersonCards: Number(event.target.value) })
						}
					/>
				</Field>
			</div>
			<Toggle
				checked={draft.memoryConsolidation.qaRecallEnabled}
				label={m.policy_memory_consolidation_qa()}
				onChange={(value) => updateConsolidation({ qaRecallEnabled: value })}
			/>
		</>
	);
}
