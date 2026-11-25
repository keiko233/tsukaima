"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { type ConversationPolicy, defaultConversationPolicy } from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { EditorialGroup } from "@tsukaima/ui";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import {
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
} from "../../_modules/policy/conversation-policy-fields";
import { toPolicyPatch } from "../../_modules/policy/policy-patch";
import { InlineError } from "../../_modules/shell/primitives";
import { Modal, ModalActions } from "../../_modules/ui/modal";

function PolicySection({
	children,
	id,
	onReset,
	title,
}: {
	children: ReactNode;
	id: string;
	onReset: () => void;
	title: string;
}) {
	return (
		<div id={id} tabIndex={-1} className="scroll-mt-16">
			<EditorialGroup
				title={title}
				actions={
					<Button type="button" variant="ghost" size="xs" onClick={onReset}>
						{m.settings_policy_defaults_reset_section()}
					</Button>
				}
			>
				<div className="space-y-3">{children}</div>
			</EditorialGroup>
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
			<EditorialGroup title={m.settings_policy_defaults_title()}>
				<InlineError
					message={policyQuery.error.message}
					onRetry={() => void policyQuery.refetch()}
					retryLabel={m.retry()}
				/>
			</EditorialGroup>
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
			sandboxWorkspaceEnabled: defaultConversationPolicy.sandboxWorkspaceEnabled,
			workspaceDelegationEnabled: false,
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
	const resetCrossSession = () =>
		change((current) => ({
			...current,
			crossSession: structuredClone(defaultConversationPolicy.crossSession),
		}));
	const resetMemoryConsolidation = () =>
		change((current) => ({
			...current,
			memoryConsolidation: structuredClone(defaultConversationPolicy.memoryConsolidation),
		}));
	const resetSocial = () =>
		change((current) => ({
			...current,
			social: structuredClone(defaultConversationPolicy.social),
		}));
	const resetHumanization = () =>
		change((current) => ({
			...current,
			humanization: structuredClone(defaultConversationPolicy.humanization),
		}));
	const resetGate = () =>
		change((current) => ({
			...current,
			gate: structuredClone(defaultConversationPolicy.gate),
		}));
	const resetGeneration = () =>
		change((current) => ({
			...current,
			generation: structuredClone(defaultConversationPolicy.generation),
		}));

	const sections = [
		{ id: "policy-pacing", label: m.policy_section_pacing() },
		{ id: "policy-sidechat", label: m.policy_section_sidechat() },
		{ id: "policy-generation", label: m.policy_section_generation() },
		{ id: "policy-compaction", label: m.policy_section_compaction() },
		{ id: "policy-cross-session", label: m.policy_section_cross_session() },
		{ id: "policy-memory-consolidation", label: m.policy_section_memory_consolidation() },
		{ id: "policy-social", label: m.policy_section_social() },
		{ id: "policy-humanization", label: m.policy_section_humanization() },
		{ id: "policy-gate", label: m.policy_section_gate() },
	];

	const save = () => {
		if (draft === undefined) return;
		savePolicy.mutate({ policy: toPolicyPatch(draft), scope: "global" });
	};

	const overrideEveryConversation = () => {
		if (draft === undefined) return;
		overrideAll.mutate({ policy: toPolicyPatch(draft) });
	};

	return (
		<section aria-labelledby="policy-defaults-title" className="space-y-5">
			<header>
				<h2 id="policy-defaults-title" className="font-serif text-xl">
					{m.settings_policy_defaults_title()}
				</h2>
				<p className="text-xs text-muted-foreground">{m.settings_policy_defaults_description()}</p>
			</header>

			{policyQuery.isPending || draft === undefined ? (
				<div className="py-4 text-center text-[11px] text-muted-foreground">
					{m.policy_loading()}
				</div>
			) : (
				<>
					<nav
						aria-label={m.settings_policy_jump_to()}
						className="sticky top-0 z-10 flex gap-4 overflow-x-auto border-b border-border bg-background py-3"
					>
						{sections.map(({ id, label }) => (
							<a
								key={id}
								href={`#${id}`}
								className="shrink-0 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								{label}
							</a>
						))}
					</nav>
					<PolicySection id="policy-pacing" onReset={resetPacing} title={m.policy_section_pacing()}>
						<PolicyPacingFields draft={draft} onChange={change} />
						<PolicyWorkspaceDelegationField draft={draft} onChange={change} />
						<PolicySandboxWorkspaceField draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection
						id="policy-sidechat"
						onReset={resetSidechat}
						title={m.policy_section_sidechat()}
					>
						<PolicySidechatFields
							draft={draft}
							models={settingsQuery.data?.models}
							onChange={change}
						/>
					</PolicySection>

					<PolicySection
						id="policy-generation"
						onReset={resetGeneration}
						title={m.policy_section_generation()}
					>
						<PolicyGenerationFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection
						id="policy-compaction"
						onReset={resetCompaction}
						title={m.policy_section_compaction()}
					>
						<PolicyCompactionFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection
						id="policy-cross-session"
						onReset={resetCrossSession}
						title={m.policy_section_cross_session()}
					>
						<PolicyCrossSessionFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection
						id="policy-memory-consolidation"
						onReset={resetMemoryConsolidation}
						title={m.policy_section_memory_consolidation()}
					>
						<PolicyMemoryConsolidationFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection id="policy-social" onReset={resetSocial} title={m.policy_section_social()}>
						<PolicySocialFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection
						id="policy-humanization"
						onReset={resetHumanization}
						title={m.policy_section_humanization()}
					>
						<PolicyHumanizationFields draft={draft} onChange={change} />
					</PolicySection>

					<PolicySection id="policy-gate" onReset={resetGate} title={m.policy_section_gate()}>
						<PolicyGateFields draft={draft} onChange={change} />
					</PolicySection>

					<div
						className={`flex flex-wrap items-center justify-between gap-2 border-t border-border py-3 ${dirty ? "sticky bottom-0 z-10 bg-background" : ""}`}
					>
						<span className="text-[11px] text-muted-foreground">
							{dirty ? m.settings_unsaved_changes() : sourceLabel}
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
		</section>
	);
}
