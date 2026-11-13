import { pluginManifestSchema, type TsukaimaPlugin } from "@tsukaima/sdk";

export const plugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "third-party",
		name: "maturity",
		permissions: ["audit.write", "storage.global"],
		version: "1.0.0",
	}),
	setup(context) {
		context.tools.register({
			description: "Exercise host-mediated storage and audit",
			async execute(input) {
				await context.storage.global.set("worker-key", input.value);
				const read = await context.storage.global.get("worker-key");
				await context.audit?.record({
					action: "worker.storage",
					result: "ok",
					targetId: "worker-key",
					targetKind: "worker-test",
				});
				context.logger.info("storage completed");
				return { content: [{ text: String(read), type: "text" }] };
			},
			name: "maturity.storage",
			parameters: { type: "object" },
			requiredPermissions: ["storage.global"],
		});
		context.tools.register({
			description: "Wait until cancelled",
			execute: async (input, invocation) => {
				const ms = Number(input.ms ?? 5_000);
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, ms);
					const onAbort = () => {
						clearTimeout(timer);
						reject(new Error("aborted by host"));
					};
					if (invocation.signal?.aborted === true) {
						clearTimeout(timer);
						reject(new Error("aborted by host"));
						return;
					}
					invocation.signal?.addEventListener("abort", onAbort, { once: true });
				});
				return { content: [{ text: "finished", type: "text" }] };
			},
			name: "maturity.wait",
			parameters: { type: "object" },
			requiredPermissions: [],
		});
	},
};
