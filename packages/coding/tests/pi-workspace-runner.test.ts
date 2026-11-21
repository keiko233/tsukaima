import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import {
	defineTool,
	ModelRuntime,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createPiWorkspaceRunner,
	GOVERNED_SHELL_MAX_COMMAND_LENGTH,
	GovernedShellError,
	parseGovernedShellCommand,
	PiWorkspaceRunner,
	PiWorkspaceRunnerError,
	runManagedProcess,
	SandboxUnavailableError,
	SCRUBBED_COMMAND_ENV,
	type PiWorkspaceNativeToolName,
	type PiWorkspaceRunnerConfig,
	type SandboxExecutor,
} from "../src/index.ts";

interface TestContext {
	readonly agentDir: string;
	readonly root: string;
	readonly sessionFile: string;
	readonly worktreePath: string;
}

interface FauxRuntime {
	readonly faux: FauxProviderHandle;
	readonly model: FauxProviderHandle["models"][0];
	readonly runtime: NonNullable<PiWorkspaceRunnerConfig["modelRuntime"]>;
}

interface RunnerOptions {
	readonly additionalTools?: readonly ToolDefinition[];
	readonly allowedCommands?: readonly string[];
	readonly appendPrompt?: readonly string[];
	readonly executor?: () => Promise<SandboxExecutor>;
	readonly nativeTools?: readonly PiWorkspaceNativeToolName[];
	readonly pathAllowlist?: readonly string[];
	readonly requireIsolatedSandbox?: boolean;
	readonly responses?: readonly ReturnType<typeof fauxAssistantMessage>[];
	readonly sessionFile?: string;
	readonly thinkingLevel?: PiWorkspaceRunnerConfig["thinkingLevel"];
}

let context: TestContext;
const disposers: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workspace-runner-"));
	const worktreePath = join(root, "worktree");
	const agentDir = join(root, "agent");
	await mkdir(worktreePath, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(worktreePath, "src"), { recursive: true });
	await mkdir(join(worktreePath, "docs"), { recursive: true });
	await writeFile(
		join(worktreePath, "package.json"),
		JSON.stringify({ name: "pi-workspace-test", private: true }, null, "\t"),
	);
	await writeFile(
		join(worktreePath, "src", "hello.ts"),
		"export function greet(name: string): string {\n\treturn `Hello, ${name}!`;\n}\n",
	);
	await writeFile(join(worktreePath, "docs", "notes.md"), "# Not allowlisted\n");
	await writeFile(join(root, "outside-secret.txt"), "do not read\n");
	await symlink(join(root, "outside-secret.txt"), join(worktreePath, "src", "link.ts"));
	context = {
		agentDir,
		root,
		sessionFile: join(root, "session.jsonl"),
		worktreePath,
	};
});

afterEach(async () => {
	while (disposers.length > 0) {
		const dispose = disposers.pop();
		await dispose?.();
	}
});

afterAll(async () => {
	await rm(context.root, { force: true, recursive: true });
});

async function createTestExecutor(): Promise<SandboxExecutor> {
	return {
		id: "test-isolated",
		isolated: true,
		async exec(input) {
			expect(input.snapshot).toBe(true);
			return await runManagedProcess({
				args: input.args,
				command: input.command,
				cwd: input.cwd,
				env: { ...SCRUBBED_COMMAND_ENV },
				maxOutputBytes: input.maxOutputBytes,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				timeoutMs: input.timeoutMs,
			});
		},
	};
}

async function createFauxRuntime(): Promise<FauxRuntime> {
	const faux = fauxProvider();
	const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	return { faux, model: faux.models[0]!, runtime };
}

async function createRunner(
	options: RunnerOptions = {},
): Promise<{ readonly faux: FauxProviderHandle; readonly runner: PiWorkspaceRunner }> {
	const fauxRuntime = await createFauxRuntime();
	fauxRuntime.faux.setResponses(
		options.responses === undefined ? [fauxAssistantMessage("ok")] : [...options.responses],
	);
	const runner = await createPiWorkspaceRunner({
		...(options.additionalTools === undefined ? {} : { additionalTools: options.additionalTools }),
		...(options.appendPrompt === undefined ? {} : { appendPrompt: options.appendPrompt }),
		...(options.nativeTools === undefined ? {} : { nativeTools: options.nativeTools }),
		...(options.requireIsolatedSandbox === undefined
			? {}
			: { requireIsolatedSandbox: options.requireIsolatedSandbox }),
		agentDir: context.agentDir,
		allowedCommands: options.allowedCommands ?? ["echo", "sleep"],
		executor: options.executor ?? createTestExecutor,
		model: fauxRuntime.model,
		modelRuntime: fauxRuntime.runtime,
		pathAllowlist: options.pathAllowlist ?? ["src", "package.json"],
		sessionFile: options.sessionFile ?? join(context.root, `session-${crypto.randomUUID()}.jsonl`),
		thinkingLevel: options.thinkingLevel ?? "off",
		worktreePath: context.worktreePath,
	});
	disposers.push(async () => await runner.dispose());
	return { faux: fauxRuntime.faux, runner };
}

function eventText(event: AgentSessionEvent): string {
	if (event.type !== "tool_execution_end") return "";
	const result = event.result as { readonly content?: readonly { readonly text?: string }[] };
	return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

function findToolEnd(
	events: readonly AgentSessionEvent[],
	toolName: string,
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> | undefined {
	return events.find(
		(event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
			event.type === "tool_execution_end" && event.toolName === toolName,
	);
}

const noteTool = defineTool({
	name: "workspace_note",
	label: "Workspace note",
	description: "Record one short note in the tool result.",
	parameters: Type.Object({ text: Type.String() }),
	async execute(_toolCallId, { text }) {
		return { content: [{ text, type: "text" }], details: undefined };
	},
});

describe("PiWorkspaceRunner native Pi session", () => {
	test("keeps Pi's native loop, tools, and prompt and appends only caller text", async () => {
		const { runner } = await createRunner({
			additionalTools: [noteTool],
			appendPrompt: ["Workspace policy: stay inside the allowlist."],
		});
		expect(runner.activeToolNames).toEqual(["read", "bash", "edit", "write", "workspace_note"]);
		expect(runner.systemPrompt).toContain("You are a coding assistant running inside pi");
		expect(runner.systemPrompt).toContain("Read file contents");
		expect(runner.systemPrompt).toContain("Execute bash commands");
		expect(runner.systemPrompt).toContain("Workspace policy: stay inside the allowlist.");
		expect(runner.sandboxIsolated).toBe(true);
	});

	test("executes a native read tool call through the Pi agent loop", async () => {
		const { runner } = await createRunner({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "src/hello.ts" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		const result = await runner.run("Read the allowlisted source file.");
		expect(result.assistantText).toBe("done");
		expect(result.toolCalls).toBe(1);
		expect(result.toolErrors).toBe(0);
		const read = findToolEnd(events, "read");
		expect(read?.isError).toBe(false);
		expect(eventText(read!)).toContain("Hello");
	});

	test("executes a caller-added tool alongside the native tools", async () => {
		const { runner } = await createRunner({
			additionalTools: [noteTool],
			responses: [
				fauxAssistantMessage([fauxToolCall("workspace_note", { text: "noted" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Use the added note tool.");
		expect(findToolEnd(events, "workspace_note")?.isError).toBe(false);
		expect(eventText(findToolEnd(events, "workspace_note")!)).toBe("noted");
	});
});

describe("PiWorkspaceRunner governed file tools", () => {
	test("denies a native read outside the path allowlist", async () => {
		const { runner } = await createRunner({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "docs/notes.md" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		const result = await runner.run("Try to read an unlisted file.");
		expect(result.toolErrors).toBe(1);
		const read = findToolEnd(events, "read");
		expect(read?.isError).toBe(true);
		expect(eventText(read!)).toContain("allowlist");
	});

	test("denies a symlink that resolves outside the worktree", async () => {
		const { runner } = await createRunner({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "src/link.ts" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Try to read through a symlink.");
		expect(findToolEnd(events, "read")?.isError).toBe(true);
		expect(eventText(findToolEnd(events, "read")!)).not.toContain("do not read");
	});

	test("writes an allowlisted file and refuses a traversal", async () => {
		const allowed = join(context.worktreePath, "src", "created.ts");
		await writeFile(allowed, "");
		const { runner } = await createRunner({
			responses: [
				fauxAssistantMessage(
					[
						fauxToolCall("write", {
							content: "export const created = true;\n",
							path: "src/created.ts",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Write the allowlisted file.");
		expect(findToolEnd(events, "write")?.isError).toBe(false);
		expect(await readFile(allowed, "utf-8")).toBe("export const created = true;\n");

		const escapePath = join(context.worktreePath, "escape.ts");
		await writeFile(escapePath, "");
		const { runner: escapingRunner } = await createRunner({
			responses: [
				fauxAssistantMessage(
					[fauxToolCall("write", { content: "bad", path: "src/../escape.ts" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const escapingEvents: AgentSessionEvent[] = [];
		const unsubscribeEscaping = escapingRunner.subscribe((event) => escapingEvents.push(event));
		disposers.push(unsubscribeEscaping);
		await escapingRunner.run("Try to escape the worktree allowlist.");
		expect(findToolEnd(escapingEvents, "write")?.isError).toBe(true);
		expect(await readFile(escapePath, "utf-8")).toBe("");
	});
});

describe("PiWorkspaceRunner governed shell", () => {
	test("runs one allowlisted command without invoking a shell", async () => {
		const { runner } = await createRunner({
			allowedCommands: ["echo"],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "hello world"' })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Run the allowlisted echo command.");
		expect(findToolEnd(events, "bash")?.isError).toBe(false);
		expect(eventText(findToolEnd(events, "bash")!)).toContain("hello world");
	});

	test("rejects shell metacharacters before spawning anything", async () => {
		const { runner } = await createRunner({
			allowedCommands: ["echo"],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi | cat" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Try a pipeline.");
		expect(findToolEnd(events, "bash")?.isError).toBe(true);
		expect(eventText(findToolEnd(events, "bash")!)).toContain("shell metacharacter");
	});

	test("rejects a command outside the allowlist", async () => {
		const { runner } = await createRunner({
			allowedCommands: ["echo"],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "curl https://example.invalid" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		await runner.run("Try an unlisted command.");
		expect(findToolEnd(events, "bash")?.isError).toBe(true);
		expect(eventText(findToolEnd(events, "bash")!)).toContain("not in the allowed command list");
	});

	test("enforces the configured timeout on a native bash call", async () => {
		const { runner } = await createRunner({
			allowedCommands: ["sleep"],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 1", timeout: 0.1 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		const startedAt = performance.now();
		await runner.run("Run a command with a short timeout.");
		expect(performance.now() - startedAt).toBeLessThan(2_000);
		expect(findToolEnd(events, "bash")?.isError).toBe(true);
		expect(eventText(findToolEnd(events, "bash")!)).toContain("timed out");
	});

	test("cancels an in-flight command when the caller aborts", async () => {
		const { runner } = await createRunner({
			allowedCommands: ["sleep"],
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			],
		});
		const events: AgentSessionEvent[] = [];
		const unsubscribe = runner.subscribe((event) => events.push(event));
		disposers.push(unsubscribe);
		const started = new Promise<void>((resolve) => {
			const stop = runner.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					stop();
					resolve();
				}
			});
			disposers.push(stop);
		});
		const controller = new AbortController();
		const run = runner.run("Run a long command.", { signal: controller.signal });
		await started;
		controller.abort();
		const result = await run;
		expect(result.aborted).toBe(true);
		expect(result.durationMs).toBeLessThan(3_000);
		expect(findToolEnd(events, "bash")?.isError).toBe(true);
		expect(eventText(findToolEnd(events, "bash")!).toLowerCase()).toContain("aborted");
	});
});

describe("PiWorkspaceRunner persistence and model seams", () => {
	test("persists the Pi JSONL session and resumes the same session id", async () => {
		const sessionFile = join(context.root, "resume.jsonl");
		const first = await createRunner({
			responses: [fauxAssistantMessage("first answer")],
			sessionFile,
		});
		const firstResult = await first.runner.run("Remember this workspace turn.");
		expect(firstResult.assistantText).toBe("first answer");
		const firstSessionId = firstResult.sessionId;
		await first.runner.dispose();
		const file = await readFile(sessionFile, "utf-8");
		expect(file).toContain("Remember this workspace turn.");
		expect(file).toContain("first answer");

		const second = await createRunner({
			responses: [fauxAssistantMessage("second answer")],
			sessionFile,
		});
		expect(second.runner.sessionId).toBe(firstSessionId);
		expect(
			second.runner.session.sessionManager.buildSessionContext().messages.length,
		).toBeGreaterThan(0);
		const secondResult = await second.runner.run("Continue the same session.");
		expect(secondResult.sessionId).toBe(firstSessionId);
		expect(secondResult.assistantText).toBe("second answer");
		await second.runner.dispose();
		const resumedFile = await readFile(sessionFile, "utf-8");
		expect(resumedFile).toContain("Continue the same session.");
	});

	test("fails closed when the sandbox backend is not OS-isolated", async () => {
		const fauxRuntime = await createFauxRuntime();
		const hostExecutor: SandboxExecutor = {
			id: "host",
			isolated: false,
			exec: async () => {
				throw new Error("not used");
			},
		};
		await expect(
			createPiWorkspaceRunner({
				agentDir: context.agentDir,
				allowedCommands: ["echo"],
				executor: async () => hostExecutor,
				model: fauxRuntime.model,
				modelRuntime: fauxRuntime.runtime,
				pathAllowlist: ["src"],
				sessionFile: join(context.root, "host.jsonl"),
				worktreePath: context.worktreePath,
			}),
		).rejects.toThrow(SandboxUnavailableError);
	});

	test("allows an explicit non-isolated opt-out only when requested", async () => {
		const hostExecutor: SandboxExecutor = {
			id: "host",
			isolated: false,
			exec: async () => {
				throw new Error("not used");
			},
		};
		const { runner } = await createRunner({
			executor: async () => hostExecutor,
			requireIsolatedSandbox: false,
		});
		expect(runner.sandboxIsolated).toBe(false);
	});

	test("fails closed when the sandbox provider cannot run", async () => {
		const fauxRuntime = await createFauxRuntime();
		await expect(
			createPiWorkspaceRunner({
				agentDir: context.agentDir,
				allowedCommands: ["echo"],
				executor: async () => {
					throw new SandboxUnavailableError("bubblewrap is unavailable", {
						code: "namespace_denied",
					});
				},
				model: fauxRuntime.model,
				modelRuntime: fauxRuntime.runtime,
				pathAllowlist: ["src"],
				sessionFile: join(context.root, "closed.jsonl"),
				worktreePath: context.worktreePath,
			}),
		).rejects.toThrow(SandboxUnavailableError);
	});

	test("rejects persistence inside the worktree", async () => {
		const fauxRuntime = await createFauxRuntime();
		await expect(
			createPiWorkspaceRunner({
				agentDir: context.agentDir,
				allowedCommands: ["echo"],
				executor: async () => createTestExecutor(),
				model: fauxRuntime.model,
				modelRuntime: fauxRuntime.runtime,
				pathAllowlist: ["src"],
				sessionFile: join(context.worktreePath, "session.jsonl"),
				worktreePath: context.worktreePath,
			}),
		).rejects.toThrow(PiWorkspaceRunnerError);
	});
});

describe("parseGovernedShellCommand", () => {
	test("keeps quoting and escapes as literal argv", () => {
		const parsed = parseGovernedShellCommand("echo 'a $b' \"c d\" e\\ f");
		expect(parsed.command).toBe("echo");
		expect(parsed.args).toEqual(["a $b", "c d", "e f"]);
	});

	test("allows regex characters inside quotes", () => {
		const parsed = parseGovernedShellCommand('rg "a[0-9]+" src');
		expect(parsed.command).toBe("rg");
		expect(parsed.args).toEqual(["a[0-9]+", "src"]);
	});

	test.each([
		["echo hi | cat", "metacharacter"],
		["echo $(whoami)", "metacharacter"],
		["echo `id`", "metacharacter"],
		["echo hi > out.txt", "metacharacter"],
		["echo *", "metacharacter"],
		["echo hi\nrm -rf /", "line break"],
		["/bin/echo hi", "allowlisted executable"],
		["echo 'unterminated", "unterminated quote"],
		["", "command is empty"],
	] as const)("rejects %p", (command, expected) => {
		expect(() => parseGovernedShellCommand(command)).toThrow(GovernedShellError);
		expect(() => parseGovernedShellCommand(command)).toThrow(expected);
	});

	test("bounds command length", () => {
		expect(() =>
			parseGovernedShellCommand(`echo ${"a".repeat(GOVERNED_SHELL_MAX_COMMAND_LENGTH)}`),
		).toThrow(GovernedShellError);
	});
});

describe("PiWorkspaceRunner host bash mode", () => {
	test("runs shell pipelines and non-allowlisted commands directly in the worktree", async () => {
		const fauxRuntime = await createFauxRuntime();
		fauxRuntime.faux.setResponses([
			fauxAssistantMessage([
				{
					type: "toolCall",
					id: "call_host_bash",
					name: "bash",
					arguments: { command: "ls src && echo hello | tr a-z A-Z" },
				},
			]),
			fauxAssistantMessage("host bash done"),
		]);
		const runner = await createPiWorkspaceRunner({
			agentDir: context.agentDir,
			allowedCommands: ["bun"],
			bashMode: "host",
			executor: async () => {
				throw new Error("executor should not be called in host bash mode");
			},
			model: fauxRuntime.model,
			modelRuntime: fauxRuntime.runtime,
			pathAllowlist: ["src", "package.json"],
			requireIsolatedSandbox: false,
			sessionFile: join(context.root, `session-${crypto.randomUUID()}.jsonl`),
			worktreePath: context.worktreePath,
		});
		disposers.push(async () => await runner.dispose());
		const events: AgentSessionEvent[] = [];
		runner.subscribe((event) => events.push(event));
		const result = await runner.run("run host bash");
		expect(result.assistantText).toBe("host bash done");
		expect(result.toolErrors).toBe(0);
		const end = findToolEnd(events, "bash");
		expect(end).toBeDefined();
		expect(eventText(end!)).toContain("hello.ts");
		expect(eventText(end!)).toContain("HELLO");
	});
});
