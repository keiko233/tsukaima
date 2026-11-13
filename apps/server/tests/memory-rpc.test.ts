import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { MemoryRow } from "@tsukaima/contracts";
import { auditLog, conversations, memories, messages } from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { signIn } from "./test-auth.ts";

const directories: string[] = [];
const TEST_ADMIN = { password: "test-admin-password", username: "admin" };

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("admin memory RPC", () => {
	test("manages review transitions, expiry, compaction, search, and safe audit rows", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-memory-rpc-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_ADMIN_PASSWORD: TEST_ADMIN.password,
			TSUKAIMA_ADMIN_USERNAME: TEST_ADMIN.username,
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();
		try {
			const cookie = await signIn(app, TEST_ADMIN.username, TEST_ADMIN.password);
			const request = async <T = unknown>(procedure: string, input?: unknown): Promise<T> => {
				const response = await app.handle(
					new Request(`http://localhost/rpc/${procedure}`, {
						body: JSON.stringify(input === undefined ? {} : { json: input }),
						headers: { cookie, "content-type": "application/json" },
						method: "POST",
					}),
				);
				const result = (await response.json()) as { json: unknown };
				if (response.status !== 200) {
					throw new Error(`RPC ${procedure} failed: ${response.status} ${JSON.stringify(result)}`);
				}
				return result.json as T;
			};

			const created = await request<MemoryRow>("admin/memory/create", {
				kind: "fact",
				scope: "global",
				status: "pending",
				summary: "RPC secret summary marker",
			});
			expect(created).toMatchObject({ pinned: false, status: "pending" });
			const pending = await request<MemoryRow[]>("admin/memory/list", { status: "pending" });
			expect(pending.map((row) => row.id)).toEqual([created.id]);
			expect(await request<MemoryRow>("admin/memory/get", { id: created.id })).toMatchObject({
				id: created.id,
			});
			expect((await request<MemoryRow>("admin/memory/approve", { id: created.id })).status).toBe(
				"active",
			);
			expect(
				(await request<MemoryRow>("admin/memory/pin", { id: created.id, pinned: true })).pinned,
			).toBe(true);
			const updated = await request<MemoryRow>("admin/memory/update", {
				id: created.id,
				importance: 0.9,
				summary: "RPC updated summary marker",
			});
			expect(updated).toMatchObject({ importance: 0.9, summary: "RPC updated summary marker" });

			const rejectedCandidate = await request<MemoryRow>("admin/memory/create", {
				kind: "fact",
				scope: "global",
				status: "pending",
				summary: "RPC rejected candidate",
			});
			expect(
				(await request<MemoryRow>("admin/memory/reject", { id: rejectedCandidate.id })).status,
			).toBe("rejected");

			const search = await request<Array<{ memory: MemoryRow; score: number }>>(
				"admin/memory/search",
				{ query: "updated summary", limit: 5 },
			);
			expect(search.some((entry) => entry.memory.id === created.id)).toBe(true);
			expect(search.every((entry) => typeof entry.score === "number")).toBe(true);

			const expiring = await request<MemoryRow>("admin/memory/create", {
				expiresAt: "2020-01-01T00:00:00.000Z",
				kind: "todo",
				scope: "global",
				summary: "Expired RPC todo",
			});
			expect(await request<{ expired: number }>("admin/memory/expire")).toEqual({
				expired: expect.any(Number),
			});
			expect(await request<MemoryRow>("admin/memory/get", { id: expiring.id })).toMatchObject({
				status: "expired",
			});
			expect((await request<MemoryRow>("admin/memory/revoke", { id: created.id })).status).toBe(
				"revoked",
			);

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			await database.insert(conversations).values({
				durableConversationId: "durable-rpc-compact",
				id: "session-rpc-compact",
				kind: "private",
				title: "RPC compact",
			});
			for (let index = 0; index < 26; index += 1) {
				await database.insert(messages).values({
					contentText:
						index === 0 ? "We decided to use SQLite. TODO: buy beans" : `Message ${index}`,
					conversationId: "session-rpc-compact",
					direction: index % 2 === 0 ? "inbound" : "outbound",
					id: `rpc-compact-${index}`,
					kind: "onebot-v11",
					occurredAt: new Date(Date.UTC(2026, 10, 13, 0, 0, index)).toISOString(),
				});
			}
			const compacted = await request<{ created: boolean; memory: MemoryRow | null }>(
				"admin/memory/compact",
				{ conversationId: "session-rpc-compact" },
			);
			expect(compacted.created).toBe(true);
			expect(compacted.memory?.kind).toBe("summary");
			const raw = await database
				.select()
				.from(messages)
				.where(eq(messages.conversationId, "session-rpc-compact"));
			expect(raw).toHaveLength(26);
			const summaryRows = await database
				.select()
				.from(memories)
				.where(eq(memories.kind, "summary"));
			expect(summaryRows).toHaveLength(1);

			const audits = await database.select().from(auditLog);
			for (const action of [
				"memory.create",
				"memory.approve",
				"memory.reject",
				"memory.pin",
				"memory.update",
				"memory.expire",
				"memory.revoke",
				"memory.compact",
			]) {
				expect(audits.some((row) => row.action === action && row.result === "ok")).toBe(true);
			}
			const auditPayloads = audits.map((row) => row.payloadJson ?? "").join("\n");
			expect(auditPayloads).not.toContain("RPC secret summary marker");
			expect(auditPayloads).not.toContain("RPC updated summary marker");
		} finally {
			await lifecycle.stop();
		}
	});
});
