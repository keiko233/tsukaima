import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DurableExtension } from "@tsukaima/core";
import { auditLog, chatObjects, conversations, messages, workspaceSessions } from "@tsukaima/db";
import { createApp } from "../src/app.ts";
import { resolveImCallerContext } from "../src/services/im-caller-context.ts";
import { computeOmittedSessionTools } from "../src/services/session-tool-policy.ts";
import {
	authorizeSandboxToolCall,
	SANDBOX_MAX_ACTIVE_PER_PARENT,
} from "../src/services/workspace-authorization.ts";
import { SANDBOX_WORKSPACE_TOOL_NAMES } from "../src/services/workspace-tools.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function startApp() {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-sandbox-workspace-"));
	directories.push(directory);
	const app = createApp({
		TSUKAIMA_DATA_DIR: directory,
		TSUKAIMA_PORT: "7420",
		TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
	});
	await app.lifecycle.start();
	return app.lifecycle;
}

async function chatSession(
	lifecycle: Awaited<ReturnType<typeof startApp>>,
	kind: "group" | "private",
	options: { readonly senderPlatformId?: string } = {},
) {
	const database = lifecycle.domainDatabase;
	const host = lifecycle.conversationHost;
	if (database === undefined || host === undefined) throw new Error("Lifecycle not ready");
	const chatId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const durableConversationId = await host.createConversation();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		createdAt: now,
		id: chatId,
		kind,
		platformConversationId: `synthetic-${kind}`,
		title: `Synthetic ${kind}`,
		updatedAt: now,
	});
	await database.insert(conversations).values({
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: sessionId,
		isReceiving: 1,
		kind,
		platformConversationId: `synthetic-${kind}`,
		title: `Synthetic ${kind}`,
		updatedAt: now,
	});
	if (kind === "group" && options.senderPlatformId !== undefined) {
		await database.insert(messages).values({
			chatObjectId: chatId,
			contentText: "synthetic group trigger",
			conversationId: sessionId,
			direction: "inbound",
			id: crypto.randomUUID(),
			ingestedAt: now,
			kind: "onebot-v11",
			occurredAt: now,
			platformMessageId: `synthetic-${crypto.randomUUID()}`,
			senderDisplayName: "Synthetic speaker",
			senderExternalId: options.senderPlatformId,
			updatedAt: now,
		});
	}
	return { chatId, durableConversationId, sessionId };
}

function workspaceToolsExtension(
	lifecycle: Awaited<ReturnType<typeof startApp>>,
): DurableExtension {
	const extension = (lifecycle as unknown as { workspaceToolsExtension?: DurableExtension })
		.workspaceToolsExtension;
	if (extension === undefined) throw new Error("workspace tools extension missing");
	return extension;
}

function extensionTool(extension: DurableExtension, name: string) {
	const found = (extension.tools ?? []).find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Tool ${name} missing from ${extension.name}`);
	return found;
}

async function executeTool(
	extension: DurableExtension,
	name: string,
	args: Record<string, unknown>,
	durableConversationId: string,
) {
	const tool = extensionTool(extension, name);
	return await tool.execute(
		args,
		{ conversationId: Number(durableConversationId) } as unknown as Parameters<
			typeof tool.execute
		>[1],
		undefined as never,
	);
}

function resultText(result: unknown): string {
	const output = (result as { readonly output?: readonly unknown[] }).output;
	for (const part of output ?? []) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			return part.text;
		}
	}
	return "";
}

describe("sandbox workspaces", () => {
	test("non-admin private and group callers use the sandbox tool surface end to end", async () => {
		const lifecycle = await startApp();
		const extension = workspaceToolsExtension(lifecycle);
		for (const kind of ["private", "group"] as const) {
			const parent = await chatSession(lifecycle, kind, { senderPlatformId: "synthetic-owner" });
			await lifecycle.conversationPolicy.update({
				conversationId: parent.sessionId,
				policy: { sandboxWorkspaceEnabled: true, workspaceDelegationEnabled: true },
				scope: "conversation",
			});
			const spawned = await executeTool(
				extension,
				"sandbox_spawn",
				{ goal: "Summarize a synthetic document into output/summary.txt." },
				parent.durableConversationId,
			);
			const spawnText = resultText(spawned);
			expect(spawnText).not.toContain("admin_required");
			const spawnedPayload = JSON.parse(spawnText) as {
				readonly sessionId: string;
				readonly workspaceKind: string;
			};
			expect(spawnedPayload.workspaceKind).toBe("sandbox");
			const status = await executeTool(
				extension,
				"sandbox_status",
				{ sessionId: spawnedPayload.sessionId },
				parent.durableConversationId,
			);
			expect(resultText(status)).toContain(spawnedPayload.sessionId);
			const send = await executeTool(
				extension,
				"sandbox_send",
				{ sessionId: spawnedPayload.sessionId, text: "Also include a one-line abstract." },
				parent.durableConversationId,
			);
			expect(resultText(send)).toContain(spawnedPayload.sessionId);

			const denied = await executeTool(
				extension,
				"workspace_spawn",
				{ goal: "Synthetic admin-only coding delegation." },
				parent.durableConversationId,
			);
			expect(resultText(denied)).toContain("admin_required");

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Database not ready");
			const audits = await database.select().from(auditLog);
			expect(
				audits.find(
					(row) =>
						row.action === "sandbox-tool.sandbox_spawn" &&
						row.actorId === (kind === "private" ? "synthetic-private" : "synthetic-owner") &&
						row.result === "ok",
				),
			).toMatchObject({ actorKind: "user", targetKind: "workspace-tool" });
			expect(
				audits.find((row) => row.action === "sandbox-tool.sandbox_send" && row.result === "ok"),
			).toBeDefined();
		}
		await lifecycle.stop();
	}, 30_000);

	test("policy toggle hides sandbox tools and runtime denies them", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "group", { senderPlatformId: "synthetic-owner" });
		await lifecycle.conversationPolicy.update({
			conversationId: parent.sessionId,
			policy: { sandboxWorkspaceEnabled: false },
			scope: "conversation",
		});
		const policy = await lifecycle.conversationPolicy.effectivePolicy(parent.sessionId);
		const omitted = computeOmittedSessionTools({
			agentAccess: true,
			capabilities: policy.capabilities,
			chatSurfaceOmitted: [],
			codingSurfaceOmitted: [],
			kind: "group",
			proactiveTools: [],
			readFailed: false,
			sandboxWorkspaceEnabled: policy.sandboxWorkspaceEnabled === true,
			workspaceDelegationEnabled: false,
		});
		for (const name of SANDBOX_WORKSPACE_TOOL_NAMES) expect(omitted).toContain(name);
		const extension = workspaceToolsExtension(lifecycle);
		const denied = await executeTool(
			extension,
			"sandbox_spawn",
			{ goal: "This must not spawn." },
			parent.durableConversationId,
		);
		expect(resultText(denied)).toContain("sandbox_workspace_disabled");
		await lifecycle.stop();
	});

	test("enforces the per-parent active sandbox quota", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "private", {
			senderPlatformId: "synthetic-owner",
		});
		for (let index = 0; index < SANDBOX_MAX_ACTIVE_PER_PARENT; index += 1) {
			await lifecycle.workspace.spawnFromSession(parent.sessionId, {
				goal: `Synthetic quota task ${index}.`,
				requestedBy: "im:synthetic-owner",
				workspaceKind: "sandbox",
			});
		}
		await expect(
			lifecycle.workspace.spawnFromSession(parent.sessionId, {
				goal: "Synthetic over-quota task.",
				requestedBy: "im:synthetic-owner",
				workspaceKind: "sandbox",
			}),
		).rejects.toThrow("sandbox_quota_exceeded");
		await lifecycle.stop();
	}, 20_000);

	test("workspace sessions cannot call sandbox tools and proactive turns fail closed", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "group", { senderPlatformId: "synthetic-owner" });
		const workspace = await lifecycle.workspace.create({
			goal: "Synthetic coding workspace.",
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const [workspaceConversation] = await database
			.select({ durableConversationId: conversations.durableConversationId })
			.from(conversations)
			.where(eq(conversations.id, workspace.sessionId))
			.limit(1);
		if (workspaceConversation === undefined) throw new Error("Workspace conversation missing");
		const extension = workspaceToolsExtension(lifecycle);
		const fromWorkspace = await executeTool(
			extension,
			"sandbox_spawn",
			{ goal: "Must not spawn from workspace." },
			workspaceConversation.durableConversationId,
		);
		expect(resultText(fromWorkspace)).toContain("sandbox_spawn_not_permitted");
		const proactive = await resolveImCallerContext({
			conversationId: parent.durableConversationId,
			database,
			overrides: { turnBoundSender: null },
			settings: lifecycle.pluginSettings,
		});
		expect(proactive.senderPlatformId).toBeUndefined();
		expect(
			authorizeSandboxToolCall({
				caller: proactive,
				policy: { sandboxWorkspaceEnabled: true },
				toolName: "sandbox_spawn",
			}),
		).toMatchObject({ allowed: false, reason: "sender_required" });
		await lifecycle.stop();
	});

	test("ordinary group callers can spawn and address their own sandbox without admin tools", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "group");
		await lifecycle.conversationPolicy.update({
			conversationId: parent.sessionId,
			policy: { sandboxWorkspaceEnabled: true },
			scope: "conversation",
		});
		const created = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			goal: "Convert the staged synthetic CSV into JSON under output/.",
			requestedBy: "im:synthetic-owner",
			workspaceKind: "sandbox",
		});
		expect(created.workspaceKind).toBe("sandbox");
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const [row] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, created.sessionId))
			.limit(1);
		expect(row).toMatchObject({
			ownerUserId: "synthetic-owner",
			parentSessionId: parent.sessionId,
			workspaceKind: "sandbox",
		});
		expect(row?.sandboxPath).toContain("sandbox-workspaces");
		const policy = await lifecycle.conversationPolicy.effectivePolicy(created.sessionId);
		expect(policy.capabilities).toEqual(["sandbox"]);
		const caller = await resolveImCallerContext({
			conversationId: parent.durableConversationId,
			database,
			settings: lifecycle.pluginSettings,
		});
		expect(caller.chatKind).toBe("group");
		await expect(
			lifecycle.workspace.spawnFromSession(parent.sessionId, {
				goal: "Coding must stay admin-only.",
				workspaceKind: "coding",
			}),
		).rejects.toThrow("delegation");
		await expect(
			lifecycle.workspace.sandboxSend({
				requester: { isAdmin: false, senderPlatformId: "synthetic-other" },
				sessionId: created.sessionId,
				sourceSessionId: parent.sessionId,
				text: "hijack attempt",
			}),
		).rejects.toThrow("sandbox_owner_mismatch");
		await expect(
			lifecycle.workspace.sandboxStatus({
				requester: { isAdmin: false, senderPlatformId: "synthetic-owner" },
				sessionId: created.sessionId,
				sourceSessionId: crypto.randomUUID(),
			}),
		).rejects.toThrow("sandbox_scope_mismatch");
		await lifecycle.stop();
	});

	test("stages only media referenced by the parent session and reports output artifacts", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "private");
		const other = await chatSession(lifecycle, "private");
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const media = await lifecycle.media.store({
			bytes: new TextEncoder().encode("synthetic,value\n1,2\n"),
			kind: "file",
			mimeType: "text/csv",
			source: "channel",
		});
		const foreign = await lifecycle.media.store({
			bytes: new TextEncoder().encode("foreign synthetic document"),
			kind: "file",
			mimeType: "text/plain",
			source: "channel",
		});
		const now = new Date().toISOString();
		await database.insert(messages).values({
			chatObjectId: parent.chatId,
			contentText: "synthetic attachment",
			conversationId: parent.sessionId,
			direction: "inbound",
			id: crypto.randomUUID(),
			ingestedAt: now,
			kind: "private",
			occurredAt: now,
			partsJson: JSON.stringify([{ fileName: "report.csv", mediaId: media.id, type: "file" }]),
			seq: 0,
			senderExternalId: "synthetic-owner",
			updatedAt: now,
		});
		const created = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			goal: "Transform the synthetic attachment.",
			mediaIds: [media.id, foreign.id],
			requestedBy: "im:synthetic-owner",
			workspaceKind: "sandbox",
		});
		const [row] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, created.sessionId))
			.limit(1);
		const sandboxPath = row?.sandboxPath;
		if (sandboxPath === null || sandboxPath === undefined) throw new Error("Missing sandbox path");
		expect(await readFile(join(sandboxPath, "inputs", "report.csv"), "utf-8")).toContain(
			"synthetic",
		);
		await expect(readFile(join(sandboxPath, "inputs", foreign.id))).rejects.toThrow();
		await writeFile(join(sandboxPath, "output", "result.json"), '{"ok":true}\n');
		const outputs = await lifecycle.workspace.collectSandboxOutputs(created.sessionId);
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatchObject({
			fileName: "result.json",
			mimeType: "application/json",
		});
		const status = await lifecycle.workspace.status({ sessionId: created.sessionId });
		expect(status.outputFiles).toEqual([
			expect.objectContaining({ fileName: "result.json", mimeType: "application/json" }),
		]);
		expect(status.workspaceKind).toBe("sandbox");
		expect(await lifecycle.workspace.get(created.sessionId)).toMatchObject({
			workspace: { workspaceKind: "sandbox" },
		});
		expect(await lifecycle.workspace.git(created.sessionId)).toBeNull();
		const otherId = other.sessionId;
		expect(otherId).not.toBe(parent.sessionId);
		await lifecycle.stop();
	});

	test("never follows symlinks when staging inputs or collecting outputs", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "private", {
			senderPlatformId: "synthetic-owner",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const media = await lifecycle.media.store({
			bytes: new TextEncoder().encode("synthetic safe input\n"),
			kind: "file",
			mimeType: "text/plain",
			source: "channel",
		});
		const now = new Date().toISOString();
		await database.insert(messages).values({
			chatObjectId: parent.chatId,
			contentText: "synthetic attachment",
			conversationId: parent.sessionId,
			direction: "inbound",
			id: crypto.randomUUID(),
			ingestedAt: now,
			kind: "private",
			occurredAt: now,
			partsJson: JSON.stringify([{ fileName: "owned.txt", mediaId: media.id, type: "file" }]),
			seq: 0,
			senderExternalId: "synthetic-owner",
			updatedAt: now,
		});
		const created = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			goal: "Stage safely.",
			requestedBy: "im:synthetic-owner",
			workspaceKind: "sandbox",
		});
		const [row] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, created.sessionId))
			.limit(1);
		const sandboxPath = row?.sandboxPath;
		if (sandboxPath === null || sandboxPath === undefined) throw new Error("Missing sandbox path");
		const outside = join(sandboxPath, "outside.txt");
		await writeFile(outside, "do-not-overwrite\n");
		await symlink(outside, join(sandboxPath, "inputs", "owned.txt"));
		await lifecycle.workspace.stageInputsForSandbox({
			mediaIds: [media.id],
			sandboxSessionId: created.sessionId,
			sourceSessionId: parent.sessionId,
		});
		expect(await readFile(outside, "utf-8")).toBe("do-not-overwrite\n");
		expect(await readFile(join(sandboxPath, "inputs", "owned-2.txt"), "utf-8")).toContain(
			"synthetic safe input",
		);
		await symlink(outside, join(sandboxPath, "output", "leak.txt"));
		expect(await lifecycle.workspace.collectSandboxOutputs(created.sessionId)).toEqual([]);
		expect(await readFile(outside, "utf-8")).toBe("do-not-overwrite\n");
		await lifecycle.stop();
	});

	test("sandbox_send stages a same-session document and rejects another session's media", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "private", {
			senderPlatformId: "synthetic-owner",
		});
		const other = await chatSession(lifecycle, "private", {
			senderPlatformId: "synthetic-other",
		});
		const extension = workspaceToolsExtension(lifecycle);
		const spawned = await executeTool(
			extension,
			"sandbox_spawn",
			{ goal: "Process a follow-up synthetic document." },
			parent.durableConversationId,
		);
		const { sessionId } = JSON.parse(resultText(spawned)) as { readonly sessionId: string };
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const owned = await lifecycle.media.store({
			bytes: new TextEncoder().encode("synthetic follow-up\n"),
			kind: "file",
			mimeType: "text/plain",
			source: "channel",
		});
		const foreign = await lifecycle.media.store({
			bytes: new TextEncoder().encode("foreign synthetic follow-up\n"),
			kind: "file",
			mimeType: "text/plain",
			source: "channel",
		});
		const now = new Date().toISOString();
		const insertAttachment = async (
			session: { readonly chatId: string; readonly sessionId: string },
			mediaId: string,
			fileName: string,
		) => {
			await database.insert(messages).values({
				chatObjectId: session.chatId,
				contentText: "synthetic attachment",
				conversationId: session.sessionId,
				direction: "inbound",
				id: crypto.randomUUID(),
				ingestedAt: now,
				kind: "private",
				occurredAt: now,
				partsJson: JSON.stringify([{ fileName, mediaId, type: "file" }]),
				seq: 0,
				senderExternalId: "synthetic-owner",
				updatedAt: now,
			});
		};
		await insertAttachment(parent, owned.id, "follow-up.txt");
		await insertAttachment(other, foreign.id, "foreign.txt");
		const sent = await executeTool(
			extension,
			"sandbox_send",
			{
				mediaIds: [owned.id, foreign.id],
				sessionId,
				text: "Use the attached synthetic follow-up.",
			},
			parent.durableConversationId,
		);
		expect(resultText(sent)).toContain(sessionId);
		const [row] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, sessionId))
			.limit(1);
		const sandboxPath = row?.sandboxPath;
		if (sandboxPath === null || sandboxPath === undefined) throw new Error("Missing sandbox path");
		expect(await readFile(join(sandboxPath, "inputs", "follow-up.txt"), "utf-8")).toContain(
			"synthetic follow-up",
		);
		await expect(readFile(join(sandboxPath, "inputs", "foreign.txt"))).rejects.toThrow();
		await lifecycle.stop();
	});

	test("sandbox_spawn auto-stages caller's recent file or stages by fileNames, and archived sandboxes free quota", async () => {
		const lifecycle = await startApp();
		const parent = await chatSession(lifecycle, "group", { senderPlatformId: "synthetic-owner" });
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const ownerDoc = await lifecycle.media.store({
			bytes: new TextEncoder().encode("owner synthetic csv\n"),
			kind: "file",
			mimeType: "text/csv",
			source: "channel",
		});
		const otherDoc = await lifecycle.media.store({
			bytes: new TextEncoder().encode("other group user doc\n"),
			kind: "file",
			mimeType: "text/plain",
			source: "channel",
		});
		const nowMs = Date.now();
		const ownerAt = new Date(nowMs + 2_000).toISOString();
		const otherAt = new Date(nowMs + 1_000).toISOString();
		await database.insert(messages).values([
			{
				chatObjectId: parent.chatId,
				contentText: "[file: other.txt]",
				conversationId: parent.sessionId,
				direction: "inbound",
				id: crypto.randomUUID(),
				ingestedAt: otherAt,
				kind: "onebot-v11",
				occurredAt: otherAt,
				partsJson: JSON.stringify([{ fileName: "other.txt", mediaId: otherDoc.id, type: "file" }]),
				platformMessageId: `synthetic-${crypto.randomUUID()}`,
				senderExternalId: "synthetic-other",
				updatedAt: otherAt,
			},
			{
				chatObjectId: parent.chatId,
				contentText: "[file: owner.csv]",
				conversationId: parent.sessionId,
				direction: "inbound",
				id: crypto.randomUUID(),
				ingestedAt: ownerAt,
				kind: "onebot-v11",
				occurredAt: ownerAt,
				partsJson: JSON.stringify([{ fileName: "owner.csv", mediaId: ownerDoc.id, type: "file" }]),
				platformMessageId: `synthetic-${crypto.randomUUID()}`,
				senderExternalId: "synthetic-owner",
				updatedAt: ownerAt,
			},
		]);
		// Bind the active turn to synthetic-owner so sandbox_spawn stages owner.csv automatically
		// without pulling in another group speaker's attachment.
		const extension = workspaceToolsExtension(lifecycle);
		const spawned = await executeTool(
			extension,
			"sandbox_spawn",
			{ goal: "Process my uploaded CSV file." },
			parent.durableConversationId,
		);
		const first = JSON.parse(resultText(spawned)) as { readonly sessionId: string };
		const [firstRow] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, first.sessionId))
			.limit(1);
		expect(
			await readFile(join(firstRow?.sandboxPath ?? "", "inputs", "owner.csv"), "utf-8"),
		).toContain("owner synthetic csv");
		await expect(
			readFile(join(firstRow?.sandboxPath ?? "", "inputs", "other.txt")),
		).rejects.toThrow();

		// Archiving a sandbox frees its slot against SANDBOX_MAX_ACTIVE_PER_PARENT.
		for (let index = 1; index < SANDBOX_MAX_ACTIVE_PER_PARENT; index += 1) {
			await lifecycle.workspace.spawnFromSession(parent.sessionId, {
				fileNames: ["owner.csv"],
				goal: `Named file task ${index}.`,
				requestedBy: "im:synthetic-owner",
				workspaceKind: "sandbox",
			});
		}
		await expect(
			lifecycle.workspace.spawnFromSession(parent.sessionId, {
				goal: "Over active quota.",
				requestedBy: "im:synthetic-owner",
				workspaceKind: "sandbox",
			}),
		).rejects.toThrow("sandbox_quota_exceeded");
		await database
			.update(conversations)
			.set({ status: "archived" })
			.where(eq(conversations.id, first.sessionId));
		const afterArchive = await lifecycle.workspace.spawnFromSession(parent.sessionId, {
			fileNames: ["owner.csv"],
			goal: "Allowed after archive.",
			requestedBy: "im:synthetic-owner",
			workspaceKind: "sandbox",
		});
		const [archivedFollowupRow] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, afterArchive.sessionId))
			.limit(1);
		expect(
			await readFile(join(archivedFollowupRow?.sandboxPath ?? "", "inputs", "owner.csv"), "utf-8"),
		).toContain("owner synthetic csv");
		await lifecycle.stop();
	}, 30_000);
});
