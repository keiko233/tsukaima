import { describe, expect, test } from "bun:test";
import { SnapshotCache } from "./cache.ts";

const entry = (fetchId: string, text = "hello") => ({
	contentType: "text/plain",
	fetchId,
	fetchedAtMs: 0,
	finalUrl: `https://example.com/${fetchId}`,
	status: 200,
	text,
	title: fetchId,
	url: `https://example.com/${fetchId}`,
});

describe("bounded snapshot cache", () => {
	test("expires entries by TTL", () => {
		let now = 0;
		const cache = new SnapshotCache({
			maxBytes: 10_000,
			maxEntries: 10,
			now: () => now,
			ttlMs: 500,
		});
		cache.set(entry("a"));
		expect(cache.get("a")).toBeDefined();
		now += 501;
		expect(cache.get("a")).toBeUndefined();
		expect(cache.stats().entries).toBe(0);
	});

	test("evicts least recently used entries by count and total bytes", () => {
		const cache = new SnapshotCache({ maxBytes: 100, maxEntries: 2, now: () => 1, ttlMs: 10_000 });
		cache.set(entry("a", "12345"));
		cache.set(entry("b", "12345"));
		expect(cache.stats().entries).toBe(2);
		cache.set(entry("c", "12345"));
		expect(cache.stats().entries).toBe(2);
		expect(cache.stats().bytes).toBeLessThanOrEqual(100);
		expect(cache.get("a")).toBeUndefined();
	});

	test("isolates conversation-scoped snapshots while allowing global reads", () => {
		const cache = new SnapshotCache({
			maxBytes: 10_000,
			maxEntries: 10,
			now: () => 1,
			ttlMs: 10_000,
		});
		cache.set(entry("private"), "conversation-a");
		cache.set(entry("global"));
		expect(cache.get("private", "conversation-a")).toBeDefined();
		expect(cache.get("private", "conversation-b")).toBeUndefined();
		expect(cache.get("private")).toBeUndefined();
		expect(cache.get("global", "conversation-b")).toBeDefined();
		expect(cache.stats().scopedEntries).toBe(1);
		expect(cache.clear("conversation-a")).toBe(1);
		expect(cache.get("global")).toBeDefined();
		expect(cache.clear()).toBe(1);
		expect(cache.stats().entries).toBe(0);
	});
});
