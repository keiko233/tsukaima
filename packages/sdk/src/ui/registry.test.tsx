import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginUiDefinition } from "../types.ts";
import {
	HOST_UI_VERSION,
	UiComponentRenderer,
	declarativeUiRegistry,
	resolveUiComponent,
} from "./registry.tsx";

const definition = (overrides: Partial<PluginUiDefinition> = {}): PluginUiDefinition => ({
	component: "approval-card",
	data: { summary: "Deploy the change" },
	id: "demo.approval",
	kind: "approval-card",
	requiredPermissions: ["ui.approval-card"],
	title: "Approval",
	version: "1.0.0",
	...overrides,
});

describe("declarative UI component registry", () => {
	test("registers the named component set and resolves a permitted definition", () => {
		expect(declarativeUiRegistry.list().map((entry) => entry.name)).toEqual([
			"approval-card",
			"memory-review",
			"sticker-grid",
			"task-list",
			"task-graph",
			"diagnostic-card",
			"settings-form",
			"fallback",
		]);
		expect(
			resolveUiComponent(definition(), {
				grantedPermissions: ["ui.panel", "ui.approval-card"],
			}).status,
		).toBe("ok");
	});

	test("falls back for unknown components, host version mismatches, slots, and permissions", () => {
		const unknown = resolveUiComponent(definition({ component: "unknown-widget" }));
		expect(unknown.status).toBe("fallback");
		if (unknown.status === "fallback") expect(unknown.reason).toBe("unknown-component");
		const version = resolveUiComponent(definition({ version: "2.0.0" }), {
			hostVersion: HOST_UI_VERSION,
		});
		expect(version.status).toBe("fallback");
		if (version.status === "fallback") {
			expect(version.reason).toBe("host-version-mismatch");
		}
		const slot = resolveUiComponent(definition({ slot: "settings-form" }));
		expect(slot.status).toBe("fallback");
		if (slot.status === "fallback") expect(slot.reason).toBe("slot-mismatch");
		const denied = resolveUiComponent(definition(), { grantedPermissions: ["ui.panel"] });
		expect(denied.status).toBe("fallback");
		if (denied.status === "fallback") expect(denied.reason).toBe("permission-denied");
	});

	test("renders the generic fallback card through the host renderer", () => {
		const html = renderToStaticMarkup(
			<UiComponentRenderer
				definition={definition({ component: "not-installed", title: "Missing widget" })}
				grantedPermissions={["ui.panel", "ui.approval-card"]}
			/>,
		);
		expect(html).toContain("Generic plugin UI fallback");
		expect(html).toContain("not-installed");
	});
});
