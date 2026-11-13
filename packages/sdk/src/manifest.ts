import { z } from "zod";

/**
 * Permission names are either a single scope (`settings`), `<scope>.<action>`
 * (`tasks.read`), `<scope>.*` (`channel.*`), or the global wildcard `*`. The schema is
 * intentionally aligned with `permissionMatches()` in `permissions.ts`.
 */
export const pluginPermissionSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\.\*)?)$/u, "Invalid permission name");

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const pluginManifestSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[a-z][a-z0-9-]*$/u, "Plugin name must be kebab-case"),
	version: z.string().min(1),
	apiVersion: z.string().min(1),
	kind: z.enum(["builtin", "first-party", "third-party"]),
	permissions: z.array(pluginPermissionSchema).max(64).default([]),
	tools: z
		.array(
			z.object({
				name: z.string().min(1),
				description: z.string().min(1),
				parameters: jsonObjectSchema.default({}),
				requiredPermissions: z.array(pluginPermissionSchema).max(16).default([]),
			}),
		)
		.max(128)
		.default([]),
	hooks: z
		.array(
			z.object({
				name: z.enum([
					"message.received",
					"activity.opened",
					"activity.closed",
					"before.agent",
					"before.reply",
					"reply.transform",
					"after.reply",
					"task.created",
					"task.completed",
					"channel.connected",
					"channel.disconnected",
				]),
			}),
		)
		.max(64)
		.default([]),
	ui: z
		.array(
			z.object({
				kind: z.enum([
					"panel",
					"conversation-action",
					"message-card",
					"settings-form",
					"approval-card",
				]),
				slot: z
					.enum(["panel", "conversation-action", "message-card", "settings-form", "approval-card"])
					.optional(),
				id: z.string().min(1),
				title: z.string().min(1),
				component: z.string().min(1),
				version: z.string().min(1).optional(),
				requiredPermissions: z.array(pluginPermissionSchema).max(32).default([]),
				i18nKeys: z.array(z.string().min(1)).max(128).default([]),
				schema: jsonObjectSchema.optional(),
				data: z.record(z.string(), z.unknown()).default({}),
			}),
		)
		.max(64)
		.default([]),
	/** Plugin-owned SQL migrations applied by the host before `prepare()`. */
	migrations: z
		.array(
			z.object({
				version: z.string().min(1),
				sql: z.string().min(1),
				rollbackSql: z.string().min(1).optional(),
				checksum: z.string().min(1).optional(),
			}),
		)
		.max(512)
		.default([]),
	configSchema: jsonObjectSchema.optional(),
	/** Config key -> environment variable name, used as a fallback when unset. */
	configEnv: z.record(z.string(), z.string().min(1)).default({}),
	/** Config keys whose values are secrets and must never be returned by an API. */
	secretKeys: z.array(z.string().min(1)).max(64).default([]),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
