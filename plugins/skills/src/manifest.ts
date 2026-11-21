import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const SKILLS_PLUGIN_ID = "skills";
export const SKILLS_RPC_PREFIX = `${SKILLS_PLUGIN_ID}.`;
export const SKILLS_LOAD_TOOL = `${SKILLS_PLUGIN_ID}.load`;
export const SKILLS_READ_RESOURCE_TOOL = `${SKILLS_PLUGIN_ID}.read_resource`;
export const SKILLS_LOAD_MODEL_NAME = "load_skill";
export const SKILLS_READ_RESOURCE_MODEL_NAME = "read_skill_resource";

export const skillsManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: { paths: "TSUKAIMA_SKILLS_PATHS" },
	configSchema: {
		properties: {
			allowResources: { type: "boolean" },
			disabled: { items: { type: "string" }, type: "array" },
			maxCatalogChars: { maximum: 8_000, minimum: 500, type: "integer" },
			paths: { items: { type: "string" }, type: "array" },
			refreshIntervalSeconds: { maximum: 3_600, minimum: 5, type: "integer" },
			surfaces: {
				items: { enum: ["chat", "workspace"], type: "string" },
				type: "array",
			},
		},
		type: "object",
	},
	hooks: [],
	kind: "builtin",
	name: SKILLS_PLUGIN_ID,
	permissions: ["ui.panel", "tools", "audit.write"],
	secretKeys: [],
	tools: [],
	ui: [],
	version: "0.1.0",
});
