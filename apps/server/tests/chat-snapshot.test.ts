import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { ChatSnapshotPreview, ChatSnapshotRow } from "@tsukaima/contracts";
import {
	auditLog,
	chatSnapshots,
	conversations,
	memories,
	memoryConsolidationState,
	messages,
} from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { signIn } from "./test-auth.ts";

const directories: string[] = [];
const TEST_ADMIN = { password: "test-admin-password", username: "admin" };

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

describe("admin chat snapshot RPC", () => {
	test("captures, previews with shared-memory quarantine, applies with undo, and audits", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-chat-snapshot-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_ADMIN_PASSWORD: TEST_ADMIN.password,
			TSUKAIMA_ADMIN_USERNAME: TEST_ADMIN.username,
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7432",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7433",
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

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			const host = lifecycle.conversationHost;
			if (host === undefined) throw new Error("conversation host missing");
			// The durable conversation must really exist in the harness for reset semantics.
			const durableId = await host.createConversation();
			await database.insert(conversations).values({
				durableConversationId: durableId,
				id: "session-snapshot-1",
				kind: "private",
				title: "Snapshot target",
			});
			await database.insert(messages).values([
				{
					contentText: "Remember the beans",
					conversationId: "session-snapshot-1",
					direction: "inbound",
					id: "snapshot-msg-1",
					kind: "onebot-v11",
					occurredAt: new Date(Date.UTC(2026, 10, 14, 0, 0, 0)).toISOString(),
				},
				{
					contentText: "Noted",
					conversationId: "session-snapshot-1",
					direction: "outbound",
					id: "snapshot-msg-2",
					kind: "onebot-v11",
					occurredAt: new Date(Date.UTC(2026, 10, 14, 0, 0, 1)).toISOString(),
				},
			]);
			await database.insert(memories).values([
				{
					conversationId: "session-snapshot-1",
					content: "User keeps beans",
					createdBy: "agent",
					id: "memory-conv-active",
					kind: "fact",
					scope: "conversation",
					status: "active",
					summary: "Conversation-scoped active fact",
				},
				{
					conversationId: "session-snapshot-1",
					content: "User name marker",
					createdBy: "agent",
					id: "memory-global-active",
					kind: "fact",
					scope: "global",
					status: "active",
					summary: "Global scoped fact",
				},
			]);

			const created = await request<ChatSnapshotRow>("admin/chatSnapshot/create", {
				conversationId: "session-snapshot-1",
				title: "Before cleanup",
			});
			expect(created).toMatchObject({
				conversationId: "session-snapshot-1",
				purpose: "checkpoint",
				status: "active",
			});
			expect(created.counts.messages).toBe(2);
			expect(created.counts.quarantinedMemories).toBe(1);

			const preview = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: created.id,
			});
			expect(preview.applicable).toBe(true);
			expect(preview.blocked).toHaveLength(0);
			expect(preview.modelContext.strategy).toBe("reset-with-handoff");
			expect(preview.visibleTranscript).toMatchObject({ messageCount: 2, preserved: true });
			expect(preview.quarantinedSharedMemories).toHaveLength(1);
			expect(preview.quarantinedSharedMemories[0]?.id).toBe("memory-global-active");
			expect(preview.restorableMemories).toBe(1);
			await database.insert(messages).values({
				contentText: "Later context outside the checkpoint",
				conversationId: "session-snapshot-1",
				direction: "inbound",
				id: "snapshot-msg-later",
				kind: "onebot-v11",
				occurredAt: new Date(Date.UTC(2026, 10, 14, 0, 0, 2)).toISOString(),
			});
			await database
				.update(memories)
				.set({
					content: "Later memory edit",
					status: "revoked",
					revokedAt: new Date().toISOString(),
				})
				.where(eq(memories.id, "memory-conv-active"));
			await database.insert(memoryConsolidationState).values({
				conversationId: "session-snapshot-1",
				watermarkMessageId: "snapshot-msg-later",
				watermarkOccurredAt: "2026-11-14T00:00:02.000Z",
			});

			const applied = await request<{ ok: true; undoSnapshotId: string }>(
				"admin/chatSnapshot/apply",
				{ id: created.id },
			);
			expect(applied.ok).toBe(true);
			const context = await lifecycle.contextProvider.inspectContext(durableId);
			expect(context.memories.recentCount).toBe(2);
			const visibleMessages = await database.select().from(messages);
			expect(visibleMessages.map((row) => row.id)).toContain("snapshot-msg-later");
			const [reactivated] = await database
				.select()
				.from(memories)
				.where(eq(memories.id, "memory-conv-active"));
			expect(reactivated).toMatchObject({
				content: "User keeps beans",
				status: "active",
				revokedAt: null,
			});
			const consolidationState = await database
				.select()
				.from(memoryConsolidationState)
				.where(eq(memoryConsolidationState.conversationId, "session-snapshot-1"));
			expect(consolidationState).toHaveLength(0);

			// Apply marked the snapshot and captured an undo checkpoint.
			const rows = await database.select().from(chatSnapshots);
			expect(rows).toHaveLength(2);
			const appliedRow = rows.find((row) => row.id === created.id);
			expect(appliedRow).toMatchObject({ status: "applied" });
			const undoRow = rows.find((row) => row.id === applied.undoSnapshotId);
			expect(undoRow).toMatchObject({ purpose: "undo", restoredFromId: created.id });

			// Re-apply is refused.
			const second = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: created.id,
			});
			expect(second.applicable).toBe(false);
			expect(second.blocked.map((block) => block.code)).toContain("already_applied");
			let conflict = false;
			try {
				await request("admin/chatSnapshot/apply", { id: created.id });
			} catch (error) {
				conflict = (error as Error).message.includes("409");
			}
			expect(conflict).toBe(true);

			// Shared/global memory was never touched; conversation memory reconciles on undo apply.
			const globalAfter = await database
				.select()
				.from(memories)
				.where(eq(memories.id, "memory-global-active"));
			expect(globalAfter).toHaveLength(1);
			expect(globalAfter[0]?.status).toBe("active");

			// Undo restore returns the conversation memory set to the pre-apply state.
			if (undoRow === undefined) throw new Error("undo snapshot missing");
			const undone = await request<{ ok: true }>("admin/chatSnapshot/apply", { id: undoRow.id });
			expect(undone.ok).toBe(true);
			const restored = await database
				.select()
				.from(memories)
				.where(eq(memories.id, "memory-conv-active"));
			expect(restored[0]?.status).toBe("revoked");

			const audits = await database.select().from(auditLog);
			for (const action of ["chat-snapshot.create", "chat-snapshot.apply"]) {
				expect(audits.some((row) => row.action === action && row.result === "ok")).toBe(true);
			}
		} finally {
			await lifecycle.stop();
		}
	});

	test("blocks apply on pending delivery, unsupported kinds, and missing conversations", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-chat-snapshot-block-"));
		directories.push(directory);
		const { app, lifecycle } = createApp({
			TSUKAIMA_ADMIN_PASSWORD: TEST_ADMIN.password,
			TSUKAIMA_ADMIN_USERNAME: TEST_ADMIN.username,
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7434",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7435",
		});
		await lifecycle.start();
		try {
			const cookie = await signIn(app, TEST_ADMIN.username, TEST_ADMIN.password);
			const request = async <T = unknown>(
				procedure: string,
				input?: unknown,
			): Promise<{ status: number; json: T }> => {
				const response = await app.handle(
					new Request(`http://localhost/rpc/${procedure}`, {
						body: JSON.stringify(input === undefined ? {} : { json: input }),
						headers: { cookie, "content-type": "application/json" },
						method: "POST",
					}),
				);
				const result = (await response.json()) as { json: T };
				return { json: result.json, status: response.status };
			};

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database missing");
			await database.insert(conversations).values([
				{
					// A non-numeric durable id stands in for a workspace session that never opened
					// a real durable conversation; the fence must still classify it as blocked.
					durableConversationId: "durable-block-1",
					id: "session-block-1",
					kind: "workspace",
					title: "Workspace session",
				},
				{
					durableConversationId: "774102",
					id: "session-block-2",
					kind: "private",
					title: "Pending delivery",
				},
			]);
			await database.insert(messages).values({
				conversationId: "session-block-2",
				deliveryStatus: "pending",
				direction: "outbound",
				id: "block-msg-1",
				kind: "onebot-v11",
				occurredAt: new Date(Date.UTC(2026, 10, 14, 1, 0, 0)).toISOString(),
			});

			const workspaceSnapshot = await request<ChatSnapshotRow>("admin/chatSnapshot/create", {
				conversationId: "session-block-1",
			});
			const workspacePreview = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: workspaceSnapshot.json.id,
			});
			expect(workspacePreview.json.applicable).toBe(false);
			expect(workspacePreview.json.blocked.map((block) => block.code)).toContain(
				"unsupported_kind",
			);

			const pendingSnapshot = await request<ChatSnapshotRow>("admin/chatSnapshot/create", {
				conversationId: "session-block-2",
			});
			const pendingPreview = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: pendingSnapshot.json.id,
			});
			expect(pendingPreview.json.applicable).toBe(false);
			expect(pendingPreview.json.blocked.map((block) => block.code)).toContain("delivery_pending");

			const missing = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: "does-not-exist",
			});
			expect(missing.json.applicable).toBe(false);
			expect(missing.json.blocked.map((block) => block.code)).toEqual(["snapshot_missing"]);

			// After the pending delivery settles, the snapshot becomes applicable again.
			await database
				.update(messages)
				.set({ deliveryStatus: "sent" })
				.where(and(eq(messages.id, "block-msg-1")));
			const settledPreview = await request<ChatSnapshotPreview>("admin/chatSnapshot/preview", {
				id: pendingSnapshot.json.id,
			});
			expect(settledPreview.json.applicable).toBe(true);
		} finally {
			await lifecycle.stop();
		}
	});
});
