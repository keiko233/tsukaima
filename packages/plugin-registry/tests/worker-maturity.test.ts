import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pluginManifestSchema, type AuditEntry, type PluginStorage } from "@elaina/sdk";
import { BunPluginWorker, PLUGIN_WORKER_PROTOCOL_VERSION } from "../src/index.ts";

const maturityManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	kind: "third-party",
	name: "maturity",
	permissions: ["audit.write", "storage.global"],
	version: "1.0.0",
});

const crashManifest = pluginManifestSchema.parse({
	apiVersion: "1",
	kind: "third-party",
	name: "crashy",
	permissions: [],
	version: "1.0.0",
});

function memoryStorage(): { storage: PluginStorage; values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	const conversations = new Map<string, unknown>();
	return {
		storage: {
			conversation: {
				get: async <T>(conversationId: string, key: string) =>
					conversations.get(`${conversationId}:${key}`) as T | undefined,
				set: async (conversationId, key, value) => {
					conversations.set(`${conversationId}:${key}`, value);
				},
			},
			global: {
				get: async <T>(key: string) => values.get(key) as T | undefined,
				set: async (key, value) => {
					values.set(key, value);
				},
			},
		},
		values,
	};
}

function createWorker(
	options: {
		readonly maxInFlight?: number;
		readonly maxQueuedRequests?: number;
		readonly maxRestarts?: number;
		readonly onCrash?: (error: Error, restarts: number) => void;
		readonly onLog?: (entry: { message: string }) => void;
		readonly onProgress?: (entry: { message: string }) => void;
		readonly requestTimeoutMs?: number;
		readonly storage?: PluginStorage;
		readonly audit?: (entry: AuditEntry) => void;
	} = {},
): BunPluginWorker {
	return new BunPluginWorker({
		manifest: maturityManifest,
		modulePath: join(import.meta.dir, "fixtures/worker-maturity-plugin.ts"),
		pluginId: "maturity",
		...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
		...(options.maxQueuedRequests === undefined
			? {}
			: { maxQueuedRequests: options.maxQueuedRequests }),
		...(options.maxRestarts === undefined ? {} : { maxRestarts: options.maxRestarts }),
		...(options.onCrash === undefined ? {} : { onCrash: options.onCrash }),
		...(options.onLog === undefined ? {} : { onLog: options.onLog }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options.requestTimeoutMs === undefined
			? {}
			: { requestTimeoutMs: options.requestTimeoutMs }),
		host: {
			...(options.audit === undefined
				? {}
				: { audit: { record: async (entry) => options.audit?.(entry) } }),
			...(options.storage === undefined ? {} : { storage: options.storage }),
		},
	});
}

describe("mature Bun plugin worker contract", () => {
	test("handshakes, streams logs/progress, and routes storage/audit through the host", async () => {
		expect(PLUGIN_WORKER_PROTOCOL_VERSION).toBe("1");
		const { storage, values } = memoryStorage();
		const audits: AuditEntry[] = [];
		const logs: string[] = [];
		const progress: string[] = [];
		const worker = createWorker({
			audit: (entry) => audits.push(entry),
			onLog: (entry) => logs.push(entry.message),
			onProgress: (entry) => progress.push(entry.message),
			storage,
		});
		await worker.start();
		try {
			expect(worker.listTools()).toEqual([{ name: "maturity.storage" }, { name: "maturity.wait" }]);
			const result = await worker.invokeTool("maturity.storage", { value: "durable" });
			expect(result).toEqual({
				ok: true,
				result: { content: [{ text: "durable", type: "text" }] },
			});
			expect(values.get("worker-key")).toBe("durable");
			expect(audits).toEqual([
				expect.objectContaining({ action: "worker.storage", targetId: "worker-key" }),
			]);
			expect(logs).toContain("storage completed");
			expect(progress).toContain("tool started");
			expect(progress).toContain("tool finished");
		} finally {
			await worker.stop();
		}
	});

	test("cancels in-flight RPC calls and enforces request timeouts", async () => {
		const cancelling = createWorker();
		await cancelling.start();
		try {
			const controller = new AbortController();
			const pending = cancelling.invokeTool(
				"maturity.wait",
				{ ms: 5_000 },
				{ signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 20);
			await expect(pending).rejects.toThrow("cancelled");
		} finally {
			await cancelling.stop();
		}

		const timingOut = createWorker({ requestTimeoutMs: 40 });
		await timingOut.start();
		try {
			await expect(timingOut.invokeTool("maturity.wait", { ms: 5_000 })).rejects.toThrow(
				"timed out",
			);
		} finally {
			await timingOut.stop();
		}
	});

	test("rejects excess in-flight requests when the queue is disabled", async () => {
		const worker = createWorker({ maxInFlight: 1, maxQueuedRequests: 0 });
		await worker.start();
		const controller = new AbortController();
		try {
			const first = worker.invokeTool(
				"maturity.wait",
				{ ms: 5_000 },
				{ signal: controller.signal },
			);
			await Bun.sleep(20);
			await expect(worker.invokeTool("maturity.wait", { ms: 10 })).rejects.toThrow("queue is full");
			controller.abort();
			await expect(first).rejects.toThrow("cancelled");
		} finally {
			await worker.stop();
		}
	});

	test("detects a crash and applies the bounded restart policy", async () => {
		let crashed: { error: Error; restarts: number } | undefined;
		const worker = new BunPluginWorker({
			manifest: crashManifest,
			maxRestarts: 1,
			modulePath: join(import.meta.dir, "fixtures/worker-crash-plugin.ts"),
			onCrash: (error, restarts) => {
				crashed = { error, restarts };
			},
			pluginId: "crashy",
			restartDelayMs: 10,
			requestTimeoutMs: 2_000,
		});
		await worker.start();
		const deadline = Date.now() + 3_000;
		while (Date.now() < deadline) {
			if (crashed !== undefined) break;
			await Bun.sleep(20);
		}
		expect(crashed?.restarts).toBe(1);
		expect(crashed?.error.message).toContain("crash");
		await worker.stop();
	});
});
