import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	defaultConversationPolicy,
	type PersonaSummary,
	type PolicyRevision,
	type SessionContextStats,
} from "@elaina/contracts";

mock.module("@/paraglide/messages", () => ({
	m: {
		access_allowlist: () => "Allowlist only",
		access_disabled: () => "Disabled",
		access_open: () => "Open",
		archive: () => "Archive",
		cancel: () => "Cancel",
		command_abort_action: () => "Stop run",
		command_abort_description: () =>
			"Abort an active reply, clear queued inputs, and cancel pending delayed outbound messages.",
		command_abort_running: () => "Stopping…",
		command_abort_title: () => "Stop current run",
		command_archive_receiving_hint: () => "Select another receiving session before archiving.",
		command_compact_action: () => "Compact now",
		command_compact_description: () =>
			"Summarize older model turns into a compact summary while keeping recent turns and full chat history.",
		command_compact_instructions_placeholder: () =>
			"Optional focus instructions (e.g. keep task progress)",
		command_compact_running: () => "Compacting…",
		command_compact_title: () => "Compact context",
		command_memory_compact_action: () => "Compact memories",
		command_memory_compact_description: () =>
			"Extract and merge recent turns in this session into durable memory records.",
		command_memory_compact_running: () => "Summarizing…",
		command_memory_compact_title: () => "Compact memories",
		command_rename_action: () => "Save name",
		command_rename_label: () => "Session name",
		command_reset_action: () => "Reset context",
		command_reset_confirm_action: () => "Confirm reset",
		command_reset_confirm_prompt: () =>
			"Start a fresh model context? Older turns will no longer be sent to the model.",
		command_reset_description: () =>
			"Start a clean model context window from this point forward. Chat messages in the UI are preserved.",
		command_reset_handoff_placeholder: () => "Optional handoff note for the new context",
		command_reset_running: () => "Resetting…",
		command_reset_title: () => "Reset model context",
		command_section_hint: () =>
			"Slash commands are disabled in chat; run session operations directly here.",
		command_section_title: () => "Session commands",
		command_session_title: () => "Session controls",
		command_status_active: () => "Running",
		command_status_idle: () => "Idle",
		context_autocompact_buffer: () => "Autocompact buffer",
		context_category_memories: () => "Memories",
		context_category_messages: () => "Messages",
		context_category_other_system: () => "Other system",
		context_category_persona: () => "Persona",
		context_category_policy: () => "Policy",
		context_category_tools: () => "System tools",
		context_category_tools_deferred: () => "System tools (deferred)",
		context_close: () => "Close context panel",
		context_compacted_badge: () => "Compacted",
		context_empty: () => "No context data available for this session.",
		context_free_space: () => "Free space",
		context_group_memories: () => "Memories",
		context_group_sections: () => "System sections",
		context_group_tools: () => "System tools",
		context_memories_disabled: () => "Memory recall is disabled by policy.",
		context_memories_empty: () => "No memories injected into this turn.",
		context_memories_long_term: () => "Long-term",
		context_memories_recent: () => "Recent",
		context_memories_warm: () => "Warm",
		context_memories_warm_topics: ({ topics }: { topics: string }) => `Topics: ${topics}`,
		context_message_count: ({ count }: { count: string }) => `${count} messages`,
		context_refresh: () => "Refresh context stats",
		context_section_instructions: () => "Instructions",
		context_section_memories: () => "Memories",
		context_section_persona: () => "Persona",
		context_section_policy: () => "Policy",
		context_section_system: () => "Base system",
		context_source_estimated: () => "Estimated",
		context_source_usage: () => "Measured",
		context_title: () => "Context",
		context_tool_deferred_badge: () => "deferred",
		context_tools_empty: () => "No tools registered.",
		context_used_headline: ({ percent }: { percent: string }) => `${percent} used`,
		context_window_unknown: () => "Unknown window",
		error_generic: () => "Something went wrong.",
		loading: () => "Loading…",
		media_ignore: () => "Ignore",
		media_lurk: () => "Lurk quietly",
		media_text_only: () => "Store as context only",
		media_wake: () => "Wake",
		mention_always: () => "Always respond to mentions",
		mention_disabled: () => "Disabled",
		mention_smart: () => "Smart participation",
		policy_allowed_tools: () => "Allowed tools",
		policy_allowed_tools_hint: () =>
			"Leave blank to allow every tool. Comma or newline separated names filter the tool list.",
		policy_allowlist: () => "Allowlist IDs",
		policy_allowlist_hint: () => "Comma or newline separated user, group, or chat IDs.",
		policy_bind_persona: () => "Bind to this conversation",
		policy_burst_max_messages: () => "Max burst messages",
		policy_burst_max_wait: () => "Max wait (ms)",
		policy_burst_settle: () => "Settle window (ms)",
		policy_cooldown: () => "Reply cooldown (ms)",
		policy_description: () =>
			"Control when this conversation responds, how it aggregates bursts, and how replies are paced. Changes create a new audited policy revision.",
		policy_group_access: () => "Group access",
		policy_group_mentions: () => "Group mentions",
		policy_history: () => "Policy history",
		policy_history_empty: () => "No policy revisions yet.",
		policy_image_only: () => "Image-only messages",
		policy_keywords: () => "Wake keywords",
		policy_keywords_hint: () => "A matching keyword counts as a direct address.",
		policy_loading: () => "Loading policy…",
		policy_long_message: () => "Long-message threshold",
		policy_max_immediate: () => "Max immediate messages",
		policy_no_persona: () => "No persona selected",
		policy_peer_bots: () => "Peer bot IDs",
		policy_persona: () => "Persona",
		policy_persona_aliases: () => "Persona self aliases",
		policy_private_access: () => "Private access",
		policy_quiet_end: () => "Quiet end hour",
		policy_quiet_hours: () => "Quiet hours",
		policy_quiet_start: () => "Quiet start hour",
		policy_rate_limit: () => "Max replies per minute",
		policy_reply_delay: () => "Bounded reply delay",
		policy_reply_delay_max: () => "Reply delay limit (ms)",
		policy_reply_to_bot: () => "Replying to the bot counts as direct",
		policy_reset_draft: () => "Discard",
		policy_revision_active: () => "Active",
		policy_save: () => "Save policy",
		policy_save_persona: () => "Save persona aliases",
		policy_section_pacing: () => "Aggregation and pacing",
		policy_section_persona: () => "Persona binding",
		policy_section_trigger: () => "Trigger and access rules",
		policy_self_aliases: () => "Self aliases",
		policy_self_aliases_hint: () => "Names that count as addressing Elaina without an @ mention.",
		policy_send_interval: () => "Send interval (ms)",
		policy_sticker_only: () => "Sticker-only messages",
		policy_strip_markdown: () => "Strip Markdown from replies",
		policy_typing: () => "Show typing indicator",
		policy_unsaved: () => "Unsaved changes",
		policy_version: ({ version }: { version: number }) => `Version ${version}`,
		restore: () => "Restore",
		retry: () => "Retry",
		set_receiving: () => "Use for new external messages",
	},
}));

const { ContextPanelContent } = await import("./context-panel-view");
const { SessionCommandsView } = await import("./session-commands-view");
const {
	PolicyPacingTabView,
	PolicyPersonaTabView,
	PolicyTriggerTabView,
	listValue,
	splitValue,
} = await import("./session-policy-tabs-view");

const noop = () => {};

const sampleStats: SessionContextStats = {
	autocompact: {
		backgroundTokens: 20_000,
		bufferTokens: 33_000,
		enabled: true,
		keepRecentTokens: 16_000,
	},
	categories: {
		memoriesTokens: 4_500,
		messagesTokens: 138_300,
		otherSystemTokens: 239,
		personaTokens: 11_300,
		policyTokens: 6_100,
		toolsTokens: 18_700,
	},
	compacted: false,
	contextWindow: 1_000_000,
	deferredToolsTokens: 0,
	freeSpaceTokens: 787_861,
	measuredUsageTokens: 179_139,
	memories: {
		enabled: true,
		items: [],
		recentCount: 0,
		warmTopics: [],
	},
	messageCount: 12,
	model: {
		modelId: "claude-sonnet-4",
		providerId: "anthropic",
	},
	personaName: "Elaina",
	sections: [],
	tokenSource: "usage",
	tools: [],
	usedPercent: 17.9139,
	usedTokens: 179_139,
};

const samplePersona: PersonaSummary = {
	createdAt: "2026-11-14T10:00:00.000Z",
	id: "persona-elaina",
	isActive: true,
	name: "Elaina",
	prompt: "Ashen Witch",
	selfAliases: ["Elaina", "伊蕾娜"],
	summary: "Main persona",
	version: 3,
};

const sampleRevisions: PolicyRevision[] = [
	{
		conversationId: "session-1",
		createdAt: "2026-11-14T12:00:00.000Z",
		id: "rev-1",
		isActive: true,
		policy: { ...defaultConversationPolicy, version: 2 },
		scope: "conversation",
		updatedAt: "2026-11-14T12:00:00.000Z",
	},
];

describe("SessionInspectorSidebar views", () => {
	test("listValue and splitValue round-trip comma and newline lists", () => {
		expect(listValue(["1001", "1002"])).toBe("1001, 1002");
		expect(splitValue("1001, 1002\n 1003 , ")).toEqual(["1001", "1002", "1003"]);
	});

	test("SessionCommandsView renders active status, command cards, feedback, and external controls", () => {
		const html = renderToStaticMarkup(
			<SessionCommandsView
				abortResult="Run aborted"
				archived={false}
				compactResult={{ message: "Context compacted", tone: "ok" }}
				isExternal
				isReceiving={false}
				isRunning
				memoryCompactResult={{ message: "No new memories to extract.", tone: "neutral" }}
				onAbort={noop}
				onCompact={noop}
				onCompactMemories={noop}
				onRename={noop}
				onResetContext={noop}
				onSetReceiving={noop}
				onToggleArchive={noop}
				resetResult="Model context reset"
				sessionTitle="Main group"
			/>,
		);

		expect(html).toContain("Session commands");
		expect(html).toContain("Running");
		expect(html).toContain("Compact context");
		expect(html).toContain("Compact now");
		expect(html).toContain("Context compacted");
		expect(html).toContain("Compact memories");
		expect(html).toContain("No new memories to extract.");
		expect(html).toContain("Stop current run");
		expect(html).toContain("Stop run");
		expect(html).toContain("Run aborted");
		expect(html).toContain("Reset model context");
		expect(html).toContain("Model context reset");
		expect(html).toContain("Main group");
		expect(html).toContain("Use for new external messages");
		expect(html).toContain("Archive");
	});

	test("SessionCommandsView shows archive block hint on active receiving external session", () => {
		const html = renderToStaticMarkup(
			<SessionCommandsView
				archived={false}
				isExternal
				isReceiving
				isRunning={false}
				onAbort={noop}
				onCompact={noop}
				onCompactMemories={noop}
				onRename={noop}
				onResetContext={noop}
				onSetReceiving={noop}
				onToggleArchive={noop}
				sessionTitle="Receiving session"
			/>,
		);

		expect(html).toContain("Idle");
		expect(html).not.toContain("Use for new external messages");
		expect(html).toContain("Select another receiving session before archiving.");
	});

	test("PolicyTriggerTabView renders trigger controls and dirty footer", () => {
		const html = renderToStaticMarkup(
			<PolicyTriggerTabView
				dirty
				draft={defaultConversationPolicy}
				onChange={noop}
				onDiscard={noop}
				onRetry={noop}
				onSave={noop}
			/>,
		);

		expect(html).toContain("Trigger and access rules");
		expect(html).toContain("Private access");
		expect(html).toContain("Group access");
		expect(html).toContain("Group mentions");
		expect(html).toContain("Sticker-only messages");
		expect(html).toContain("Image-only messages");
		expect(html).toContain("Allowlist IDs");
		expect(html).toContain("Wake keywords");
		expect(html).toContain("Self aliases");
		expect(html).toContain("Peer bot IDs");
		expect(html).toContain("Unsaved changes");
		expect(html).toContain("Discard");
		expect(html).toContain("Save policy");
	});

	test("PolicyPacingTabView renders burst, cooldown, quiet hours, and tool filters", () => {
		const html = renderToStaticMarkup(
			<PolicyPacingTabView
				dirty={false}
				draft={defaultConversationPolicy}
				onChange={noop}
				onDiscard={noop}
				onRetry={noop}
				onSave={noop}
			/>,
		);

		expect(html).toContain("Aggregation and pacing");
		expect(html).toContain("Settle window (ms)");
		expect(html).toContain("Max burst messages");
		expect(html).toContain("Quiet hours");
		expect(html).toContain("Allowed tools");
		expect(html).not.toContain("Unsaved changes");
	});

	test("PolicyPersonaTabView renders persona binding and policy revision history", () => {
		const html = renderToStaticMarkup(
			<PolicyPersonaTabView
				history={sampleRevisions}
				onBindPersona={noop}
				onChangePersonaAliases={noop}
				onChangePersonaId={noop}
				onRetry={noop}
				onSavePersona={noop}
				personaAliases="Elaina, 伊蕾娜"
				personaId={samplePersona.id}
				personas={[samplePersona]}
			/>,
		);

		expect(html).toContain("Persona binding");
		expect(html).toContain("Elaina · v3");
		expect(html).toContain("Save persona aliases");
		expect(html).toContain("Bind to this conversation");
		expect(html).toContain("Policy history");
		expect(html).toContain("Version 2");
		expect(html).toContain("Active");
	});

	test("ContextPanelContent omits outer header when embedded inside inspector tab", () => {
		const html = renderToStaticMarkup(
			<ContextPanelContent embedded onClose={noop} onRefresh={noop} stats={sampleStats} />,
		);

		expect(html).not.toContain("Close context panel");
		expect(html).toContain("Refresh context stats");
		expect(html).toContain("18% used");
		expect(html).toContain("179.1k / 1M");
	});
});
