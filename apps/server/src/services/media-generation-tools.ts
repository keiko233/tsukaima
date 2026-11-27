import type { MessagePart } from "@tsukaima/contracts";
import type { DurableExtension, DurableToolRegistration, ModelPolicy } from "@tsukaima/core";
import type {
	AuditEntry,
	PluginImageGenerateRequest,
	PluginImageGenerateResult,
	PluginImageReference,
} from "@tsukaima/sdk";
import type { Logger } from "../logging.ts";
import { record } from "../records.ts";
import type { MediaService, StoredMedia } from "./media-service.ts";
import type { OutboundService } from "./outbound.ts";

export const MEDIA_GENERATION_TOOLS_EXTENSION_NAME = "tsukaima-media-generation-tools";
export const MEDIA_GENERATION_TOOL_NAMES = ["generate_image"] as const;

export interface MediaGenerationToolsOptions {
	readonly audit?: (entry: AuditEntry) => Promise<void> | void;
	readonly generateImage: (
		request: PluginImageGenerateRequest,
	) => Promise<PluginImageGenerateResult>;
	readonly logger: Logger;
	readonly media: MediaService;
	readonly outbound?: OutboundService | undefined;
	readonly recordUsage?: (usage: {
		readonly capability: string;
		readonly count: number;
		readonly modelId: string;
		readonly providerId: string;
	}) => void;
	readonly routingPolicies?: () => readonly ModelPolicy[];
}

function textOutput(value: unknown) {
	return {
		output: [
			{
				text: typeof value === "string" ? value : JSON.stringify(value),
				type: "text" as const,
			},
		],
	};
}

function errorOutput(error: unknown) {
	return {
		isError: true as const,
		output: [
			{
				text: JSON.stringify({
					error: error instanceof Error ? error.message : String(error),
				}),
				type: "text" as const,
			},
		],
	};
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = optionalString(input, key);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

function optionalInt(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
	const value = input[key];
	if (!Array.isArray(value)) return undefined;
	const items = value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
	return items.length > 0 ? items : undefined;
}

async function resolveReferenceImages(
	media: MediaService,
	mediaIds: readonly string[] | undefined,
): Promise<readonly PluginImageReference[]> {
	if (mediaIds === undefined || mediaIds.length === 0) return [];
	const references: PluginImageReference[] = [];
	for (const mediaId of mediaIds) {
		const row = await media.findById(mediaId);
		if (row === undefined) {
			throw new Error(`Reference media ${mediaId} was not found`);
		}
		if (row.kind !== "image" && row.kind !== "sticker") {
			throw new Error(`Reference media ${mediaId} is not an image`);
		}
		const bytes = await media.readBytes(row.sha256);
		references.push({ bytes, mimeType: row.mimeType });
	}
	return references;
}

async function generateWithPolicy(
	options: MediaGenerationToolsOptions,
	baseRequest: PluginImageGenerateRequest,
	capability: string,
): Promise<PluginImageGenerateResult> {
	if (baseRequest.providerId !== undefined || baseRequest.modelId !== undefined) {
		return await options.generateImage(baseRequest);
	}
	const policy = options.routingPolicies?.().find((entry) => entry.capability === capability);
	if (policy === undefined) {
		return await options.generateImage(baseRequest);
	}
	const candidates = [policy.primary, ...(policy.fallbacks ?? [])];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return await options.generateImage({
				...baseRequest,
				modelId: candidate.modelId,
				providerId: candidate.providerId,
			});
		} catch (error) {
			lastError = error;
		}
	}
	if (lastError !== undefined) throw lastError;
	return await options.generateImage(baseRequest);
}

/**
 * Built-in media generation tools (`generate_image`). Generated assets are persisted into the
 * content-addressed media store (with SSRF guard for upstream URLs) and optionally sent directly
 * to the active conversation via `OutboundService`.
 */
export function createMediaGenerationTools(options: MediaGenerationToolsOptions): DurableExtension {
	const log = options.logger.child("tsukaima::server::media-gen");
	const generateImageTool: DurableToolRegistration = {
		deferred: true,
		description:
			"Generate an image from a text prompt (and optional reference media IDs) using a configured image-generation model, store it, and deliver it to the current chat.",
		name: "generate_image",
		parameters: {
			additionalProperties: false,
			properties: {
				aspectRatio: {
					description: "Optional aspect ratio (e.g. '1:1', '16:9', '9:16').",
					type: "string",
				},
				count: {
					description: "Number of images to generate (1-4). Defaults to 1.",
					maximum: 4,
					minimum: 1,
					type: "integer",
				},
				modelId: {
					description: "Optional specific image model id.",
					type: "string",
				},
				negativePrompt: {
					description: "Optional negative prompt describing what to avoid.",
					type: "string",
				},
				prompt: {
					description: "Text description of the image to generate.",
					type: "string",
				},
				providerId: {
					description: "Optional specific model provider id.",
					type: "string",
				},
				referenceMediaIds: {
					description: "Optional stored image media IDs for image-to-image editing.",
					items: { type: "string" },
					type: "array",
				},
				sendToChat: {
					description: "When true (default), deliver the generated image(s) to this chat.",
					type: "boolean",
				},
				size: {
					description: "Optional output pixel dimensions (e.g. '1024x1024').",
					type: "string",
				},
			},
			required: ["prompt"],
			type: "object",
		},
		surface: "both",
		async execute(rawArgs, api, context) {
			const conversationId = String(api.conversationId);
			try {
				const args = record(rawArgs);
				const prompt = requiredString(args, "prompt");
				const negativePrompt = optionalString(args, "negativePrompt");
				const size = optionalString(args, "size");
				const aspectRatio = optionalString(args, "aspectRatio");
				const rawCount = optionalInt(args, "count");
				const count = rawCount === undefined ? undefined : Math.max(1, Math.min(4, rawCount));
				const modelId = optionalString(args, "modelId");
				const providerId = optionalString(args, "providerId");
				const referenceMediaIds = optionalStringArray(args, "referenceMediaIds");
				const sendToChat = args.sendToChat !== false;
				const signal =
					context !== null && typeof context === "object"
						? "abortSignal" in context && context.abortSignal instanceof AbortSignal
							? context.abortSignal
							: "signal" in context && context.signal instanceof AbortSignal
								? context.signal
								: undefined
						: undefined;

				const referenceImages = await resolveReferenceImages(options.media, referenceMediaIds);
				const capability = referenceImages.length > 0 ? "image.edit" : "image.generate";
				const request: PluginImageGenerateRequest = {
					prompt,
					...(aspectRatio === undefined ? {} : { aspectRatio }),
					...(count === undefined ? {} : { count }),
					...(modelId === undefined ? {} : { modelId }),
					...(negativePrompt === undefined ? {} : { negativePrompt }),
					...(providerId === undefined ? {} : { providerId }),
					...(referenceImages.length === 0 ? {} : { referenceImages }),
					...(signal === undefined ? {} : { signal }),
					...(size === undefined ? {} : { size }),
				};

				const result = await generateWithPolicy(options, request, capability);
				if (result.images.length === 0) {
					throw new Error("Image provider returned no images");
				}
				options.recordUsage?.({
					capability,
					count: result.images.length,
					modelId: result.modelId,
					providerId: result.providerId,
				});

				const storedImages: StoredMedia[] = [];
				for (const image of result.images) {
					const metadata = {
						modelId: result.modelId,
						prompt,
						providerId: result.providerId,
						...(image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt }),
					};
					if (image.bytes !== undefined) {
						storedImages.push(
							await options.media.store({
								bytes: image.bytes,
								...(image.height === undefined ? {} : { height: image.height }),
								kind: "image",
								metadata,
								mimeType: image.mimeType,
								source: "generated",
								...(image.width === undefined ? {} : { width: image.width }),
							}),
						);
					} else if (image.url !== undefined) {
						storedImages.push(
							await options.media.storeFromUrl(image.url, {
								...(image.height === undefined ? {} : { height: image.height }),
								kind: "image",
								metadata,
								mimeType: image.mimeType,
								source: "generated",
								...(image.width === undefined ? {} : { width: image.width }),
							}),
						);
					}
				}
				if (storedImages.length === 0) {
					throw new Error("Generated image entries had neither bytes nor a url");
				}

				let delivered = false;
				if (sendToChat && options.outbound !== undefined) {
					const parts: MessagePart[] = storedImages.map((stored) => ({
						mediaId: stored.id,
						mimeType: stored.mimeType,
						sha256: stored.sha256,
						sizeBytes: stored.sizeBytes,
						type: "image",
						...(stored.height === null ? {} : { height: stored.height }),
						...(stored.width === null ? {} : { width: stored.width }),
					}));
					await options.outbound.sendToConversation("media-generation", {
						conversationId,
						parts,
					});
					delivered = true;
				}

				await options.audit?.({
					action: "media.generate_image",
					actorId: conversationId,
					actorKind: "agent",
					payload: {
						count: storedImages.length,
						delivered,
						mediaIds: storedImages.map((stored) => stored.id),
						modelId: result.modelId,
						providerId: result.providerId,
					},
					result: "ok",
					targetId: conversationId,
					targetKind: "conversation",
				});
				log.debug("generated image stored", {
					conversationId,
					count: storedImages.length,
					delivered,
					modelId: result.modelId,
					providerId: result.providerId,
				});

				return textOutput({
					count: storedImages.length,
					delivered,
					mediaIds: storedImages.map((stored) => stored.id),
					modelId: result.modelId,
					providerId: result.providerId,
					revisedPrompts: result.images
						.map((image) => image.revisedPrompt)
						.filter((value): value is string => value !== undefined),
				});
			} catch (error) {
				await options.audit?.({
					action: "media.generate_image",
					actorId: conversationId,
					actorKind: "agent",
					payload: {
						error: error instanceof Error ? error.message : String(error),
					},
					reason: error instanceof Error ? error.message : String(error),
					result: "failed",
					targetId: conversationId,
					targetKind: "conversation",
				});
				return errorOutput(error);
			}
		},
	};

	return {
		name: MEDIA_GENERATION_TOOLS_EXTENSION_NAME,
		tools: [generateImageTool],
	};
}
