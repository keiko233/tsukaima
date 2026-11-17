import { z } from "zod";

/**
 * Leaf schemas shared by the domain model and the oRPC contract. They live in their own
 * module so `api.ts` can build the contract without importing `index.ts` back
 * (which would create a module evaluation cycle).
 */

const mediaReferenceShape = {
	/** Canonical `media.id` row (content-addressed by `sha256`). */
	mediaId: z.string().min(1).optional(),
	/**
	 * Content hash. Kept optional so historical `{ type: "image", sha256 }` rows keep
	 * parsing even before the matching `media` row exists.
	 */
	sha256: z.string().min(1).optional(),
	/** Remote/retrieval source that may be materialized into the media store later. */
	sourceUrl: z.string().min(1).optional(),
	/** Opaque platform reference (NapCat file id, local path, base64 marker, ...). */
	channelRef: z.string().min(1).optional(),
} as const;

/**
 * Bounded reason an inbound media part has no local bytes. It is deliberately an enum, never a
 * raw upstream error: the WebUI can render an honest unavailable state and a backfill can decide
 * whether a retry is worthwhile without trusting attacker-controlled text.
 */
export const mediaUnavailableReasonSchema = z.enum([
	"blocked_address",
	"blocked_content_type",
	"blocked_host",
	"blocked_scheme",
	"channel_fetch_failed",
	"channel_unavailable",
	"dns_failure",
	"expired",
	"http_error",
	"invalid_redirect",
	"invalid_url",
	"network_error",
	"not_found",
	"redirect_limit",
	"response_too_large",
	"timeout",
	"unknown",
]);
export type MediaUnavailableReason = z.infer<typeof mediaUnavailableReasonSchema>;

const mediaMetadataShape = {
	/** Set only when no bytes could be stored; `mediaId` stays absent in that case. */
	mediaUnavailableReason: mediaUnavailableReasonSchema.optional(),
	mimeType: z.string().min(1).optional(),
	sizeBytes: z.number().int().nonnegative().optional(),
	previewText: z.string().optional(),
	modelReadable: z.boolean().optional(),
} as const;

const imagePartSchema = z.object({
	...mediaReferenceShape,
	...mediaMetadataShape,
	height: z.number().int().positive().optional(),
	type: z.literal("image"),
	width: z.number().int().positive().optional(),
});

const stickerPartSchema = z.object({
	...mediaReferenceShape,
	...mediaMetadataShape,
	height: z.number().int().positive().optional(),
	type: z.literal("sticker"),
	width: z.number().int().positive().optional(),
});

const audioPartSchema = z.object({
	...mediaReferenceShape,
	...mediaMetadataShape,
	durationMs: z.number().int().nonnegative().optional(),
	transcript: z.string().optional(),
	transcriptStatus: z.enum(["ok", "fallback", "skipped", "failed"]).optional(),
	type: z.literal("audio"),
});

const videoFrameSchema = z.object({
	mediaId: z.string().min(1).optional(),
	offsetMs: z.number().int().nonnegative().optional(),
	sha256: z.string().min(1).optional(),
});

const videoPartSchema = z.object({
	...mediaReferenceShape,
	...mediaMetadataShape,
	durationMs: z.number().int().nonnegative().optional(),
	frames: z.array(videoFrameSchema).max(16).optional(),
	height: z.number().int().positive().optional(),
	type: z.literal("video"),
	width: z.number().int().positive().optional(),
});

const filePartSchema = z.object({
	...mediaReferenceShape,
	...mediaMetadataShape,
	fileName: z.string().min(1),
	type: z.literal("file"),
});

const channelNativePartSchema = z.object({
	diagnostic: z.string().optional(),
	nativeType: z.string().min(1),
	rawRef: z.string().optional(),
	safeFields: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
		.optional(),
	summary: z.string().optional(),
	type: z.literal("channel-native"),
});

const messagePartUnionSchema = z.discriminatedUnion("type", [
	z.object({ text: z.string(), type: z.literal("text") }),
	imagePartSchema,
	stickerPartSchema,
	audioPartSchema,
	videoPartSchema,
	filePartSchema,
	channelNativePartSchema,
]);

/**
 * A message part can reference bytes through a local media row, a content hash, a remote
 * source, or a platform-native reference. At least one is required so a persisted part is
 * always resolvable; legacy hash-only image/sticker rows remain valid.
 */
export const messagePartSchema = messagePartUnionSchema.superRefine((part, context) => {
	if (part.type === "text" || part.type === "channel-native") return;
	if (
		part.mediaId === undefined &&
		part.sha256 === undefined &&
		part.sourceUrl === undefined &&
		part.channelRef === undefined
	) {
		context.addIssue({
			code: "custom",
			message: `${part.type} part requires mediaId, sha256, sourceUrl, or channelRef`,
			path: [],
		});
	}
});

export type MessagePart = z.infer<typeof messagePartSchema>;

/**
 * Human/model-facing fallback text for one part. Channel-native parts expose only their safe
 * summary; card payload URLs and IDs never leak through this helper.
 */
export function messagePartText(part: MessagePart): string {
	switch (part.type) {
		case "text":
			return part.text;
		case "image":
			return part.previewText ? `[image: ${part.previewText}]` : "[image]";
		case "sticker":
			return part.previewText ? `[sticker: ${part.previewText}]` : "[sticker]";
		case "audio": {
			if (part.transcript !== undefined && part.transcript.trim().length > 0) {
				return `[voice: ${part.transcript.trim()}]`;
			}
			return part.previewText ? `[audio: ${part.previewText}]` : "[audio]";
		}
		case "video":
			return part.previewText ? `[video: ${part.previewText}]` : "[video]";
		case "file":
			return `[file: ${part.fileName}]`;
		case "channel-native":
			return part.summary !== undefined && part.summary.trim().length > 0
				? part.summary
				: `[${part.nativeType}]`;
	}
}

/** Joins part text with single spaces, matching existing message storage/display behavior. */
export function messagePartsText(parts: readonly MessagePart[]): string {
	return parts.map(messagePartText).join(" ").trim();
}

export const healthStateSchema = z.enum(["starting", "degraded", "ready", "maintenance", "failed"]);

export const healthResponseSchema = z.object({
	stage: z.string(),
	state: healthStateSchema,
	uptimeMs: z.number().int().nonnegative(),
	version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
