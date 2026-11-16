import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { chatObjects, conversations, messages, workspaceSessions } from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { createLocalChat, listChats } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function startApp() {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-workspace-"));
	directories.push(directory);
	const app = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7420",
		TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
	});
	await app.lifecycle.start();
	return app.lifecycle;
}

describe("workspace sessions", () => {
	test("creates a coding workspace, keeps it out of chat, and shares durable delivery", async () => {
		const lifecycle = await startApp();
		const parent = await createLocalChat(lifecycle, {
			sessionTitle: "Main",
			title: "Admin chat",
		});
		const workspace = await lifecycle.workspace.create({
			goal: "Fix the broken restart countdown and add a regression test.",
			parentSessionId: parent.sessionId,
			requestedBy: "test-admin",
		});

		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const [workspaceRow] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, workspace.sessionId))
			.limit(1);
		expect(workspaceRow?.taskId).toBe(workspace.taskId);
		expect(workspaceRow?.parentSessionId).toBe(parent.sessionId);
		expect(workspaceRow?.repositoryRoot).toBe(process.cwd());

		const [chatRow] = await database
			.select()
			.from(chatObjects)
			.where(eq(chatObjects.id, workspace.chatId))
			.limit(1);
		expect(chatRow?.kind).toBe("workspace");
		const [sessionRow] = await database
			.select()
			.from(conversations)
			.where(eq(conversations.id, workspace.sessionId))
			.limit(1);
		expect(sessionRow?.kind).toBe("workspace");

		const policy = await lifecycle.conversationPolicy.effectivePolicy(workspace.sessionId);
		expect(policy.capabilities).toContain("coding");

		const detail = await lifecycle.workspace.get(workspace.sessionId);
		expect(detail?.workspace.taskId).toBe(workspace.taskId);
		expect(detail?.workspace.taskStatus).toBe("pending");
		expect((await lifecycle.workspace.list()).map((entry) => entry.id)).toEqual([
			workspace.sessionId,
		]);

		const chatList = await listChats(lifecycle, { status: "all" });
		expect(chatList.some((chat) => chat.id === workspace.chatId)).toBe(false);
		expect(chatList.some((chat) => chat.id === parent.chatId)).toBe(true);

		const sent = await lifecycle.sessionMessaging.sendAgentMessage({
			deliveryMode: "queue",
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Also cover the restart countdown wording.",
		});
		const [stored] = await database
			.select()
			.from(messages)
			.where(eq(messages.id, sent.messageId))
			.limit(1);
		expect(stored?.deliveryStatus).toBe("accepted");
		expect(stored?.contentText).toContain("restart countdown");

		await lifecycle.stop();
	});

	test("chat can spawn a workspace through the same service boundary", async () => {
		const lifecycle = await startApp();
		const parent = await createLocalChat(lifecycle, {
			sessionTitle: "Main",
			title: "Admin chat",
		});
		const spawned = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			goal: "Add a workspace status card.",
			mode: "patch",
		});
		const detail = await lifecycle.workspace.get(spawned.sessionId);
		expect(detail?.workspace.parentSessionId).toBe(parent.sessionId);
		expect(detail?.workspace.goal).toContain("status card");
		await lifecycle.stop();
	});

	test("chat gets workspace controls but workspace alone gets coding tools", async () => {
		const lifecycle = await startApp();
		const parent = await createLocalChat(lifecycle, {
			sessionTitle: "Main",
			title: "Admin chat",
		});
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: parent.sessionId,
			source: "webui",
			text: "Say hello without changing code.",
		});
		const workspace = await lifecycle.workspace.create({
			goal: "Inspect the chat tool policy.",
			parentSessionId: parent.sessionId,
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		const host = lifecycle.conversationHost;
		if (database === undefined || host === undefined) throw new Error("Lifecycle not ready");
		const sessions = await database.select().from(conversations);
		const parentDurable = sessions.find(
			(session) => session.id === parent.sessionId,
		)?.durableConversationId;
		const workspaceDurable = sessions.find(
			(session) => session.id === workspace.sessionId,
		)?.durableConversationId;
		if (parentDurable === undefined || workspaceDurable === undefined) {
			throw new Error("Durable conversation missing");
		}
		const parentTools = (await host.inspectConversationContext(parentDurable))?.tools.map(
			(tool) => tool.name,
		);
		const workspaceTools = (await host.inspectConversationContext(workspaceDurable))?.tools.map(
			(tool) => tool.name,
		);
		expect(parentTools).toContain("workspace_spawn");
		expect(parentTools).toContain("session_lookup");
		expect(parentTools?.some((name) => name.startsWith("self-iteration_"))).toBe(false);
		expect(workspaceTools).toContain("workspace_status");
		expect(workspaceTools).not.toContain("workspace_spawn");
		expect(workspaceTools?.some((name) => name.startsWith("self-iteration_"))).toBe(true);

		const found = await lifecycle.sessionMessaging.searchSessions("Admin chat");
		expect(found[0]?.id).toBe(parent.sessionId);
		await lifecycle.stop();
	});
});
