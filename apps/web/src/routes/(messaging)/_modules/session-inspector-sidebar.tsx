"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type {
	ConversationPolicy,
	ConversationPolicyView,
	PersonaSummary,
	SessionDetail,
	WorkspaceDetail,
} from "@tsukaima/contracts";
import { Button } from "@tsukaima/ui/components/motion/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tsukaima/ui/components/motion/tabs";
import { orpc } from "@/lib/api";
import { errorMessage, useToast } from "@/lib/toast";
import { m } from "@/paraglide/messages";
import { ContextPanel } from "./context-panel";
import { WorkspaceInspectorTabs } from "./workspace-inspector";
import { SessionCommandsView, type CommandFeedback } from "./session-commands-view";
import {
	PolicyPacingTabView,
	PolicyPersonaTabView,
	PolicyTriggerTabView,
	listValue,
	splitValue,
} from "./session-policy-tabs-view";

export type InspectorTab =
	| "context"
	| "commands"
	| "trigger"
	| "pacing"
	| "persona"
	| "todos"
	| "sessions"
	| "data";

const INSPECTOR_TAB_KEY = "tsukaima.webui.inspector-tab";

function isInspectorTab(value: string | null): value is InspectorTab {
	return (
		value === "context" ||
		value === "commands" ||
		value === "trigger" ||
		value === "pacing" ||
		value === "persona" ||
		value === "todos" ||
		value === "sessions" ||
		value === "data"
	);
}

export function storedInspectorTab(surface: "chat" | "workspace" = "chat"): InspectorTab {
	try {
		const raw = localStorage.getItem(`${INSPECTOR_TAB_KEY}.${surface}`);
		if (isInspectorTab(raw)) {
			if (surface === "workspace") {
				return raw === "todos" || raw === "sessions" || raw === "data" ? raw : "context";
			}
			return raw === "todos" || raw === "sessions" || raw === "data" ? "context" : raw;
		}
		return "context";
	} catch {
		return "context";
	}
}

export function SessionInspectorSidebar({
	activeTab,
	isRunning,
	onClose,
	onTabChange,
	session,
	surface = "chat",
	workspace,
}: {
	activeTab: InspectorTab;
	isRunning: boolean;
	onClose?: () => void;
	onTabChange: (tab: InspectorTab) => void;
	session: SessionDetail;
	surface?: "chat" | "workspace";
	workspace?: WorkspaceDetail | null;
}) {
	const sessionId = session.id;
	const toast = useToast();
	const queryClient = useQueryClient();

	const [compactResult, setCompactResult] = useState<CommandFeedback | undefined>();
	const [memoryCompactResult, setMemoryCompactResult] = useState<CommandFeedback | undefined>();
	const [abortResult, setAbortResult] = useState<string | undefined>();
	const [resetResult, setResetResult] = useState<string | undefined>();

	const [draft, setDraft] = useState<ConversationPolicy | undefined>();
	const [personaId, setPersonaId] = useState("");
	const [personaAliases, setPersonaAliases] = useState("");

	useEffect(() => {
		setCompactResult(undefined);
		setMemoryCompactResult(undefined);
		setAbortResult(undefined);
		setResetResult(undefined);
		setDraft(undefined);
		setPersonaId("");
		setPersonaAliases("");
	}, [sessionId]);

	const policyTabActive =
		activeTab === "trigger" || activeTab === "pacing" || activeTab === "persona";
	const personaTabActive = activeTab === "persona";

	const policy = useQuery({
		...orpc.admin.policies.get.queryOptions({ input: { conversationId: sessionId } }),
		enabled: policyTabActive,
	});
	const history = useQuery({
		...orpc.admin.policies.history.queryOptions({
			input: { conversationId: sessionId, scope: "conversation" },
		}),
		enabled: personaTabActive,
	});
	const personas = useQuery({
		...orpc.admin.personas.list.queryOptions(),
		enabled: personaTabActive,
	});
	const bindings = useQuery({
		...orpc.admin.personas.bindings.queryOptions(),
		enabled: personaTabActive,
	});
	// Shared with the settings page through the query cache; the catalog is admin-scoped.
	const settings = useQuery({
		...orpc.admin.settings.get.queryOptions(),
		enabled: policyTabActive,
	});

	useEffect(() => {
		if (policy.data !== undefined && draft === undefined) {
			setDraft(structuredClone(policy.data.policy));
		}
	}, [draft, policy.data]);

	useEffect(() => {
		if (!personaTabActive || personaId.length > 0 || bindings.data === undefined) return;
		const bound = bindings.data.find((binding) => binding.conversationId === sessionId);
		if (bound !== undefined) setPersonaId(bound.personaId);
	}, [bindings.data, personaId, personaTabActive, sessionId]);

	useEffect(() => {
		const selected = personas.data?.find((entry) => entry.id === personaId);
		setPersonaAliases(selected === undefined ? "" : listValue(selected.selfAliases));
	}, [personaId, personas.data]);

	const dirty =
		draft !== undefined &&
		policy.data !== undefined &&
		JSON.stringify(draft) !== JSON.stringify(policy.data.policy);

	const compactMutation = useMutation(
		orpc.admin.sessions.compact.mutationOptions({
			onError: (error) =>
				toast.error(m.command_compact_failed(), { description: errorMessage(error) }),
			onSuccess: async (result) => {
				const message = result.compacted ? m.command_compact_done() : m.command_compact_noop();
				setCompactResult({ message, tone: result.compacted ? "ok" : "neutral" });
				if (result.compacted) toast.success(message);
				else toast.info(message);
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.contextStats.key({ input: { sessionId } }),
					}),
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.messages.key({ input: { sessionId } }),
					}),
				]);
			},
		}),
	);

	const compactMemoriesMutation = useMutation(
		orpc.admin.memory.compact.mutationOptions({
			onError: (error) =>
				toast.error(m.command_memory_compact_failed(), { description: errorMessage(error) }),
			onSuccess: async (result) => {
				const message = result.created
					? `${m.command_memory_compact_done()}${result.memory ? ` · ${result.memory.summary}` : ""}`
					: m.command_memory_compact_noop();
				setMemoryCompactResult({ message, tone: result.created ? "ok" : "neutral" });
				if (result.created) toast.success(m.command_memory_compact_done());
				else toast.info(m.command_memory_compact_noop());
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.contextStats.key({ input: { sessionId } }),
					}),
					queryClient.invalidateQueries({ queryKey: orpc.admin.memory.key() }),
				]);
			},
		}),
	);

	const abortMutation = useMutation(
		orpc.admin.sessions.abort.mutationOptions({
			onError: (error) =>
				toast.error(m.command_abort_failed(), { description: errorMessage(error) }),
			onSuccess: async (result) => {
				const message = result.cancelledPendingOutput
					? m.command_abort_done_cancelled()
					: m.command_abort_done();
				setAbortResult(message);
				toast.success(message);
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.contextStats.key({ input: { sessionId } }),
					}),
					queryClient.invalidateQueries({
						queryKey: orpc.admin.sessions.messages.key({ input: { sessionId } }),
					}),
				]);
			},
		}),
	);

	const resetContextMutation = useMutation(
		orpc.admin.sessions.resetContext.mutationOptions({
			onError: (error) =>
				toast.error(m.command_reset_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				const message = m.command_reset_done();
				setResetResult(message);
				toast.success(message);
				await queryClient.invalidateQueries({
					queryKey: orpc.admin.sessions.contextStats.key({ input: { sessionId } }),
				});
			},
		}),
	);

	const updateSessionMutation = useMutation(
		orpc.admin.sessions.update.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_session_update_failed(), { description: errorMessage(error) }),
			onSuccess: async (_data, variables) => {
				if (variables.status === "archived") toast.success(m.toast_session_archived());
				else if (variables.status === "active") toast.success(m.toast_session_restored());
				else if (variables.title !== undefined) toast.success(m.toast_session_renamed());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);

	const setReceivingMutation = useMutation(
		orpc.admin.sessions.setReceiving.mutationOptions({
			onError: (error) =>
				toast.error(m.toast_receiving_update_failed(), { description: errorMessage(error) }),
			onSuccess: async () => {
				toast.success(m.toast_receiving_updated());
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.chats.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);

	const savePolicy = useMutation(
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

	const bindPersona = useMutation(
		orpc.admin.personas.bindPersona.mutationOptions({
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
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: orpc.admin.personas.key() }),
					queryClient.invalidateQueries({ queryKey: orpc.admin.sessions.key() }),
				]);
			},
		}),
	);

	const isExternal = session.chat.kind === "private" || session.chat.kind === "group";
	const archived = session.status === "archived";

	const handlePolicyChange = (updater: (current: ConversationPolicy) => ConversationPolicy) => {
		setDraft((current) => (current === undefined ? current : updater(current)));
	};

	const handleDiscardPolicy = () => {
		if (policy.data !== undefined) {
			setDraft(structuredClone(policy.data.policy));
		}
	};

	const handleSavePolicy = () => {
		if (draft === undefined) return;
		savePolicy.mutate({
			conversationId: sessionId,
			policy: draft,
			scope: "conversation",
		});
	};

	const selectedPersona = personas.data?.find((entry) => entry.id === personaId);

	if (surface === "workspace") {
		return (
			<WorkspaceInspectorTabs
				activeTab={activeTab}
				isRunning={isRunning}
				onClose={onClose}
				onTabChange={onTabChange}
				session={session}
				workspace={workspace}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-9 items-center justify-between gap-2 border-b border-border/60 px-3">
				<h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
					{m.inspector_title()}
				</h2>
				{onClose ? (
					<Button
						type="button"
						variant="ghost"
						size="iconSm"
						onClick={onClose}
						aria-label={m.inspector_close()}
						title={m.inspector_close()}
						className="size-6 rounded-md text-muted-foreground hover:text-foreground"
					>
						<X className="size-3" />
					</Button>
				) : null}
			</div>

			<Tabs
				variant="underline"
				value={activeTab}
				onValueChange={(value) => {
					if (isInspectorTab(value)) {
						onTabChange(value);
					}
				}}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="shrink-0 border-b border-border/70 px-1.5">
					<TabsList className="w-full justify-between gap-0">
						<TabsTrigger
							value="context"
							indicatorClassName="h-px"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.inspector_tab_context()}
						</TabsTrigger>
						<TabsTrigger
							value="commands"
							indicatorClassName="h-px"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							<span className="inline-flex items-center gap-1">
								{m.inspector_tab_commands()}
								{isRunning ? (
									<span
										aria-hidden="true"
										className="size-1.5 animate-pulse rounded-full bg-amber-500"
									/>
								) : null}
							</span>
						</TabsTrigger>
						<TabsTrigger
							value="trigger"
							indicatorClassName="h-px"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.inspector_tab_trigger()}
						</TabsTrigger>
						<TabsTrigger
							value="pacing"
							indicatorClassName="h-px"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.inspector_tab_pacing()}
						</TabsTrigger>
						<TabsTrigger
							value="persona"
							indicatorClassName="h-px"
							className="min-h-0 flex-1 justify-center px-0.5 pt-1 pb-1.5 text-[11px] font-normal"
						>
							{m.inspector_tab_persona()}
						</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent value="context" className="mt-0 flex min-h-0 flex-1 flex-col">
					<ContextPanel embedded enabled={activeTab === "context"} sessionId={sessionId} />
				</TabsContent>

				<TabsContent value="commands" className="mt-0 flex min-h-0 flex-1 flex-col">
					<SessionCommandsView
						abortResult={abortResult}
						aborting={abortMutation.isPending}
						archived={archived}
						compactResult={compactResult}
						compacting={compactMutation.isPending}
						compactingMemories={compactMemoriesMutation.isPending}
						isExternal={isExternal}
						isReceiving={session.isReceiving}
						isRunning={isRunning}
						memoryCompactResult={memoryCompactResult}
						onAbort={() => abortMutation.mutate({ sessionId })}
						onCompact={(instructions) => {
							const trimmed = instructions?.trim();
							compactMutation.mutate({
								...(trimmed !== undefined && trimmed.length > 0 ? { instructions: trimmed } : {}),
								sessionId,
							});
						}}
						onCompactMemories={() => compactMemoriesMutation.mutate({ conversationId: sessionId })}
						onRename={(title) => updateSessionMutation.mutate({ sessionId, title })}
						onResetContext={(handoff) => {
							const trimmed = handoff?.trim();
							resetContextMutation.mutate({
								...(trimmed !== undefined && trimmed.length > 0 ? { handoff: trimmed } : {}),
								sessionId,
							});
						}}
						onSetReceiving={() => setReceivingMutation.mutate({ sessionId })}
						onToggleArchive={() =>
							updateSessionMutation.mutate({
								sessionId,
								status: archived ? "active" : "archived",
							})
						}
						resetResult={resetResult}
						resetting={resetContextMutation.isPending}
						sessionTitle={session.title}
						updatingSession={updateSessionMutation.isPending || setReceivingMutation.isPending}
					/>
				</TabsContent>

				<TabsContent value="trigger" className="mt-0 flex min-h-0 flex-1 flex-col">
					<PolicyTriggerTabView
						dirty={dirty}
						draft={draft}
						errorMessage={policy.error ? errorMessage(policy.error) : undefined}
						isError={policy.isError}
						isPending={policy.isPending}
						onChange={handlePolicyChange}
						onDiscard={handleDiscardPolicy}
						onRetry={() => void policy.refetch()}
						onSave={handleSavePolicy}
						saving={savePolicy.isPending}
					/>
				</TabsContent>

				<TabsContent value="pacing" className="mt-0 flex min-h-0 flex-1 flex-col">
					<PolicyPacingTabView
						dirty={dirty}
						draft={draft}
						errorMessage={policy.error ? errorMessage(policy.error) : undefined}
						isError={policy.isError}
						isPending={policy.isPending}
						onChange={handlePolicyChange}
						onDiscard={handleDiscardPolicy}
						onRetry={() => void policy.refetch()}
						onSave={handleSavePolicy}
						saving={savePolicy.isPending}
						sidechatModels={settings.data?.models}
					/>
				</TabsContent>

				<TabsContent value="persona" className="mt-0 flex min-h-0 flex-1 flex-col">
					<PolicyPersonaTabView
						binding={bindPersona.isPending}
						errorMessage={personas.error ? errorMessage(personas.error) : undefined}
						history={history.data}
						isError={personas.isError}
						isPending={personas.isPending}
						onBindPersona={() =>
							bindPersona.mutate({
								conversationId: sessionId,
								personaId,
								scope: "conversation",
							})
						}
						onChangePersonaAliases={setPersonaAliases}
						onChangePersonaId={setPersonaId}
						onRetry={() => {
							void personas.refetch();
							void history.refetch();
						}}
						onSavePersona={() => {
							if (selectedPersona === undefined) return;
							savePersona.mutate({
								id: selectedPersona.id,
								name: selectedPersona.name,
								prompt: selectedPersona.prompt,
								selfAliases: splitValue(personaAliases),
								summary: selectedPersona.summary,
							});
						}}
						personaAliases={personaAliases}
						personaId={personaId}
						personas={personas.data ?? []}
						savingPersona={savePersona.isPending}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
