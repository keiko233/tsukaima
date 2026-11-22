import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, messages } from "@tsukaima/db";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function setup() {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-chat-history-"));
	directories.push(directory);
	const { lifecycle } = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7423",
	});
	await lifecycle.start();
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("database not ready");
	await database.insert(conversations).values([
		{
			durableConversationId: "durable-history-private",
			id: "session-history-private",
			kind: "private",
			title: "Synthetic private current",
		},
		{
			durableConversationId: "durable-history-group",
			id: "session-history-group",
			kind: "group",
			title: "Synthetic group current",
		},
		{
			durableConversationId: "durable-history-webui",
			id: "session-history-webui",
			kind: "webui",
			title: "Synthetic webui current",
		},
		{
			durableConversationId: "durable-history-private-other",
			id: "session-history-private-other",
			kind: "private",
			title: "Synthetic private other",
		},
		{
			durableConversationId: "durable-history-group-other",
			id: "session-history-group-other",
			kind: "group",
			title: "Synthetic group other",
		},
		{
			durableConversationId: "durable-history-workspace",
			id: "session-history-workspace",
			kind: "workspace",
			title: "Synthetic workspace",
		},
		{
			durableConversationId: "durable-history-task",
			id: "session-history-task",
			kind: "task",
			title: "Synthetic task",
		},
		{
			durableConversationId: "durable-history-plugin",
			id: "session-history-plugin",
			kind: "plugin",
			title: "Synthetic plugin",
		},
	]);
	await database.insert(messages).values([
		{
			contentText: "Synthetic first line",
			conversationId: "session-history-private",
			direction: "inbound",
			id: "msg-private-1",
			kind: "text",
			occurredAt: "2025-01-01T10:00:00.000Z",
			senderDisplayName: "Synthetic Speaker",
			senderExternalId: "synth-speaker-1",
		},
		{
			contentText: "Synthetic second line",
			conversationId: "session-history-private",
			direction: "inbound",
			id: "msg-private-2",
			kind: "text",
			occurredAt: "2025-01-01T10:01:00.000Z",
			senderDisplayName: "Synthetic Speaker",
		},
		{
			contentText: "Synthetic third line",
			conversationId: "session-history-private",
			direction: "inbound",
			id: "msg-private-3",
			kind: "text",
			occurredAt: "2025-01-01T10:02:00.000Z",
			senderDisplayName: "Synthetic Speaker",
		},
		{
			contentText: "SECRET-TOOL-CONTENT",
			conversationId: "session-history-private",
			direction: "outbound",
			id: "msg-private-tool",
			kind: "tool",
			occurredAt: "2025-01-01T10:02:30.000Z",
			senderDisplayName: "Synthetic Speaker",
		},
		{
			contentText: "Synthetic fourth line",
			conversationId: "session-history-private",
			direction: "inbound",
			id: "msg-private-4",
			kind: "text",
			occurredAt: "2025-01-01T10:03:00.000Z",
			senderDisplayName: "Synthetic Speaker",
		},
		{
			contentText: "Synthetic fifth line",
			conversationId: "session-history-private",
			direction: "outbound",
			id: "msg-private-5",
			kind: "text",
			occurredAt: "2025-01-01T10:04:00.000Z",
			senderDisplayName: "Synthetic Assistant",
		},
		{
			contentText: "Synthetic other private phrase",
			conversationId: "session-history-private-other",
			direction: "inbound",
			id: "msg-private-other-1",
			kind: "text",
			occurredAt: "2025-01-01T09:00:00.000Z",
			senderDisplayName: "Synthetic Other Speaker",
		},
		{
			contentText: "Synthetic group greeting",
			conversationId: "session-history-group-other",
			direction: "inbound",
			id: "msg-group-other-1",
			kind: "text",
			occurredAt: "2025-01-01T09:05:00.000Z",
			senderDisplayName: "Synthetic Group Speaker",
		},
		{
			contentText: "Synthetic webui note",
			conversationId: "session-history-webui",
			direction: "inbound",
			id: "msg-webui-1",
			kind: "text",
			occurredAt: "2025-01-01T09:10:00.000Z",
			senderDisplayName: "Synthetic WebUI Speaker",
		},
		{
			contentText: "SECRET-WORKSPACE-CONTENT",
			conversationId: "session-history-workspace",
			direction: "inbound",
			id: "msg-workspace-1",
			kind: "text",
			occurredAt: "2025-01-01T09:15:00.000Z",
			senderDisplayName: "Synthetic Workspace Speaker",
		},
		{
			contentText: "SECRET-TASK-CONTENT",
			conversationId: "session-history-task",
			direction: "inbound",
			id: "msg-task-1",
			kind: "text",
			occurredAt: "2025-01-01T09:20:00.000Z",
			senderDisplayName: "Synthetic Task Speaker",
		},
		{
			contentText: "SECRET-PLUGIN-CONTENT",
			conversationId: "session-history-plugin",
			direction: "inbound",
			id: "msg-plugin-1",
			kind: "text",
			occurredAt: "2025-01-01T09:25:00.000Z",
			senderDisplayName: "Synthetic Plugin Speaker",
		},
	]);
	return { database, lifecycle };
}

type Lifecycle = ReturnType<typeof createApp>["lifecycle"];
async function invoke(
	lifecycle: Lifecycle,
	tool: string,
	input: Record<string, unknown>,
	durableConversationId: string,
): Promise<string> {
	const result = await lifecycle.pluginHost.invokeTool(tool, input, {
		conversationId: durableConversationId,
	});
	if (!result.ok) throw new Error(`tool invocation failed: ${tool}`);
	return result.result.content[0]?.text ?? "";
}

function messageIds(text: string): string[] {
	return [...text.matchAll(/\[msg:([^\]]+)\]/gu)].map((match) => match[1] ?? "");
}

describe("chat history tools", () => {
	test("searches and reads the current session with around/before/after pagination", async () => {
		const { lifecycle } = await setup();
		try {
			const search = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic fourth" },
				"durable-history-private",
			);
			expect(search).toContain("Synthetic fourth line");
			expect(search).toContain("[msg:msg-private-4]");
			expect(search).toContain("[session:session-history-private]");

			const toolSearch = await invoke(
				lifecycle,
				"history.search",
				{ query: "SECRET-TOOL-CONTENT" },
				"durable-history-private",
			);
			expect(toolSearch).toBe("No matching messages.");

			const around = await invoke(
				lifecycle,
				"history.read",
				{ aroundMessageId: "msg-private-3", limit: 3 },
				"durable-history-private",
			);
			expect(messageIds(around)).toEqual(["msg-private-3", "msg-private-4", "msg-private-5"]);
			expect(around).not.toContain("Synthetic second line");

			const before = await invoke(
				lifecycle,
				"history.read",
				{ before: "2025-01-01T10:02:00.000Z", limit: 2 },
				"durable-history-private",
			);
			expect(messageIds(before)).toEqual(["msg-private-1", "msg-private-2"]);

			const after = await invoke(
				lifecycle,
				"history.read",
				{ after: "msg-private-3", limit: 2 },
				"durable-history-private",
			);
			expect(messageIds(after)).toEqual(["msg-private-4", "msg-private-5"]);

			const latest = await invoke(
				lifecycle,
				"history.read",
				{ limit: 2 },
				"durable-history-private",
			);
			expect(messageIds(latest)).toEqual(["msg-private-4", "msg-private-5"]);
			expect(latest).not.toContain("SECRET-TOOL-CONTENT");
		} finally {
			await lifecycle.stop();
		}
	});

	test("searches and reads private, group, and webui sessions from a private session", async () => {
		const { lifecycle } = await setup();
		try {
			const sessions = await invoke(
				lifecycle,
				"history.sessions",
				{ query: "Synthetic" },
				"durable-history-private",
			);
			expect(sessions).toContain("[session:session-history-private]");
			expect(sessions).toContain("[session:session-history-private-other]");
			expect(sessions).toContain("[session:session-history-group-other]");
			expect(sessions).toContain("[session:session-history-webui]");
			expect(sessions).not.toContain("session-history-workspace");
			expect(sessions).not.toContain("session-history-task");
			expect(sessions).not.toContain("session-history-plugin");

			const privateOther = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-private",
			);
			expect(privateOther).toContain("Synthetic other private phrase");
			expect(privateOther).toContain("[session:session-history-private-other]");

			const groupOther = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic group greeting" },
				"durable-history-private",
			);
			expect(groupOther).toContain("Synthetic group greeting");
			expect(groupOther).toContain("[session:session-history-group-other]");

			const webuiRead = await invoke(
				lifecycle,
				"history.read",
				{ sessionId: "session-history-webui", limit: 1 },
				"durable-history-private",
			);
			expect(webuiRead).toContain("Synthetic webui note");
			expect(webuiRead).toContain("[session:session-history-webui]");

			const webuiSearch = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic group greeting" },
				"durable-history-webui",
			);
			expect(webuiSearch).toContain("Synthetic group greeting");
		} finally {
			await lifecycle.stop();
		}
	});

	test("excludes tool messages and workspace, task, and plugin sessions", async () => {
		const { lifecycle } = await setup();
		try {
			for (const query of ["SECRET-TOOL-CONTENT", "SECRET-WORKSPACE-CONTENT"]) {
				const result = await invoke(
					lifecycle,
					"history.search",
					{ query },
					"durable-history-private",
				);
				expect(result).toBe("No matching messages.");
			}
			const task = await invoke(
				lifecycle,
				"history.search",
				{ query: "SECRET-TASK-CONTENT" },
				"durable-history-private",
			);
			expect(task).toBe("No matching messages.");
			const plugin = await invoke(
				lifecycle,
				"history.search",
				{ query: "SECRET-PLUGIN-CONTENT" },
				"durable-history-private",
			);
			expect(plugin).toBe("No matching messages.");
		} finally {
			await lifecycle.stop();
		}
	});

	test("enforces cross-session policy and private-to-group privacy", async () => {
		const { lifecycle } = await setup();
		try {
			const indicatorSessions = await invoke(
				lifecycle,
				"history.sessions",
				{},
				"durable-history-group",
			);
			expect(indicatorSessions).toContain("[session:session-history-private-other]");
			expect(indicatorSessions).toContain("(title hidden)");
			expect(indicatorSessions).not.toContain("Synthetic private other");

			const indicatorSearch = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-group",
			);
			expect(indicatorSearch).toContain("[msg:msg-private-other-1]");
			expect(indicatorSearch).not.toContain("Synthetic other private phrase");
			expect(indicatorSearch).not.toContain("Synthetic private other");
			expect(indicatorSearch).toContain("content hidden");

			const indicatorRead = await invoke(
				lifecycle,
				"history.read",
				{ sessionId: "session-history-private-other" },
				"durable-history-group",
			);
			expect(indicatorRead).toContain("may not read private chat messages");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-group",
				policy: { crossSession: { privateToGroup: "none" } },
				scope: "conversation",
			});
			const noneSessions = await invoke(lifecycle, "history.sessions", {}, "durable-history-group");
			expect(noneSessions).not.toContain("session-history-private-other");
			const noneSearch = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-group",
			);
			expect(noneSearch).toBe("No matching messages.");
			const noneRead = await invoke(
				lifecycle,
				"history.read",
				{ sessionId: "session-history-private-other" },
				"durable-history-group",
			);
			expect(noneRead).toContain("hidden from group conversations");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-group",
				policy: { crossSession: { privateToGroup: "text" } },
				scope: "conversation",
			});
			const textSearch = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-group",
			);
			expect(textSearch).toContain("Synthetic other private phrase");
			expect(textSearch).toContain("Synthetic private other");
			const textRead = await invoke(
				lifecycle,
				"history.read",
				{ sessionId: "session-history-private-other" },
				"durable-history-group",
			);
			expect(textRead).toContain("Synthetic other private phrase");
		} finally {
			await lifecycle.stop();
		}
	});

	test("disabling cross-session keeps the current session usable and hides other sessions", async () => {
		const { lifecycle } = await setup();
		try {
			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-private",
				policy: { crossSession: { enabled: false } },
				scope: "conversation",
			});
			const current = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic fourth" },
				"durable-history-private",
			);
			expect(current).toContain("Synthetic fourth line");

			const cross = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-private",
			);
			expect(cross).toBe("No matching messages.");

			const sessions = await invoke(lifecycle, "history.sessions", {}, "durable-history-private");
			expect(sessions).toContain("[session:session-history-private]");
			expect(sessions).not.toContain("session-history-private-other");

			const read = await invoke(
				lifecycle,
				"history.read",
				{ sessionId: "session-history-private-other" },
				"durable-history-private",
			);
			expect(read).toContain("Cross-session history is disabled");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-private-other",
				policy: { crossSession: { enabled: false } },
				scope: "conversation",
			});
			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-private",
				policy: { crossSession: { enabled: true } },
				scope: "conversation",
			});
			const targetDisabled = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic other private phrase" },
				"durable-history-private",
			);
			expect(targetDisabled).toBe("No matching messages.");
		} finally {
			await lifecycle.stop();
		}
	});

	test("denies workspace sessions and respects the conversation tool allowlist", async () => {
		const { lifecycle } = await setup();
		try {
			const workspace = await invoke(
				lifecycle,
				"history.sessions",
				{},
				"durable-history-workspace",
			);
			expect(workspace).toContain("not available in workspace sessions");

			await lifecycle.conversationPolicy.update({
				conversationId: "session-history-private",
				policy: { pacing: { allowedTools: ["other.tool"] } },
				scope: "conversation",
			});
			const denied = await invoke(
				lifecycle,
				"history.search",
				{ query: "Synthetic fourth" },
				"durable-history-private",
			);
			expect(denied).toContain("not allowed in this conversation");

			for (const name of ["history.sessions", "history.search", "history.read"]) {
				const tool = lifecycle.pluginHost.tools().find((entry) => entry.name === name);
				expect(tool?.policy?.lazy).toBe(false);
				expect(tool?.policy?.surface).toBe("chat");
			}
		} finally {
			await lifecycle.stop();
		}
	});
});
