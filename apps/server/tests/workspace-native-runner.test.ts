import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DomainCodingStore } from "@tsukaima/coding";
import {
	createFakeModel,
	createOpenAICompatibleModelPort,
	createSlowStreamingModel,
} from "@tsukaima/core";
import { codingTasks, messages, workspaceSessions, type TsukaimaDatabase } from "@tsukaima/db";
import { loadConfig } from "../src/config.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";
import { abortSessionRun, getSessionContextStats } from "../src/services/webui.ts";
import { WORKSPACE_NATIVE_LIVE_TOOL_OUTPUT_MAX_CHARS } from "../src/services/workspace-native-runner.ts";

const directories: string[] = [];
const lifecycles: TsukaimaLifecycle[] = [];

afterEach(async () => {
	await Promise.all(
		lifecycles.splice(0).map((lifecycle) => lifecycle.stop().catch(() => undefined)),
	);
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function fixtureRepository(root: string): Promise<string> {
	const repo = join(root, "repo");
	await fs.mkdir(join(repo, "src"), { recursive: true });
	await fs.writeFile(join(repo, "README.md"), "# Synthetic native workspace fixture\n");
	await fs.writeFile(join(repo, "src", "app.ts"), "export const value = 'old';\n");
	const git = (args: readonly string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
			{
				cwd: repo,
			},
		);
	git(["init", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-m", "initial"]);
	return repo;
}

async function start(
	options: {
		readonly dataDir?: string;
		readonly model?: ReturnType<typeof createFakeModel>;
		readonly root?: string;
	} = {},
) {
	const root = options.root ?? (await fs.mkdtemp(join(tmpdir(), "tsukaima-native-workspace-")));
	if (options.root === undefined) directories.push(root);
	const repo = join(root, "repo");
	if (
		!(await fs.stat(repo).then(
			() => true,
			() => false,
		))
	)
		await fixtureRepository(root);
	const dataDir = options.dataDir ?? join(root, "data");
	const lifecycle = new TsukaimaLifecycle(
		loadConfig({
			TSUKAIMA_DATA_DIR: dataDir,
			TSUKAIMA_PORT: "7440",
			TSUKAIMA_REPOSITORY_ROOT: repo,
		}),
		{
			env: {},
			model: options.model ?? createFakeModel({ responses: ["native workspace answer"] }),
		},
	);
	lifecycles.push(lifecycle);
	await lifecycle.start();
	return { dataDir, lifecycle, repo, root };
}

async function waitFor<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 20_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(25);
	}
	throw new Error("Timed out waiting for condition");
}

async function nativeAnswers(database: TsukaimaDatabase, sessionId: string) {
	const rows = await database.select().from(messages).where(eq(messages.conversationId, sessionId));
	return rows.filter(
		(row) => row.direction === "outbound" && (row.durableEntryId ?? "").startsWith("native-"),
	);
}

describe("workspace native Pi integration", () => {
	test("routes a WebUI workspace send through a native Pi session and persists the answer", async () => {
		const { dataDir, lifecycle, repo } = await start();
		const workspace = await lifecycle.workspace.create({
			goal: "Inspect the fixture without changing it.",
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");

		await lifecycle.sessionMessaging.sendAgentMessage({
			deliveryMode: "steer",
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Read the fixture and report the value.",
		});
		const answer = await waitFor(
			async () => (await nativeAnswers(database, workspace.sessionId))[0],
		);
		expect(answer.contentText).toBe("native workspace answer");
		expect(answer.deliveryStatus).toBe("sent");
		expect(answer.runId).not.toBeNull();
		expect(answer.segmentIndex).toBe(0);
		expect(answer.seq).toBeGreaterThan(0);
		const segments = await lifecycle.conversationRuns.listSegmentsForConversation(
			workspace.sessionId,
		);
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({
			finalMessageId: answer.id,
			runId: answer.runId,
			segmentIndex: 0,
			status: "completed",
		});

		const [workspaceRow] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, workspace.sessionId))
			.limit(1);
		const [task] = await database
			.select()
			.from(codingTasks)
			.where(eq(codingTasks.id, workspaceRow?.taskId ?? ""))
			.limit(1);
		expect(task?.worktreePath).toBeDefined();
		expect(
			await fs.stat(join(task?.worktreePath ?? "")).then(
				() => true,
				() => false,
			),
		).toBe(true);
		expect(
			await fs.stat(join(repo, "src", "app.ts")).then(
				() => true,
				() => false,
			),
		).toBe(true);

		const sessionFile = join(dataDir, "workspace-sessions", workspace.sessionId, "session.jsonl");
		expect(
			await fs.stat(sessionFile).then(
				() => true,
				() => false,
			),
		).toBe(true);
		const entries = (await fs.readFile(sessionFile, "utf-8")).trim().split("\n");
		expect(entries.length).toBeGreaterThan(0);
	}, 60_000);

	test("executes a native edit tool call inside the task worktree", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-native-tools-"));
		directories.push(root);
		const repo = await fixtureRepository(root);
		const requestBodies: string[] = [];
		const requests: string[][] = [];
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://native-workspace.invalid/v1",
				fetch: (async (_input, init) => {
					const body = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: readonly { readonly role?: string }[];
						tools?: readonly { readonly function?: { readonly name?: string } }[];
					};
					const offered = (body.tools ?? []).map((tool) => tool.function?.name ?? "");
					requests.push(offered);
					requestBodies.push(JSON.stringify(body.messages ?? []));
					const last = body.messages?.at(-1);
					if (last?.role === "user" && offered.includes("edit")) {
						return Response.json({
							choices: [
								{
									finish_reason: "tool_calls",
									message: {
										content: null,
										tool_calls: [
											{
												function: {
													arguments: JSON.stringify({
														edits: [{ newText: "'new'", oldText: "'old'" }],
														path: "src/app.ts",
													}),
													name: "edit",
												},
												id: "native-edit-1",
												type: "function",
											},
										],
									},
								},
							],
							id: "scripted-native-edit",
							model: "scripted-native",
							usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
						});
					}
					return Response.json({
						choices: [{ finish_reason: "stop", message: { content: "Edited the fixture." } }],
						id: "scripted-native-text",
						model: "scripted-native",
						usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
					});
				}) as typeof fetch,
			},
			[{ capabilities: ["basic-chat", "tool-use"], modelId: "scripted-native" }],
		);
		const { lifecycle } = await start({ model: model as never, root });
		const workspace = await lifecycle.workspace.create({
			goal: "Change the fixture value.",
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Change old to new with the edit tool.",
		});
		const answer = await waitFor(
			async () => (await nativeAnswers(database, workspace.sessionId))[0],
		);
		expect(answer.contentText).toContain("Edited the fixture");
		const [workspaceRow] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, workspace.sessionId))
			.limit(1);
		const [task] = await database
			.select()
			.from(codingTasks)
			.where(eq(codingTasks.id, workspaceRow?.taskId ?? ""))
			.limit(1);
		expect(await fs.readFile(join(task?.worktreePath ?? "", "src", "app.ts"), "utf-8")).toContain(
			"'new'",
		);
		expect(await fs.readFile(join(repo, "src", "app.ts"), "utf-8")).toContain("'old'");
		expect(requests[0]).toContain("edit");
		expect(requests[0]).toContain("bash");
		expect(requests[0]?.some((name) => name.startsWith("self-iteration"))).toBe(false);
		expect(requests[0]).not.toContain("db_query");
		expect(requests[0]).not.toContain("tool_search");
		const context = await getSessionContextStats(lifecycle, workspace.sessionId);
		expect(context?.tools.map((tool) => tool.name).toSorted()).toEqual(requests[0]?.toSorted());
		expect(context?.personaName).toBeNull();
		expect(context?.usedTokens).toBeGreaterThan(0);
		expect(requests[0]).not.toContain("db_schema");
		expect(requests[0]).not.toContain("propose");
		expect(requests[0]).not.toContain("check");
		expect(requestBodies.join("\n")).not.toContain("self-iteration");
		expect(requestBodies.join("\n")).not.toContain("db_query");
	}, 60_000);

	test("keeps multi-turn live tool state bounded and free of duplicate rounds", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-native-multiturn-"));
		directories.push(root);
		const repo = await fixtureRepository(root);
		await fs.mkdir(join(repo, "docs"), { recursive: true });
		await fs.writeFile(
			join(repo, "docs", "large.txt"),
			Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(24)}\n`).join(""),
		);
		execFileSync("git", ["add", "docs/large.txt"], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@tsukaima.invalid",
				"commit",
				"-m",
				"large fixture",
			],
			{ cwd: repo },
		);
		let request = 0;
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "synthetic-native-key",
				baseUrl: "http://native-workspace.invalid/v1",
				fetch: (async (_input, _init) => {
					request += 1;
					if (request <= 2) {
						return Response.json({
							choices: [
								{
									finish_reason: "tool_calls",
									message: {
										content: null,
										tool_calls: [
											{
												function: {
													arguments: JSON.stringify({
														path: "docs/large.txt",
													}),
													name: "read",
												},
												id: `native-read-${request}`,
												type: "function",
											},
										],
									},
								},
							],
							id: `scripted-native-read-${request}`,
							model: "scripted-native",
							usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
						});
					}
					return Response.json({
						choices: [
							{
								finish_reason: "stop",
								message: { content: "Read the large fixture twice." },
							},
						],
						id: "scripted-native-multiturn",
						model: "scripted-native",
						usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
					});
				}) as typeof fetch,
			},
			[{ capabilities: ["basic-chat", "tool-use"], modelId: "scripted-native" }],
		);
		const { lifecycle } = await start({ model: model as never, root });
		const workspace = await lifecycle.workspace.create({
			goal: "Read a large fixture twice.",
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Read the large fixture twice with the read tool.",
		});
		const answer = await waitFor(
			async () => (await nativeAnswers(database, workspace.sessionId))[0],
		);
		const entryId = answer.durableEntryId;
		if (entryId === null) throw new Error("Answer entry id missing");
		const final = await lifecycle.liveRuns.final(entryId);
		const toolSteps = final?.steps.filter((step) => step.kind === "tool") ?? [];
		expect(toolSteps).toHaveLength(2);
		for (const step of toolSteps) {
			if (step.kind !== "tool") continue;
			// Completed rounds are cleared, so each call appears once rather than once per turn.
			expect(step.output.length).toBeLessThanOrEqual(WORKSPACE_NATIVE_LIVE_TOOL_OUTPUT_MAX_CHARS);
			expect(step.output).toContain("[truncated]");
		}
	}, 60_000);

	test("abort stops an active native run and a repeated message id is idempotent", async () => {
		const slow = createSlowStreamingModel(["working", " slowly", " on", " the", " request"], {
			delayMs: 40,
		});
		const { lifecycle } = await start({ model: slow as never });
		const workspace = await lifecycle.workspace.create({
			goal: "Keep the task running.",
			requestedBy: "test-admin",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await lifecycle.sessionMessaging.sendAgentMessage({
			deliveryMode: "steer",
			messageId: "native-idempotent-message",
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Start the slow request.",
		});
		await lifecycle.sessionMessaging.sendAgentMessage({
			deliveryMode: "steer",
			messageId: "native-idempotent-message",
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Start the slow request.",
		});
		await waitFor(() =>
			lifecycle.liveRuns
				.snapshot(workspace.sessionId)
				.then((state) => (state === undefined || state.settled ? undefined : true)),
		);
		const abort = await abortSessionRun(lifecycle, workspace.sessionId);
		expect(abort.ok).toBe(true);
		await waitFor(() =>
			lifecycle.liveRuns
				.snapshot(workspace.sessionId)
				.then((state) => (state === undefined || state.settled ? true : undefined)),
		);
		expect((await nativeAnswers(database, workspace.sessionId)).length).toBeLessThanOrEqual(1);
	}, 60_000);

	test("resumes a stored analysis-only task without write or shell tools", async () => {
		const { lifecycle } = await start();
		const workspace = await lifecycle.workspace.create({ goal: "Inspect the fixture." });
		const database = lifecycle.domainDatabase;
		if (database === undefined || workspace.taskId === null) throw new Error("Workspace not ready");
		await database
			.update(codingTasks)
			.set({ mode: "analysis" })
			.where(eq(codingTasks.id, workspace.taskId));
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			text: "Inspect the fixture.",
		});
		const stats = await getSessionContextStats(lifecycle, workspace.sessionId);
		const tools = stats?.tools.map(({ name }) => name);
		expect(tools).toContain("read");
		for (const name of ["bash", "edit", "write"]) expect(tools).not.toContain(name);
	});
	test("keeps the native Pi session across a restart and continues the transcript", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-native-restart-"));
		directories.push(root);
		const first = await start({ model: createFakeModel({ responses: ["first answer"] }), root });
		const workspace = await first.lifecycle.workspace.create({
			goal: "Keep working across a restart.",
			requestedBy: "test-admin",
		});
		const database = first.lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await first.lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "First request.",
		});
		await waitFor(async () => (await nativeAnswers(database, workspace.sessionId))[0]);
		const sessionFile = join(
			first.dataDir,
			"workspace-sessions",
			workspace.sessionId,
			"session.jsonl",
		);
		const before = (await fs.readFile(sessionFile, "utf-8")).trim().split("\n").length;
		await first.lifecycle.stop();
		const resumed = await start({
			dataDir: first.dataDir,
			model: createFakeModel({ responses: ["second answer"] }),
			root,
		});
		await resumed.lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Continue after restart.",
		});
		const resumedDatabase = resumed.lifecycle.domainDatabase;
		if (resumedDatabase === undefined) throw new Error("Resumed database not ready");
		const answers = await waitFor(async () => {
			const rows = await nativeAnswers(resumedDatabase, workspace.sessionId);
			return rows.length >= 2 ? rows : undefined;
		});
		expect(answers.map((row) => row.contentText).toSorted()).toEqual([
			"first answer",
			"second answer",
		]);
		const after = (await fs.readFile(sessionFile, "utf-8")).trim().split("\n").length;
		expect(after).toBeGreaterThan(before);
	}, 60_000);
	test("denies a native workspace turn after the coding capability is withdrawn", async () => {
		const { lifecycle } = await start();
		const workspace = await lifecycle.workspace.create({
			goal: "Keep the capability check honest.",
			requestedBy: "test-admin",
		});
		await lifecycle.conversationPolicy.update({
			conversationId: workspace.sessionId,
			policy: { capabilities: [] },
			scope: "conversation",
		});
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		await expect(
			lifecycle.sessionMessaging.sendAgentMessage({
				sessionId: workspace.sessionId,
				source: "webui",
				text: "Change the fixture.",
			}),
		).rejects.toThrow("Workspace coding capability is disabled");
		await Bun.sleep(50);
		expect(await nativeAnswers(database, workspace.sessionId)).toHaveLength(0);
	}, 60_000);

	test("keeps legacy coding task and proposal rows readable through the workspace", async () => {
		const { lifecycle } = await start();
		const database = lifecycle.domainDatabase;
		if (database === undefined) throw new Error("Database not ready");
		const store = new DomainCodingStore(() => database);
		const legacy = await store.createTask({
			baseRef: "HEAD",
			constraints: {
				allowedCommands: ["bun"],
				maxOutputBytes: 8_192,
				pathAllowlist: ["src"],
				timeoutMs: 5_000,
			},
			goal: "Legacy proposal task",
			mode: "proposal",
			sourceConversationId: "workspace:legacy",
		});
		await store.updateTask(legacy.id, { status: "awaiting_approval" });
		const proposal = await store.createProposal({
			changedFiles: ["src/app.ts"],
			diff: "--- a/src/app.ts\n+++ b/src/app.ts\n",
			motivation: "Legacy fixture",
			riskAssessment: "low",
			rollbackNotes: "revert",
			taskId: legacy.id,
			title: "Legacy proposal",
		});
		await store.transitionProposal(proposal.id, "pending_approval");
		await store.createDeployment({
			createdBy: "admin",
			proposalId: proposal.id,
			rollbackPlan: "revert",
			sourceRevision: "deadbeef",
			status: "pending",
			taskId: legacy.id,
		});

		const workspace = await lifecycle.workspace.create({
			goal: "Read legacy rows.",
			requestedBy: "test-admin",
		});
		await database
			.update(workspaceSessions)
			.set({ taskId: legacy.id })
			.where(eq(workspaceSessions.id, workspace.sessionId));

		const status = await lifecycle.workspace.status({ sessionId: workspace.sessionId });
		expect(status.taskId).toBe(legacy.id);
		expect(status.status).toBe("awaiting_approval");
		expect(status.proposals).toEqual([
			expect.objectContaining({
				changedFiles: ["src/app.ts"],
				id: proposal.id,
				status: "pending_approval",
				title: "Legacy proposal",
			}),
		]);

		const detail = await lifecycle.workspace.get(workspace.sessionId);
		expect(detail?.proposals.map((entry) => entry.id)).toEqual([proposal.id]);
		expect(detail?.workspace.taskStatus).toBe("awaiting_approval");
	}, 60_000);
});
