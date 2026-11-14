import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildConfigPatch, PluginConfigForm } from "./config-form.tsx";

const schema = {
	properties: {
		accessToken: { type: "string", title: "Access token", titleKey: "config_access_token" },
		adminUsers: { items: { type: "string" }, title: "Admin user ids", type: "array" },
		deleteGroupFile: { title: "Delete files", type: "boolean" },
		forwardExpand: {
			anyOf: [
				{ type: "boolean" },
				{
					properties: {
						maxChars: { title: "Max characters", type: "number" },
						timeoutMs: { title: "Timeout (ms)", type: "number" },
					},
					type: "object",
				},
			],
			title: "Expand forwards",
		},
		mode: {
			enum: ["forward", "reverse"],
			enumLabels: { forward: "config_mode_forward", reverse: "config_mode_reverse" },
			title: "Mode",
			type: "string",
		},
		port: { title: "Port", type: "number" },
		reconnect: {
			properties: {
				initialDelayMs: { title: "Initial delay (ms)", type: "number" },
				jitterRatio: { title: "Jitter ratio", type: "number" },
			},
			title: "Reconnect backoff",
			type: "object",
		},
	},
	type: "object",
} as const;

const prefixTranslate = (key: string) => `t:${key}`;

function render(
	value: Record<string, unknown> = {},
	translate?: (key: string) => string,
	labels: Record<string, string> = {},
): string {
	return renderToStaticMarkup(
		<PluginConfigForm
			labels={labels}
			onSave={() => {}}
			schema={schema}
			translate={translate}
			value={value}
		/>,
	);
}

describe("plugin config form", () => {
	test("labels every field and renders a control for each supported shape", () => {
		const html = render({ deleteGroupFile: true, forwardExpand: true, mode: "reverse" });
		expect(html).toContain("Access token");
		expect(html).toContain("Admin user ids");
		expect(html).toContain("Delete files");
		expect(html).toContain("Expand forwards");
		expect(html).toContain("Max characters");
		expect(html).toContain("Timeout (ms)");
		expect(html).toContain("Reconnect backoff");
		expect(html).toContain("Initial delay (ms)");
		expect(html).toContain("Jitter ratio");
		// No bare schema key leaks into the markup as a label.
		for (const key of Object.keys(schema.properties)) expect(html).not.toContain(`>${key}<`);
	});

	test("resolves titleKey and enumLabels through the plugin catalog", () => {
		const html = render({ mode: "reverse" }, prefixTranslate);
		expect(html).toContain("t:config_access_token");
		expect(html).toContain("t:config_mode_forward");
		expect(html).toContain("t:config_mode_reverse");
	});

	test("falls back to the schema literal when a key is missing from the catalog", () => {
		const html = render({}, (key) => key);
		expect(html).toContain("Access token");
		expect(html).toContain("Mode");
	});

	test("shows configured and unset placeholders for secret fields", () => {
		const configured = renderToStaticMarkup(
			<PluginConfigForm
				labels={{ configured: "Stored", unset: "Missing" }}
				onSave={() => {}}
				schema={schema}
				secretKeys={["accessToken"]}
				secretsSet={["accessToken"]}
				value={{}}
			/>,
		);
		expect(configured).toContain("Stored");
		const unset = renderToStaticMarkup(
			<PluginConfigForm
				labels={{ configured: "Stored", unset: "Missing" }}
				onSave={() => {}}
				schema={schema}
				secretKeys={["accessToken"]}
				secretsSet={[]}
				value={{}}
			/>,
		);
		expect(unset).toContain("Missing");
	});

	test("renders grouped sections and appends unlisted keys", () => {
		const html = renderToStaticMarkup(
			<PluginConfigForm
				groups={[{ keys: ["mode", "port"], titleKey: "group_connection" }]}
				onSave={() => {}}
				schema={schema}
				translate={(key) => (key === "group_connection" ? "Connection" : key)}
				value={{}}
			/>,
		);
		expect(html).toContain("Connection");
		expect(html.indexOf("Connection")).toBeLessThan(html.indexOf("Port"));
		expect(html.indexOf("Port")).toBeLessThan(html.indexOf("Reconnect backoff"));
	});

	test("explains unsupported shapes instead of silently dropping them", () => {
		const html = renderToStaticMarkup(
			<PluginConfigForm
				labels={{ unsupported: "Edit this in JSON" }}
				onSave={() => {}}
				schema={{
					properties: { weird: { items: { type: "object" }, type: "array", title: "Weird" } },
					type: "object",
				}}
				value={{ weird: [{ a: 1 }] }}
			/>,
		);
		expect(html).toContain("Weird");
		expect(html).toContain("Edit this in JSON");
	});
});

describe("config patch building", () => {
	test("omits untouched fields, nulls cleared ones, and coerces by schema type", () => {
		const patch = buildConfigPatch(schema, {
			adminUsers: "10001, 10002 ,,",
			deleteGroupFile: "true",
			mode: "reverse",
			port: "3001",
			reconnect: "",
		});
		expect(patch).toEqual({
			adminUsers: ["10001", "10002"],
			deleteGroupFile: true,
			mode: "reverse",
			port: 3001,
		});
	});

	test("clears a field when its draft is empty", () => {
		expect(buildConfigPatch(schema, { accessToken: "  ", port: "" })).toEqual({
			accessToken: null,
			port: null,
		});
	});

	test("sends nested objects and their cleared sub-fields", () => {
		expect(buildConfigPatch(schema, { "reconnect.initialDelayMs": "500" })).toEqual({
			reconnect: { initialDelayMs: 500 },
		});
		expect(buildConfigPatch(schema, { "reconnect.initialDelayMs": "" })).toEqual({
			reconnect: null,
		});
	});

	test("sends true for an enabled switch with no tuned options, false when disabled", () => {
		expect(buildConfigPatch(schema, { forwardExpand: "true" })).toEqual({ forwardExpand: true });
		expect(buildConfigPatch(schema, { forwardExpand: "false" })).toEqual({
			forwardExpand: false,
		});
		expect(
			buildConfigPatch(schema, { "forwardExpand.maxChars": "400", forwardExpand: "true" }),
		).toEqual({ forwardExpand: { maxChars: 400 } });
	});
});
