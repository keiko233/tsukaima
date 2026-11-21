/**
 * Sticker sources (Telegram TGS and video stickers in particular) use a square canvas with a
 * lot of transparent padding. Chat clients render that padding as black, so GIF output must be
 * trimmed to the union of every frame's content before encoding.
 */

export interface RgbaFrame {
	readonly data: Uint8Array | Uint8ClampedArray;
	readonly height: number;
	readonly width: number;
}

export interface CropBounds {
	readonly height: number;
	readonly width: number;
	readonly x: number;
	readonly y: number;
}

/** Alpha above this counts as visible content; anything below is treated as padding. */
const CONTENT_ALPHA = 8;
/** Opaque pixels whose RGB sum is below this are treated as black padding, not content. */
const CONTENT_LUMA_SUM = 48;

function isContentPixel(data: Uint8Array | Uint8ClampedArray, offset: number): boolean {
	const alpha = data[offset + 3] ?? 0;
	if (alpha <= CONTENT_ALPHA) return false;
	const red = data[offset] ?? 0;
	const green = data[offset + 1] ?? 0;
	const blue = data[offset + 2] ?? 0;
	// Only near-opaque near-black pixels are padding; semi-transparent dark pixels stay content
	// so anti-aliased edges survive the trim.
	return alpha < 250 || red + green + blue > CONTENT_LUMA_SUM;
}

/** Union content bounds across every frame, so the animation never shifts after cropping. */
export class ContentBoundsAccumulator {
	readonly #height: number;
	readonly #width: number;
	#maxX = -1;
	#maxY = -1;
	#minX = Number.POSITIVE_INFINITY;
	#minY = Number.POSITIVE_INFINITY;

	constructor(width: number, height: number) {
		this.#width = Math.max(1, Math.floor(width));
		this.#height = Math.max(1, Math.floor(height));
	}

	add(frame: RgbaFrame): void {
		const width = Math.min(frame.width, this.#width);
		const height = Math.min(frame.height, this.#height);
		for (let y = 0; y < height; y += 1) {
			const rowOffset = y * frame.width;
			let first = -1;
			let last = -1;
			for (let x = 0; x < width; x += 1) {
				if (!isContentPixel(frame.data, (rowOffset + x) * 4)) continue;
				if (first < 0) first = x;
				last = x;
			}
			if (first < 0) continue;
			if (first < this.#minX) this.#minX = first;
			if (last > this.#maxX) this.#maxX = last;
			if (y < this.#minY) this.#minY = y;
			this.#maxY = y;
		}
	}

	bounds(): CropBounds | undefined {
		if (this.#maxX < 0) return undefined;
		const x = Math.max(0, this.#minX);
		const y = Math.max(0, this.#minY);
		return {
			height: Math.max(1, Math.min(this.#height - y, this.#maxY - y + 1)),
			width: Math.max(1, Math.min(this.#width - x, this.#maxX - x + 1)),
			x,
			y,
		};
	}
}

export function cropRgbaFrame(frame: RgbaFrame, bounds: CropBounds): Uint8ClampedArray {
	const cropped = new Uint8ClampedArray(bounds.width * bounds.height * 4);
	for (let y = 0; y < bounds.height; y += 1) {
		const sourceStart = ((bounds.y + y) * frame.width + bounds.x) * 4;
		cropped.set(
			frame.data.subarray(sourceStart, sourceStart + bounds.width * 4),
			y * bounds.width * 4,
		);
	}
	return cropped;
}

/** Logical screen size from a GIF header, so stored items match the cropped media. */
export function gifScreenSize(
	bytes: Uint8Array,
): { readonly height: number; readonly width: number } | undefined {
	if (bytes.byteLength < 10) return undefined;
	if (
		(bytes[0] ?? 0) !== 0x47 ||
		(bytes[1] ?? 0) !== 0x49 ||
		(bytes[2] ?? 0) !== 0x46 ||
		(bytes[3] ?? 0) !== 0x38 ||
		((bytes[4] ?? 0) !== 0x37 && (bytes[4] ?? 0) !== 0x39) ||
		(bytes[5] ?? 0) !== 0x61
	) {
		return undefined;
	}
	const width = (bytes[7] ?? 0) * 256 + (bytes[6] ?? 0);
	const height = (bytes[9] ?? 0) * 256 + (bytes[8] ?? 0);
	return width > 0 && height > 0 ? { height, width } : undefined;
}

/**
 * Chat clients render GIF transparency as black, so converted stickers are flattened onto
 * white. Cropping already removed the border padding; this only affects interior holes and
 * anti-aliased edges.
 */
export function flattenOnWhite(pixels: Uint8ClampedArray): Uint8ClampedArray {
	const output = new Uint8ClampedArray(pixels.length);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		const alpha = pixels[offset + 3] ?? 0;
		if (alpha === 255) {
			output[offset] = pixels[offset] ?? 255;
			output[offset + 1] = pixels[offset + 1] ?? 255;
			output[offset + 2] = pixels[offset + 2] ?? 255;
		} else if (alpha === 0) {
			output[offset] = 255;
			output[offset + 1] = 255;
			output[offset + 2] = 255;
		} else {
			const blend = (channel: number | undefined): number =>
				Math.round(((channel ?? 0) * alpha + 255 * (255 - alpha)) / 255);
			output[offset] = blend(pixels[offset]);
			output[offset + 1] = blend(pixels[offset + 1]);
			output[offset + 2] = blend(pixels[offset + 2]);
		}
		output[offset + 3] = 255;
	}
	return output;
}

export interface EncodeGifFramesOptions {
	readonly delay: number;
	readonly frameCount: number;
	readonly height: number;
	readonly readFrame: (index: number) => Promise<RgbaFrame> | RgbaFrame;
	readonly width: number;
}

export interface EncodedGif {
	readonly bounds: CropBounds;
	readonly bytes: Uint8Array;
	readonly frameCount: number;
}

/**
 * Two-pass GIF encoding: the first pass only measures content bounds, the second crops each
 * frame before quantizing. Frames are re-read instead of buffered so long animations with large
 * canvases stay within a bounded memory budget.
 */
export async function encodeGifFrames(options: EncodeGifFramesOptions): Promise<EncodedGif> {
	const frameCount = Math.max(1, Math.floor(options.frameCount));
	const width = Math.max(1, Math.floor(options.width));
	const height = Math.max(1, Math.floor(options.height));
	const { applyPalette, GIFEncoder, quantize } = await import("gifenc");
	const accumulator = new ContentBoundsAccumulator(width, height);
	for (let index = 0; index < frameCount; index += 1) {
		accumulator.add(await options.readFrame(index));
	}
	const bounds = accumulator.bounds() ?? { height, width, x: 0, y: 0 };
	const gif = GIFEncoder();
	for (let index = 0; index < frameCount; index += 1) {
		const pixels = flattenOnWhite(cropRgbaFrame(await options.readFrame(index), bounds));
		const palette = quantize(pixels, 256, { format: "rgb565" });
		const indexed = applyPalette(pixels, palette, "rgb565");
		gif.writeFrame(indexed, bounds.width, bounds.height, {
			delay: options.delay,
			palette,
			...(index === 0 ? { repeat: 0 } : {}),
		});
	}
	gif.finish();
	return { bounds, bytes: gif.bytes(), frameCount };
}
