import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import type { Extension } from "@earendil-works/pi-durable";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { openDurableStorage } from "@tsukaima/durable";
import {
	type ContextPromptProvider,
	type DurableConversationHostOptions,
	createFakeModel,
	createOpenAICompatibleModelPort,
	createSlowStreamingModel,
	PiDurableConversationHost,
} from "./index.ts";

const conversationEnvelope = (
	id: string,
	text: string,
	overrides: Partial<MessageEnvelope> = {},
): MessageEnvelope => ({
	channelId: "test",
	channelKind: "webui",
	conversationKey: { kind: "webui" },
	id,
	mentions: [],
	parts: [{ text, type: "text" }],
	sender: { displayName: "Tester", id: "user-1", platformId: "user-1" },
	source: { messageId: id, receivedAtMs: 1, timestampMs: 1 },
	...overrides,
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

async function withHost(
	run: (host: PiDurableConversationHost, directory: string) => Promise<void>,
	options: Omit<DurableConversationHostOptions, "storage"> = {},
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-batch-1-"));
	try {
		const storage = await openDurableStorage(join(directory, "durable.sqlite"));
		const host = new PiDurableConversationHost({
			policy: { maxMessages: 20, windowMs: 20 },
			storage,
			timeZone: "UTC",
			...options,
		});
		try {
			await run(host, directory);
		} finally {
			await host.close();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

type CapturedContext = {
	readonly messages?: readonly { readonly content?: unknown; readonly role?: string }[];
};

const captureStreams = (model: ReturnType<typeof createFakeModel>, contexts: CapturedContext[]) => {
	const stream = model.models.streamSimple.bind(model.models);
	model.models.streamSimple = (target, context, options) => {
		contexts.push(context as CapturedContext);
		return stream(target, context, options);
	};
};

describe("Batch 1 acceptance: stable static prompt", () => {
	test("keeps exactly one role:system message at index 0 across eight turns", async () => {
		const contexts: CapturedContext[] = [];
		const model = createFakeModel({
			responses: Array.from({ length: 8 }, (_, index) => `answer-${index + 1}`),
		});
		captureStreams(model, contexts);
		const provider: ContextPromptProvider = {
			renderPersona: async () => "PERSONA-STATIC",
			renderPolicy: async () => "- STATIC-RULE",
			renderSystem: async () => "SYSTEM-STATIC",
			renderTurnContext: async () => [
				{ key: "clock", text: "CLOCK-EPHEMERAL" },
				{ key: "memories", text: "MEMORY-EPHEMERAL" },
			],
		};
		const answers: string[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				for (let turn = 0; turn < 8; turn += 1) {
					await host.append({
						conversationId,
						envelope: conversationEnvelope(`stable-${turn}`, `turn ${turn}`),
						forceSubmit: true,
						submittedAtMs: 1_000 + turn,
					});
					await waitFor(() => (answers.length > turn ? answers[turn] : undefined));
				}
			},
			{
				contextProvider: provider,
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
		expect(contexts).toHaveLength(8);
		for (const context of contexts) {
			const messages = context.messages ?? [];
			const systemMessages = messages.filter((message) => message.role === "system");
			expect(systemMessages).toHaveLength(1);
			expect(messages[0]?.role).toBe("system");
			expect(JSON.stringify(messages)).not.toContain("Updated system prompt section");
		}
	});
});

describe("Batch 1 acceptance: one turn-context render per tool run", () => {
	test("renders ephemeral context once while the model takes two tool rounds", async () => {
		let renderCount = 0;
		const provider: ContextPromptProvider = {
			renderPersona: async () => "PERSONA",
			renderTurnContext: async () => {
				renderCount += 1;
				return [{ key: "clock", text: `CLOCK-${renderCount}` }];
			},
		};
		const requests: unknown[] = [];
		const model = createOpenAICompatibleModelPort(
			{
				apiKey: "test-key",
				baseUrl: "http://scripted-tool.invalid/v1",
				fetch: (async (_input, init) => {
					const request = JSON.parse(String(init?.body ?? "{}")) as {
						messages?: readonly { readonly role?: string }[];
					};
					requests.push(request);
					const toolResults = (request.messages ?? []).filter(
						(message) => message.role === "tool",
					).length;
					const body =
						toolResults < 2
							? {
									choices: [
										{
											finish_reason: "tool_calls",
											message: {
												content: null,
												tool_calls: [
													{
														function: {
															arguments: "{}",
															name: "probe_tool",
														},
														id: `call-${toolResults + 1}`,
														type: "function",
													},
												],
											},
										},
									],
									id: `scripted-${toolResults}`,
									model: "scripted-tool-model",
									usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
								}
							: {
									choices: [{ finish_reason: "stop", message: { content: "final answer" } }],
									id: "scripted-final",
									model: "scripted-tool-model",
									usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
								};
					return new Response(JSON.stringify(body), {
						headers: { "content-type": "application/json" },
						status: 200,
					});
				}) as typeof fetch,
			},
			[
				{
					capabilities: ["basic-chat", "tool-use"],
					modelId: "scripted-tool-model",
					supportsTools: true,
				},
			],
		);
		const probe: Extension = {
			name: "probe-tools",
			tools: [
				{
					callers: ["model"],
					description: "Probe output once per round",
					execute: async () => ({ output: [{ text: "probe result", type: "text" }] }),
					name: "probe_tool",
					parameters: { properties: {}, type: "object" },
				},
			],
		};
		const answers: string[] = [];
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.append({
					conversationId,
					envelope: conversationEnvelope("tool-run", "use the probe twice"),
					forceSubmit: true,
					submittedAtMs: 1_000,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
			},
			{
				contextProvider: provider,
				extensions: [probe],
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
			},
		);
		expect(answers).toEqual(["final answer"]);
		expect(requests).toHaveLength(3);
		expect(renderCount).toBe(1);
	});
});

describe("Batch 1 acceptance: clean durable user turns", () => {
	test("persists local time, resolved mentions, and a quoted reply without trigger telemetry", async () => {
		await withHost(async (host) => {
			const conversationId = await host.createConversation();
			const receivedAtMs = Date.UTC(2026, 4, 6, 3, 4);
			await host.append({
				conversationId,
				envelope: conversationEnvelope("clean-turn", "hi @1002, what about this?", {
					conversationKey: { groupId: "group-1", kind: "group", peerId: "1001" },
					mentions: [{ id: "1002", label: "Alice" }],
					sender: { displayName: "Alpha", id: "1001", platformId: "1001" },
					source: { messageId: "clean-turn", receivedAtMs, timestampMs: receivedAtMs },
					target: {
						replyToEnvelopeId: "earlier",
						quote: { excerpt: "the earlier note", senderDisplayName: "Bob" },
					},
				}),
				forceSubmit: true,
				submittedAtMs: receivedAtMs,
				turnContext: {
					classification: "soft",
					cue: "CUE-EPHEMERAL TSUKAIMA_LURK",
					promptHooks: "HOOK-EPHEMERAL",
				},
			});
			const entries = await waitForAsync(async () => {
				const listed = await host.listEntries(conversationId);
				return listed.some((entry) => entry.model?.some((message) => message.role === "user"))
					? listed
					: undefined;
			});
			const userEntries = entries.filter((entry) =>
				entry.model?.some((message) => message.role === "user"),
			);
			expect(userEntries).toHaveLength(1);
			const text = contentText(userEntries[0]?.model?.[0]?.content ?? "");
			expect(text).toContain("[03:04] Alpha(1001) ");
			expect(text).toContain("hi @Alice, what about this?");
			expect(text).toContain('[reply to Bob: "the earlier note"]');
			expect(text).not.toContain("Conversation trigger:");
			expect(text).not.toContain("CUE-EPHEMERAL");
			expect(text).not.toContain("HOOK-EPHEMERAL");
		});
	});
});

describe("Batch 1 acceptance: multimodal user turns", () => {
	test("applies mention labels on the image input path", async () => {
		const contexts: CapturedContext[] = [];
		const answers: string[] = [];
		const model = createSlowStreamingModel(["seen"], {
			delayMs: 5,
			onContext: (context) => contexts.push(context as CapturedContext),
			supportsImage: true,
		});
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.append({
					conversationId,
					envelope: conversationEnvelope("image-mention", "look @1002", {
						conversationKey: { groupId: "group-1", kind: "group", peerId: "1001" },
						mentions: [{ id: "1002", label: "Alice" }],
						parts: [
							{ text: "look @1002", type: "text" },
							{ mediaId: "media-1", mimeType: "image/png", type: "image" },
						],
						sender: { displayName: "Alpha", id: "1001", platformId: "1001" },
					}),
					forceSubmit: true,
					submittedAtMs: 1_000,
				});
				await waitFor(() => (answers.length > 0 ? answers[0] : undefined));
			},
			{
				model,
				onAnswer: (answer) => {
					answers.push(answer.text);
				},
				resolveImage: async (part) =>
					part.type === "image" ? { data: "AQID", mimeType: "image/png" } : undefined,
			},
		);
		const serialized = JSON.stringify(contexts);
		expect(serialized).toContain("look @Alice");
		expect(serialized).toContain('"data":"AQID"');
	});
});

describe("Batch 1 acceptance: inspector reflects pinned turn context", () => {
	test("shows the live run's memoized sections and matching token categories", async () => {
		let renders = 0;
		const provider: ContextPromptProvider = {
			renderPersona: async () => "Inspector persona",
			renderPolicy: async () => "- Inspector policy",
			renderSystem: async () => "Inspector system",
			renderTurnContext: async () => {
				renders += 1;
				return [
					{ key: "clock", text: "PINNED-CLOCK" },
					{ key: "memories", text: "PINNED-MEMORY" },
					{ key: "observation", text: "PINNED-OBSERVATION" },
				];
			},
		};
		const model = createSlowStreamingModel(["slow ", "enough ", "answer"], { delayMs: 150 });
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				await host.append({
					conversationId,
					envelope: conversationEnvelope("inspect-live", "inspect while running"),
					forceSubmit: true,
					submittedAtMs: 1_000,
				});
				await waitFor(() => (renders > 0 ? true : undefined));
				// Let the hook finish committing the pinned snapshot before inspecting.
				await Bun.sleep(20);
				const stats = await host.inspectConversationContext(conversationId);
				expect(stats?.sections).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							key: "tsukaima-system",
							text: expect.stringContaining("Inspector system"),
						}),
						expect.objectContaining({
							key: "turn-context/clock",
							text: expect.stringContaining("PINNED-CLOCK"),
						}),
						expect.objectContaining({
							key: "turn-context/observation",
							text: expect.stringContaining("PINNED-OBSERVATION"),
						}),
					]),
				);
				expect(stats?.categories.turnContextTokens).toBeGreaterThan(0);
				expect(stats?.categories.memoriesTokens).toBeGreaterThan(0);
				expect(renders).toBe(1);
				const categorySum =
					(stats?.categories.messagesTokens ?? 0) +
					(stats?.categories.toolsTokens ?? 0) +
					(stats?.categories.personaTokens ?? 0) +
					(stats?.categories.policyTokens ?? 0) +
					(stats?.categories.memoriesTokens ?? 0) +
					(stats?.categories.turnContextTokens ?? 0) +
					(stats?.categories.otherSystemTokens ?? 0);
				expect(stats?.usedTokens).toBe(categorySum);
			},
			{ contextProvider: provider, model },
		);
	});
});

describe("Batch 1 acceptance: failed chat compaction", () => {
	test("declines instead of falling back to the coding checklist", async () => {
		const model = createFakeModel({ responses: [] });
		const contexts: CapturedContext[] = [];
		captureStreams(model, contexts);
		const provider: ContextPromptProvider = {
			renderPersona: async () => "PERSONA",
			summarizeCompaction: async () => {
				throw new Error("synthetic summarizer failure");
			},
			isChatConversation: async () => true,
		};
		await withHost(
			async (host) => {
				const conversationId = await host.createConversation();
				const chunk = "synthetic chat detail ".repeat(1_500);
				for (let index = 0; index < 4; index += 1) {
					await host.append({
						conversationId,
						envelope: conversationEnvelope(`decline-${index}`, `${index}: ${chunk}`),
						forceSubmit: true,
						submittedAtMs: 1_000 + index,
					});
				}
				for (let attempt = 0; attempt < 80; attempt += 1) {
					const stats = await host.inspectConversationContext(conversationId);
					if ((stats?.messageCount ?? 0) >= 8) break;
					await Bun.sleep(20);
				}
				expect(await host.compactConversation(conversationId)).toMatchObject({
					compacted: false,
					entryId: null,
					submissionId: null,
				});
				expect(JSON.stringify(contexts)).not.toContain("## Goal");
				expect(JSON.stringify(contexts)).not.toContain("context summarization assistant");
			},
			{ contextProvider: provider, model },
		);
	});
});
