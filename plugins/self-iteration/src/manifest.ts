import { pluginManifestSchema, type PluginManifest } from "@elaina/sdk";
import { SELF_ITERATION_PLUGIN_ID } from "./domain.ts";

export const SELF_ITERATION_MANIFEST: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: {
			repositoryRoot: { type: "string" },
			worktreeRoot: { type: "string" },
		},
		type: "object",
	},
	hooks: [],
	kind: "builtin",
	migrations: [],
	name: SELF_ITERATION_PLUGIN_ID,
	permissions: [
		"tools.register",
		"rpc.register",
		"ui.panel",
		"ui.approval-card",
		"coding.read",
		"coding.execute",
		"storage.global",
		"audit.write",
		"tasks.create",
	],
	version: "0.1.0",
});

export { SELF_ITERATION_PLUGIN_ID };
