import type { PluginLogger } from "@tsukaima/sdk";
import {
	defaultAnimatedConverter,
	type AnimatedConversionOptions,
	type AnimatedConverter,
} from "./animated.ts";
import { gifScreenSize } from "./padding-crop.ts";

export type SupportedStickerMime =
	| "image/gif"
	| "image/jpeg"
	| "image/png"
	| "image/webp"
	| "video/mp4"
	| "video/quicktime"
	| "video/webm";

export interface DetectedStickerFormat {
	readonly extension: string;
	readonly isVideo: boolean;
	readonly mimeType: SupportedStickerMime;
}

export interface NormalizedStickerMedia {
	readonly bytes: Uint8Array;
	readonly convertedFromVideo: boolean;
	readonly height: number | null;
	readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
	readonly originalMimeType: string;
	readonly width: number | null;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
	if (bytes.byteLength < offset + length) return "";
	let out = "";
	for (let i = 0; i < length; i += 1) {
		out += String.fromCharCode(bytes[offset + i] ?? 0);
	}
	return out;
}

/** Sniff image/video format from magic bytes so CDN URLs without extensions work reliably. */
export function detectStickerMediaFormat(
	bytes: Uint8Array,
	declaredMimeType?: string,
): DetectedStickerFormat | undefined {
	if (bytes.byteLength >= 8) {
		// PNG: 89 50 4E 47 0D 0A 1A 0A
		if (
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a
		) {
			return { extension: "png", isVideo: false, mimeType: "image/png" };
		}
	}
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { extension: "jpg", isVideo: false, mimeType: "image/jpeg" };
	}
	if (bytes.byteLength >= 6) {
		const header = asciiAt(bytes, 0, 6);
		if (header === "GIF87a" || header === "GIF89a") {
			return { extension: "gif", isVideo: false, mimeType: "image/gif" };
		}
	}
	if (
		bytes.byteLength >= 12 &&
		asciiAt(bytes, 0, 4) === "RIFF" &&
		asciiAt(bytes, 8, 4) === "WEBP"
	) {
		return { extension: "webp", isVideo: false, mimeType: "image/webp" };
	}
	// ISO Base Media File Format (MP4 / M4V / MOV, including Twitter video.twimg.com/*.mp4)
	if (bytes.byteLength >= 12 && asciiAt(bytes, 4, 4) === "ftyp") {
		const brand = asciiAt(bytes, 8, 4);
		if (brand === "qt  ") {
			return { extension: "mov", isVideo: true, mimeType: "video/quicktime" };
		}
		return { extension: "mp4", isVideo: true, mimeType: "video/mp4" };
	}
	// EBML header (WebM / Matroska)
	if (
		bytes.byteLength >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		return { extension: "webm", isVideo: true, mimeType: "video/webm" };
	}
	// Fallback to declared MIME only if it is one of our supported types and bytes were not HTML/text.
	const normalized = declaredMimeType?.split(";")[0]?.trim().toLowerCase();
	if (normalized === "image/png")
		return { extension: "png", isVideo: false, mimeType: "image/png" };
	if (normalized === "image/jpeg" || normalized === "image/jpg") {
		return { extension: "jpg", isVideo: false, mimeType: "image/jpeg" };
	}
	if (normalized === "image/gif")
		return { extension: "gif", isVideo: false, mimeType: "image/gif" };
	if (normalized === "image/webp") {
		return { extension: "webp", isVideo: false, mimeType: "image/webp" };
	}
	if (normalized === "video/mp4") return { extension: "mp4", isVideo: true, mimeType: "video/mp4" };
	if (normalized === "video/webm") {
		return { extension: "webm", isVideo: true, mimeType: "video/webm" };
	}
	if (normalized === "video/quicktime") {
		return { extension: "mov", isVideo: true, mimeType: "video/quicktime" };
	}
	return undefined;
}

async function probeImageSize(
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ readonly height: number | null; readonly width: number | null }> {
	if (mimeType === "image/gif") {
		const size = gifScreenSize(bytes);
		return { height: size?.height ?? null, width: size?.width ?? null };
	}
	try {
		const { loadImage } = await import("canvas");
		const image = await loadImage(Buffer.from(bytes));
		return {
			height: Number.isFinite(image.height) && image.height > 0 ? image.height : null,
			width: Number.isFinite(image.width) && image.width > 0 ? image.width : null,
		};
	} catch {
		return { height: null, width: null };
	}
}

/**
 * Normalize inbound/imported media into a QQ-compatible sticker format.
 * Videos (such as Twitter's `.mp4` GIFs or `.webm`) are transcoded to looping animated GIFs.
 */
export async function normalizeStickerMedia(
	bytes: Uint8Array,
	options: {
		readonly conversion?: AnimatedConversionOptions;
		readonly converter?: AnimatedConverter;
		readonly declaredMimeType?: string;
		readonly logger?: PluginLogger | undefined;
	} = {},
): Promise<NormalizedStickerMedia> {
	const detected = detectStickerMediaFormat(bytes, options.declaredMimeType);
	if (detected === undefined) {
		const hint = options.declaredMimeType ? ` (${options.declaredMimeType})` : "";
		throw new Error(
			`Unsupported media format${hint}: expected PNG, JPEG, GIF, WebP, MP4, MOV, or WebM.`,
		);
	}
	if (detected.isVideo) {
		const converter = options.converter ?? defaultAnimatedConverter;
		const gifBytes = await converter.convertVideo(bytes, {
			maxFrames: 150,
			width: 480,
			...options.conversion,
			inputExtension: detected.extension,
		});
		const size = gifScreenSize(gifBytes);
		options.logger?.debug("video sticker converted to gif", {
			convertedBytes: gifBytes.byteLength,
			height: size?.height ?? null,
			originalBytes: bytes.byteLength,
			originalMimeType: detected.mimeType,
			width: size?.width ?? null,
		});
		return {
			bytes: gifBytes,
			convertedFromVideo: true,
			height: size?.height ?? null,
			mimeType: "image/gif",
			originalMimeType: detected.mimeType,
			width: size?.width ?? null,
		};
	}
	const size = await probeImageSize(bytes, detected.mimeType);
	return {
		bytes,
		convertedFromVideo: false,
		height: size.height,
		mimeType: detected.mimeType as "image/gif" | "image/jpeg" | "image/png" | "image/webp",
		originalMimeType: detected.mimeType,
		width: size.width,
	};
}
