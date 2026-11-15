"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type ConversationPolicy, defaultConversationPolicy } from "@elaina/contracts";
import { Button } from "@elaina/ui/components/motion/button";
import { Card, CardContent, CardHeader, CardTitle } from "@elaina/ui/components/motion/card";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import {
	PolicyCompactionFields,
	PolicyPacingFields,
	PolicySidechatFields,
} from "../../_modules/policy/conversation-policy-fields";
import { InlineError } from "../../_modules/shell/primitives";
import { Modal, ModalActions } from "../../_modules/ui/modal";

function SectionHeader({ onReset, title }: { onReset: () => void; title: string }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<h3 className="text-xs font-semibold text-foreground">{title}</h3>
			<Button type="button" variant="ghost" size="xs" onClick={onReset}>
				{m.settings_policy_defaults_reset_section()}
			</Button>
		</div>
	);
}

export function PolicyDefaultsCard() {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<ConversationPolicy | undefined>();
	const [overrideOpen, setOverrideOpen] = useState(false);
	const policyQuery = useQuery(orpc.admin.policies.get.queryOptions());
	// Same cache entry as the settings page query, so opening both costs one request.
	const settingsQuery = useQuery(orpc.admin.settings.get.queryOptions());
	const overrideAll = useMutation(
		orpc.admin.policies.overrideAll.mutationOptions({
			onError: (error) =>
				toast.error(m.settings_policy_override_all_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async (result) => {
				setDraft(structuredClone(result.view.policy));
				setOverrideOpen(false);
				toast.success(m.settings_policy_override_all_done({ count: String(result.updated) }));
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.policies.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);
	const savePolicy = useMutation(
		orpc.admin.policies.update.mutationOptions({
			onError: (error) =>
				toast.error(m.settings_policy_defaults_save_failed(), {
					description: errorMessage(error),
				}),
			onSuccess: async (view) => {
				setDraft(structuredClone(view.policy));
				toast.success(m.settings_policy_defaults_saved());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.policies.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);

	useEffect(() => {
		if (policyQuery.data !== undefined && draft === undefined) {
			setDraft(structuredClone(policyQuery.data.policy));
		}
	}, [draft, policyQuery.data]);

	if (policyQuery.isError) {
		return (
			<Card size="compact">
				<CardHeader>
					<CardTitle as="h2">{m.settings_policy_defaults_title()}</CardTitle>
				</CardHeader>
				<CardContent>
					<InlineError
						message={policyQuery.error.message}
						onRetry={() => void policyQuery.refetch()}
						retryLabel={m.retry()}
					/>
				</CardContent>
			</Card>
		);
	}

	const dirty =
		draft !== undefined &&
		policyQuery.data !== undefined &&
		JSON.stringify(draft) !== JSON.stringify(policyQuery.data.policy);
	const sourceLabel =
		policyQuery.data?.source.scope === "global"
			? m.settings_policy_defaults_source_global()
			: m.settings_policy_defaults_source_default();

	const change = (updater: (current: ConversationPolicy) => ConversationPolicy) => {
		setDraft((current) => (current === undefined ? current : updater(current)));
	};

	const resetPacing = () =>
		change((current) => ({
			...current,
			pacing: structuredClone(defaultConversationPolicy.pacing),
		}));
	const resetSidechat = () =>
		change((current) => ({
			...current,
			sidechat: structuredClone(defaultConversationPolicy.sidechat),
		}));
	const resetCompaction = () =>
		change((current) => ({
			...current,
			compaction: structuredClone(defaultConversationPolicy.compaction),
		}));

	const save = () => {
		if (draft === undefined) return;
		savePolicy.mutate({ policy: draft, scope: "global" });
	};

	const overrideEveryConversation = () => {
		if (draft === undefined) return;
		overrideAll.mutate({ policy: draft });
	};

	return (
		<Card size="compact">
			<CardHeader>
				<CardTitle as="h2">{m.settings_policy_defaults_title()}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.settings_policy_defaults_description()}
				</p>

				{policyQuery.isPending || draft === undefined ? (
					<div className="py-4 text-center text-[11px] text-muted-foreground">
						{m.policy_loading()}
					</div>
				) : (
					<>
						<section className="space-y-2.5">
							<SectionHeader onReset={resetPacing} title={m.policy_section_pacing()} />
							<PolicyPacingFields draft={draft} onChange={change} />
						</section>

						<section className="space-y-2.5 border-t border-border/60 pt-3">
							<SectionHeader onReset={resetSidechat} title={m.policy_section_sidechat()} />
							<PolicySidechatFields
								draft={draft}
								models={settingsQuery.data?.models}
								onChange={change}
							/>
						</section>

						<section className="space-y-2.5 border-t border-border/60 pt-3">
							<SectionHeader onReset={resetCompaction} title={m.policy_section_compaction()} />
							<PolicyCompactionFields draft={draft} onChange={change} />
						</section>

						<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
							<span className="text-[11px] text-muted-foreground">
								{dirty ? m.policy_unsaved() : sourceLabel}
							</span>
							<div className="flex flex-wrap items-center justify-end gap-1.5">
								{dirty ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={savePolicy.isPending || overrideAll.isPending}
										onClick={() => {
											if (policyQuery.data !== undefined) {
												setDraft(structuredClone(policyQuery.data.policy));
											}
										}}
									>
										{m.policy_reset_draft()}
									</Button>
								) : null}
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={savePolicy.isPending || overrideAll.isPending}
									onClick={() => setOverrideOpen(true)}
								>
									{m.settings_policy_override_all()}
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={!dirty || savePolicy.isPending || overrideAll.isPending}
									loading={savePolicy.isPending}
									onClick={save}
								>
									{m.settings_policy_defaults_save()}
								</Button>
							</div>
						</div>
					</>
				)}
			</CardContent>

			<Modal
				open={overrideOpen}
				onOpenChange={setOverrideOpen}
				title={m.settings_policy_override_all_title()}
				description={m.settings_policy_override_all_description()}
			>
				<p className="text-[11px] leading-4 text-muted-foreground">
					{m.settings_policy_override_all_warning()}
				</p>
				<ModalActions>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={overrideAll.isPending}
						onClick={() => setOverrideOpen(false)}
					>
						{m.cancel()}
					</Button>
					<Button
						type="button"
						variant="danger"
						size="sm"
						loading={overrideAll.isPending}
						onClick={overrideEveryConversation}
					>
						{m.settings_policy_override_all_action()}
					</Button>
				</ModalActions>
			</Modal>
		</Card>
	);
}
