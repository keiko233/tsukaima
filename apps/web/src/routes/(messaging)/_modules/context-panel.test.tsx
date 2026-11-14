import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionContextStats } from "@tsukaima/contracts";

mock.module("@/paraglide/messages", () => ({
	m: {
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
		retry: () => "Retry",
	},
}));

const {
	ContextPanelContent,
	formatCategoryPercent,
	formatCompactTokens,
	formatHeadlinePercent,
} = await import("./context-panel-view");

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
	compacted: true,
	contextWindow: 1_000_000,
	deferredToolsTokens: 25_600,
	freeSpaceTokens: 787_861,
	measuredUsageTokens: 179_139,
	memories: {
		enabled: true,
		items: [
			{
				id: "mem-1",
				kind: "summary",
				scope: "conversation",
				summary: "Discussing context sidebar design",
				tier: "warm",
			},
			{
				id: "mem-2",
				kind: "fact",
				scope: "user",
				summary: "Prefers concise replies",
				tier: "long-term",
			},
		],
		recentCount: 4,
		warmTopics: ["webui"],
	},
	messageCount: 18,
	model: {
		modelId: "claude-sonnet-4",
		providerId: "anthropic",
	},
	personaName: "Tsukaima",
	sections: [
		{ key: "tsukaima-persona", label: "Persona", tokens: 11_300 },
		{ key: "tsukaima-policy", label: "Policy", tokens: 6_100 },
		{ key: "tsukaima-memory", label: "Memories", tokens: 4_500 },
	],
	tokenSource: "usage",
	tools: [
		{ deferred: false, description: "Search memories", name: "memory_search", tokens: 18_700 },
		{ deferred: true, description: "Run shell", name: "bash", tokens: 25_600 },
	],
	usedPercent: 17.9139,
	usedTokens: 179_139,
};

describe("ContextPanel", () => {
	test("formats compact tokens and percentages cleanly", () => {
		expect(formatCompactTokens(239)).toBe("239");
		expect(formatCompactTokens(4_500)).toBe("4.5k");
		expect(formatCompactTokens(33_000)).toBe("33k");
		expect(formatCompactTokens(1_000_000)).toBe("1M");
		expect(formatCategoryPercent(138_300, 1_000_000)).toBe("13.8%");
		expect(formatCategoryPercent(100, 0)).toBe("—");
		expect(formatHeadlinePercent(17.92, 1_000_000)).toBe("18%");
		expect(formatHeadlinePercent(0.4, 1_000_000)).toBe("0.4%");
	});

	test("renders Claude Code style breakdown, buffer, deferred tools, and accordions", () => {
		const html = renderToStaticMarkup(
			<ContextPanelContent onRefresh={() => {}} stats={sampleStats} />,
		);

		expect(html).toContain("Context");
		expect(html).toContain("18% used");
		expect(html).toContain("179.1k / 1M");
		expect(html).toContain("Messages");
		expect(html).toContain("138.3k");
		expect(html).toContain("13.8%");
		expect(html).toContain("System tools");
		expect(html).toContain("18.7k");
		expect(html).toContain("Persona");
		expect(html).toContain("Policy");
		expect(html).toContain("Autocompact buffer");
		expect(html).toContain("33k");
		expect(html).toContain("Free space");
		expect(html).toContain("System tools (deferred)");
		expect(html).toContain("25.6k");
		expect(html).toContain("anthropic/claude-sonnet-4");
		expect(html).toContain("Measured");
		expect(html).toContain("18 messages");
		expect(html).toContain("Compacted");
	});

	test("renders loading and empty states", () => {
		expect(renderToStaticMarkup(<ContextPanelContent isPending stats={undefined} />)).toContain(
			"Loading…",
		);
		expect(renderToStaticMarkup(<ContextPanelContent stats={null} />)).toContain(
			"No context data available for this session.",
		);
	});
});
