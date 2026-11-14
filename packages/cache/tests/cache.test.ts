import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyvCache } from "../src/index.ts";

const directories: string[] = [];
const caches: KeyvCache[] = [];

afterEach(async () => {
	await Promise.all(caches.splice(0).map((cache) => cache.close()));
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function temporaryCache(path = false): Promise<KeyvCache> {
	const cache = new KeyvCache(
		path ? { path: join(await temporaryDirectory(), "cache.sqlite") } : {},
	);
	caches.push(cache);
	return cache;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-cache-"));
	directories.push(directory);
	return directory;
}

describe("KeyvCache", () => {
	test("round-trips JSON values and namespaced keys", async () => {
		const cache = await temporaryCache();
		await cache.set("run:1", { text: "hello", tools: [1, 2] });
		await cache.set("plugin:search:q", "cached");
		expect(await cache.get("run:1")).toEqual({ text: "hello", tools: [1, 2] });
		expect(await cache.keys("plugin:")).toEqual(["plugin:search:q"]);
		await cache.clear("plugin:");
		expect(await cache.get("plugin:search:q")).toBeUndefined();
		expect(await cache.get("run:1")).toEqual({ text: "hello", tools: [1, 2] });
	});

	test("expires entries after the requested TTL", async () => {
		const cache = await temporaryCache();
		await cache.set("short", "lived", { ttlMs: 15 });
		expect(await cache.get("short")).toBe("lived");
		await Bun.sleep(30);
		expect(await cache.get("short")).toBeUndefined();
	});

	test("getOrSet runs one factory for concurrent misses", async () => {
		const cache = await temporaryCache();
		let calls = 0;
		const values = await Promise.all(
			Array.from({ length: 8 }, () =>
				cache.getOrSet("one", async () => {
					calls += 1;
					await Bun.sleep(5);
					return "value";
				}),
			),
		);
		expect(values).toEqual(Array.from({ length: 8 }, () => "value"));
		expect(calls).toBe(1);
	});

	test("increment is serialized", async () => {
		const cache = await temporaryCache();
		const values = await Promise.all(Array.from({ length: 25 }, () => cache.increment("seq")));
		expect(values.toSorted((a, b) => a - b)).toEqual(
			Array.from({ length: 25 }, (_, index) => index + 1),
		);
		expect(await cache.get("seq")).toBe(25);
	});

	test("persists across instances that open the same file", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "cache.sqlite");
		const first = new KeyvCache({ path });
		await first.set("durable", { ok: true });
		await first.close();
		const second = new KeyvCache({ path });
		caches.push(second);
		expect(await second.get("durable")).toEqual({ ok: true });
	});

	test("publishes process-local bus events by exact channel and prefix", async () => {
		const cache = await temporaryCache();
		const exact: string[] = [];
		const prefixed: string[] = [];
		cache.subscribe<string>("run", (payload) => exact.push(payload));
		cache.subscribe<string>("run.*", (payload) => prefixed.push(payload));
		await cache.publish("run", "one");
		await cache.publish("run.active", "two");
		await cache.publish("other", "three");
		expect(exact).toEqual(["one"]);
		expect(prefixed).toEqual(["one", "two"]);
	});

	test("append-only stream caps old events and resumes from a sequence", async () => {
		const cache = await temporaryCache();
		const stream = cache.stream("run:1:events", { maxEvents: 3 });
		for (const value of ["a", "b", "c", "d"]) await stream.append(value);
		const events = await stream.read(0, 10);
		expect(events.map((event) => event.value)).toEqual(["b", "c", "d"]);
		expect(events.map((event) => event.seq)).toEqual([2, 3, 4]);
		const resumed = await stream.read(3);
		expect(resumed.map((event) => event.value)).toEqual(["d"]);
		expect((await stream.latest())?.value).toBe("d");
		expect(cache.stats().streamAppends).toBe(4);
	});
});
