import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	PluginDecisionChoiceRequest,
	PluginGeneratedVideo,
	PluginImageGenerateRequest,
	PluginImageReference,
	PluginLogger,
	PluginModelCompleteMessage,
	PluginModelCompleteRequest,
	PluginModelCompleteResult,
	PluginModelDescriptor,
	PluginModelPort,
	PluginModelProvider,
	PluginVideoGenerateRequest,
	PluginVideoJobStatus,
} from "@tsukaima/sdk";
import { MODEL_CAPABILITIES } from "@tsukaima/sdk/model-capabilities";
import {
	extractAcpArtifacts,
	withArtifactSandbox,
	type AcpArtifactUpdateInput,
} from "./artifacts.ts";
import {
	toAcpPluginModelDescriptor,
	type AcpModelConfig,
	type ResolvedAcpProfile,
} from "./config.ts";
import {
	type AcpClientSessionHandlers,
	type AcpManagedClient,
	type AcpProcessManager,
	type AcpPromptParams,
} from "./process-manager.ts";
import type {
	AcpClientHandlers,
	AcpContentBlock,
	AcpImageContentBlock,
	AcpPermissionDecision,
	AcpSessionUpdate,
} from "./protocol.ts";

const VIDEO_POLL_AFTER_MS = 2_000;

/** Creates the host-facing model provider for one resolved ACP profile. */
export interface AcpModelProviderDependencies {
	readonly artifactsRootDir: string;
	readonly createPortImpl: (options: {
		readonly onMessage?: (message: unknown) => void;
	}) => PluginModelPort | Promise<PluginModelPort>;
	readonly logger: PluginLogger;
	readonly processManager: AcpProcessManager;
	readonly profile: ResolvedAcpProfile;
	readonly videoJobs?: AcpVideoJobRegistry;
}

type AcpVideoJobState =
	| { readonly controller: AbortController; readonly status: "running" }
	| { readonly status: "succeeded"; readonly video: PluginGeneratedVideo }
	| { readonly error: string; readonly status: "failed" };

/**
 * Tracks in-memory asynchronous ACP video jobs. Cancellation aborts the owning run so the
 * session sends `session/cancel`, and {@link dispose} tears down every still-running job.
 */
export class AcpVideoJobRegistry {
	readonly #jobs = new Map<string, AcpVideoJobState>();
	readonly #pollAfterMs: number;

	constructor(options: { readonly pollAfterMs?: number } = {}) {
		this.#pollAfterMs = options.pollAfterMs ?? VIDEO_POLL_AFTER_MS;
	}

	/** Starts a job and records its terminal state without surfacing rejections to the host. */
	start(jobId: string, run: (signal: AbortSignal) => Promise<PluginGeneratedVideo>): void {
		if (this.#jobs.has(jobId)) {
			throw new Error(`ACP video job ${jobId} is already registered`);
		}
		const controller = new AbortController();
		this.#jobs.set(jobId, { controller, status: "running" });
		void (async () => {
			try {
				const video = await run(controller.signal);
				if (this.#jobs.get(jobId)?.status === "running") {
					this.#jobs.set(jobId, { status: "succeeded", video });
				}
			} catch (error) {
				if (this.#jobs.get(jobId)?.status !== "running") return;
				this.#jobs.set(jobId, {
					error: controller.signal.aborted ? "Video generation cancelled" : errorMessage(error),
					status: "failed",
				});
			}
		})();
	}

	/** Returns the current public status for a job, or undefined when it is unknown. */
	status(jobId: string): PluginVideoJobStatus | undefined {
		const job = this.#jobs.get(jobId);
		if (job === undefined) return undefined;
		if (job.status === "running") {
			return { pollAfterMs: this.#pollAfterMs, status: "running" };
		}
		if (job.status === "succeeded") return { status: "succeeded", video: job.video };
		return { error: job.error, retryable: false, status: "failed" };
	}

	/** Marks a running job as cancelled and aborts its session. */
	cancel(jobId: string, reason = "Video generation cancelled"): void {
		const job = this.#jobs.get(jobId);
		if (job === undefined || job.status !== "running") return;
		this.#jobs.set(jobId, { error: reason, status: "failed" });
		job.controller.abort();
	}

	/** Cancels every running job and forgets all tracked state. */
	dispose(): void {
		for (const job of this.#jobs.values()) {
			if (job.status === "running") job.controller.abort();
		}
		this.#jobs.clear();
	}
}

/** Builds the ACP model provider surface used by the plugin host's model registry. */
export function createAcpModelProvider(
	dependencies: AcpModelProviderDependencies,
): PluginModelProvider {
	const { artifactsRootDir, createPortImpl, logger, processManager, profile } = dependencies;
	const videoJobs = dependencies.videoJobs ?? new AcpVideoJobRegistry();
	const completeImpl = async (
		request: PluginModelCompleteRequest,
	): Promise<PluginModelCompleteResult> => {
		const modelId = resolveChatModelId(profile, request.modelId);
		const { text } = await runChatSession(processManager, profile, {
			blocks: toPromptBlocks(request.messages),
			modelId,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		return {
			modelId,
			providerId: profile.providerId,
			text,
		};
	};

	return {
		id: profile.providerId,
		isConfigured() {
			return (
				profile.enabled &&
				(profile.enabledModels.length > 0 ||
					profile.supportsImageGeneration ||
					profile.supportsVideoGeneration)
			);
		},
		listModels() {
			const models = profile.enabledModels.map((model) =>
				toAcpPluginModelDescriptor(model, profile),
			);
			if (
				models.length === 0 &&
				(profile.supportsImageGeneration || profile.supportsVideoGeneration)
			) {
				models.push(synthesizeMediaModel(profile));
			}
			return models;
		},
		async createPort(options = {}) {
			return await createPortImpl(options);
		},
		complete: completeImpl,
		async decideChoice(request) {
			const completion = await completeImpl({
				messages: [{ content: buildDecisionPrompt(request), role: "user" }],
				...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
				...(request.modelId === undefined ? {} : { modelId: request.modelId }),
				...(request.providerId === undefined ? {} : { providerId: request.providerId }),
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
			const decision = parseDecisionChoice(completion.text, request.options);
			return {
				choice: decision.decision,
				modelId: completion.modelId,
				providerId: completion.providerId,
				...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
				...(decision.reason === undefined ? {} : { reason: decision.reason }),
			};
		},
		async generateImage(request) {
			const selection = resolveMediaModel(profile, request.modelId, "image");
			const runId = randomUUID();
			logger.debug("ACP image generation started", {
				modelId: selection.modelId,
				providerId: profile.providerId,
				referenceCount: request.referenceImages?.length ?? 0,
			});
			return await withArtifactSandbox(artifactsRootDir, runId, async ({ artifactDir }) => {
				const staged = await stageReferenceImages(artifactDir, request.referenceImages);
				try {
					const { assistantText: replyText, updates } = await runMediaSession(
						processManager,
						profile,
						{
							artifactDir,
							imageBlocks: staged.map((reference) => reference.block),
							promptText: imagePrompt(request, staged),
							...(selection.sessionModelId === undefined
								? {}
								: { modelId: selection.sessionModelId }),
							...(request.signal === undefined ? {} : { signal: request.signal }),
						},
					);
					await removeStagedReferences(staged);
					const artifacts = await extractAcpArtifacts({
						artifactDir,
						assistantText: replyText,
						updates: toArtifactUpdates(updates),
					});
					if (artifacts.images.length === 0) {
						throw new Error("ACP image generation completed but produced no image artifacts");
					}
					return {
						images: artifacts.images.map((image) => ({
							bytes: image.bytes,
							mimeType: image.mimeType,
						})),
						modelId: selection.modelId,
						providerId: profile.providerId,
					};
				} finally {
					await removeStagedReferences(staged);
				}
			});
		},
		submitVideoJob(request) {
			const selection = resolveMediaModel(profile, request.modelId, "video");
			const jobId = randomUUID();
			logger.debug("ACP video generation submitted", {
				jobId,
				modelId: selection.modelId,
				providerId: profile.providerId,
				referenceCount: request.referenceImages?.length ?? 0,
			});
			videoJobs.start(
				jobId,
				async (signal) =>
					await withArtifactSandbox(artifactsRootDir, jobId, async ({ artifactDir }) => {
						const staged = await stageReferenceImages(artifactDir, request.referenceImages);
						try {
							const { assistantText: replyText, updates } = await runMediaSession(
								processManager,
								profile,
								{
									artifactDir,
									imageBlocks: staged.map((reference) => reference.block),
									promptText: videoPrompt(request, staged),
									...(selection.sessionModelId === undefined
										? {}
										: { modelId: selection.sessionModelId }),
									signal,
								},
							);
							await removeStagedReferences(staged);
							const artifacts = await extractAcpArtifacts({
								artifactDir,
								assistantText: replyText,
								updates: toArtifactUpdates(updates),
							});
							const video = artifacts.videos[0];
							if (video === undefined) {
								throw new Error("ACP video generation completed but produced no video artifacts");
							}
							return { bytes: video.bytes, mimeType: video.mimeType };
						} finally {
							await removeStagedReferences(staged);
						}
					}),
			);
			return {
				jobId,
				modelId: selection.modelId,
				pollAfterMs: VIDEO_POLL_AFTER_MS,
				providerId: profile.providerId,
			};
		},
		pollVideoJob(handle, signal) {
			if (signal?.aborted === true) throw abortError();
			if (handle.providerId !== profile.providerId) {
				return {
					error: `Video job belongs to provider ${handle.providerId}`,
					retryable: false,
					status: "failed",
				};
			}
			return (
				videoJobs.status(handle.jobId) ?? {
					error: `Unknown ACP video job ${handle.jobId}`,
					retryable: false,
					status: "failed",
				}
			);
		},
		cancelVideoJob(handle) {
			if (handle.providerId !== profile.providerId) return;
			videoJobs.cancel(handle.jobId);
		},
	};
}

export interface AcpCapabilityRunInput {
	readonly artifactsRootDir: string;
	readonly modelId?: string;
	readonly processManager: AcpProcessManager;
	readonly profile: ResolvedAcpProfile;
	readonly promptText: string;
	readonly referenceImages?: readonly PluginImageReference[];
	readonly signal?: AbortSignal;
}

export interface AcpCapabilityRunOutput {
	readonly assistantText: string;
	readonly audios: readonly { readonly bytes: Uint8Array; readonly mimeType: string }[];
	readonly images: readonly { readonly bytes: Uint8Array; readonly mimeType: string }[];
	readonly videos: readonly { readonly bytes: Uint8Array; readonly mimeType: string }[];
}

/**
 * Runs one ACP capability turn inside a disposable artifact sandbox and returns extracted
 * text plus media artifacts without exposing host filesystems outside the sandbox.
 */
export async function runSandboxedAcpCapability(
	input: AcpCapabilityRunInput,
): Promise<AcpCapabilityRunOutput> {
	const runId = randomUUID();
	return await withArtifactSandbox(input.artifactsRootDir, runId, async ({ artifactDir }) => {
		const staged = await stageReferenceImages(artifactDir, input.referenceImages);
		try {
			const { assistantText: replyText, updates } = await runMediaSession(
				input.processManager,
				input.profile,
				{
					artifactDir,
					imageBlocks: staged.map((reference) => reference.block),
					promptText: input.promptText,
					...(input.modelId === undefined ? {} : { modelId: input.modelId }),
					...(input.signal === undefined ? {} : { signal: input.signal }),
				},
			);
			await removeStagedReferences(staged);
			const artifacts = await extractAcpArtifacts({
				artifactDir,
				assistantText: replyText,
				updates: toArtifactUpdates(updates),
			});
			return {
				assistantText: replyText,
				audios: artifacts.audios.map((audio) => ({ bytes: audio.bytes, mimeType: audio.mimeType })),
				images: artifacts.images.map((image) => ({ bytes: image.bytes, mimeType: image.mimeType })),
				videos: artifacts.videos.map((video) => ({ bytes: video.bytes, mimeType: video.mimeType })),
			};
		} finally {
			await removeStagedReferences(staged);
		}
	});
}

function synthesizeMediaModel(profile: ResolvedAcpProfile): PluginModelDescriptor {
	const capabilities: string[] = [];
	const output: ("image" | "video")[] = [];
	if (profile.supportsImageGeneration) {
		capabilities.push(MODEL_CAPABILITIES.imageGenerate, MODEL_CAPABILITIES.imageEdit);
		output.push("image");
	}
	if (profile.supportsVideoGeneration) {
		capabilities.push(MODEL_CAPABILITIES.videoGenerate);
		output.push("video");
	}
	return {
		capabilities,
		contextWindow: 128_000,
		id: `${profile.id}-media`,
		input: ["text", "image"],
		maxOutputTokens: 8_192,
		name: `${profile.name ?? profile.id} (media)`,
		output,
	};
}

function enabledModel(
	profile: ResolvedAcpProfile,
	requestedModelId: string | undefined,
): AcpModelConfig | undefined {
	if (requestedModelId === undefined) return profile.enabledModels[0];
	return profile.enabledModels.find((model) => model.id === requestedModelId);
}

function resolveChatModelId(
	profile: ResolvedAcpProfile,
	requestedModelId: string | undefined,
): string {
	const model = enabledModel(profile, requestedModelId);
	if (model !== undefined) return model.id;
	if (requestedModelId !== undefined) {
		throw new Error(`ACP model "${requestedModelId}" is not enabled on ${profile.providerId}`);
	}
	throw new Error(`ACP profile "${profile.id}" has no enabled chat model`);
}

interface MediaModelSelection {
	readonly modelId: string;
	readonly sessionModelId?: string;
}

function resolveMediaModel(
	profile: ResolvedAcpProfile,
	requestedModelId: string | undefined,
	kind: "image" | "video",
): MediaModelSelection {
	const profileSupports =
		kind === "image" ? profile.supportsImageGeneration : profile.supportsVideoGeneration;
	const supports = (model: AcpModelConfig): boolean =>
		kind === "image" ? model.supportsImageGeneration : model.supportsVideoGeneration;

	if (requestedModelId !== undefined) {
		const model = profile.enabledModels.find((candidate) => candidate.id === requestedModelId);
		if (model !== undefined) {
			if (!profileSupports && !supports(model)) {
				throw new Error(`ACP model "${requestedModelId}" does not support ${kind} generation`);
			}
			return { modelId: model.id, sessionModelId: model.id };
		}
		if (profileSupports) return { modelId: requestedModelId };
		throw new Error(
			`ACP model "${requestedModelId}" is not enabled for ${kind} generation on ${profile.providerId}`,
		);
	}

	if (profileSupports) {
		const first = profile.enabledModels[0];
		return first === undefined
			? { modelId: `${profile.id}-media` }
			: { modelId: first.id, sessionModelId: first.id };
	}
	const model = profile.enabledModels.find(supports);
	if (model === undefined) {
		throw new Error(`ACP profile "${profile.id}" does not support ${kind} generation`);
	}
	return { modelId: model.id, sessionModelId: model.id };
}

interface ChatSessionInput {
	readonly blocks: readonly AcpContentBlock[];
	readonly modelId?: string;
	readonly signal?: AbortSignal;
}

async function runChatSession(
	processManager: AcpProcessManager,
	profile: ResolvedAcpProfile,
	input: ChatSessionInput,
): Promise<{ readonly text: string; readonly updates: readonly AcpSessionUpdate[] }> {
	const updates: AcpSessionUpdate[] = [];
	const collect = createUpdateCollector(updates);
	const handlers = createChatSessionHandlers(collect);
	const protocolHandlers: AcpClientHandlers = {
		onFsRead: () => {
			throw new Error("ACP chat sessions do not expose host filesystems");
		},
		onFsWrite: () => {
			throw new Error("ACP chat sessions are read-only");
		},
		onPermissionRequest: () => cancelledPermission(),
	};

	return await processManager.withSession(
		profile,
		{
			handlers,
			...(input.modelId === undefined ? {} : { modelId: input.modelId }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		},
		async (session) => {
			installSessionHandlers(session.client, session.sessionId, protocolHandlers);
			try {
				await session.client.prompt(
					promptParams(session.sessionId, input.blocks, input.signal, collect),
				);
				return { text: assistantText(updates), updates };
			} finally {
				installSessionHandlers(session.client, session.sessionId, undefined);
			}
		},
	);
}

interface MediaSessionInput {
	readonly artifactDir: string;
	readonly imageBlocks: readonly AcpImageContentBlock[];
	readonly modelId?: string;
	readonly promptText: string;
	readonly signal?: AbortSignal;
}

async function runMediaSession(
	processManager: AcpProcessManager,
	profile: ResolvedAcpProfile,
	input: MediaSessionInput,
): Promise<{ readonly assistantText: string; readonly updates: readonly AcpSessionUpdate[] }> {
	const updates: AcpSessionUpdate[] = [];
	const collect = createUpdateCollector(updates);
	const handlers = createMediaSessionHandlers(input.artifactDir, collect);
	const protocolHandlers = createMediaProtocolHandlers(input.artifactDir);

	return await processManager.withSession(
		profile,
		{
			cwd: input.artifactDir,
			handlers,
			...(input.modelId === undefined ? {} : { modelId: input.modelId }),
			...(input.signal === undefined ? {} : { signal: input.signal }),
		},
		async (session) => {
			installSessionHandlers(session.client, session.sessionId, protocolHandlers);
			try {
				const supportsImages = session.promptCapabilities?.image !== false;
				const blocks: AcpContentBlock[] = [
					{ type: "text", text: input.promptText },
					...(supportsImages ? input.imageBlocks : []),
				];
				await session.client.prompt(promptParams(session.sessionId, blocks, input.signal, collect));
				return { assistantText: assistantText(updates), updates };
			} finally {
				installSessionHandlers(session.client, session.sessionId, undefined);
			}
		},
	);
}

type AcpPromptRequest = AcpPromptParams & {
	readonly onUpdate?: (update: AcpSessionUpdate) => void;
	readonly signal?: AbortSignal;
};

function promptParams(
	sessionId: string,
	prompt: readonly unknown[],
	signal: AbortSignal | undefined,
	onUpdate: (update: AcpSessionUpdate) => void,
): AcpPromptRequest {
	return {
		onUpdate,
		prompt,
		sessionId,
		...(signal === undefined ? {} : { signal }),
	};
}

interface AcpClientWithSessionHandlers extends AcpManagedClient {
	setSessionHandlers?(sessionId: string, handlers: AcpClientHandlers | undefined): void;
}

function installSessionHandlers(
	client: AcpManagedClient,
	sessionId: string,
	handlers: AcpClientHandlers | undefined,
): void {
	(client as AcpClientWithSessionHandlers).setSessionHandlers?.(sessionId, handlers);
}

function createChatSessionHandlers(
	collect: (update: AcpSessionUpdate) => void,
): AcpClientSessionHandlers {
	return {
		createTerminal: denyChatAccess,
		killTerminal: denyChatAccess,
		onPermissionRequest: () => cancelledPermission(),
		onSessionUpdate: (notification) => collectSessionUpdate(notification, collect),
		readTextFile: denyChatAccess,
		releaseTerminal: denyChatAccess,
		requestPermission: () => cancelledPermission(),
		sessionUpdate: (notification) => collectSessionUpdate(notification, collect),
		terminalOutput: denyChatAccess,
		waitForTerminalExit: denyChatAccess,
		writeTextFile: denyChatAccess,
	};
}

function denyChatAccess(): never {
	throw new Error("ACP chat sessions do not expose host filesystems or terminals");
}

function createMediaSessionHandlers(
	artifactDir: string,
	collect: (update: AcpSessionUpdate) => void,
): AcpClientSessionHandlers {
	return {
		createTerminal: denyMediaTerminal,
		killTerminal: denyMediaTerminal,
		onPermissionRequest: (params) => decideMediaPermission(artifactDir, params),
		onSessionUpdate: (notification) => collectSessionUpdate(notification, collect),
		readTextFile: async (params) => ({ content: await readSandboxedMedia(artifactDir, params) }),
		releaseTerminal: denyMediaTerminal,
		requestPermission: (params) => decideMediaPermission(artifactDir, params),
		sessionUpdate: (notification) => collectSessionUpdate(notification, collect),
		terminalOutput: denyMediaTerminal,
		waitForTerminalExit: denyMediaTerminal,
		writeTextFile: async (params) => await writeSandboxedMedia(artifactDir, params),
	};
}

function denyMediaTerminal(): never {
	throw new Error("Terminal access is disabled for ACP media sessions");
}

function createMediaProtocolHandlers(artifactDir: string): AcpClientHandlers {
	return {
		onFsRead: async (request) => ({ content: await readSandboxedMedia(artifactDir, request) }),
		onFsWrite: async (request) => await writeSandboxedMedia(artifactDir, request),
		onPermissionRequest: (request) => decideMediaPermission(artifactDir, request),
	};
}

function collectSessionUpdate(
	notification: unknown,
	collect: (update: AcpSessionUpdate) => void,
): void {
	const update = readSessionUpdate(notification);
	if (update !== undefined) collect(update);
}

function createUpdateCollector(updates: AcpSessionUpdate[]): (update: AcpSessionUpdate) => void {
	const seen = new Set<AcpSessionUpdate>();
	return (update) => {
		if (seen.has(update)) return;
		seen.add(update);
		updates.push(update);
	};
}

function readSessionUpdate(notification: unknown): AcpSessionUpdate | undefined {
	if (!isRecord(notification)) return undefined;
	const update = notification.update;
	return isRecord(update) ? (update as unknown as AcpSessionUpdate) : undefined;
}

function assistantText(updates: readonly AcpSessionUpdate[]): string {
	let text = "";
	for (const update of updates) {
		if (update.sessionUpdate !== "agent_message_chunk") continue;
		text += updateText(update);
	}
	return text;
}

function updateText(update: AcpSessionUpdate): string {
	let text = typeof update.text === "string" ? update.text : "";
	for (const block of contentBlocks(update.content)) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

function contentBlocks(content: AcpSessionUpdate["content"]): readonly AcpContentBlock[] {
	if (content === undefined) return [];
	return Array.isArray(content)
		? (content as readonly AcpContentBlock[])
		: [content as AcpContentBlock];
}

function toArtifactUpdates(
	updates: readonly AcpSessionUpdate[],
): readonly AcpArtifactUpdateInput[] {
	const result: AcpArtifactUpdateInput[] = [];
	for (const update of updates) {
		const content = toArtifactContent(update.content);
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			if (content.length > 0) {
				result.push({
					content,
					type: update.sessionUpdate === "tool_call" ? "tool_call" : "tool_call_update",
				});
			}
			continue;
		}
		result.push(...content);
	}
	return result;
}

function toArtifactContent(
	content: AcpSessionUpdate["content"],
): readonly AcpArtifactUpdateInput[] {
	const result: AcpArtifactUpdateInput[] = [];
	for (const block of contentBlocks(content)) {
		if (block.type === "image" || block.type === "audio") {
			result.push({ data: block.data, mimeType: block.mimeType, type: block.type });
			continue;
		}
		if (block.type === "resource") {
			result.push({ resource: block.resource, type: "resource" });
			continue;
		}
		if (block.type === "resource_link") {
			result.push({
				type: "resource_link",
				uri: block.uri,
				...(block.name === undefined ? {} : { name: block.name }),
				...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
			});
		}
	}
	return result;
}

function toPromptBlocks(
	messages: readonly PluginModelCompleteMessage[],
): readonly AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];
	for (const message of messages) {
		const prefix = message.role === "user" ? "" : `${message.role}: `;
		if (typeof message.content === "string") {
			blocks.push({ text: `${prefix}${message.content}`, type: "text" });
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") {
				blocks.push({ text: `${prefix}${part.text}`, type: "text" });
			} else {
				blocks.push({ data: part.data, mimeType: part.mimeType, type: "image" });
			}
		}
	}
	return blocks;
}

interface StagedReference {
	readonly block: AcpImageContentBlock;
	readonly path: string;
}

async function stageReferenceImages(
	artifactDir: string,
	references: readonly PluginImageReference[] | undefined,
): Promise<readonly StagedReference[]> {
	if (references === undefined || references.length === 0) return [];
	const staged: StagedReference[] = [];
	for (const [index, reference] of references.entries()) {
		const path = join(artifactDir, `reference-${index}.${imageExtension(reference.mimeType)}`);
		await writeFile(path, reference.bytes);
		staged.push({
			block: {
				data: Buffer.from(reference.bytes).toString("base64"),
				mimeType: reference.mimeType,
				type: "image",
			},
			path,
		});
	}
	return staged;
}

async function removeStagedReferences(staged: readonly StagedReference[]): Promise<void> {
	await Promise.all(
		staged.map(async (reference) => {
			try {
				await rm(reference.path, { force: true });
			} catch {
				// The sandbox may already have removed the file.
			}
		}),
	);
}

function imageExtension(mimeType: string): string {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/gif":
			return "gif";
		case "image/jpeg":
		case "image/jpg":
			return "jpg";
		case "image/webp":
			return "webp";
		default:
			return "png";
	}
}

function imagePrompt(
	request: PluginImageGenerateRequest,
	staged: readonly StagedReference[],
): string {
	const details: string[] = [];
	if (request.size !== undefined) details.push(`Size: ${request.size}`);
	if (request.aspectRatio !== undefined) details.push(`Aspect ratio: ${request.aspectRatio}`);
	if (request.count !== undefined && request.count > 0) {
		details.push(`Image count: ${request.count}`);
	}
	if (request.negativePrompt !== undefined) {
		details.push(`Avoid: ${request.negativePrompt}`);
	}
	return [
		"Generate an image for the request below and save the output in the current working directory.",
		`Prompt: ${request.prompt}`,
		...details,
		...(staged.length === 0
			? []
			: [
					`Reference images are saved in the current working directory as ${staged
						.map((reference) => reference.path.split(sep).at(-1))
						.join(", ")}.`,
				]),
		"Write the final image file with an image extension inside the current working directory and mention its file name in your reply.",
		"Do not write outside the current working directory and do not use a terminal.",
	].join("\n");
}

function videoPrompt(
	request: PluginVideoGenerateRequest,
	staged: readonly StagedReference[],
): string {
	const details: string[] = [];
	if (request.aspectRatio !== undefined) details.push(`Aspect ratio: ${request.aspectRatio}`);
	if (request.durationSeconds !== undefined) {
		details.push(`Duration: ${request.durationSeconds}s`);
	}
	if (request.resolution !== undefined) details.push(`Resolution: ${request.resolution}`);
	if (request.negativePrompt !== undefined) details.push(`Avoid: ${request.negativePrompt}`);
	return [
		"Generate a short video for the request below and save the output in the current working directory.",
		`Prompt: ${request.prompt}`,
		...details,
		...(staged.length === 0
			? []
			: [
					`Reference images are saved in the current working directory as ${staged
						.map((reference) => reference.path.split(sep).at(-1))
						.join(", ")}.`,
				]),
		"Write the final video file with a video extension inside the current working directory and mention its file name in your reply.",
		"Do not write outside the current working directory and do not use a terminal.",
	].join("\n");
}

function buildDecisionPrompt(request: PluginDecisionChoiceRequest): string {
	const choices = Object.keys(request.options);
	return [
		request.instructions,
		`Context:\n${request.context}`,
		`Allowed decisions: ${choices.join(", ")}`,
		'Respond with only one JSON object shaped like {"decision": "<allowed decision>", "confidence": <number between 0 and 1>, "reason": "<short reason>"}.',
		"Do not include markdown fences or any other text.",
	].join("\n\n");
}

interface ParsedDecisionChoice {
	readonly confidence?: number;
	readonly decision: string;
	readonly reason?: string;
}

function parseDecisionChoice(
	text: string,
	options: Readonly<Record<string, string>>,
): ParsedDecisionChoice {
	const parsed = parseJsonObject(text);
	if (!isRecord(parsed)) {
		throw new Error("ACP decision response was not a JSON object");
	}
	const decision = parsed.decision;
	if (typeof decision !== "string" || !Object.hasOwn(options, decision)) {
		throw new Error(`ACP decision response must choose one of: ${Object.keys(options).join(", ")}`);
	}
	const confidence =
		typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
			? parsed.confidence
			: undefined;
	const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
	return {
		decision,
		...(confidence === undefined ? {} : { confidence }),
		...(reason === undefined ? {} : { reason }),
	};
}

function parseJsonObject(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
	const candidate = fenced?.[1]?.trim() ?? trimmed;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("ACP decision response did not contain a JSON object");
	}
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		throw new Error("ACP decision response contained invalid JSON");
	}
}

async function decideMediaPermission(
	artifactDir: string,
	request: unknown,
): Promise<AcpPermissionDecision> {
	if (!isRecord(request)) return cancelledPermission();
	const toolCall = isRecord(request.toolCall) ? request.toolCall : undefined;
	if (toolCall === undefined) return cancelledPermission();
	if (!(await isSafeMediaPermission(artifactDir, toolCall))) {
		return cancelledPermission();
	}
	const allowOption = findAllowOption(request.options);
	return allowOption === undefined
		? cancelledPermission()
		: { outcome: "selected", optionId: allowOption };
}

const DANGEROUS_TOOL_PATTERN =
	/\b(?:bash|chmod|chown|command|container|dd|delete|docker|exec|execute|kill|mv|move|process|remove|rename|rm|shell|sh|ssh|sudo|terminal|truncate|unlink|zsh)\b/iu;
const MEDIA_TOOL_PATTERN =
	/\b(?:artifact|artifacts|generate|generation|gif|image|images|jpe?g|media|mov|mp4|photo|picture|png|render|video|videos|webm|webp)\b/iu;

async function isSafeMediaPermission(
	artifactDir: string,
	toolCall: Record<string, unknown>,
): Promise<boolean> {
	const kind = typeof toolCall.kind === "string" ? toolCall.kind : "";
	const title = typeof toolCall.title === "string" ? toolCall.title : "";
	const label = `${kind} ${title}`.trim();
	if (DANGEROUS_TOOL_PATTERN.test(label)) return false;
	if (MEDIA_TOOL_PATTERN.test(label)) return true;
	const candidate = findPathCandidate(toolCall.rawInput) ?? findPathCandidate(toolCall);
	return candidate !== undefined && (await isInsideArtifactDir(artifactDir, candidate));
}

function findPathCandidate(value: unknown, depth = 0): string | undefined {
	if (depth > 3 || !isRecord(value)) return undefined;
	for (const key of ["path", "filePath", "file", "filename", "target", "destination"]) {
		const entry = value[key];
		if (typeof entry === "string" && entry.trim().length > 0) return entry;
	}
	for (const entry of Object.values(value)) {
		const nested = findPathCandidate(entry, depth + 1);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

function findAllowOption(options: unknown): string | undefined {
	if (!Array.isArray(options)) return undefined;
	const records = options.filter(isRecord);
	const allowed =
		records.find(
			(option) =>
				typeof option.kind === "string" &&
				(option.kind === "allow_once" || option.kind === "allow_always"),
		) ??
		records.find(
			(option) =>
				typeof option.name === "string" && /\b(?:allow|approve|accept|yes)\b/iu.test(option.name),
		);
	return allowed !== undefined && typeof allowed.optionId === "string"
		? allowed.optionId
		: undefined;
}

function cancelledPermission(): AcpPermissionDecision {
	return { outcome: "cancelled" };
}

async function writeSandboxedMedia(artifactDir: string, params: unknown): Promise<void> {
	if (!isRecord(params)) {
		throw new Error("Invalid ACP media filesystem write request");
	}
	const path = params.path;
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("Invalid ACP media filesystem write path");
	}
	if (!(await isInsideArtifactDir(artifactDir, path))) {
		throw new Error("ACP media sandbox rejected a write outside the artifact directory");
	}
	const content = typeof params.content === "string" ? params.content : "";
	const target = resolve(artifactDir, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, "utf8");
}

async function readSandboxedMedia(artifactDir: string, params: unknown): Promise<string> {
	if (!isRecord(params)) {
		throw new Error("Invalid ACP media filesystem read request");
	}
	const path = params.path;
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("Invalid ACP media filesystem read path");
	}
	if (!(await isInsideArtifactDir(artifactDir, path))) {
		throw new Error("ACP media sandbox rejected a read outside the artifact directory");
	}
	return await readFile(resolve(artifactDir, path), "utf8");
}

async function isInsideArtifactDir(artifactDir: string, candidatePath: string): Promise<boolean> {
	let rootReal: string;
	try {
		rootReal = await realpath(artifactDir);
	} catch {
		return false;
	}
	const target = resolve(artifactDir, candidatePath);
	try {
		return isStrictlyInside(rootReal, await realpath(target));
	} catch {
		// The target does not exist yet; verify its nearest existing ancestor instead.
	}
	let probe = dirname(target);
	while (true) {
		try {
			const probeReal = await realpath(probe);
			return probeReal === rootReal || isStrictlyInside(rootReal, probeReal);
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return false;
			probe = parent;
		}
	}
}

function isStrictlyInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
	const error = new Error("ACP video job poll aborted");
	error.name = "AbortError";
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
