"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ModelCatalogEntry, ModelSelection, ThinkingLevel } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@tsukaima/ui/components/motion/select";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import {
	Field,
	modelOptionLabel,
	modelSelectionKey,
	parseModelSelectionKey,
	THINKING_LEVELS,
	thinkingLevelLabel,
} from "../../_modules/policy/conversation-policy-fields";
import { InlineError } from "../../_modules/shell/primitives";

const INHERIT = "__inherit__";

function sameModel(a: ModelSelection | undefined, b: ModelSelection | undefined): boolean {
	return a?.providerId === b?.providerId && a?.modelId === b?.modelId;
}

function modelByRef(
	models: readonly ModelCatalogEntry[],
	ref: ModelSelection | undefined,
): ModelCatalogEntry | undefined {
	if (ref === undefined) return undefined;
	return models.find((model) => model.id === ref.modelId && model.providerId === ref.providerId);
}

export function SessionModelView({
	sessionId,
	surface,
}: {
	sessionId: string;
	surface: "chat" | "workspace";
}) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const policy = useQuery(
		orpc.admin.policies.get.queryOptions({ input: { conversationId: sessionId } }),
	);
	const settings = useQuery(orpc.admin.settings.get.queryOptions());
	const [modelDraft, setModelDraft] = useState<string>(INHERIT);
	const [thinkingDraft, setThinkingDraft] = useState<string>(INHERIT);

	useEffect(() => {
		setModelDraft(INHERIT);
		setThinkingDraft(INHERIT);
	}, [sessionId]);

	useEffect(() => {
		if (policy.data === undefined) return;
		setModelDraft(
			policy.data.policy.model === undefined
				? INHERIT
				: modelSelectionKey(policy.data.policy.model),
		);
		setThinkingDraft(policy.data.policy.thinking ?? INHERIT);
	}, [policy.data]);

	const save = useMutation(
		orpc.admin.policies.update.mutationOptions({
			onError: (error) => toast.error(m.model_save_failed(), { description: errorMessage(error) }),
			onSuccess: async (view) => {
				setModelDraft(
					view.policy.model === undefined ? INHERIT : modelSelectionKey(view.policy.model),
				);
				setThinkingDraft(view.policy.thinking ?? INHERIT);
				toast.success(m.model_saved());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.policies.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);

	if (policy.isError) {
		return (
			<div className="px-3 py-4">
				<InlineError
					message={errorMessage(policy.error)}
					onRetry={() => void policy.refetch()}
					retryLabel={m.retry()}
				/>
			</div>
		);
	}

	if (policy.isPending || policy.data === undefined) {
		return (
			<div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
				{m.policy_loading()}
			</div>
		);
	}

	const models = settings.data?.availableModels ?? [];
	const defaultModel =
		surface === "workspace" ? settings.data?.workspaceModel : settings.data?.chatModel;
	const defaultThinking =
		surface === "workspace" ? settings.data?.workspaceThinking : settings.data?.chatThinking;
	const draftModel = modelDraft === INHERIT ? undefined : parseModelSelectionKey(modelDraft);
	const draftThinking = thinkingDraft === INHERIT ? undefined : (thinkingDraft as ThinkingLevel);
	const selectedModel = modelByRef(models, draftModel);
	const effectiveModel = draftModel ?? defaultModel;
	const effectiveModelEntry = modelByRef(models, effectiveModel);
	const effortLevels =
		effectiveModelEntry?.reasoning?.levels === undefined ||
		effectiveModelEntry.reasoning.levels.length === 0
			? THINKING_LEVELS
			: effectiveModelEntry.reasoning.levels;
	const dirty =
		!sameModel(draftModel, policy.data.policy.model) ||
		(draftThinking ?? undefined) !== (policy.data.policy.thinking ?? undefined);
	const defaultModelLabel =
		defaultModel === undefined
			? m.model_active_default()
			: `${modelByRef(models, defaultModel)?.name ?? defaultModel.modelId} · ${defaultModel.providerId}`;
	const defaultEffortLabel =
		defaultThinking === undefined ? m.effort_default() : thinkingLevelLabel(defaultThinking);
	const missingSelectedModel =
		draftModel !== undefined && selectedModel === undefined && modelDraft.length > 0;
	const missingSelectedEffort =
		draftThinking !== undefined && !effortLevels.includes(draftThinking);

	const saveModel = () => {
		save.mutate({
			conversationId: sessionId,
			policy: {
				model: draftModel ?? null,
				thinking: draftThinking ?? null,
			},
			scope: "conversation",
		});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pt-2.5 pb-3">
				<div className="space-y-0.5">
					<h3 className="text-xs font-semibold text-foreground">{m.model_section_title()}</h3>
					<p className="text-[11px] leading-4 text-muted-foreground">
						{m.model_section_description()}
					</p>
				</div>

				<Field
					hint={`${m.model_default_hint()}: ${defaultModelLabel}`}
					label={m.model_choice_label()}
				>
					<Select
						value={modelDraft}
						disabled={save.isPending}
						onValueChange={(value) => setModelDraft(value)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>{m.model_choice_inherit()}</SelectItem>
							{models.map((model) => (
								<SelectItem
									key={`${model.providerId}:${model.id}`}
									value={modelSelectionKey({
										modelId: model.id,
										providerId: model.providerId,
									})}
								>
									{modelOptionLabel(model)}
								</SelectItem>
							))}
							{missingSelectedModel ? (
								<SelectItem value={modelDraft}>
									{draftModel?.providerId} / {draftModel?.modelId} · {m.model_choice_unavailable()}
								</SelectItem>
							) : null}
						</SelectContent>
					</Select>
				</Field>
				{models.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">{m.model_choice_empty()}</p>
				) : null}

				<Field
					hint={`${m.model_effort_default_hint()}: ${defaultEffortLabel}`}
					label={m.model_effort_label()}
				>
					<Select
						value={thinkingDraft}
						disabled={save.isPending}
						onValueChange={(value) => setThinkingDraft(value)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={INHERIT}>{m.effort_default()}</SelectItem>
							{effortLevels.map((level) => (
								<SelectItem key={level} value={level}>
									{thinkingLevelLabel(level)}
								</SelectItem>
							))}
							{missingSelectedEffort && draftThinking !== undefined ? (
								<SelectItem value={draftThinking}>
									{thinkingLevelLabel(draftThinking)} · {m.model_choice_unavailable()}
								</SelectItem>
							) : null}
						</SelectContent>
					</Select>
				</Field>
			</div>
			<div className="shrink-0 border-t border-border/70 bg-background/80 px-3 py-2">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] text-muted-foreground">
						{dirty ? m.policy_unsaved() : ""}
					</span>
					<div className="flex items-center gap-1.5">
						{dirty ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={save.isPending}
								onClick={() => {
									setModelDraft(
										policy.data.policy.model === undefined
											? INHERIT
											: modelSelectionKey(policy.data.policy.model),
									);
									setThinkingDraft(policy.data.policy.thinking ?? INHERIT);
								}}
							>
								{m.policy_reset_draft()}
							</Button>
						) : null}
						<Button type="button" size="sm" disabled={save.isPending} onClick={saveModel}>
							{m.policy_save()}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
