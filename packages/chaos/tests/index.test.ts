import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageEnvelope } from "@elaina/contracts";
import {
	AbuseGuard,
	DuplicateEnvelopeIdError,
	EnvelopeValidationError,
	IdempotentIngest,
	InvalidEnvelopeError,
	openChaoticStorage,
	OversizeMessageError,
	RateLimiter,
	runRestartDrill,
	TransientStorage,
} from "../src/index.ts";

const envelope = (id = "envelope-1", text = "hello"): MessageEnvelope => ({
	channelId: "test",
	channelKind: "webui",
	conversationKey: { kind: "webui" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { timestampMs: 0 },
});

describe("chaos abuse guard", () => {
	test("accepts a valid envelope and reports size", () => {
		const guard = new AbuseGuard({ maxBytes: 1_024 });
		const result = guard.check(envelope());
		expect(result.actualBytes).toBeGreaterThan(0);
		expect(result.envelope.id).toBe("envelope-1");
	});

	test("rejects oversized and invalid envelopes", () => {
		const guard = new AbuseGuard({ maxBytes: 1 });
		expect(() => guard.check(envelope())).toThrow(OversizeMessageError);
		const invalid = envelope("envelope-2");
		delete (invalid.parts[0] as { text?: string; type: "text" }).text;
		expect(() => new AbuseGuard().check(invalid)).toThrow(EnvelopeValidationError);
		expect(() => new AbuseGuard().check({ invalid: true })).toThrow(InvalidEnvelopeError);
	});
});

describe("chaos rate limit", () => {
	test("allows the window limit then reports retry timing", () => {
		const limiter = new RateLimiter({ intervalMs: 100, limit: 2 });
		expect(limiter.check("sender", 1)).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
		expect(limiter.check("sender", 2)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
		const blocked = limiter.check("sender", 3);
		expect(blocked.allowed).toBeFalse();
		expect(blocked.retryAfterMs).toBe(98);
		expect(limiter.check("sender", 101)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
	});

	test("rejects duplicate IDs without consuming another slot", () => {
		const ingest = new IdempotentIngest({
			rateLimiter: new RateLimiter({ intervalMs: 1_000, limit: 2 }),
			sizeLimitBytes: 65_536,
		});
		expect(ingest.ingest({ envelope: envelope("m1"), key: "sender", nowMs: 1 })).toEqual({
			allowed: true,
			remaining: 1,
			retryAfterMs: 0,
		});
		expect(() => ingest.ingest({ envelope: envelope("m1"), key: "sender", nowMs: 2 })).toThrow(
			DuplicateEnvelopeIdError,
		);
		const next = ingest.ingest({ envelope: envelope("m2"), key: "sender", nowMs: 2_000 });
		expect(next.allowed).toBeTrue();
	});
});

describe("chaos transient storage", () => {
	test("recovers after injected failures and wraps exhaustion", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-chaos-"));
		try {
			let callCount = 0;
			const { storage, close } = await openChaoticStorage(join(directory, "durable.sqlite"), {
				fail: (operation) => operation === "mintId" && ++callCount < 2,
			});
			const id = await storage.mintId();
			expect(id).toBeGreaterThan(0);
			expect(callCount).toBe(2);

			const failing = new TransientStorage(storage, {
				fail: () => true,
				maxRetries: 2,
			});
			await expect(failing.mintId()).rejects.toThrow("Durable operation failed: mintId");
			await expect(failing.mintId()).rejects.toThrow("Durable operation failed: mintId");
			await close();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});

describe("chaos restart drill", () => {
	test("persists a conversation and entry across reopen", async () => {
		const directory = await mkdtemp(join(tmpdir(), "elaina-restart-"));
		try {
			const result = await runRestartDrill(join(directory, "durable.sqlite"));
			expect(result.committedBeforeRestart).toBeTrue();
			expect(result.observedAfterRestart).toBeTrue();
			expect(result.conversationId).toBeGreaterThan(0);
			expect(result.entryId).toBeGreaterThan(0);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
