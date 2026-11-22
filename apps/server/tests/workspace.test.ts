import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
	chatObjects,
	codingTasks,
	conversations,
	messages,
	workspaceReferences,
	workspaceSessions,
	workspaceTodos,
} from "@tsukaima/db";
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

	test("starts a draft workspace from its first message exactly once", async () => {
		const lifecycle = await startApp();
		const draft = await lifecycle.workspace.create({});
		expect(draft.taskId).toBeNull();
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const [before] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, draft.sessionId))
			.limit(1);
		expect(before?.taskId).toBeNull();
		expect(before?.goal).toBeNull();

		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: draft.sessionId,
			source: "webui",
			text: "Add a draft workspace status badge.",
		});
		const [after] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, draft.sessionId))
			.limit(1);
		expect(after?.taskId).not.toBeNull();
		expect(after?.goal).toContain("draft workspace status badge");
		expect(after?.tagsJson).toBe("[]");
		const taskId = after?.taskId;
		if (taskId === null || taskId === undefined) throw new Error("Task was not created");
		const [task] = await database
			.select()
			.from(codingTasks)
			.where(eq(codingTasks.id, taskId))
			.limit(1);
		expect(task?.goal).toContain("draft workspace status badge");
		expect(task?.mode).toBe("maintenance");

		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: draft.sessionId,
			source: "webui",
			text: "Keep the badge compact.",
		});
		const tasks = await database.select().from(codingTasks);
		expect(tasks).toHaveLength(1);
		expect((await lifecycle.workspace.list())[0]?.title).toContain("draft workspace status badge");
		await lifecycle.stop();
	});

	test("stores an explicit workspace model and reasoning override", async () => {
		const lifecycle = await startApp();
		const workspace = await lifecycle.workspace.create({
			model: { modelId: "fake-deterministic", providerId: "fake" },
			thinking: "high",
		});
		const policy = await lifecycle.conversationPolicy.effectivePolicy(workspace.sessionId);
		expect(policy.model).toEqual({
			modelId: "fake-deterministic",
			providerId: "fake",
		});
		expect(policy.thinking).toBe("high");
		expect(
			lifecycle.conversationHost?.resolveModelRef({
				modelId: "missing-model",
				providerId: "fake",
			}),
		).toBeUndefined();
		await expect(
			lifecycle.workspace.create({
				model: { modelId: "missing-model", providerId: "fake" },
			}),
		).rejects.toThrow("is not available");
		await lifecycle.stop();
	});

	test("stores workspace todos and referenced conversation context", async () => {
		const lifecycle = await startApp();
		const parent = await createLocalChat(lifecycle, {
			sessionTitle: "Reference source",
			title: "Admin chat",
		});
		const workspace = await lifecycle.workspace.create({});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Use the referenced conversation to plan the change.",
			references: [{ sessionId: parent.sessionId }],
		});
		const todos = await lifecycle.workspaceTodos.replace(workspace.sessionId, [
			{ content: "Inspect the referenced transcript" },
			{ content: "Add a regression test", status: "completed" },
		]);
		expect(todos.map((todo) => todo.status)).toEqual(["in_progress", "completed"]);
		const storedTodos = await database
			.select()
			.from(workspaceTodos)
			.where(eq(workspaceTodos.workspaceSessionId, workspace.sessionId));
		expect(storedTodos).toHaveLength(2);
		const references = await database
			.select()
			.from(workspaceReferences)
			.where(eq(workspaceReferences.sourceSessionId, workspace.sessionId));
		expect(references[0]?.targetSessionId).toBe(parent.sessionId);
		const detail = await lifecycle.workspace.get(workspace.sessionId);
		expect(detail?.todos).toHaveLength(2);
		expect(detail?.references[0]?.sessionId).toBe(parent.sessionId);
		await expect(
			lifecycle.workspaceTodos.replace(workspace.sessionId, [
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
			]),
		).rejects.toThrow("At most one todo can be in progress");
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
		});
		const detail = await lifecycle.workspace.get(spawned.sessionId);
		expect(detail?.workspace.parentSessionId).toBe(parent.sessionId);
		expect(detail?.workspace.goal).toContain("status card");
		await lifecycle.stop();
	});

	test("spawnFromSession dispatches the workspace run, reports latestReply, and notifies parent on completion", async () => {
		const lifecycle = await startApp();
		const parent = await createLocalChat(lifecycle, {
			sessionTitle: "Main",
			title: "Admin chat",
		});
		const spawned = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			goal: "Inspect and fix the synthetic bug.",
		});
		const deadline = Date.now() + 8_000;
		let parentNotified = false;
		let statusSnapshot: Record<string, unknown> | undefined;
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		while (Date.now() < deadline) {
			statusSnapshot = await lifecycle.workspace.status({ sessionId: spawned.sessionId });
			const parentMessages = await database
				.select({ contentText: messages.contentText, direction: messages.direction })
				.from(messages)
				.where(eq(messages.conversationId, parent.sessionId));
			parentNotified = parentMessages.some(
				(row) =>
					row.direction === "system" &&
					(row.contentText ?? "").includes("[Workspace subagent finished]"),
			);
			if (
				statusSnapshot.running === false &&
				typeof statusSnapshot.latestReply === "string" &&
				statusSnapshot.latestReply.length > 0 &&
				parentNotified
			) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		expect(statusSnapshot?.running).toBe(false);
		expect(typeof statusSnapshot?.latestReply).toBe("string");
		expect(String(statusSnapshot?.latestReply ?? "").length).toBeGreaterThan(0);
		expect(parentNotified).toBe(true);
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
		expect(parentTools).toContain("tool_search");
		expect(workspaceTools).toContain("workspace_status");
		expect(workspaceTools).toContain("workspace_git_identity");
		expect(workspaceTools).not.toContain("workspace_spawn");
		expect(workspaceTools).not.toContain("session_lookup");
		expect(workspaceTools).toContain("todo_write");
		expect(workspaceTools).toContain("db_query");
		expect(parentTools).not.toContain("workspace_git_identity");
		expect(parentTools).not.toContain("todo_write");
		expect(parentTools).not.toContain("db_query");
		expect(workspaceTools).not.toContain("search");

		const found = await lifecycle.sessionMessaging.searchSessions("Admin chat");
		expect(found[0]?.id).toBe(parent.sessionId);
		await lifecycle.stop();
	});
});
