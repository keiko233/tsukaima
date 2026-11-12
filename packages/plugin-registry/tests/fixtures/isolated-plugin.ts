import { pluginManifestSchema, type ElainaPlugin } from "@elaina/sdk";

export const plugin: ElainaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "third-party",
		name: "isolated",
		permissions: [],
		version: "1.0.0",
	}),
	setup(context) {
		context.tools.register({
			description: "Echo input text from an isolated worker",
			execute(input) {
				return {
					content: [{ text: String(input.text ?? ""), type: "text" }],
				};
			},
			name: "isolated.echo",
			parameters: {
				properties: { text: { type: "string" } },
				required: ["text"],
				type: "object",
			},
			requiredPermissions: [],
		});
	},
};
