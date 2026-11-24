import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginI18n } from "@tsukaima/sdk/i18n";
import { PluginPanelProvider, type PluginSummary } from "@tsukaima/sdk/ui";
import mcpUi from "../../../../plugins/mcp/src/ui.tsx";
import { oneBotNapCatManifest } from "../../../../plugins/onebot-napcat/src/manifest.ts";
import oneBotUi from "../../../../plugins/onebot-napcat/src/ui.tsx";
import openAiUi from "../../../../plugins/openai-compatible/src/ui.tsx";
import proactiveUi from "../../../../plugins/proactive-scheduler/src/ui.tsx";
import skillsUi from "../../../../plugins/skills/src/ui.tsx";
import stickerUi from "../../../../plugins/sticker-meme/src/ui.tsx";
import { i18n as mcpI18n } from "../../../../plugins/mcp/src/i18n.ts";
import { i18n as oneBotI18n } from "../../../../plugins/onebot-napcat/src/i18n.ts";
import { i18n as openAiI18n } from "../../../../plugins/openai-compatible/src/i18n.ts";
import { i18n as proactiveI18n } from "../../../../plugins/proactive-scheduler/src/i18n.ts";
import { i18n as skillsI18n } from "../../../../plugins/skills/src/i18n.ts";
import { i18n as stickerI18n } from "../../../../plugins/sticker-meme/src/i18n.ts";
import type { PluginUiModuleDefinition } from "@tsukaima/sdk/ui";

const plugin: PluginSummary = {
	apiVersion: "1",
	config: {},
	configSchema: undefined,
	enabled: 1,
	id: "onebot-napcat",
	kind: "builtin",
	name: "onebot-napcat",
	permissions: ["ui.panel"],
	runMode: "host",
	secretKeys: [],
	secretsSet: [],
	status: {
		code: "status_connected",
		details: { endpoint: "ws://napcat.test:3001" },
		level: "ok",
		metrics: { events: 1284, reconnects: 0 },
		summary: "Connected to NapCat",
		updatedAt: new Date().toISOString(),
	},
	version: "0.1.0",
};

function fakeI18n(): PluginI18n {
	return {
		formatDate: (value) => String(value),
		formatNumber: (value) => String(value),
		locale: "en",
		locales: ["en"],
		t: (key) => key,
	};
}

function renderPanel(
	definition: PluginUiModuleDefinition,
	i18n: PluginI18n = fakeI18n(),
	pluginValue: PluginSummary = plugin,
	panelId?: string,
): string {
	const panel =
		panelId === undefined
			? definition.panels[0]
			: definition.panels.find((candidate) => candidate.id === panelId);
	if (panel === undefined) throw new Error("no panel");
	const Panel = panel.component;
	return renderToStaticMarkup(
		<PluginPanelProvider
			value={{
				config: {
					save: async () => {},
					saving: false,
					secretsSet: pluginValue.secretsSet,
					value: pluginValue.config,
				},
				i18n,
				notify: { error: () => {}, info: () => {}, success: () => {} },
				plugin: pluginValue,
				refresh: async () => {},
				rpc: { call: async <T,>() => ({ ok: true }) as T },
				status: plugin.status,
			}}
		>
			<Panel />
		</PluginPanelProvider>,
	);
}

describe("built-in plugin panels", () => {
	test("renders the onebot connection panel with localized copy", () => {
		const html = renderPanel(oneBotUi, oneBotI18n.bind("en"));
		expect(html).toContain("Channel status");
		expect(html).toContain("1284");
		const zh = renderPanel(oneBotUi, oneBotI18n.bind("zh-cn"));
		expect(zh).toContain("通道状态");
	});

	test("renders the onebot settings panel with translated field labels and hints", () => {
		const settingsPlugin: PluginSummary = {
			...plugin,
			config: { mode: "forward", wsUrl: "ws://napcat.test:3001" },
			configSchema: oneBotNapCatManifest.configSchema,
			secretKeys: oneBotNapCatManifest.secretKeys,
		};
		const en = renderPanel(oneBotUi, oneBotI18n.bind("en"), settingsPlugin, "settings");
		expect(en).toContain("WebSocket URL");
		expect(en).toContain("NapCat forward WebSocket address");
		expect(en).toContain("Reply with a quote");
		expect(en).toContain("Reconnect backoff");
		expect(en).toContain("Connection");
		// The raw schema key is never used as a visible label.
		expect(en).not.toContain(">wsUrl<");
		const zh = renderPanel(oneBotUi, oneBotI18n.bind("zh-cn"), settingsPlugin, "settings");
		expect(zh).toContain("WebSocket 地址");
		expect(zh).toContain("以引用方式回复");
		expect(zh).toContain("重连退避");
		expect(zh).toContain("连接");
		expect(zh).not.toContain(">wsUrl<");
	});

	test("renders the openai-compatible provider panel with a model catalog", () => {
		const html = renderPanel(openAiUi, openAiI18n.bind("en"), {
			...plugin,
			config: {
				baseUrl: "https://models.example/v1",
				models: [
					{ enabled: true, id: "fast-chat", name: "Fast Chat", supportsTools: true },
					{ enabled: false, id: "slow-chat" },
				],
			},
			id: "openai-compatible",
			name: "openai-compatible",
			secretKeys: ["apiKey"],
		});
		expect(html).toContain("Models");
		expect(html).toContain("Discover models");
		expect(html).toContain("fast-chat");
		expect(html).toContain("Fast Chat");
		expect(html).toContain("slow-chat");
		expect(html).toContain("Tool use");
		expect(html).toContain("Default");
		expect(html).toContain("Temperature");
		expect(html).toContain("Top P");
		expect(html).toContain("Stop sequences");
		expect(html).toContain("Request timeout (ms)");
		expect(html).not.toContain("Edit this value in the plugin configuration JSON.");
		expect(html.indexOf("onebot-napcat")).toBe(-1);
	});

	test("renders the proactive-scheduler panel in en and zh-cn", () => {
		const proactivePlugin: PluginSummary = {
			...plugin,
			id: "proactive-scheduler",
			name: "proactive-scheduler",
			permissions: ["ui.panel", "tools", "tasks.create", "conversation.read", "channel.send"],
		};
		const html = renderPanel(proactiveUi, proactiveI18n.bind("en"), proactivePlugin);
		expect(html).toContain("Proactive scheduler");
		expect(html).toContain("Scheduled tasks");
		expect(html).toContain("Dry-run simulation");
		const zh = renderPanel(proactiveUi, proactiveI18n.bind("zh-cn"), proactivePlugin);
		expect(zh).toContain("主动消息调度");
		expect(zh).toContain("已排期任务");
		expect(zh).toContain("试运行");
	});

	test("renders the MCP server panel in en and zh-cn", () => {
		const mcpPlugin: PluginSummary = {
			...plugin,
			id: "mcp",
			name: "mcp",
			permissions: ["ui.panel", "tools", "audit.write", "storage.global"],
		};
		const html = renderPanel(mcpUi, mcpI18n.bind("en"), mcpPlugin);
		expect(html).toContain("MCP servers");
		expect(html).toContain("Add MCP server");
		expect(html).toContain("Access scope");
		expect(html).toContain("Loading MCP servers…");
		const zh = renderPanel(mcpUi, mcpI18n.bind("zh-cn"), mcpPlugin);
		expect(zh).toContain("MCP 服务器");
		expect(zh).toContain("添加 MCP 服务器");
		expect(zh).toContain("使用权限");
		expect(zh).toContain("正在加载 MCP 服务器…");
		expect(mcpI18n.bind("en").t("auth_oauth_authorization_code")).toContain("OAuth");
		expect(mcpI18n.bind("zh-cn").t("auth_oauth_authorization_code")).toContain("OAuth");
	});

	test("renders the Skills panel in en and zh-cn", () => {
		const skillsPluginSummary: PluginSummary = {
			...plugin,
			id: "skills",
			name: "skills",
			permissions: ["ui.panel", "tools", "audit.write"],
		};
		const html = renderPanel(skillsUi, skillsI18n.bind("en"), skillsPluginSummary);
		expect(html).toContain("Skills");
		expect(html).toContain("Rescan");
		const zh = renderPanel(skillsUi, skillsI18n.bind("zh-cn"), skillsPluginSummary);
		expect(zh).toContain("技能");
		expect(zh).toContain("重新扫描");
	});

	test("renders the sticker-meme library panel in en and zh-cn", () => {
		const stickerPlugin: PluginSummary = {
			...plugin,
			id: "sticker-meme",
			name: "sticker-meme",
			permissions: ["ui.panel", "media.read", "media.write"],
			secretKeys: ["telegramBotToken"],
		};
		const html = renderPanel(stickerUi, stickerI18n.bind("en"), stickerPlugin);
		expect(html).toContain("Sticker library");
		expect(html).toContain("Add sticker from URL");
		expect(html).toContain("Steal from QQ chat");
		expect(html).toContain("Uncategorized stickers");
		expect(html).toContain("No sticker packs yet");
		expect(html).toContain("Telegram bot token");
		expect(html).toContain("Bot token");
		expect(html).toContain("Animated format");
		expect(html).toContain("Video format");
		expect(html).toContain("Classification model");
		expect(html).toContain("Auto (configured vision model)");
		expect(html).toContain("Save model settings");
		expect(html).toContain("Import workers");
		expect(html).toContain("Semantic workers");
		expect(html).toContain("Classify in a separate background job");
		expect(html).toContain("Expand a pack to browse its stickers");
		expect(html).not.toContain("No items in this view.");
		const zh = renderPanel(stickerUi, stickerI18n.bind("zh-cn"), stickerPlugin);
		expect(zh).toContain("表情包素材库");
		expect(zh).toContain("从 URL 添加表情包");
		expect(zh).toContain("从 QQ 聊天偷表情包");
		expect(zh).toContain("无分类的表情包");
		expect(zh).toContain("还没有表情包");
		expect(zh).toContain("Telegram 机器人 Token");
		expect(zh).toContain("动态表情格式");
		expect(zh).toContain("视频表情格式");
		expect(zh).toContain("分类模型");
		expect(zh).toContain("自动（使用已配置的视觉模型）");
		expect(zh).toContain("保存模型设置");
		expect(zh).toContain("导入并发数");
		expect(zh).toContain("语义并发数");
		expect(zh).toContain("在独立后台任务中分类");
		expect(zh).toContain("展开表情包即可浏览素材");
	});
});
