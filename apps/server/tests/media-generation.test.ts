import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { conversations } from "@tsukaima/db";
import type {
	PluginImageGenerateRequest,
	PluginVideoGenerateRequest,
	PluginVideoJobStatus,
} from "@tsukaima/sdk";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logging.ts";
import { createMediaGenerationTools } from "../src/services/media-generation-tools.ts";
import { createPluginMediaBridge } from "../src/services/plugin-media.ts";
import { createLocalChat, listMessagePage } from "../src/services/webui.ts";

const directories: string[] = [];

afterEach(async () => {
	while (directories.length > 0) {
		const dir = directories.pop();
		if (dir !== undefined) await rm(dir, { force: true, recursive: true });
	}
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const GENERATED_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const MP4_BYTES = new Uint8Array([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34,
]);

describe("media generation phase 3", () => {
	test("generates an image, stores it in MediaService, records usage, and sends to conversation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-media-gen-"));
		directories.push(directory);
		const { lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();
		const host = lifecycle.conversationHost;
		if (host === undefined) throw new Error("Conversation host missing");
		const created = await createLocalChat(lifecycle, {
			sessionTitle: "Image Gen Test",
			title: "Image Gen Chat",
		});
		const [sessionRow] =
			(await lifecycle.domainDatabase
				?.select({ durableConversationId: conversations.durableConversationId })
				.from(conversations)
				.where(eq(conversations.id, created.sessionId))
				.limit(1)) ?? [];
		const durableId = sessionRow?.durableConversationId;
		if (durableId === undefined) throw new Error("Durable conversation id missing");

		const calls: PluginImageGenerateRequest[] = [];
		const unregister = lifecycle.pluginHost.registerModelProvider("test-image-owner", {
			id: "test-image-provider",
			isConfigured: () => true,
			listModels: () => [
				{
					capabilities: ["image.generate", "image.edit"],
					id: "flux-pro",
					input: ["text", "image"],
					output: ["image"],
				},
			],
			createPort: () => {
				throw new Error("chat port not used");
			},
			generateImage: (request) => {
				calls.push(request);
				return {
					images: [
						{
							bytes: GENERATED_PNG_BYTES,
							height: 512,
							mimeType: "image/png",
							revisedPrompt: "A crisp watercolor landscape",
							width: 512,
						},
					],
					modelId: request.modelId ?? "flux-pro",
					providerId: "test-image-provider",
				};
			},
		});

		try {
			const reference = await lifecycle.media.store({
				bytes: PNG_BYTES,
				kind: "image",
				mimeType: "image/png",
				source: "webui",
			});
			const extension = createMediaGenerationTools({
				audit: (entry) => lifecycle.writeAudit(entry),
				generateImage: (request) => lifecycle.pluginHost.generateImageModel(request),
				logger: createLogger({ level: "error" }),
				media: lifecycle.media,
				outbound: lifecycle.outbound,
				recordUsage: (usage) => {
					lifecycle.modelUsageLedger.recordUsage({ ...usage, kind: "image" });
				},
				routingPolicies: () => lifecycle.routingPolicies,
			});
			const tool = extension.tools?.find((entry) => entry.name === "generate_image");
			if (tool === undefined) throw new Error("generate_image tool missing");

			const result = await tool.execute(
				{
					aspectRatio: "1:1",
					prompt: "A watercolor landscape",
					referenceMediaIds: [reference.id],
				},
				{ conversationId: Number(durableId) } as never,
				{} as never,
			);
			expect(result.isError).toBeUndefined();
			const firstBlock = result.output?.[0];
			const parsed = JSON.parse(firstBlock?.type === "text" ? firstBlock.text : "{}") as {
				count: number;
				delivered: boolean;
				mediaIds: string[];
				modelId: string;
				providerId: string;
				revisedPrompts: string[];
			};
			expect(parsed.count).toBe(1);
			expect(parsed.delivered).toBe(true);
			expect(parsed.modelId).toBe("flux-pro");
			expect(parsed.providerId).toBe("test-image-provider");
			expect(parsed.revisedPrompts).toEqual(["A crisp watercolor landscape"]);
			expect(parsed.mediaIds).toHaveLength(1);
			expect(calls[0]?.referenceImages).toHaveLength(1);

			const stored = await lifecycle.media.findById(parsed.mediaIds[0]!);
			expect(stored?.kind).toBe("image");
			expect(stored?.source).toBe("generated");
			expect(
				lifecycle.modelUsageLedger.records.some(
					(entry) => entry.kind === "image" && entry.count === 1 && entry.modelId === "flux-pro",
				),
			).toBe(true);

			const page = await listMessagePage(lifecycle, { limit: 10, sessionId: created.sessionId });
			const outboundMessage = page.messages.find((item) => item.direction === "outbound");
			expect(outboundMessage).toBeDefined();
			expect(outboundMessage?.parts[0]).toMatchObject({
				mediaId: parsed.mediaIds[0],
				type: "image",
			});
		} finally {
			unregister();
			await lifecycle.stop();
		}
	});

	test("falls back across routingPolicies and blocks private image URLs via SSRF guard", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-media-fallback-"));
		directories.push(directory);
		const { lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();

		try {
			const bridge = createPluginMediaBridge(lifecycle.media, "test-plugin", ["media.write"]);
			await expect(
				bridge.storeFromUrl?.("http://127.0.0.1:9999/secret.png", { kind: "image" }),
			).rejects.toThrow();

			const attempted: string[] = [];
			const extension = createMediaGenerationTools({
				generateImage: async (request) => {
					attempted.push(`${request.providerId}:${request.modelId}`);
					if (request.providerId === "primary-img") {
						throw new Error("primary rate limited");
					}
					return {
						images: [{ bytes: PNG_BYTES, mimeType: "image/png" }],
						modelId: request.modelId ?? "backup-model",
						providerId: request.providerId ?? "backup-img",
					};
				},
				logger: createLogger({ level: "error" }),
				media: lifecycle.media,
				routingPolicies: () => [
					{
						capability: "image.generate",
						fallbacks: [{ modelId: "backup-model", providerId: "backup-img" }],
						primary: { modelId: "primary-model", providerId: "primary-img" },
					},
				],
			});
			const tool = extension.tools?.[0];
			if (tool === undefined) throw new Error("generate_image tool missing");
			const result = await tool.execute(
				{ prompt: "test fallback", sendToChat: false },
				{ conversationId: 1 } as never,
				{} as never,
			);
			expect(result.isError).toBeUndefined();
			expect(attempted).toEqual(["primary-img:primary-model", "backup-img:backup-model"]);
		} finally {
			await lifecycle.stop();
		}
	});

	test("submits async video job, polls across durable tasks, stores video, and delivers to chat", async () => {
		const directory = await mkdtemp(join(tmpdir(), "tsukaima-video-gen-"));
		directories.push(directory);
		const { lifecycle } = createApp({
			TSUKAIMA_DATA_DIR: directory,
			TSUKAIMA_PORT: "7420",
			TSUKAIMA_WEB_ORIGIN: "http://127.0.0.1:7421",
		});
		await lifecycle.start();
		const created = await createLocalChat(lifecycle, {
			sessionTitle: "Video Gen Test",
			title: "Video Gen Chat",
		});
		const [sessionRow] =
			(await lifecycle.domainDatabase
				?.select({ durableConversationId: conversations.durableConversationId })
				.from(conversations)
				.where(eq(conversations.id, created.sessionId))
				.limit(1)) ?? [];
		const durableId = sessionRow?.durableConversationId;
		if (durableId === undefined) throw new Error("Durable conversation id missing");

		const submitted: PluginVideoGenerateRequest[] = [];
		let pollCount = 0;
		const unregister = lifecycle.pluginHost.registerModelProvider("test-video-owner", {
			id: "test-video-provider",
			isConfigured: () => true,
			listModels: () => [
				{
					capabilities: ["video.generate", "video.image2video"],
					id: "veo-test",
					input: ["text", "image"],
					output: ["video"],
				},
			],
			createPort: () => {
				throw new Error("chat port not used");
			},
			submitVideoJob: (request) => {
				submitted.push(request);
				return {
					jobId: "vid-job-1",
					modelId: request.modelId ?? "veo-test",
					pollAfterMs: 500,
					providerId: "test-video-provider",
				};
			},
			pollVideoJob: (): PluginVideoJobStatus => {
				pollCount += 1;
				if (pollCount === 1) {
					return { pollAfterMs: 500, progress: 50, status: "running" };
				}
				return {
					status: "succeeded",
					video: {
						bytes: MP4_BYTES,
						durationMs: 4_000,
						height: 720,
						mimeType: "video/mp4",
						width: 1280,
					},
				};
			},
		});

		try {
			const extension = createMediaGenerationTools({
				audit: (entry) => lifecycle.writeAudit(entry),
				generateImage: (request) => lifecycle.pluginHost.generateImageModel(request),
				logger: createLogger({ level: "error" }),
				media: lifecycle.media,
				outbound: lifecycle.outbound,
				videoGeneration: lifecycle.videoGeneration,
			});
			const generateVideo = extension.tools?.find((entry) => entry.name === "generate_video");
			const statusTool = extension.tools?.find((entry) => entry.name === "video_job_status");
			if (generateVideo === undefined || statusTool === undefined) {
				throw new Error("video tools missing");
			}

			const submitResult = await generateVideo.execute(
				{ durationSeconds: 4, prompt: "Ocean waves at dusk" },
				{ conversationId: Number(durableId) } as never,
				{} as never,
			);
			expect(submitResult.isError).toBeUndefined();
			const submission = JSON.parse(
				submitResult.output?.[0]?.type === "text" ? submitResult.output[0].text : "{}",
			) as { jobId: string; status: string; taskId: string };
			expect(submission.status).toBe("submitted");
			expect(submission.jobId).toBe("vid-job-1");
			expect(submitted[0]?.durationSeconds).toBe(4);

			// First poll sees running and reschedules without blocking.
			const taskBefore = await lifecycle.videoGeneration.getStatus(submission.taskId);
			if (taskBefore === undefined) throw new Error("video task missing");
			const firstPoll = await lifecycle.videoGeneration.pollTask(taskBefore);
			expect(firstPoll.stop).toBeUndefined();
			expect(firstPoll.outcome).toEqual({ progress: 50, status: "running" });

			// Second poll sees succeeded, stores video, and delivers it to the conversation.
			const secondPoll = await lifecycle.videoGeneration.pollTask(taskBefore);
			expect(secondPoll.stop).toBe(true);
			const outcome = secondPoll.outcome as { delivered: boolean; mediaId: string; status: string };
			expect(outcome.status).toBe("succeeded");
			expect(outcome.delivered).toBe(true);

			const stored = await lifecycle.media.findById(outcome.mediaId);
			expect(stored?.kind).toBe("video");
			expect(stored?.source).toBe("generated");
			expect(stored?.durationMs).toBe(4_000);
			expect(
				lifecycle.modelUsageLedger.records.some(
					(entry) => entry.kind === "video" && entry.count === 1 && entry.modelId === "veo-test",
				),
			).toBe(true);

			const page = await listMessagePage(lifecycle, { limit: 10, sessionId: created.sessionId });
			const outboundMessage = page.messages.find((item) => item.direction === "outbound");
			expect(outboundMessage?.parts[0]).toMatchObject({
				mediaId: outcome.mediaId,
				type: "video",
			});

			const statusResult = await statusTool.execute(
				{ taskId: submission.taskId },
				{ conversationId: Number(durableId) } as never,
				{} as never,
			);
			expect(statusResult.isError).toBeUndefined();
			const statusJson = JSON.parse(
				statusResult.output?.[0]?.type === "text" ? statusResult.output[0].text : "{}",
			) as { taskId: string };
			expect(statusJson.taskId).toBe(submission.taskId);
		} finally {
			unregister();
			await lifecycle.stop();
		}
	});
});
