import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { conversations, memories } from "@elaina/db";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function setup(env: Record<string, string> = {}) {
	const directory = await fs.mkdtemp(join(tmpdir(), "elaina-memory-tools-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		ELAINA_DATA_DIR: directory,
		ELAINA_PORT: "7420",
		...env,
	});
	await lifecycle.start();
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("database not ready");
	await database.insert(conversations).values([
		{
			durableConversationId: "durable-private-tools",
			id: "session-private-tools",
			kind: "private",
			title: "Private tools",
		},
		{
			durableConversationId: "durable-group-tools",
			id: "session-group-tools",
			kind: "group",
			title: "Group tools",
		},
	]);
	return { database, lifecycle };
}

describe("memory tools", () => {
	test("saves, recalls, updates, and forgets through the plugin host under policy gating", async () => {
		const { database, lifecycle } = await setup();
		try {
			const saved = await lifecycle.pluginHost.invokeTool(
				"memory.save",
				{ kind: "preference", summary: "Likes oolong tea" },
				{ conversationId: "durable-private-tools" },
			);
			expect(saved.ok).toBe(true);
			if (!saved.ok) throw new Error("save failed");
			expect(saved.result.content[0]?.text).toContain("Memory saved");
			const [row] = await database.select().from(memories);
			expect(row).toMatchObject({
				conversationId: "session-private-tools",
				kind: "preference",
				scope: "conversation",
				status: "active",
			});
			if (row === undefined) throw new Error("memory missing");

			const recalled = await lifecycle.pluginHost.invokeTool(
				"memory.recall",
				{ query: "oolong" },
				{ conversationId: "durable-private-tools" },
			);
			expect(recalled.ok).toBe(true);
			if (!recalled.ok) throw new Error("recall failed");
			expect(recalled.result.content[0]?.text).toContain("Likes oolong tea");

			const updated = await lifecycle.pluginHost.invokeTool(
				"memory.update",
				{ id: row.id, summary: "Likes oolong and matcha" },
				{ conversationId: "durable-private-tools" },
			);
			expect(updated.ok).toBe(true);
			expect(
				(await database.select().from(memories).where(eq(memories.id, row.id)))[0]?.summary,
			).toBe("Likes oolong and matcha");

			const forgotten = await lifecycle.pluginHost.invokeTool(
				"memory.forget",
				{ id: row.id },
				{ conversationId: "durable-private-tools" },
			);
			expect(forgotten.ok).toBe(true);
			expect(
				(await database.select().from(memories).where(eq(memories.id, row.id)))[0]?.status,
			).toBe("revoked");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-private-tools",
				policy: { memoryEnabled: false },
				scope: "conversation",
			});
			const disabled = await lifecycle.pluginHost.invokeTool(
				"memory.recall",
				{ query: "oolong" },
				{ conversationId: "durable-private-tools" },
			);
			if (!disabled.ok) throw new Error("invocation failed");
			expect(disabled.result.content[0]?.text).toContain("disabled");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-private-tools",
				policy: { memoryEnabled: true, pacing: { allowedTools: ["other.tool"] } },
				scope: "conversation",
			});
			const denied = await lifecycle.pluginHost.invokeTool(
				"memory.recall",
				{ query: "oolong" },
				{ conversationId: "durable-private-tools" },
			);
			if (!denied.ok) throw new Error("invocation failed");
			expect(denied.result.content[0]?.text).toContain("not allowed");
		} finally {
			await lifecycle.stop();
		}
	});

	test("emits plugin trace and debug logs while running every memory tool", async () => {
		const { database, lifecycle } = await setup({ ELAINA_LOG_LEVEL: "trace" });
		try {
			const saved = await lifecycle.pluginHost.invokeTool(
				"memory.save",
				{ kind: "preference", summary: "Likes oolong tea\nand matcha" },
				{ conversationId: "durable-private-tools" },
			);
			if (!saved.ok) throw new Error("save failed");
			const [row] = await database.select().from(memories);
			if (row === undefined) throw new Error("memory missing");

			const recalled = await lifecycle.pluginHost.invokeTool(
				"memory.recall",
				{ limit: 4, query: "oolong" },
				{ conversationId: "durable-private-tools" },
			);
			if (!recalled.ok) throw new Error("recall failed");

			const updated = await lifecycle.pluginHost.invokeTool(
				"memory.update",
				{ id: row.id, summary: "Likes oolong and matcha" },
				{ conversationId: "durable-private-tools" },
			);
			if (!updated.ok) throw new Error("update failed");

			const forgotten = await lifecycle.pluginHost.invokeTool(
				"memory.forget",
				{ id: row.id },
				{ conversationId: "durable-private-tools" },
			);
			if (!forgotten.ok) throw new Error("forget failed");

			const pluginEntries = lifecycle.logs
				.list({ limit: 500 })
				.filter((entry) => entry.target.startsWith("elaina::plugin::memory"));
			const find = (message: string) => pluginEntries.find((entry) => entry.message === message);

			expect(find("memory plugin ready")).toMatchObject({
				level: "info",
				target: "elaina::plugin::memory",
			});
			expect(find("memory plugin ready")?.fields.tools).toEqual([
				"memory.recall",
				"memory.save",
				"memory.update",
				"memory.forget",
			]);

			const saveStart = find("memory.save start");
			expect(saveStart).toMatchObject({
				level: "trace",
				target: "elaina::plugin::memory::tools",
			});
			expect(saveStart?.fields).toMatchObject({
				conversationId: "durable-private-tools",
				kind: "preference",
				scope: "conversation",
				sessionId: "session-private-tools",
				summary: "Likes oolong tea\\nand matcha",
			});
			expect(find("memory.save complete")?.fields).toMatchObject({
				merged: false,
				memoryId: row.id,
				status: "active",
			});
			expect(find("memory.save complete")?.level).toBe("debug");

			expect(find("memory.recall start")?.level).toBe("trace");
			expect(find("memory.recall start")?.fields).toMatchObject({
				limit: 4,
				query: "oolong",
				sessionId: "session-private-tools",
			});
			expect(find("memory.recall complete")).toMatchObject({ level: "debug" });
			expect(find("memory.recall complete")?.fields.resultCount).toBe(1);

			expect(find("memory.update start")?.level).toBe("trace");
			expect(find("memory.update start")?.fields).toMatchObject({ id: row.id });
			expect(find("memory.update complete")).toMatchObject({ level: "debug" });
			expect(find("memory.update complete")?.fields.memoryId).toBe(row.id);

			expect(find("memory.forget start")?.level).toBe("trace");
			expect(find("memory.forget start")?.fields).toMatchObject({ id: row.id });
			expect(find("memory.forget complete")).toMatchObject({ level: "debug" });
			expect(find("memory.forget complete")?.fields).toMatchObject({
				memoryId: row.id,
				status: "revoked",
			});

			for (const message of [
				"memory.save start",
				"memory.recall start",
				"memory.update start",
				"memory.forget start",
			]) {
				expect(find(message)?.fields.durationMs).toBeUndefined();
				const preview = find(message)?.fields.summary ?? find(message)?.fields.query;
				if (typeof preview === "string") {
					expect(preview.length).toBeLessThanOrEqual(120);
					expect(preview).not.toContain("\n");
				}
			}
			for (const message of [
				"memory.save complete",
				"memory.recall complete",
				"memory.update complete",
				"memory.forget complete",
			]) {
				expect(typeof find(message)?.fields.durationMs).toBe("number");
			}
		} finally {
			await lifecycle.stop();
		}
	});

	test("forces group shared writes into pending conversation memory when disabled", async () => {
		const { database, lifecycle } = await setup();
		try {
			await lifecycle.conversationPolicy.update({
				conversationId: "session-group-tools",
				policy: { sharedMemoryWriteEnabled: false },
				scope: "conversation",
			});
			const saved = await lifecycle.pluginHost.invokeTool(
				"memory.save",
				{ kind: "fact", scope: "global", summary: "Group shared fact" },
				{ conversationId: "durable-group-tools" },
			);
			if (!saved.ok) throw new Error("save failed");
			expect(saved.result.content[0]?.text).toContain("pending");
			const [row] = await database.select().from(memories);
			expect(row).toMatchObject({
				conversationId: "session-group-tools",
				scope: "conversation",
				status: "pending",
			});

			const globalRow = await lifecycle.memory.create({
				content: "Global baseline",
				createdBy: "system",
				kind: "fact",
				scope: "global",
				summary: "Global baseline",
				visibility: "shared",
			});
			const blockedUpdate = await lifecycle.pluginHost.invokeTool(
				"memory.update",
				{ id: globalRow.memory.id, summary: "Overwritten baseline" },
				{ conversationId: "durable-group-tools" },
			);
			if (!blockedUpdate.ok) throw new Error("update call failed");
			expect(blockedUpdate.result.content[0]?.text).toContain("Shared memory writes are disabled");

			await lifecycle.memory.create({
				content: "Private session secret",
				conversationId: "session-private-tools",
				createdBy: "agent",
				kind: "persona",
				scope: "persona",
				summary: "SECRET-OTHER-PERSONA",
			});
			const recall = await lifecycle.pluginHost.invokeTool(
				"memory.recall",
				{ query: "SECRET-OTHER-PERSONA" },
				{ conversationId: "durable-group-tools" },
			);
			if (!recall.ok) throw new Error("recall call failed");
			expect(recall.result.content[0]?.text).not.toContain("SECRET-OTHER-PERSONA");
		} finally {
			await lifecycle.stop();
		}
	});
});
