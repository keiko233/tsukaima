import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DomainCodingStore } from "@tsukaima/coding";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import {
	auditLog,
	codingProposals,
	codingTasks,
	conversations,
	workspaceSessions,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import { probeBubblewrapSandbox } from "@tsukaima/coding";
import { providerSafeToolName } from "@tsukaima/sdk";
import { loadConfig } from "../src/config.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";

/**
 * Batch 1 acceptance: a deterministic model drives a Workspace turn through the same model
 * tool surface a real turn uses, against a synthetic repository in a temporary directory.
 */

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

const TOOL = {
	analyze: providerSafeToolName("self-iteration.analyze"),
	build: providerSafeToolName("self-iteration.build"),
	diff: providerSafeToolName("self-iteration.diff"),
	edit: providerSafeToolName("self-iteration.edit"),
	propose: providerSafeToolName("self-iteration.propose"),
	status: providerSafeToolName("self-iteration.status"),
	test: providerSafeToolName("self-iteration.test"),
	upstream: providerSafeToolName("self-iteration.upstream"),
	worktree: providerSafeToolName("self-iteration.worktree"),
} as const;

/** Registered plugin tool names, as `pluginHost.invokeTool` routes them. */
const RAW = {
	analyze: "self-iteration.analyze",
	edit: "self-iteration.edit",
	status: "self-iteration.status",
	worktree: "self-iteration.worktree",
} as const;

const EAGER_TOOLS = [
	TOOL.analyze,
	TOOL.worktree,
	TOOL.edit,
	TOOL.test,
	TOOL.build,
	TOOL.diff,
	TOOL.propose,
	TOOL.status,
];

interface WireRequest {
	readonly messages?: readonly {
		readonly role: string;
		readonly content?: unknown;
		readonly tool_call_id?: string;
		readonly tool_calls?: readonly {
			readonly id: string;
			readonly function: { readonly name: string };
		}[];
	}[];
	readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
}

/** Outputs of the tool calls the scripted turn made, keyed by provider tool name. */
interface Observed {
	readonly outputs: Map<string, Record<string, unknown>>;
	readonly requests: WireRequest[];
	readonly calls: string[];
}

function toolNames(request: WireRequest): string[] {
	return (request.tools ?? []).map((tool) => tool.function?.name ?? "");
}

function toolCallResponse(name: string, args: Record<string, unknown>, id: string) {
	return {
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: null,
					tool_calls: [
						{ function: { arguments: JSON.stringify(args), name }, id, type: "function" },
					],
				},
			},
		],
		id: `scripted-${id}`,
		model: "scripted-workspace",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	};
}

function textResponse(content: string) {
	return {
		choices: [{ finish_reason: "stop", message: { content } }],
		id: "scripted-text",
		model: "scripted-workspace",
		usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
	};
}

function parseOutput(content: unknown): Record<string, unknown> {
	if (typeof content !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(content);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return { raw: content };
	}
}

/**
 * Deterministic Workspace turn: analyze -> edit -> test -> build -> diff -> propose. Every
 * follow-up call is chosen from the previous tool's real output, never from a fixed transcript.
 * Turns that do not offer the coding tools get a plain acknowledgement.
 */
function scriptedWorkspaceModel() {
	const observed: Observed = { calls: [], outputs: new Map(), requests: [] };
	const port = createOpenAICompatibleModelPort(
		{
			apiKey: "test-key",
			baseUrl: "http://workspace-agent.invalid/v1",
			fetch: (async (_input, init) => {
				const request = JSON.parse(String(init?.body ?? "{}")) as WireRequest;
				observed.requests.push(request);
				const names = toolNames(request);
				const messages = request.messages ?? [];
				const last = messages.at(-1);
				let body: unknown = textResponse("noted");
				if (names.includes(TOOL.analyze)) {
					if (last?.role === "user") {
						observed.calls.push(TOOL.analyze);
						body = toolCallResponse(TOOL.analyze, { action: "read", path: "src/app.ts" }, "call-1");
					} else if (last?.role === "tool") {
						const name = messages
							.flatMap((message) => message.tool_calls ?? [])
							.find((call) => call.id === last.tool_call_id)?.function.name;
						const output = parseOutput(last.content);
						if (name !== undefined) observed.outputs.set(name, output);
						const id = `call-${messages.length + 1}`;
						const next = nextCall(name, output);
						if (next !== undefined) {
							observed.calls.push(next.name);
							body = toolCallResponse(next.name, next.args, id);
						} else {
							body = textResponse("Proposal submitted for admin approval.");
						}
					}
				}
				return new Response(JSON.stringify(body), {
					headers: { "content-type": "application/json" },
					status: 200,
				});
			}) as typeof fetch,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "scripted-workspace" }],
	);
	return { observed, port };
}

function nextCall(
	name: string | undefined,
	output: Record<string, unknown>,
): { readonly args: Record<string, unknown>; readonly name: string } | undefined {
	switch (name) {
		case TOOL.analyze:
			// The read must come from the task's base revision, before any worktree exists.
			expect(String(output.content)).toContain("export const value = 'old';");
			return {
				args: { find: "'old'", path: "src/app.ts", replace: "'new'" },
				name: TOOL.edit,
			};
		case TOOL.edit:
			return { args: {}, name: TOOL.test };
		case TOOL.test:
			expect(output.passed).toBe(true);
			return { args: {}, name: TOOL.build };
		case TOOL.build:
			return { args: {}, name: TOOL.diff };
		case TOOL.diff: {
			return {
				args: {
					envChanges: [],
					motivation: "The fixture value must read 'new' for the regression check.",
					requiresRestart: false,
					riskAssessment: "low: one literal in a synthetic fixture",
					rollbackNotes: "Revert the single-line change.",
					title: "Update fixture value",
				},
				name: TOOL.propose,
			};
		}
		default:
			return undefined;
	}
}

async function fixtureRepository(root: string): Promise<string> {
	const repo = join(root, "repo");
	await fs.mkdir(join(repo, "src"), { recursive: true });
	await fs.writeFile(join(repo, "README.md"), "# Synthetic workspace fixture\n");
	await fs.writeFile(join(repo, "src", "app.ts"), "export const value = 'old';\n");
	await fs.writeFile(
		join(repo, "src", "app.test.ts"),
		'import { expect, test } from "bun:test";\nimport { value } from "./app.ts";\ntest("value", () => { expect(typeof value).toBe("string"); });\n',
	);
	await fs.writeFile(
		join(repo, "package.json"),
		JSON.stringify(
			{ name: "fixture", scripts: { build: "bun -e \"console.log('built')\"" } },
			null,
			"\t",
		),
	);
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
	root: string,
	repo: string,
	model: ReturnType<typeof scriptedWorkspaceModel>["port"],
	extraEnv: Record<string, string> = {},
) {
	const lifecycle = new TsukaimaLifecycle(
		loadConfig({
			TSUKAIMA_DATA_DIR: join(root, "data"),
			TSUKAIMA_PORT: "7430",
			TSUKAIMA_REPOSITORY_ROOT: repo,
			...extraEnv,
		}),
		{ env: {}, model },
	);
	lifecycles.push(lifecycle);
	await lifecycle.start();
	return lifecycle;
}

async function fixture() {
	const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-workspace-agent-"));
	directories.push(root);
	const repo = await fixtureRepository(root);
	const model = scriptedWorkspaceModel();
	const lifecycle = await start(root, repo, model.port);
	const database = lifecycle.domainDatabase;
	if (database === undefined) throw new Error("Domain database is not ready");
	return { database, lifecycle, model, repo, root };
}

async function waitFor<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 30_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(25);
	}
	throw new Error("Timed out waiting for condition");
}

async function durableId(database: TsukaimaDatabase, sessionId: string): Promise<string> {
	const [row] = await database
		.select({ durableConversationId: conversations.durableConversationId })
		.from(conversations)
		.where(eq(conversations.id, sessionId))
		.limit(1);
	if (row === undefined) throw new Error("conversation not found");
	return row.durableConversationId;
}

describe("Workspace agent execution (batch 2 isolation)", () => {
	test("with the bubblewrap backend, the first Workspace request also offers exec and check", async () => {
		const bwrap = await probeBubblewrapSandbox({ repositoryPath: process.cwd() });
		if (!bwrap.ok) return;
		const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-workspace-isolated-"));
		directories.push(root);
		const repo = await fixtureRepository(root);
		const model = scriptedWorkspaceModel();
		const lifecycle = await start(root, repo, model.port, {
			TSUKAIMA_CODING_SANDBOX: "bubblewrap",
		});
		const workspace = await lifecycle.workspace.create({
			goal: "Inspect the fixture.",
			requestedBy: "test-admin",
		});
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Show the tool surface.",
		});
		await waitFor(() =>
			model.observed.requests.some((request) => toolNames(request).includes(TOOL.analyze))
				? true
				: undefined,
		);
		const first = model.observed.requests.find((request) =>
			toolNames(request).includes(TOOL.analyze),
		);
		if (first === undefined) throw new Error("no workspace request offered coding tools");
		expect(toolNames(first)).toContain(providerSafeToolName("self-iteration.exec"));
		expect(toolNames(first)).toContain(providerSafeToolName("self-iteration.check"));
	}, 60_000);

	test("a workspace turn offers core tools upfront and completes edit, test, and proposal through the bound task", async () => {
		const { database, lifecycle, model, repo } = await fixture();
		const workspace = await lifecycle.workspace.create({
			goal: "Change the fixture value to new.",
			requestedBy: "test-admin",
		});
		const taskId = workspace.taskId;
		if (taskId === null) throw new Error("workspace did not start a task");

		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Make the change, run the test, and propose it.",
		});
		await waitFor(() => (model.observed.outputs.has(TOOL.propose) ? true : undefined));

		// The first Workspace request offers the core tools without tool_search, and keeps upstream
		// deferred until the model asks for it.
		const first = model.observed.requests.find((request) =>
			toolNames(request).includes(TOOL.analyze),
		);
		if (first === undefined) throw new Error("no workspace request offered coding tools");
		for (const name of EAGER_TOOLS) expect(toolNames(first)).toContain(name);
		expect(toolNames(first)).not.toContain(TOOL.upstream);
		expect(toolNames(first)).toContain("tool_search");

		// The turn never asked for a task id: calls resolved the task from the workspace binding.
		expect(model.observed.calls).toEqual([
			TOOL.analyze,
			TOOL.edit,
			TOOL.test,
			TOOL.build,
			TOOL.diff,
			TOOL.propose,
		]);
		const proposeOutput = model.observed.outputs.get(TOOL.propose) ?? {};
		expect(proposeOutput.missing).toEqual([]);

		const [row] = await database
			.select()
			.from(workspaceSessions)
			.where(eq(workspaceSessions.id, workspace.sessionId))
			.limit(1);
		expect(row?.taskId).toBe(taskId);
		const [task] = await database
			.select()
			.from(codingTasks)
			.where(eq(codingTasks.id, taskId))
			.limit(1);
		expect(task?.worktreePath).toBeDefined();
		expect(await database.select().from(codingTasks)).toHaveLength(1);

		// The edit landed in the task worktree; the live repository was never written.
		expect(await fs.readFile(join(task?.worktreePath ?? "", "src", "app.ts"), "utf-8")).toContain(
			"'new'",
		);
		expect(await fs.readFile(join(repo, "src", "app.ts"), "utf-8")).toContain("'old'");
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString()).toBe("");

		const proposals = await database
			.select()
			.from(codingProposals)
			.where(eq(codingProposals.taskId, taskId));
		expect(proposals).toHaveLength(1);
		expect(proposals[0]?.status).toBe("pending_approval");

		// Resumed Workspace: a fresh process resolves the same task from the durable binding.
		const durable = await durableId(database, workspace.sessionId);
		await lifecycle.stop();
		const resumed = await start(join(repo, ".."), repo, scriptedWorkspaceModel().port);
		const status = await resumed.pluginHost.invokeTool(RAW.status, {}, { conversationId: durable });
		expect(status.ok).toBe(true);
		if (!status.ok) throw new Error("status denied after restart");
		expect(JSON.parse(status.result.content[0]?.text ?? "{}")).toEqual(
			expect.objectContaining({ taskId }),
		);
	}, 90_000);

	test("legacy tasks keep working through the binding, and mismatched or missing bindings fail closed", async () => {
		const { database, lifecycle } = await fixture();
		const store = new DomainCodingStore(() => database);
		const legacy = await store.createTask({
			baseRef: "HEAD",
			constraints: {
				allowedCommands: ["bun"],
				maxOutputBytes: 1024,
				pathAllowlist: ["src"],
				timeoutMs: 1000,
			},
			goal: "Legacy analysis task",
			mode: "analysis",
			sourceConversationId: "workspace:webui",
		});
		const bound = await lifecycle.workspace.create({
			goal: "Bound workspace",
			requestedBy: "test-admin",
		});
		const draft = await lifecycle.workspace.create({ requestedBy: "test-admin" });
		const boundDurable = await durableId(database, bound.sessionId);
		const draftDurable = await durableId(database, draft.sessionId);
		// Rebind the bound workspace to the legacy analysis task, as a pre-binding row would be.
		await database
			.update(workspaceSessions)
			.set({ taskId: legacy.id })
			.where(eq(workspaceSessions.id, bound.sessionId));

		const legacyRead = await lifecycle.pluginHost.invokeTool(
			RAW.analyze,
			{ action: "read", path: "README.md", taskId: legacy.id },
			{ conversationId: boundDurable },
		);
		expect(legacyRead.ok).toBe(true);
		if (!legacyRead.ok) throw new Error("legacy read denied");
		expect(legacyRead.result.content[0]?.text).toContain("Synthetic workspace fixture");

		const other = await store.createTask({
			baseRef: "HEAD",
			constraints: {
				allowedCommands: ["bun"],
				maxOutputBytes: 1024,
				pathAllowlist: ["src"],
				timeoutMs: 1000,
			},
			goal: "Another task",
			mode: "proposal",
			sourceConversationId: "workspace:webui",
		});
		const mismatch = await lifecycle.pluginHost.invokeTool(
			RAW.edit,
			{ content: "x", create: true, path: "src/other.ts", taskId: other.id },
			{ conversationId: boundDurable },
		);
		expect(mismatch.ok).toBe(true);
		if (!mismatch.ok) throw new Error("mismatch call was not routed");
		expect(mismatch.result.content[0]?.text).toContain("task_binding_mismatch");
		expect((await store.getTask(other.id))?.worktreePath).toBeUndefined();
		const audits = await database.select().from(auditLog);
		expect(
			audits.some(
				(entry) =>
					entry.action === "self-iteration.task.binding_mismatch" && entry.result === "denied",
			),
		).toBe(true);

		const missing = await lifecycle.pluginHost.invokeTool(
			RAW.edit,
			{ content: "x", create: true, path: "src/draft.ts" },
			{ conversationId: draftDurable },
		);
		expect(missing.ok).toBe(true);
		if (!missing.ok) throw new Error("draft call was not routed");
		expect(missing.result.content[0]?.text).toContain("task_binding_missing");
	}, 60_000);

	test("concurrent first calls share one task worktree", async () => {
		const { database, lifecycle, repo } = await fixture();
		const workspace = await lifecycle.workspace.create({
			goal: "Concurrent provisioning",
			requestedBy: "test-admin",
		});
		const durable = await durableId(database, workspace.sessionId);
		const results = await Promise.all([
			lifecycle.pluginHost.invokeTool(
				RAW.edit,
				{ content: "a\n", create: true, path: "src/a.ts" },
				{ conversationId: durable },
			),
			lifecycle.pluginHost.invokeTool(RAW.worktree, {}, { conversationId: durable }),
			lifecycle.pluginHost.invokeTool(
				RAW.analyze,
				{ action: "read", path: "README.md" },
				{ conversationId: durable },
			),
		]);
		for (const result of results) expect(result.ok).toBe(true);
		const listed = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo })
			.toString()
			.split("\n")
			.filter(
				(line) => line.startsWith("worktree ") && line.includes(workspace.taskId ?? "__none__"),
			);
		expect(listed).toHaveLength(1);
	}, 60_000);

	test("withdrawn coding capability rejects invocations, including tools discovered earlier", async () => {
		const { database, lifecycle, model } = await fixture();
		const workspace = await lifecycle.workspace.create({
			goal: "Capability withdrawal",
			requestedBy: "test-admin",
		});
		const durable = await durableId(database, workspace.sessionId);
		const before = await lifecycle.pluginHost.invokeTool(
			RAW.analyze,
			{ action: "read", path: "README.md" },
			{ conversationId: durable },
		);
		expect(before.ok).toBe(true);

		await lifecycle.conversationPolicy.update({
			conversationId: workspace.sessionId,
			policy: { capabilities: [] },
			scope: "conversation",
		});
		const denied = await lifecycle.pluginHost.invokeTool(
			RAW.edit,
			{ content: "x", create: true, path: "src/late.ts" },
			{ conversationId: durable },
		);
		expect(denied).toEqual(
			expect.objectContaining({
				message: "missing_capability:coding",
				ok: false,
				reason: "unauthorized",
			}),
		);

		// The next turn must not offer any coding tool in its request.
		const requestsBefore = model.observed.requests.length;
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Continue after the capability change.",
		});
		const next = await waitFor(() =>
			model.observed.requests.length > requestsBefore ? model.observed.requests.at(-1) : undefined,
		);
		expect(toolNames(next).some((name) => name.startsWith("self-iteration_"))).toBe(false);
		const inspection = await lifecycle.conversationHost?.inspectConversationContext(durable);
		expect(inspection?.tools.some((tool) => tool.name.startsWith("self-iteration_"))).toBe(false);
	}, 60_000);

	test("the context inspector agrees with the first model request about eager and deferred tools", async () => {
		const { database, lifecycle, model } = await fixture();
		const workspace = await lifecycle.workspace.create({
			goal: "Inspector parity",
			requestedBy: "test-admin",
		});
		await lifecycle.sessionMessaging.sendAgentMessage({
			sessionId: workspace.sessionId,
			source: "webui",
			text: "Show the tool surface.",
		});
		await waitFor(() => (model.observed.outputs.has(TOOL.propose) ? true : undefined));
		const durable = await durableId(database, workspace.sessionId);
		const inspection = await lifecycle.conversationHost?.inspectConversationContext(durable);
		const offered = new Set(
			model.observed.requests[0] ? toolNames(model.observed.requests[0]) : [],
		);
		const inspected = inspection?.tools ?? [];
		for (const name of EAGER_TOOLS) {
			expect(inspected.find((tool) => tool.name === name)?.deferred).toBe(false);
			expect(offered.has(name)).toBe(true);
		}
		expect(inspected.find((tool) => tool.name === TOOL.upstream)?.deferred).toBe(true);
		expect(offered.has(TOOL.upstream)).toBe(false);
	}, 60_000);
});
