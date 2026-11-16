import { afterEach, describe, expect, test } from "bun:test";
import { KeyvCache } from "@tsukaima/cache";
import { createPluginCacheBridge } from "../src/services/plugin-cache.ts";

const caches: KeyvCache[] = [];

afterEach(async () => {
	await Promise.all(caches.splice(0).map((cache) => cache.close()));
});

function setup() {
	const cache = new KeyvCache();
	caches.push(cache);
	return cache;
}

describe("plugin cache bridge", () => {
	test("is absent without a cache permission", () => {
		const cache = setup();
		expect(createPluginCacheBridge(cache, "demo", ["storage.global"])).toBeUndefined();
	});

	test("namespaces values so plugins cannot read each other's keys", async () => {
		const cache = setup();
		const first = createPluginCacheBridge(cache, "first", ["cache.read", "cache.write"]);
		const second = createPluginCacheBridge(cache, "second", ["cache.read", "cache.write"]);
		await first?.set("token", "one");
		expect(await first?.get("token")).toBe("one");
		expect(await second?.get("token")).toBeUndefined();
		expect(await cache.keys("plugin:first:")).toEqual(["plugin:first:token"]);
	});

	test("enforces the action permission at call time", async () => {
		const cache = setup();
		const readOnly = createPluginCacheBridge(cache, "demo", ["cache.read"]);
		await expect(readOnly?.set("key", "value")).rejects.toThrow("cache.write");
		const writer = createPluginCacheBridge(cache, "writer", ["cache.write"]);
		await expect(writer?.get("key")).rejects.toThrow("cache.read");
	});

	test("expires values and supports getOrSet and publish", async () => {
		const cache = setup();
		const bridge = createPluginCacheBridge(cache, "demo", [
			"cache.read",
			"cache.write",
			"cache.publish",
		]);
		await bridge?.set("short", "lived", { ttlMs: 10 });
		await Bun.sleep(20);
		expect(await bridge?.get("short")).toBeUndefined();
		let calls = 0;
		expect(
			await bridge?.getOrSet("computed", () => {
				calls += 1;
				return "value";
			}),
		).toBe("value");
		expect(calls).toBe(1);

		const payloads: unknown[] = [];
		const dispose = bridge?.subscribe?.("updates", (payload) => payloads.push(payload));
		await bridge?.publish("updates", { ok: true });
		dispose?.();
		expect(payloads).toEqual([{ ok: true }]);
	});
});
