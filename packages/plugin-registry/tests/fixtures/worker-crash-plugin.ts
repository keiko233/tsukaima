import { pluginManifestSchema, type ElainaPlugin } from "@elaina/sdk";

export const plugin: ElainaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "third-party",
		name: "crashy",
		permissions: [],
		version: "1.0.0",
	}),
	setup() {
		setTimeout(() => {
			throw new Error("intentional worker crash");
		}, 60);
	},
};
