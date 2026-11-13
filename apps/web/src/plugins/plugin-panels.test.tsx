import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginI18n } from "@elaina/sdk/i18n";
import { PluginPanelProvider, type PluginSummary } from "@elaina/sdk/ui";
import oneBotUi from "../../../../plugins/onebot-napcat/src/ui.tsx";
import openAiUi from "../../../../plugins/openai-compatible/src/ui.tsx";
import { i18n as oneBotI18n } from "../../../../plugins/onebot-napcat/src/i18n.ts";
import { i18n as openAiI18n } from "../../../../plugins/openai-compatible/src/i18n.ts";
import type { PluginUiModuleDefinition } from "@elaina/sdk/ui";

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
): string {
	const panel = definition.panels[0];
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

	test("renders the openai-compatible provider panel", () => {
		const html = renderPanel(openAiUi, openAiI18n.bind("en"));
		expect(html).toContain("Model provider");
	});
});
