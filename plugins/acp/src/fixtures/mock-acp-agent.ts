import { createInterface } from "node:readline";
import type { AcpConfigOption, AcpContentBlock, AcpSessionUpdate } from "../protocol.ts";

type JsonRpcId = string | number;

type ClientResponse =
	| { readonly kind: "result"; readonly result: unknown }
	| { readonly kind: "error"; readonly code: number; readonly message: string };

interface MockSession {
	readonly sessionId: string;
	cancelCount: number;
	model: string;
	activeAbort: AbortController | undefined;
}

const sessions = new Map<string, MockSession>();
const clientRequests = new Map<JsonRpcId, (response: ClientResponse) => void>();
let nextSessionId = 0;
let nextClientRequestId = 0;

const reader = createInterface({
	crlfDelay: Number.POSITIVE_INFINITY,
	input: process.stdin,
	terminal: false,
});

process.stderr.write("[mock-acp] ready\n");

reader.on("line", (line) => {
	void handleLine(line).catch((error: unknown) => {
		process.stderr.write(`[mock-acp] handler error: ${String(error)}\n`);
	});
});
reader.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

async function handleLine(line: string): Promise<void> {
	const trimmed = line.trim();
	if (trimmed.length === 0) return;
	let message: unknown;
	try {
		message = JSON.parse(trimmed);
	} catch {
		send({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32700, message: "Parse error" },
		});
		return;
	}
	if (!isRecord(message)) return;

	const method = readString(message.method);
	const id = readId(message.id);
	if (method === undefined) {
		if (id !== undefined) handleClientResponse(id, message);
		return;
	}
	const params = isRecord(message.params) ? message.params : {};
	if (id === undefined) {
		handleNotification(method, params);
		return;
	}

	try {
		await handleRequest(id, method, params);
	} catch (error) {
		sendError(id, -32603, error instanceof Error ? error.message : "Internal error");
	}
}

async function handleRequest(
	id: JsonRpcId,
	method: string,
	params: Record<string, unknown>,
): Promise<void> {
	switch (method) {
		case "initialize":
			sendResult(id, {
				protocolVersion: 1,
				agentCapabilities: {
					loadSession: false,
					promptCapabilities: {
						audio: true,
						embeddedContext: true,
						image: true,
					},
				},
				agentInfo: {
					name: "mock-acp-agent",
					title: "Synthetic ACP fixture",
					version: "0.0.0",
				},
			});
			return;
		case "session/new": {
			const sessionId = `mock-session-${(nextSessionId += 1)}`;
			const session: MockSession = {
				activeAbort: undefined,
				cancelCount: 0,
				model: "mock-model-1",
				sessionId,
			};
			sessions.set(sessionId, session);
			const cwd = readString(params.cwd) ?? "";
			sendResult(id, {
				sessionId,
				configOptions: modelConfigOptions(session),
				...(cwd.includes("[legacy-models]")
					? {
							models: {
								currentModelId: "legacy-model-1",
								availableModels: [
									{
										modelId: "legacy-model-1",
										name: "Legacy Model One",
									},
								],
							},
							availableModels: [
								{
									id: "legacy-model-2",
									name: "Legacy Model Two",
									description: "Top-level fallback model",
								},
							],
						}
					: {}),
			});
			return;
		}
		case "session/set_config_option": {
			const session = requireSession(params.sessionId);
			const configId = readString(params.configId);
			const value = params.value;
			if (configId !== "model" || typeof value !== "string") {
				sendError(id, -32602, "Unsupported config option");
				return;
			}
			if (value !== "mock-model-1" && value !== "mock-model-2") {
				sendError(id, -32602, "Unsupported model id");
				return;
			}
			session.model = value;
			sendResult(id, { configOptions: modelConfigOptions(session) });
			return;
		}
		case "session/set_model": {
			const session = requireSession(params.sessionId);
			const modelId = readString(params.modelId);
			if (modelId === undefined) {
				sendError(id, -32602, "Missing modelId");
				return;
			}
			session.model = modelId;
			sendResult(id, {
				models: {
					currentModelId: modelId,
					availableModels: [
						{ modelId: "mock-model-1", name: "Mock Model One" },
						{ modelId: "mock-model-2", name: "Mock Model Two" },
					],
				},
			});
			return;
		}
		case "session/prompt": {
			const session = requireSession(params.sessionId);
			const prompt = parsePrompt(params.prompt);
			await runPrompt(id, session, prompt);
			return;
		}
		default:
			sendError(id, -32601, `Method not found: ${method}`);
	}
}

function handleNotification(method: string, params: Record<string, unknown>): void {
	if (method !== "session/cancel") return;
	const sessionId = readString(params.sessionId);
	if (sessionId === undefined) return;
	const session = sessions.get(sessionId);
	if (session === undefined) return;
	session.cancelCount += 1;
	process.stderr.write(`[mock-acp] cancel ${session.cancelCount}\n`);
	session.activeAbort?.abort();
}

function handleClientResponse(id: JsonRpcId, message: Record<string, unknown>): void {
	const resolve = clientRequests.get(id);
	if (resolve === undefined) return;
	clientRequests.delete(id);
	if (isRecord(message.error)) {
		resolve({
			kind: "error",
			code: typeof message.error.code === "number" ? message.error.code : -32603,
			message:
				typeof message.error.message === "string" ? message.error.message : "Client request failed",
		});
		return;
	}
	resolve({ kind: "result", result: message.result });
}

async function runPrompt(id: JsonRpcId, session: MockSession, prompt: string): Promise<void> {
	if (session.activeAbort !== undefined) {
		sendError(id, -32000, "A prompt is already active");
		return;
	}
	const abort = new AbortController();
	session.activeAbort = abort;
	let responded = false;
	try {
		sendUpdate(session.sessionId, {
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "Considering the synthetic request." },
		});
		await pause(12, abort.signal);
		if (abort.signal.aborted) return;

		sendUpdate(session.sessionId, {
			sessionUpdate: "agent_message_chunk",
			messageId: "message-1",
			content: { type: "text", text: "Echo: " },
		});
		await pause(12, abort.signal);
		if (abort.signal.aborted) return;

		sendUpdate(session.sessionId, {
			sessionUpdate: "agent_message_chunk",
			messageId: "message-1",
			content: { type: "text", text: prompt },
		});
		await pause(12, abort.signal);
		if (abort.signal.aborted) return;

		const toolContent: AcpContentBlock[] = [{ type: "text", text: `model:${session.model}` }];
		if (prompt.includes("[trigger-image]")) {
			toolContent.push({
				type: "image",
				data: "c3ludGhldGljLWltYWdl",
				mimeType: "image/png",
			});
		}
		sendUpdate(session.sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: "tool-status",
			title: "Mock status tool",
			kind: "other",
			status: "in_progress",
			rawInput: { synthetic: true },
		});
		sendUpdate(session.sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: "tool-status",
			title: "Mock status tool",
			kind: "other",
			status: "completed",
			output: `model:${session.model}`,
			content: toolContent,
		});
		await pause(12, abort.signal);
		if (abort.signal.aborted) return;

		if (prompt.includes("[trigger-permission]")) {
			const response = await requestClient("session/request_permission", {
				sessionId: session.sessionId,
				toolCall: {
					toolCallId: "tool-permission",
					title: "Synthetic permission request",
					kind: "edit",
					status: "pending",
					rawInput: { path: "synthetic.txt" },
				},
				options: [
					{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
					{ optionId: "deny", name: "Deny", kind: "reject_once" },
				],
			});
			const output = permissionOutput(response);
			sendUpdate(session.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-permission",
				status: "completed",
				output,
			});
			if (abort.signal.aborted) return;
		}

		if (prompt.includes("[trigger-fs-write]")) {
			const response = await requestClient("fs/write_text_file", {
				sessionId: session.sessionId,
				path: "/synthetic/mock-acp-write.txt",
				content: "synthetic fixture content",
			});
			const output = response.kind === "error" ? `fs-write:error:${response.code}` : "fs-write:ok";
			sendUpdate(session.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-fs-write",
				status: "completed",
				output,
			});
			if (abort.signal.aborted) return;
		}

		if (prompt.includes("[trigger-terminal]")) {
			const response = await requestClient("terminal/create", {
				sessionId: session.sessionId,
				command: "printf",
				args: ["synthetic"],
			});
			const output = response.kind === "error" ? `terminal:error:${response.code}` : "terminal:ok";
			sendUpdate(session.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-terminal",
				status: "completed",
				output,
			});
			if (abort.signal.aborted) return;
		}

		await pause(12, abort.signal);
		if (abort.signal.aborted) return;
		sendUpdate(session.sessionId, {
			sessionUpdate: "agent_message_chunk",
			messageId: "message-2",
			content: {
				type: "text",
				text: `cancel-count:${session.cancelCount}`,
			},
		});
		sendResult(id, { stopReason: "end_turn" });
		responded = true;
	} finally {
		if (abort.signal.aborted && !responded) {
			sendResult(id, { stopReason: "cancelled" });
		}
		if (session.activeAbort === abort) {
			session.activeAbort = undefined;
		}
	}
}

function permissionOutput(response: ClientResponse): string {
	if (response.kind === "error") return `permission:error:${response.code}`;
	if (!isRecord(response.result) || !isRecord(response.result.outcome)) {
		return "permission:invalid";
	}
	const outcome = response.result.outcome;
	if (outcome.outcome === "selected" && typeof outcome.optionId === "string") {
		return `permission:selected:${outcome.optionId}`;
	}
	return "permission:cancelled";
}

function modelConfigOptions(session: MockSession): readonly AcpConfigOption[] {
	return [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: session.model,
			options: [
				{
					value: "mock-model-1",
					name: "Mock Model One",
					description: "Synthetic fast model",
				},
				{
					value: "mock-model-2",
					name: "Mock Model Two",
					description: "Synthetic thorough model",
				},
			],
		},
	];
}

function sendUpdate(sessionId: string, update: AcpSessionUpdate): void {
	send({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});
}

function requestClient(method: string, params: unknown): Promise<ClientResponse> {
	return new Promise((resolve) => {
		const id = `mock-client-request-${(nextClientRequestId += 1)}`;
		const timer = setTimeout(() => {
			clientRequests.delete(id);
			resolve({ kind: "error", code: -32000, message: "Client request timed out" });
		}, 5_000);
		clientRequests.set(id, (response) => {
			clearTimeout(timer);
			resolve(response);
		});
		send({ jsonrpc: "2.0", id, method, params });
	});
}

function requireSession(value: unknown): MockSession {
	const sessionId = readString(value);
	const session = sessionId === undefined ? undefined : sessions.get(sessionId);
	if (session === undefined) throw new Error("Unknown session");
	return session;
}

function parsePrompt(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const parts: string[] = [];
	for (const block of value) {
		if (!isRecord(block) || block.type !== "text") continue;
		const text = readString(block.text);
		if (text !== undefined) parts.push(text);
	}
	return parts.join("\n");
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

function sendResult(id: JsonRpcId, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readId(value: unknown): JsonRpcId | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}
