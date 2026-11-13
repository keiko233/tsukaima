import { pluginManifestSchema, type TsukaimaPlugin } from "@tsukaima/sdk";

export const plugin: TsukaimaPlugin = {
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
