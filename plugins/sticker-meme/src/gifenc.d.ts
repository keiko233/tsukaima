declare module "gifenc" {
	export interface GifFrameOptions {
		readonly palette?: readonly (readonly number[])[];
		readonly first?: boolean;
		readonly transparent?: boolean;
		readonly transparentIndex?: number;
		readonly delay?: number;
		readonly repeat?: number;
		readonly dispose?: number;
	}

	export interface GifEncoder {
		writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
		finish(): void;
		bytes(): Uint8Array;
	}

	export function GIFEncoder(options?: {
		readonly auto?: boolean;
		readonly initialCapacity?: number;
	}): GifEncoder;
	export function quantize(
		rgba: Uint8Array | Uint8ClampedArray,
		maxColors: number,
		options?: {
			readonly format?: "rgb565" | "rgb444" | "rgba4444";
			readonly oneBitAlpha?: boolean | number;
			readonly clearAlpha?: boolean;
			readonly clearAlphaThreshold?: number;
			readonly clearAlphaColor?: number;
		},
	): number[][];
	export function applyPalette(
		rgba: Uint8Array | Uint8ClampedArray,
		palette: readonly (readonly number[])[],
		format?: "rgb565" | "rgb444" | "rgba4444",
	): Uint8Array;
}
