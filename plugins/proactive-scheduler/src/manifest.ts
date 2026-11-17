import { pluginManifestSchema, type PluginManifest } from "@tsukaima/sdk/manifest";

export const PROACTIVE_SCHEDULER_PLUGIN_ID = "proactive-scheduler";
export const PROACTIVE_SCHEDULER_RPC_PREFIX = `${PROACTIVE_SCHEDULER_PLUGIN_ID}.`;
export const PROACTIVE_SCHEDULER_RUN_KIND = "proactive-scheduler.run";
export const PROACTIVE_SCHEDULER_TICK_KIND = "proactive-scheduler.tick";
export const PROACTIVE_SCHEDULER_TICK_DEDUPE_KEY = "proactive-scheduler.tick";
export const PROACTIVE_SCHEDULER_TABLE_PREFIX = "plugin_proactive_scheduler_";

export const proactiveSchedulerManifest: PluginManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	configSchema: {
		properties: {
			maxPromptChars: { type: "integer" },
			tickIntervalMs: { type: "integer" },
		},
		type: "object",
	},
	hooks: [{ name: "message.received" }, { name: "after.reply" }],
	kind: "builtin",
	migrations: { directory: "migrations" },
	name: PROACTIVE_SCHEDULER_PLUGIN_ID,
	permissions: [
		"ui.panel",
		"tools",
		"audit.write",
		"storage.global",
		"tasks.create",
		"tasks.get",
		"tasks.list",
		"tasks.cancel",
		"tasks.watch",
		"conversation.read",
		"channel.send",
		"followups.read",
		"schedules.create",
	],
	version: "0.1.0",
});
