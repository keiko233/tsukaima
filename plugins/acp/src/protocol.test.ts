import { afterEach, describe, expect, test } from "bun:test";
import {
	AcpAbortError,
	AcpClientClosedError,
	connectAcpStdio,
	type AcpClient,
	type AcpClientHandlers,
	type AcpContentBlock,
	type AcpPromptResult,
	type AcpSessionUpdate,
} from "./protocol.ts";

const FIXTURE_PATH = new URL("./fixtures/mock-acp-agent.ts", import.meta.url).pathname;
const PLUGIN_ROOT = new URL("../", import.meta.url).pathname;
const TEST_ENV = {
	HOME: process.env.HOME ?? "/tmp",
	PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
};
const clients: AcpClient[] = [];

afterEach(async () => {
	await Promise.all(
		clients.splice(0).map((client) =>
			client.close().catch(() => {
				// A test may already have closed its client.
			}),
		),
	);
});

function spawnClient(handlers?: AcpClientHandlers): AcpClient {
	const client = connectAcpStdio({
		command: process.execPath,
		args: [FIXTURE_PATH],
		cwd: PLUGIN_ROOT,
		env: TEST_ENV,
		requestTimeoutMs: 5_000,
		...(handlers === undefined ? {} : { handlers }),
	});
	clients.push(client);
	return client;
}

async function initializedClient(handlers?: AcpClientHandlers): Promise<AcpClient> {
	const client = spawnClient(handlers);
	await client.initialize({ name: "acp-protocol-test", version: "0.0.0" });
	return client;
}

async function newSession(client: AcpClient, cwd = PLUGIN_ROOT): Promise<string> {
	const session = await client.newSession({ cwd });
	return session.sessionId;
}

async function prompt(
	client: AcpClient,
	sessionId: string,
	text: string,
): Promise<{ readonly result: AcpPromptResult; readonly updates: AcpSessionUpdate[] }> {
	const updates: AcpSessionUpdate[] = [];
	const result = await client.prompt({
		sessionId,
		prompt: [{ type: "text", text }],
		onUpdate: (update) => {
			updates.push(update);
		},
	});
	return { result, updates };
}

function outputFor(updates: readonly AcpSessionUpdate[], toolCallId: string): unknown {
	return updates.find(
		(update) => update.sessionUpdate === "tool_call_update" && update.toolCallId === toolCallId,
	)?.output;
}

function contentBlocks(update: AcpSessionUpdate): readonly AcpContentBlock[] {
	if (update.content === undefined) return [];
	if (Array.isArray(update.content)) return update.content as readonly AcpContentBlock[];
	return [update.content as AcpContentBlock];
}

function textFrom(updates: readonly AcpSessionUpdate[]): string {
	const parts: string[] = [];
	for (const update of updates) {
		if (typeof update.text === "string") parts.push(update.text);
		for (const block of contentBlocks(update)) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() > deadline) throw new Error("Timed out waiting for condition");
		await Bun.sleep(10);
	}
}

describe("ACP stdio protocol", () => {
	test("initializes against a real spawned agent and captures stderr diagnostics", async () => {
		const client = spawnClient();
		const result = await client.initialize({
			name: "acp-protocol-test",
			version: "0.0.0",
		});

		expect(result.protocolVersion).toBe(1);
		expect(result.agentInfo?.name).toBe("mock-acp-agent");
		expect(result.agentCapabilities?.promptCapabilities?.image).toBe(true);
		await waitFor(() => client.getStderr().includes("[mock-acp] ready"));
	});

	test("normalizes config-option and legacy model metadata from session/new", async () => {
		const client = await initializedClient();
		const session = await client.newSession({ cwd: PLUGIN_ROOT });

		expect(session.sessionId).toStartWith("mock-session-");
		expect(session.configOptions?.[0]?.id).toBe("model");
		expect(session.configOptions?.[0]?.currentValue).toBe("mock-model-1");
		expect(session.availableModels).toEqual([
			{
				id: "mock-model-1",
				name: "Mock Model One",
				description: "Synthetic fast model",
			},
			{
				id: "mock-model-2",
				name: "Mock Model Two",
				description: "Synthetic thorough model",
			},
		]);

		const legacy = await client.newSession({ cwd: `${PLUGIN_ROOT}/[legacy-models]` });
		expect(legacy.availableModels).toEqual([
			{
				id: "mock-model-1",
				name: "Mock Model One",
				description: "Synthetic fast model",
			},
			{
				id: "mock-model-2",
				name: "Mock Model Two",
				description: "Synthetic thorough model",
			},
			{ id: "legacy-model-1", name: "Legacy Model One" },
			{
				id: "legacy-model-2",
				name: "Legacy Model Two",
				description: "Top-level fallback model",
			},
		]);
	});

	test("sets a model through the advertised config option", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);

		await client.setModel({ sessionId, modelId: "mock-model-2" });
		const { updates } = await prompt(client, sessionId, "which model?");

		expect(outputFor(updates, "tool-status")).toBe("model:mock-model-2");
	});

	test("falls back to session/set_model when config selection is rejected", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);

		await client.setModel({ sessionId, modelId: "legacy-only-model" });
		const { updates } = await prompt(client, sessionId, "legacy model?");

		expect(outputFor(updates, "tool-status")).toBe("model:legacy-only-model");
	});

	test("streams thought, message, tool, and image updates for a prompt", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);

		const { result, updates } = await prompt(client, sessionId, "[trigger-image] synthetic prompt");

		expect(result.stopReason).toBe("end_turn");
		expect(updates.map((update) => update.sessionUpdate)).toEqual([
			"agent_thought_chunk",
			"agent_message_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
			"agent_message_chunk",
		]);
		expect(textFrom(updates)).toContain("Echo: [trigger-image] synthetic prompt");
		expect(textFrom(updates)).toContain("cancel-count:0");

		const toolUpdate = updates.find(
			(update) =>
				update.sessionUpdate === "tool_call_update" && update.toolCallId === "tool-status",
		);
		expect(toolUpdate).toBeDefined();
		if (toolUpdate === undefined) return;
		expect(outputFor(updates, "tool-status")).toBe("model:mock-model-1");
		expect(
			contentBlocks(toolUpdate).some(
				(block) => block.type === "image" && block.mimeType === "image/png",
			),
		).toBe(true);
	});

	test("denies permission requests by default", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);

		const { updates } = await prompt(client, sessionId, "[trigger-permission]");

		expect(outputFor(updates, "tool-permission")).toBe("permission:cancelled");
	});

	test("denies filesystem writes and terminal requests by default", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);

		const fsResult = await prompt(client, sessionId, "[trigger-fs-write]");
		expect(outputFor(fsResult.updates, "tool-fs-write")).toBe("fs-write:error:-32601");

		const terminalResult = await prompt(client, sessionId, "[trigger-terminal]");
		expect(outputFor(terminalResult.updates, "tool-terminal")).toBe("terminal:error:-32601");
	});

	test("routes permission and filesystem requests through explicit handlers", async () => {
		let writtenPath: string | undefined;
		const client = await initializedClient({
			onFsWrite: (request) => {
				writtenPath = request.path;
			},
			onPermissionRequest: (request) => {
				const allow = request.options.find((option) => option.optionId === "allow-once");
				return allow === undefined
					? { outcome: "cancelled" }
					: { outcome: "selected", optionId: allow.optionId };
			},
		});
		const sessionId = await newSession(client);

		const { updates } = await prompt(client, sessionId, "[trigger-permission] [trigger-fs-write]");

		expect(outputFor(updates, "tool-permission")).toBe("permission:selected:allow-once");
		expect(outputFor(updates, "tool-fs-write")).toBe("fs-write:ok");
		expect(writtenPath).toBe("/synthetic/mock-acp-write.txt");
	});

	test("aborting a prompt sends session/cancel and rejects with AbortError", async () => {
		const client = await initializedClient();
		const sessionId = await newSession(client);
		const controller = new AbortController();
		let aborted = false;

		const pending = client.prompt({
			sessionId,
			prompt: [{ type: "text", text: "cancel this prompt" }],
			signal: controller.signal,
			onUpdate: (update) => {
				if (!aborted && update.sessionUpdate === "agent_thought_chunk") {
					aborted = true;
					controller.abort();
				}
			},
		});

		await expect(pending).rejects.toBeInstanceOf(AcpAbortError);
		await waitFor(() => client.getStderr().includes("[mock-acp] cancel 1"));
		expect(aborted).toBe(true);
	});

	test("closes idempotently and rejects requests after close", async () => {
		const client = await initializedClient();

		await client.close();
		await client.close();

		expect(client.closed).toBe(true);
		await expect(client.initialize()).rejects.toBeInstanceOf(AcpClientClosedError);
	});
});
