import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginLogger, PluginModelProvider } from "@tsukaima/sdk";
import { createAcpModel, type ResolvedAcpProfile } from "./config.ts";
import {
	AcpProcessManager,
	type AcpClientInitializeParams,
	type AcpClientSessionHandlers,
	type AcpManagedClient,
	type AcpNewSessionInfo,
	type AcpNewSessionParams,
	type AcpPromptParams,
	type AcpSetModelParams,
} from "./process-manager.ts";
import type { AcpClientHandlers, AcpSessionUpdate } from "./protocol.ts";
import { AcpVideoJobRegistry, createAcpModelProvider } from "./provider.ts";

const silentLogger: PluginLogger = {
	debug() {},
	error() {},
	info() {},
	trace() {},
	warn() {},
};

const directories: string[] = [];
const managers: AcpProcessManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map(async (manager) => await manager.disposeAll()));
	await Promise.all(
		directories
			.splice(0)
			.map(async (directory) => await rm(directory, { force: true, recursive: true })),
	);
});

function createProfile(overrides: Partial<ResolvedAcpProfile> = {}): ResolvedAcpProfile {
	const models = overrides.models ?? [
		createAcpModel("chat-model", { enabled: true, supportsImage: true }),
	];
	return {
		allowedCapabilityChat: false,
		args: ["--stdio"],
		command: "synthetic-acp",
		enableAsModelProvider: true,
		enabled: true,
		enabledModels: models.filter((model) => model.enabled),
		env: {},
		id: "synthetic",
		idleTtlMs: 60_000,
		models,
		preset: "custom",
		providerId: "acp:synthetic",
		requestTimeoutMs: 30_000,
		supportsCapabilityTool: false,
		supportsImageGeneration: false,
		supportsVideoGeneration: false,
		toolBridgeMode: "disabled",
		...overrides,
	};
}

interface PromptContext {
	readonly cwd: string;
	readonly emit: (update: AcpSessionUpdate) => void;
	readonly handlers: AcpClientSessionHandlers;
	readonly params: AcpPromptParams & { readonly signal?: AbortSignal };
	readonly prompt: string;
	readonly protocolHandlers: AcpClientHandlers;
	readonly sessionId: string;
}

type PromptBehavior = (context: PromptContext) => Promise<void>;

class FakeAcpClient implements AcpManagedClient {
	closed = false;
	readonly modelCalls: string[] = [];
	readonly newSessionCalls: AcpNewSessionParams[] = [];
	readonly promptCalls: PromptContext[] = [];
	protocolHandlerClears = 0;
	protocolHandlerSets = 0;
	readonly #protocolHandlers = new Map<string, AcpClientHandlers>();
	readonly #sessionHandlers = new Map<string, AcpClientSessionHandlers>();
	#behavior: PromptBehavior | undefined;
	#cwd = "";
	#nextSession = 0;

	get activeProtocolHandlerCount(): number {
		return this.#protocolHandlers.size;
	}

	setBehavior(behavior?: PromptBehavior): void {
		this.#behavior = behavior;
	}

	async initialize(_params: AcpClientInitializeParams): Promise<unknown> {
		return {};
	}

	async newSession(
		params: AcpNewSessionParams,
		handlers?: AcpClientSessionHandlers,
	): Promise<AcpNewSessionInfo> {
		this.#nextSession += 1;
		const sessionId = `synthetic-session-${this.#nextSession}`;
		this.#cwd = params.cwd;
		this.newSessionCalls.push(params);
		if (handlers !== undefined) this.#sessionHandlers.set(sessionId, handlers);
		return {
			availableModels: [],
			configOptions: [],
			currentModelId: "chat-model",
			promptCapabilities: { image: true },
			sessionId,
		};
	}

	setSessionHandlers(sessionId: string, handlers: AcpClientHandlers | undefined): void {
		if (handlers === undefined) {
			this.protocolHandlerClears += 1;
			this.#protocolHandlers.delete(sessionId);
			return;
		}
		this.protocolHandlerSets += 1;
		this.#protocolHandlers.set(sessionId, handlers);
	}

	async prompt(params: AcpPromptParams & { readonly signal?: AbortSignal }): Promise<unknown> {
		const handlers = this.#sessionHandlers.get(params.sessionId);
		const protocolHandlers = this.#protocolHandlers.get(params.sessionId);
		if (handlers === undefined || protocolHandlers === undefined) {
			throw new Error("ACP session handlers were not installed");
		}
		const context: PromptContext = {
			cwd: this.#cwd,
			emit: (update) => {
				handlers.onSessionUpdate?.({ sessionId: params.sessionId, update });
			},
			handlers,
			params,
			prompt: promptText(params.prompt),
			protocolHandlers,
			sessionId: params.sessionId,
		};
		this.promptCalls.push(context);
		await this.#behavior?.(context);
		return { stopReason: "end_turn" };
	}

	async setModel(params: AcpSetModelParams): Promise<void> {
		this.modelCalls.push(params.modelId);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

interface Harness {
	readonly client: FakeAcpClient;
	readonly provider: PluginModelProvider;
	readonly root: string;
}

interface CreateHarnessOptions {
	readonly behavior?: PromptBehavior;
	readonly profile?: ResolvedAcpProfile;
}

async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "tsukaima-acp-provider-"));
	directories.push(root);
	const profile = options.profile ?? createProfile();
	const client = new FakeAcpClient();
	client.setBehavior(options.behavior);
	const manager = new AcpProcessManager({
		connect: async () => client,
		reaperIntervalMs: 3_600_000,
	});
	managers.push(manager);
	const provider = createAcpModelProvider({
		artifactsRootDir: join(root, "artifacts"),
		createPortImpl: () => ({
			modelId: profile.enabledModels[0]?.id ?? `${profile.id}-media`,
			models: {},
			providerId: profile.providerId,
		}),
		logger: silentLogger,
		processManager: manager,
		profile,
	});
	return { client, provider, root };
}

function promptText(prompt: readonly unknown[]): string {
	const parts: string[] = [];
	for (const block of prompt) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n");
}

function promptImageCount(prompt: readonly unknown[]): number {
	return prompt.filter((block) => isRecord(block) && block.type === "image").length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pngBytes(suffix = 0): Uint8Array {
	return Uint8Array.from([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		0x49,
		0x48,
		0x44,
		0x52,
		suffix,
	]);
}

function mp4Bytes(suffix = 0): Uint8Array {
	return Uint8Array.from([
		0x00,
		0x00,
		0x00,
		0x18,
		0x66,
		0x74,
		0x79,
		0x70,
		0x69,
		0x73,
		0x6f,
		0x6d,
		0x00,
		0x00,
		0x02,
		0x00,
		0x69,
		0x73,
		0x6f,
		0x6d,
		suffix,
	]);
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition was not reached");
}

describe("createAcpModelProvider", () => {
	test("lists configured descriptors and delegates port creation", async () => {
		const profile = createProfile({
			models: [
				createAcpModel("chat-model", { enabled: true, supportsImage: true }),
				createAcpModel("disabled-model", { enabled: false }),
			],
		});
		const harness = await createHarness({ profile });

		expect(harness.provider.id).toBe("acp:synthetic");
		expect(await harness.provider.isConfigured?.()).toBe(true);
		const models = await harness.provider.listModels?.();
		expect(models?.map((model) => model.id)).toEqual(["chat-model"]);
		expect(models?.[0]?.capabilities).toContain("basic-chat");
		expect(models?.[0]?.capabilities).toContain("vision");

		const port = await harness.provider.createPort();
		expect(port).toMatchObject({ modelId: "chat-model", providerId: "acp:synthetic" });
	});

	test("synthesizes a media-only descriptor when no chat models are enabled", async () => {
		const harness = await createHarness({
			profile: createProfile({
				enabledModels: [],
				models: [],
				supportsImageGeneration: true,
				supportsVideoGeneration: true,
			}),
		});

		expect(await harness.provider.isConfigured?.()).toBe(true);
		const models = await harness.provider.listModels?.();
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "synthetic-media",
			output: ["image", "video"],
		});
		expect(models?.[0]?.capabilities).toEqual(
			expect.arrayContaining(["image.generate", "image.edit", "video.generate"]),
		);
	});

	test("reports an unconfigured disabled profile", async () => {
		const harness = await createHarness({ profile: createProfile({ enabled: false }) });
		expect(await harness.provider.isConfigured?.()).toBe(false);
	});

	test("completes a chat turn and clears read-only session handlers", async () => {
		let writeError: unknown;
		const harness = await createHarness({
			behavior: async (context) => {
				try {
					await context.protocolHandlers.onFsWrite?.({
						content: "nope",
						path: "synthetic.txt",
						sessionId: context.sessionId,
					});
				} catch (error) {
					writeError = error;
				}
				context.emit({
					content: { text: "ignored", type: "text" },
					sessionUpdate: "agent_thought_chunk",
				});
				context.emit({
					content: { text: "Hello", type: "text" },
					sessionUpdate: "agent_message_chunk",
				});
				context.emit({
					content: { text: " world", type: "text" },
					sessionUpdate: "agent_message_chunk",
				});
			},
		});

		const result = await harness.provider.complete?.({
			messages: [{ content: "Synthetic prompt", role: "user" }],
			modelId: "chat-model",
		});

		expect(result).toEqual({
			modelId: "chat-model",
			providerId: "acp:synthetic",
			text: "Hello world",
		});
		expect(harness.client.modelCalls).toEqual(["chat-model"]);
		expect(harness.client.promptCalls[0]?.prompt).toContain("Synthetic prompt");
		expect(harness.client.protocolHandlerSets).toBeGreaterThan(0);
		expect(harness.client.protocolHandlerClears).toBeGreaterThan(0);
		expect(harness.client.activeProtocolHandlerCount).toBe(0);
		expect(writeError).toBeInstanceOf(Error);
		expect((writeError as Error).message).toMatch(/read-only|not expose/i);
	});

	test("decides a constrained choice through the chat completion path", async () => {
		const harness = await createHarness({
			behavior: async (context) => {
				context.emit({
					content: {
						text: '{"decision":"approve","confidence":0.75,"reason":"fits"}',
						type: "text",
					},
					sessionUpdate: "agent_message_chunk",
				});
			},
		});

		const result = await harness.provider.decideChoice?.({
			context: "Synthetic context",
			instructions: "Pick one",
			modelId: "chat-model",
			options: { approve: "Allow", deny: "Deny" },
		});

		expect(result).toEqual({
			choice: "approve",
			confidence: 0.75,
			modelId: "chat-model",
			providerId: "acp:synthetic",
			reason: "fits",
		});
		expect(harness.client.promptCalls[0]?.prompt).toContain("Allowed decisions: approve, deny");
	});

	test("rejects a decision outside the offered options", async () => {
		const harness = await createHarness({
			behavior: async (context) => {
				context.emit({
					content: { text: '{"decision":"other"}', type: "text" },
					sessionUpdate: "agent_message_chunk",
				});
			},
		});

		await expect(
			harness.provider.decideChoice?.({
				context: "Synthetic context",
				instructions: "Pick one",
				modelId: "chat-model",
				options: { approve: "Allow", deny: "Deny" },
			}),
		).rejects.toThrow(/must choose one of/u);
	});

	test("generates an image inside the artifact sandbox and rejects escaping writes", async () => {
		const reference = pngBytes(1);
		const generated = pngBytes(2);
		let stagedReference: Uint8Array | undefined;
		let insideWriteWorked = false;
		let escapeError: unknown;
		let imageBlockCount = 0;
		let terminalHandler: unknown;
		const harness = await createHarness({
			behavior: async (context) => {
				stagedReference = new Uint8Array(await readFile(join(context.cwd, "reference-0.png")));
				imageBlockCount = promptImageCount(context.params.prompt);
				terminalHandler = context.protocolHandlers.onTerminal;

				const insidePath = join(context.cwd, "notes", "inside.txt");
				await context.protocolHandlers.onFsWrite?.({
					content: "inside",
					path: insidePath,
					sessionId: context.sessionId,
				});
				insideWriteWorked = existsSync(insidePath);

				try {
					await context.protocolHandlers.onFsWrite?.({
						content: "escape",
						path: join(context.cwd, "..", "escape.txt"),
						sessionId: context.sessionId,
					});
				} catch (error) {
					escapeError = error;
				}

				await writeFile(join(context.cwd, "generated.png"), generated);
				context.emit({
					content: { text: "Saved generated.png", type: "text" },
					sessionUpdate: "agent_message_chunk",
				});
			},
			profile: createProfile({
				models: [
					createAcpModel("image-model", {
						enabled: true,
						supportsImage: true,
						supportsImageGeneration: true,
					}),
				],
				supportsImageGeneration: true,
			}),
		});

		const result = await harness.provider.generateImage?.({
			prompt: "Synthetic scene",
			referenceImages: [{ bytes: reference, mimeType: "image/png" }],
		});

		expect(stagedReference).toEqual(reference);
		expect(imageBlockCount).toBe(1);
		expect(terminalHandler).toBeUndefined();
		expect(insideWriteWorked).toBe(true);
		expect(escapeError).toBeInstanceOf(Error);
		expect((escapeError as Error).message).toMatch(/outside|sandbox/i);
		expect(existsSync(join(harness.root, "artifacts", "escape.txt"))).toBe(false);
		expect(result?.images).toHaveLength(1);
		expect(result?.images[0]?.bytes).toEqual(generated);
		expect(result?.images[0]?.mimeType).toBe("image/png");
		expect(result).toMatchObject({
			modelId: "image-model",
			providerId: "acp:synthetic",
		});
	});

	test("runs a submitted video job to success", async () => {
		const video = mp4Bytes(1);
		let releaseVideo: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseVideo = resolve;
		});
		const harness = await createHarness({
			behavior: async (context) => {
				await writeFile(join(context.cwd, "generated.mp4"), video);
				await gate;
				context.emit({
					content: { text: "Saved generated.mp4", type: "text" },
					sessionUpdate: "agent_message_chunk",
				});
			},
			profile: createProfile({
				enabledModels: [],
				models: [],
				supportsVideoGeneration: true,
			}),
		});

		const handle = await harness.provider.submitVideoJob?.({
			prompt: "Synthetic clip",
		});
		expect(handle).toMatchObject({
			modelId: "synthetic-media",
			pollAfterMs: 2_000,
			providerId: "acp:synthetic",
		});
		expect(await harness.provider.pollVideoJob?.(handle!)).toEqual({
			pollAfterMs: 2_000,
			status: "running",
		});

		releaseVideo?.();
		let status = await harness.provider.pollVideoJob?.(handle!);
		for (let attempt = 0; attempt < 500 && status?.status === "running"; attempt += 1) {
			await Bun.sleep(1);
			status = await harness.provider.pollVideoJob?.(handle!);
		}
		expect(status?.status).toBe("succeeded");
		if (status?.status === "succeeded") {
			expect(status.video.bytes).toEqual(video);
			expect(status.video.mimeType).toBe("video/mp4");
		}
	});

	test("cancels a running video job and reports failure", async () => {
		let abortObserved = false;
		let promptStarted = false;
		const harness = await createHarness({
			behavior: async (context) => {
				promptStarted = true;
				await new Promise<void>((_resolve, reject) => {
					const signal = context.params.signal;
					if (signal?.aborted === true) {
						abortObserved = true;
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener(
						"abort",
						() => {
							abortObserved = true;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
			profile: createProfile({
				enabledModels: [],
				models: [],
				supportsVideoGeneration: true,
			}),
		});

		const handle = await harness.provider.submitVideoJob?.({
			prompt: "Synthetic clip",
		});
		expect(await harness.provider.pollVideoJob?.(handle!)).toMatchObject({ status: "running" });

		await waitFor(() => promptStarted);
		await harness.provider.cancelVideoJob?.(handle!);
		await waitFor(() => abortObserved);

		const status = await harness.provider.pollVideoJob?.(handle!);
		expect(status).toMatchObject({ retryable: false, status: "failed" });
		if (status?.status === "failed") expect(status.error).toMatch(/cancel/iu);
	});

	test("disposes running video jobs by aborting their controllers", async () => {
		const registry = new AcpVideoJobRegistry();
		let jobSignal: AbortSignal | undefined;
		registry.start("job-dispose", async (signal) => {
			jobSignal = signal;
			await new Promise<void>((resolve) => {
				if (signal.aborted) {
					resolve();
					return;
				}
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return { bytes: mp4Bytes(2), mimeType: "video/mp4" };
		});
		await Bun.sleep(0);
		expect(jobSignal).toBeDefined();
		expect(registry.status("job-dispose")).toMatchObject({ status: "running" });

		registry.dispose();

		expect(jobSignal?.aborted).toBe(true);
		expect(registry.status("job-dispose")).toBeUndefined();
	});
});
