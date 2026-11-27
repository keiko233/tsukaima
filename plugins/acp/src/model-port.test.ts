import { afterEach, describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	Api,
} from "@earendil-works/pi-ai";
import { resolveAcpProfiles, type ResolvedAcpProfile } from "./config.ts";
import { createAcpModelPort } from "./model-port.ts";
import { AcpProcessManager, type AcpManagedClient, type AcpSpawnSpec } from "./process-manager.ts";
import { connectAcpStdio, type AcpClientHandlers, type AcpSessionUpdate } from "./protocol.ts";

const FIXTURE_PATH = new URL("./fixtures/mock-acp-agent.ts", import.meta.url).pathname;
const PLUGIN_ROOT = new URL("../", import.meta.url).pathname;
const managers: AcpProcessManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

function createProfile(overrides: Record<string, unknown> = {}): ResolvedAcpProfile {
	const profiles = resolveAcpProfiles({
		profiles: [
			{
				args: [FIXTURE_PATH],
				command: process.execPath,
				cwd: PLUGIN_ROOT,
				enabled: true,
				id: "synthetic-mock",
				models: [
					{
						enabled: true,
						id: "mock-model-1",
						name: "Mock Model One",
						supportsImage: true,
						supportsTools: true,
					},
					{
						enabled: true,
						id: "mock-model-2",
						name: "Mock Model Two",
						supportsTools: true,
					},
				],
				requestTimeoutMs: 10_000,
				...overrides,
			},
		],
	});
	const profile = profiles[0];
	if (profile === undefined) throw new Error("synthetic profile failed to resolve");
	return profile;
}

interface Harness {
	readonly manager: AcpProcessManager;
	readonly setModelCalls: readonly { readonly modelId: string; readonly sessionId: string }[];
	readonly updates: readonly AcpSessionUpdate[];
}

function createHarness(options: { handlers?: AcpClientHandlers } = {}): Harness {
	const setModelCalls: { modelId: string; sessionId: string }[] = [];
	const updates: AcpSessionUpdate[] = [];
	const manager = new AcpProcessManager({
		connect: async (spec: AcpSpawnSpec) => {
			const client = connectAcpStdio({
				args: [...spec.args],
				command: spec.command,
				cwd: spec.cwd,
				env: spec.env,
				requestTimeoutMs: spec.profile.requestTimeoutMs,
				...(options.handlers === undefined ? {} : { handlers: options.handlers }),
			});
			const originalSetModel = client.setModel.bind(client);
			client.setModel = async (params) => {
				setModelCalls.push({ ...params });
				await originalSetModel(params);
			};
			const originalPrompt = client.prompt.bind(client);
			client.prompt = async (input) => {
				const onUpdate = input.onUpdate;
				return originalPrompt({
					...input,
					onUpdate: (update) => {
						updates.push(update);
						return onUpdate?.(update);
					},
				});
			};
			return client as unknown as AcpManagedClient;
		},
		hostEnv: {
			HOME: process.env.HOME ?? "/tmp",
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		},
		reaperIntervalMs: 3_600_000,
	});
	managers.push(manager);
	return { manager, setModelCalls, updates };
}

function contextWith(text: string, extra: Partial<Context> = {}): Context {
	return {
		messages: [{ content: text, role: "user", timestamp: Date.now() }],
		...extra,
	};
}

function requireModel(port: ReturnType<typeof createAcpModelPort>, modelId: string): Model<Api> {
	const model = port.models.getModel(port.providerId, modelId);
	if (model === undefined) throw new Error(`model ${modelId} was not registered`);
	return model;
}

describe("createAcpModelPort", () => {
	test("streams thought and text deltas from a spawned ACP agent", async () => {
		const { manager } = createHarness();
		const messages: AssistantMessage[] = [];
		const port = createAcpModelPort({
			onMessage: (message) => messages.push(message),
			processManager: manager,
			profile: createProfile(),
		});
		const model = requireModel(port, port.modelId);
		const types: string[] = [];
		const thinking: string[] = [];
		const text: string[] = [];

		for await (const event of port.models.streamSimple(model, contextWith("hello synthetic"))) {
			types.push(event.type);
			if (event.type === "thinking_delta") thinking.push(event.delta);
			if (event.type === "text_delta") text.push(event.delta);
		}

		expect(types[0]).toBe("start");
		expect(types).toContain("thinking_start");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("thinking_end");
		expect(types).toContain("text_start");
		expect(types).toContain("text_delta");
		expect(types).toContain("text_end");
		expect(types.at(-1)).toBe("done");
		expect(thinking.join("")).toContain("Considering");
		expect(text.join("")).toContain("Echo:");
		expect(text.join("")).toContain("hello synthetic");

		const completed = await port.models.completeSimple(model, contextWith("second synthetic"));
		expect(completed.stopReason).toBe("stop");
		expect(
			completed.content.some((block) => block.type === "text" && block.text.includes("Echo:")),
		).toBe(true);
		expect(messages.map((message) => message.stopReason)).toEqual(["stop", "stop"]);
	});

	test("selects the requested model through ACP setModel", async () => {
		const { manager, setModelCalls } = createHarness();
		const port = createAcpModelPort({ processManager: manager, profile: createProfile() });
		const model = requireModel(port, "mock-model-2");

		const completed = await port.models.completeSimple(model, contextWith("switch model"));

		expect(completed.stopReason).toBe("stop");
		expect(setModelCalls).toContainEqual({
			modelId: "mock-model-2",
			sessionId: expect.any(String),
		});
	});

	test("aborts an in-flight prompt and emits an aborted result", async () => {
		const { manager } = createHarness();
		const port = createAcpModelPort({ processManager: manager, profile: createProfile() });
		const model = requireModel(port, port.modelId);
		const controller = new AbortController();
		const events: AssistantMessageEvent[] = [];
		let aborted = false;

		for await (const event of port.models.streamSimple(model, contextWith("abort synthetic"), {
			signal: controller.signal,
		})) {
			events.push(event);
			if (!aborted && event.type === "thinking_delta") {
				aborted = true;
				controller.abort();
			}
		}

		expect(aborted).toBe(true);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("aborted");
			expect(last.error.stopReason).toBe("aborted");
		}
	});

	test("denies permission requests in chat mode even when the client default allows them", async () => {
		const { manager, updates } = createHarness({
			handlers: {
				onPermissionRequest: () => ({ optionId: "allow-once", outcome: "selected" }),
			},
		});
		const port = createAcpModelPort({ processManager: manager, profile: createProfile() });
		const model = requireModel(port, port.modelId);

		const completed = await port.models.completeSimple(model, contextWith("[trigger-permission]"));

		expect(completed.stopReason).toBe("stop");
		const permissionUpdate = updates.find(
			(update) =>
				update.sessionUpdate === "tool_call_update" && update.toolCallId === "tool-permission",
		);
		expect(permissionUpdate?.output).toBe("permission:cancelled");
	});

	test("parses prompt-json tool calls into toolcall events", async () => {
		const { manager } = createHarness();
		const port = createAcpModelPort({
			processManager: manager,
			profile: createProfile({ toolBridgeMode: "prompt-json" }),
		});
		const model = requireModel(port, port.modelId);
		const context: Context = {
			messages: [
				{
					content:
						'Call the tool: <tool_call>{"name":"synthetic_tool","arguments":{"value":42}}</tool_call>',
					role: "user",
					timestamp: Date.now(),
				},
			],
			tools: [
				{
					description: "A synthetic tool for the test.",
					name: "synthetic_tool",
					parameters: {
						properties: { value: { type: "number" } },
						required: ["value"],
						type: "object",
					},
				},
			],
		};
		const events: AssistantMessageEvent[] = [];

		for await (const event of port.models.streamSimple(model, context)) {
			events.push(event);
		}

		const toolEnd = events.find((event) => event.type === "toolcall_end");
		expect(events.some((event) => event.type === "toolcall_start")).toBe(true);
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "toolcall_end") {
			expect(toolEnd.toolCall.name).toBe("synthetic_tool");
			expect(toolEnd.toolCall.arguments).toEqual({ value: 42 });
		}
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.reason).toBe("toolUse");
			expect(done.message.stopReason).toBe("toolUse");
		}
	});
});
