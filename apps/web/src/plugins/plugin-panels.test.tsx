import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginI18n } from "@tsukaima/sdk/i18n";
import { PluginPanelProvider, type PluginSummary } from "@tsukaima/sdk/ui";
import { oneBotNapCatManifest } from "../../../../plugins/onebot-napcat/src/manifest.ts";
import oneBotUi from "../../../../plugins/onebot-napcat/src/ui.tsx";
import openAiUi from "../../../../plugins/openai-compatible/src/ui.tsx";
import proactiveUi from "../../../../plugins/proactive-scheduler/src/ui.tsx";
import searchUi from "../../../../plugins/search-fetch/src/ui.tsx";
import selfIterationUi from "../../../../plugins/self-iteration/src/ui.tsx";
import stickerUi from "../../../../plugins/sticker-meme/src/ui.tsx";
import { i18n as oneBotI18n } from "../../../../plugins/onebot-napcat/src/i18n.ts";
import { i18n as openAiI18n } from "../../../../plugins/openai-compatible/src/i18n.ts";
import { i18n as proactiveI18n } from "../../../../plugins/proactive-scheduler/src/i18n.ts";
import { i18n as searchI18n } from "../../../../plugins/search-fetch/src/i18n.ts";
import { i18n as selfIterationI18n } from "../../../../plugins/self-iteration/src/i18n.ts";
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
					secretsSet: [],
					value: {},
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

	test("renders the openai-compatible provider panel", () => {
		const html = renderPanel(openAiUi, openAiI18n.bind("en"), {
			...plugin,
			id: "openai-compatible",
			name: "openai-compatible",
			secretKeys: ["apiKey"],
		});
		expect(html).toContain("Models");
		expect(html).toContain("Discover models");
		expect(html.indexOf("onebot-napcat")).toBe(-1);
	});

	test("renders the search-fetch panel in en and zh-cn", () => {
		const searchPlugin: PluginSummary = {
			...plugin,
			config: {},
			id: "search-fetch",
			name: "search-fetch",
			permissions: ["ui.panel", "tools", "network.search", "network.fetch"],
			secretKeys: ["braveApiKey", "serperApiKey", "tavilyApiKey"],
		};
		const html = renderPanel(searchUi, searchI18n.bind("en"), searchPlugin);
		expect(html).toContain("Search and fetch");
		expect(html).toContain("Providers");
		expect(html).toContain("Routing policy");
		expect(html).toContain("Test query");
		const zh = renderPanel(searchUi, searchI18n.bind("zh-cn"), searchPlugin);
		expect(zh).toContain("搜索与抓取");
		expect(zh).toContain("提供商");
		expect(zh).toContain("路由策略");
		expect(zh).toContain("测试查询");
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

	test("renders the self-iteration panel in en and zh-cn", () => {
		const selfIterationPlugin: PluginSummary = {
			...plugin,
			id: "self-iteration",
			name: "self-iteration",
			permissions: ["ui.panel", "tools.register", "rpc.register", "coding.read", "coding.execute"],
		};
		const html = renderPanel(selfIterationUi, selfIterationI18n.bind("en"), selfIterationPlugin);
		expect(html).toContain("Self-iteration runtime");
		expect(html).toContain("Coding tasks");
		expect(html).toContain("Coding policy");
		expect(html).toContain("Deployment history");
		expect(html).toContain("Approval cards");
		const zh = renderPanel(selfIterationUi, selfIterationI18n.bind("zh-cn"), selfIterationPlugin);
		expect(zh).toContain("自我迭代运行时");
		expect(zh).toContain("编码任务");
		expect(zh).toContain("编码策略");
		expect(zh).toContain("部署历史");
		expect(zh).toContain("审批卡片");
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
		expect(html).toContain("No sticker packs yet");
		expect(html).toContain("Telegram bot token");
		expect(html).toContain("Bot token");
		expect(html).toContain("Animated format");
		expect(html).toContain("Video format");
		expect(html).toContain("Classification model");
		expect(html).toContain("Auto (configured vision model)");
		expect(html).toContain("Save model settings");
		const zh = renderPanel(stickerUi, stickerI18n.bind("zh-cn"), stickerPlugin);
		expect(zh).toContain("表情包素材库");
		expect(zh).toContain("还没有表情包");
		expect(zh).toContain("Telegram 机器人 Token");
		expect(zh).toContain("动态表情格式");
		expect(zh).toContain("视频表情格式");
		expect(zh).toContain("分类模型");
		expect(zh).toContain("自动（使用已配置的视觉模型）");
		expect(zh).toContain("保存模型设置");
	});
});
