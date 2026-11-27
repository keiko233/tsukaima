import type { MessagePart } from "@tsukaima/contracts";
import type { ModelPolicy } from "@tsukaima/core";
import type {
	AuditEntry,
	PluginTask,
	PluginTaskExecutionResult,
	PluginVideoGenerateRequest,
	PluginVideoJobHandle,
	PluginVideoJobStatus,
} from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import type { MediaService, StoredMedia } from "./media-service.ts";
import type { OutboundService } from "./outbound.ts";
import type { PluginTaskService } from "./plugin-task-service.ts";

export const VIDEO_GENERATION_PLUGIN_ID = "media-generation";
export const VIDEO_POLL_TASK_KIND = "video.poll";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 600_000;

interface VideoPollTaskPayload {
	readonly conversationId: string;
	readonly jobId: string;
	readonly maxWaitMs: number;
	readonly modelId: string;
	readonly pollAfterMs: number;
	readonly prompt: string;
	readonly providerId: string;
	readonly sendToChat: boolean;
	readonly startedAtMs: number;
}

export interface VideoGenerationServiceOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly cancelVideoJob?: (handle: PluginVideoJobHandle) => Promise<void>;
	readonly logger: Logger;
	readonly media: MediaService;
	readonly now?: () => number;
	readonly outbound?: OutboundService | undefined;
	readonly pollVideoJob: (
		handle: PluginVideoJobHandle,
		signal?: AbortSignal,
	) => Promise<PluginVideoJobStatus>;
	readonly recordUsage?: (usage: {
		readonly capability: string;
		readonly count: number;
		readonly modelId: string;
		readonly providerId: string;
	}) => void;
	readonly routingPolicies?: () => readonly ModelPolicy[];
	readonly submitVideoJob: (request: PluginVideoGenerateRequest) => Promise<PluginVideoJobHandle>;
	readonly tasks: PluginTaskService;
}

export interface VideoGenerationSubmission {
	readonly jobId: string;
	readonly modelId: string;
	readonly providerId: string;
	readonly status: "submitted";
	readonly taskId: string;
}

/**
 * Orchestrates asynchronous video generation using durable `PluginTaskService` polling,
 * SSRF-guarded media ingestion, and `OutboundService` conversation delivery.
 */
export class VideoGenerationService {
	readonly #audit: VideoGenerationServiceOptions["audit"];
	readonly #cancelVideoJob: VideoGenerationServiceOptions["cancelVideoJob"];
	readonly #logger: Logger;
	readonly #media: MediaService;
	readonly #now: () => number;
	readonly #outbound: OutboundService | undefined;
	readonly #pollVideoJob: VideoGenerationServiceOptions["pollVideoJob"];
	readonly #recordUsage: VideoGenerationServiceOptions["recordUsage"];
	readonly #routingPolicies: VideoGenerationServiceOptions["routingPolicies"];
	readonly #submitVideoJob: VideoGenerationServiceOptions["submitVideoJob"];
	readonly #tasks: PluginTaskService;
	#unregister: (() => void) | undefined;

	constructor(options: VideoGenerationServiceOptions) {
		this.#audit = options.audit;
		this.#cancelVideoJob = options.cancelVideoJob;
		this.#logger = options.logger.child("tsukaima::server::video-gen");
		this.#media = options.media;
		this.#now = options.now ?? Date.now;
		this.#outbound = options.outbound;
		this.#pollVideoJob = options.pollVideoJob;
		this.#recordUsage = options.recordUsage;
		this.#routingPolicies = options.routingPolicies;
		this.#submitVideoJob = options.submitVideoJob;
		this.#tasks = options.tasks;
	}

	register(): void {
		if (this.#unregister !== undefined) return;
		this.#unregister = this.#tasks.registerHandler(
			VIDEO_GENERATION_PLUGIN_ID,
			VIDEO_POLL_TASK_KIND,
			async (task) => await this.pollTask(task),
		);
	}

	dispose(): void {
		this.#unregister?.();
		this.#unregister = undefined;
	}

	async submit(input: {
		readonly conversationId: string;
		readonly maxWaitMs?: number;
		readonly request: PluginVideoGenerateRequest;
		readonly sendToChat?: boolean;
	}): Promise<VideoGenerationSubmission> {
		const capability =
			input.request.referenceImages !== undefined && input.request.referenceImages.length > 0
				? "video.image2video"
				: "video.generate";
		const handle = await this.#submitWithPolicy(input.request, capability);
		const now = this.#now();
		const pollAfterMs = Math.max(500, handle.pollAfterMs ?? DEFAULT_POLL_INTERVAL_MS);
		const maxWaitMs = Math.max(10_000, input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
		const payload: VideoPollTaskPayload = {
			conversationId: input.conversationId,
			jobId: handle.jobId,
			maxWaitMs,
			modelId: handle.modelId,
			pollAfterMs,
			prompt: input.request.prompt,
			providerId: handle.providerId,
			sendToChat: input.sendToChat !== false,
			startedAtMs: now,
		};
		// Store the durable conversation ID inside payload rather than `plugin_tasks.conversation_id`
		// (which references `conversations.id`, and polling should not hold the conversation lock).
		const task = await this.#tasks.create(VIDEO_GENERATION_PLUGIN_ID, {
			kind: VIDEO_POLL_TASK_KIND,
			maxAttempts: 120,
			nextRunAtMs: now + pollAfterMs,
			payload,
		});
		await this.#audit?.({
			action: "media.generate_video.submitted",
			actorId: input.conversationId,
			actorKind: "agent",
			payload: {
				jobId: handle.jobId,
				modelId: handle.modelId,
				providerId: handle.providerId,
				taskId: task.id,
			},
			result: "ok",
			targetId: task.id,
			targetKind: "plugin-task",
		});
		this.#logger.debug("video generation job submitted", {
			conversationId: input.conversationId,
			jobId: handle.jobId,
			modelId: handle.modelId,
			providerId: handle.providerId,
			taskId: task.id,
		});
		return {
			jobId: handle.jobId,
			modelId: handle.modelId,
			providerId: handle.providerId,
			status: "submitted",
			taskId: task.id,
		};
	}

	async getStatus(taskId: string): Promise<PluginTask | undefined> {
		return await this.#tasks.get(VIDEO_GENERATION_PLUGIN_ID, taskId);
	}

	async cancel(taskId: string): Promise<PluginTask | undefined> {
		const task = await this.#tasks.get(VIDEO_GENERATION_PLUGIN_ID, taskId);
		if (task === undefined) return undefined;
		const payload = parsePayload(task.payload);
		if (payload !== undefined && this.#cancelVideoJob !== undefined) {
			await this.#cancelVideoJob({
				jobId: payload.jobId,
				modelId: payload.modelId,
				providerId: payload.providerId,
			}).catch(() => undefined);
		}
		return await this.#tasks.cancel(VIDEO_GENERATION_PLUGIN_ID, taskId);
	}

	async pollTask(task: PluginTask): Promise<PluginTaskExecutionResult> {
		const payload = parsePayload(task.payload);
		if (payload === undefined) {
			return { logs: ["invalid video task payload"], outcome: { status: "failed" }, stop: true };
		}
		const now = this.#now();
		if (now - payload.startedAtMs > payload.maxWaitMs) {
			await this.#audit?.({
				action: "media.generate_video.failed",
				actorId: payload.conversationId,
				actorKind: "system",
				payload: { jobId: payload.jobId, reason: "timeout" },
				reason: "Video generation timed out",
				result: "failed",
				targetId: task.id,
				targetKind: "plugin-task",
			});
			return {
				logs: ["video generation timed out"],
				outcome: { error: "Video generation timed out", status: "failed" },
				stop: true,
			};
		}

		const status = await this.#pollVideoJob({
			jobId: payload.jobId,
			modelId: payload.modelId,
			providerId: payload.providerId,
		});

		if (status.status !== "succeeded") {
			if (status.status === "failed") {
				if (status.retryable === true) {
					throw new Error(status.error);
				}
				await this.#audit?.({
					action: "media.generate_video.failed",
					actorId: payload.conversationId,
					actorKind: "system",
					payload: { error: status.error, jobId: payload.jobId },
					reason: status.error,
					result: "failed",
					targetId: task.id,
					targetKind: "plugin-task",
				});
				return {
					logs: [`failed: ${status.error}`],
					outcome: { error: status.error, status: "failed" },
					stop: true,
				};
			}
			const delayMs = Math.max(500, status.pollAfterMs ?? payload.pollAfterMs);
			return {
				logs: [`status=${status.status}`],
				nextRunAtMs: this.#now() + delayMs,
				outcome: {
					...(status.progress === undefined ? {} : { progress: status.progress }),
					status: status.status,
				},
			};
		}

		const metadata = {
			jobId: payload.jobId,
			modelId: payload.modelId,
			prompt: payload.prompt,
			providerId: payload.providerId,
		};
		let stored: StoredMedia;
		if (status.video.bytes !== undefined) {
			stored = await this.#media.store({
				bytes: status.video.bytes,
				...(status.video.durationMs === undefined ? {} : { durationMs: status.video.durationMs }),
				...(status.video.height === undefined ? {} : { height: status.video.height }),
				kind: "video",
				metadata,
				mimeType: status.video.mimeType,
				source: "generated",
				...(status.video.width === undefined ? {} : { width: status.video.width }),
			});
		} else if (status.video.url !== undefined) {
			stored = await this.#media.storeFromUrl(status.video.url, {
				...(status.video.durationMs === undefined ? {} : { durationMs: status.video.durationMs }),
				...(status.video.height === undefined ? {} : { height: status.video.height }),
				kind: "video",
				metadata,
				mimeType: status.video.mimeType,
				source: "generated",
				...(status.video.width === undefined ? {} : { width: status.video.width }),
			});
		} else {
			throw new Error("Completed video result had neither bytes nor url");
		}

		this.#recordUsage?.({
			capability: "video.generate",
			count: 1,
			modelId: payload.modelId,
			providerId: payload.providerId,
		});

		let delivered = false;
		if (payload.sendToChat && payload.conversationId.length > 0 && this.#outbound !== undefined) {
			const part: MessagePart = {
				mediaId: stored.id,
				mimeType: stored.mimeType,
				sha256: stored.sha256,
				sizeBytes: stored.sizeBytes,
				type: "video",
				...(stored.durationMs === null ? {} : { durationMs: stored.durationMs }),
				...(stored.height === null ? {} : { height: stored.height }),
				...(stored.width === null ? {} : { width: stored.width }),
			};
			await this.#outbound.sendToConversation(VIDEO_GENERATION_PLUGIN_ID, {
				conversationId: payload.conversationId,
				parts: [part],
			});
			delivered = true;
		}

		await this.#audit?.({
			action: "media.generate_video.completed",
			actorId: payload.conversationId,
			actorKind: "system",
			payload: {
				delivered,
				jobId: payload.jobId,
				mediaId: stored.id,
				modelId: payload.modelId,
				providerId: payload.providerId,
			},
			result: "ok",
			targetId: task.id,
			targetKind: "plugin-task",
		});
		this.#logger.info("video generation completed", {
			conversationId: payload.conversationId,
			delivered,
			jobId: payload.jobId,
			mediaId: stored.id,
			taskId: task.id,
		});

		return {
			logs: [`stored mediaId=${stored.id} delivered=${String(delivered)}`],
			outcome: {
				delivered,
				jobId: payload.jobId,
				mediaId: stored.id,
				status: "succeeded",
			},
			stop: true,
		};
	}

	async #submitWithPolicy(
		baseRequest: PluginVideoGenerateRequest,
		capability: string,
	): Promise<PluginVideoJobHandle> {
		if (baseRequest.providerId !== undefined || baseRequest.modelId !== undefined) {
			return await this.#submitVideoJob(baseRequest);
		}
		const policy = this.#routingPolicies?.().find((entry) => entry.capability === capability);
		if (policy === undefined) {
			return await this.#submitVideoJob(baseRequest);
		}
		const candidates = [policy.primary, ...(policy.fallbacks ?? [])];
		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				return await this.#submitVideoJob({
					...baseRequest,
					modelId: candidate.modelId,
					providerId: candidate.providerId,
				});
			} catch (error) {
				lastError = error;
			}
		}
		if (lastError !== undefined) throw lastError;
		return await this.#submitVideoJob(baseRequest);
	}
}

function parsePayload(raw: unknown): VideoPollTaskPayload | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	if (
		typeof value.conversationId !== "string" ||
		typeof value.jobId !== "string" ||
		typeof value.modelId !== "string" ||
		typeof value.providerId !== "string" ||
		typeof value.prompt !== "string"
	) {
		return undefined;
	}
	return {
		conversationId: value.conversationId,
		jobId: value.jobId,
		maxWaitMs: typeof value.maxWaitMs === "number" ? value.maxWaitMs : DEFAULT_MAX_WAIT_MS,
		modelId: value.modelId,
		pollAfterMs:
			typeof value.pollAfterMs === "number" ? value.pollAfterMs : DEFAULT_POLL_INTERVAL_MS,
		prompt: value.prompt,
		providerId: value.providerId,
		sendToChat: value.sendToChat !== false,
		startedAtMs: typeof value.startedAtMs === "number" ? value.startedAtMs : Date.now(),
	};
}
