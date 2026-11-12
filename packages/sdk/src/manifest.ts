import { z } from "zod";

export const pluginPermissionSchema = z
	.string()
	.trim()
	.min(1)
	.regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-<>.]*)?$/u, "Invalid permission name");

const jsonObjectSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
	z
		.object({})
		.passthrough()
		.superRefine((value, context) => {
			for (const [key, child] of Object.entries(value)) {
				const parsed = jsonObjectSchema.safeParse(child);
				if (!parsed.success) {
					context.addIssue({
						code: z.ZodIssueCode.invalid_type,
						expected: "object",
						received: typeof child,
						path: [key],
						message: "JSON object values must be JSON-compatible objects",
					});
				}
			}
		}),
);

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
				parameters: jsonObjectSchema,
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
				id: z.string().min(1),
				title: z.string().min(1),
				component: z.string().min(1),
				data: z.record(z.string(), z.unknown()).default({}),
			}),
		)
		.max(64)
		.default([]),
	configSchema: jsonObjectSchema.optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
