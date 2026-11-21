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

/**
 * Migrations live in SQL files, not in the manifest. The manifest only points at the directory
 * that holds `<version>_<name>.sql` files and their optional `<version>_<name>.down.sql`
 * rollbacks. SQL files are loaded relative to the plugin root by the host.
 */
export const pluginMigrationsDeclarationSchema = z.object({
	directory: z.string().trim().min(1).max(256),
});

export type PluginMigrationsDeclaration = z.infer<typeof pluginMigrationsDeclarationSchema>;

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
				/** Offer the tool only after `tool_search` loads it. Defaults to `true`. */
				lazy: z.boolean().optional(),
				/** Conversation surface this tool belongs to. Defaults to `both`. */
				surface: z.enum(["chat", "coding", "both"]).optional(),
				/** Preferred model-facing shorthand; collisions fall back to the namespaced name. */
				shortName: z.string().trim().min(1).max(64).optional(),
				/** Explicit model-facing name; honors in Round 1 of model tool name allocation. */
				modelName: z.string().trim().min(1).max(64).optional(),
				/** Earlier or alternative model-facing names that must keep resolving. */
				aliases: z.array(z.string().trim().min(1).max(128)).max(8).optional(),
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
	/** Directory of plugin-owned SQL migration files, relative to the plugin root. */
	migrations: pluginMigrationsDeclarationSchema.optional(),
	configSchema: jsonObjectSchema.optional(),
	/** Config key -> environment variable name, used as a fallback when unset. */
	configEnv: z.record(z.string(), z.string().min(1)).default({}),
	/** Config keys whose values are secrets and must never be returned by an API. */
	secretKeys: z.array(z.string().min(1)).max(64).default([]),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
