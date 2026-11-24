import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const SKILLS_PLUGIN_ID = "skills";
export const SKILLS_RPC_PREFIX = `${SKILLS_PLUGIN_ID}.`;
export const SKILLS_LOAD_TOOL = `${SKILLS_PLUGIN_ID}.load`;
export const SKILLS_READ_RESOURCE_TOOL = `${SKILLS_PLUGIN_ID}.read_resource`;
export const SKILLS_LOAD_MODEL_NAME = "load_skill";
export const SKILLS_READ_RESOURCE_MODEL_NAME = "read_skill_resource";
export const SKILLS_INSTALL_TOOL = `${SKILLS_PLUGIN_ID}.install`;
export const SKILLS_REMOVE_TOOL = `${SKILLS_PLUGIN_ID}.remove`;
export const SKILLS_RESCAN_TOOL = `${SKILLS_PLUGIN_ID}.rescan`;
export const SKILLS_INSTALL_MODEL_NAME = "skill_install";
export const SKILLS_REMOVE_MODEL_NAME = "skill_remove";
export const SKILLS_RESCAN_MODEL_NAME = "skill_rescan";

export const skillsManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configEnv: { paths: "TSUKAIMA_SKILLS_PATHS" },
	configSchema: {
		properties: {
			adminSkills: {
				descriptionKey: "config_admin_skills_hint",
				items: { type: "string" },
				titleKey: "config_admin_skills",
				type: "array",
			},
			allowResources: {
				descriptionKey: "config_allow_resources_hint",
				titleKey: "config_allow_resources",
				type: "boolean",
			},
			disabled: {
				descriptionKey: "config_disabled_hint",
				items: { type: "string" },
				titleKey: "config_disabled",
				type: "array",
			},
			everyoneSkills: {
				descriptionKey: "config_everyone_skills_hint",
				items: { type: "string" },
				titleKey: "config_everyone_skills",
				type: "array",
			},
			maxCatalogChars: {
				descriptionKey: "config_max_catalog_chars_hint",
				maximum: 8_000,
				minimum: 500,
				titleKey: "config_max_catalog_chars",
				type: "integer",
			},
			paths: {
				descriptionKey: "config_paths_hint",
				items: { type: "string" },
				titleKey: "config_paths",
				type: "array",
			},
			refreshIntervalSeconds: {
				descriptionKey: "config_refresh_interval_seconds_hint",
				maximum: 3_600,
				minimum: 5,
				titleKey: "config_refresh_interval_seconds",
				type: "integer",
			},
			scope: {
				default: "admin",
				descriptionKey: "config_scope_hint",
				enum: ["admin", "everyone"],
				enumLabels: {
					admin: "config_scope_admin",
					everyone: "config_scope_everyone",
				},
				titleKey: "config_scope",
				type: "string",
			},
			surfaces: {
				descriptionKey: "config_surfaces_hint",
				items: { enum: ["chat", "workspace"], type: "string" },
				titleKey: "config_surfaces",
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
