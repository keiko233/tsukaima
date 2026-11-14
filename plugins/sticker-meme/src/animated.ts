import { createRequire } from "node:module";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Canvas as NodeCanvas } from "canvas";

export interface AnimatedConversionOptions {
	/** Output FPS. Defaults to 15 and is capped by the source frame rate. */
	readonly fps?: number;
	readonly height?: number;
	/** Maximum encoded frames. Defaults to 50. */
	readonly maxFrames?: number;
	readonly width?: number;
}

export interface AnimatedConverter {
	readonly available: boolean;
	convertTgs(bytes: Uint8Array, options?: AnimatedConversionOptions): Promise<Uint8Array>;
	convertWebm(
		bytes: Uint8Array,
		options?: AnimatedConversionOptions,
	): Promise<Uint8Array | undefined>;
}

interface LottieAnimation {
	readonly totalFrames: number;
	destroy(): void;
	goToAndStop(value: number, isFrame?: boolean): void;
}

interface JsdomWindow {
	cancelAnimationFrame?(id: number): void;
	close(): void;
	document: { createElement(name: string): unknown };
	navigator: unknown;
	requestAnimationFrame?(callback: (time: number) => void): number;
	lottie?: {
		loadAnimation(options: {
			animationData: unknown;
			renderer: "canvas";
			rendererSettings: { clearCanvas: boolean; context: unknown };
		}): LottieAnimation;
	};
}

const require = createRequire(import.meta.url);
const DEFAULT_FPS = 15;
const MAX_FPS = 30;
const DEFAULT_MAX_FRAMES = 50;
const MAX_MAX_FRAMES = 120;
const MAX_SIZE = 512;
let renderQueue: Promise<unknown> = Promise.resolve();
let lottieScript: vm.Script | undefined;

function serialize<T>(work: () => Promise<T>): Promise<T> {
	const next = renderQueue.then(work, work);
	renderQueue = next.catch(() => undefined);
	return next;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value ?? fallback)));
}

function waitForRender(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadLottieScript(): vm.Script {
	if (lottieScript !== undefined) return lottieScript;
	const lottiePath = require.resolve("lottie-web/build/player/lottie.js");
	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	const source = readFileSync(lottiePath, "utf8").replace(
		"function ImagePreloaderFactory() {",
		`function createImgData(assetData) {
			var path = getAssetsPath(assetData, this.assetsPath, this.path);
			var ob = { assetData };
			loadImage(path).then(image => {
				ob.img = image;
				this._imageLoaded();
			});
			return ob;
		}; function ImagePreloaderFactory() {`,
	);
	lottieScript = new vm.Script(source, { filename: "lottie-web.js" });
	return lottieScript;
}

/**
 * Telegram animated stickers are gzipped Lottie JSON. Render frames with lottie-web's canvas
 * renderer and encode them to an animated GIF so QQ receives a format it already supports.
 */
export async function tgsToGif(
	bytes: Uint8Array,
	options: AnimatedConversionOptions = {},
): Promise<Uint8Array> {
	return await serialize(async () => {
		const { Canvas, loadImage } = await import("canvas");
		const { applyPalette, GIFEncoder, quantize } = await import("gifenc");
		const animationData = JSON.parse(gunzipSync(bytes).toString("utf8")) as {
			fr?: number;
			h?: number;
			w?: number;
		};
		const sourceWidth = Math.max(1, Number(animationData.w) || 512);
		const sourceHeight = Math.max(1, Number(animationData.h) || 512);
		const requestedWidth = clamp(options.width, sourceWidth, 1, MAX_SIZE);
		const width = Math.min(sourceWidth, requestedWidth);
		const height = Math.max(
			1,
			Math.min(
				MAX_SIZE,
				options.height === undefined
					? Math.round((sourceHeight / sourceWidth) * width)
					: clamp(options.height, sourceHeight, 1, MAX_SIZE),
			),
		);
		const { JSDOM } = (await import("jsdom")) as unknown as {
			JSDOM: new (html: string, options: { pretendToBeVisual: boolean }) => { window: JsdomWindow };
		};
		const { window } = new JSDOM("", { pretendToBeVisual: true });
		const jsdomDocument = window.document;
		const originalCreateElement = jsdomDocument.createElement;
		jsdomDocument.createElement = (name: string) =>
			name === "canvas" ? new Canvas(300, 150) : originalCreateElement.call(jsdomDocument, name);
		try {
			const context = vm.createContext({
				Canvas: Canvas as unknown as NodeCanvas,
				clearInterval,
				clearTimeout,
				console,
				document: jsdomDocument,
				loadImage,
				navigator: window.navigator,
				requestAnimationFrame: window.requestAnimationFrame?.bind(window),
				cancelAnimationFrame: window.cancelAnimationFrame?.bind(window),
				self: window,
				setInterval,
				setTimeout,
				window,
			});
			loadLottieScript().runInContext(context);
			const lottie = (context as { lottie?: JsdomWindow["lottie"] }).lottie;
			if (lottie === undefined) throw new Error("Lottie renderer did not initialize");
			window.lottie = lottie;
			const sourceCanvas = new Canvas(sourceWidth, sourceHeight);
			const sourceContext = sourceCanvas.getContext("2d");
			const outputCanvas = new Canvas(width, height);
			const outputContext = outputCanvas.getContext("2d");
			const animation = lottie.loadAnimation({
				animationData,
				renderer: "canvas",
				rendererSettings: { clearCanvas: true, context: sourceContext },
			});
			try {
				const sourceFps = Math.max(1, Number(animationData.fr) || 30);
				const totalFrames = Math.max(1, Math.floor(animation.totalFrames || 1));
				const fps = Math.min(sourceFps, clamp(options.fps, DEFAULT_FPS, 1, MAX_FPS));
				const maxFrames = clamp(options.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_MAX_FRAMES);
				const durationSeconds = totalFrames / sourceFps;
				const frameCount = Math.max(1, Math.min(maxFrames, Math.round(durationSeconds * fps)));
				const delay = Math.max(20, Math.round(1000 / fps));
				const gif = GIFEncoder();
				for (let frame = 0; frame < frameCount; frame += 1) {
					const timeSeconds = (frame / frameCount) * durationSeconds;
					animation.goToAndStop(timeSeconds * sourceFps, true);
					await waitForRender();
					outputContext.clearRect(0, 0, width, height);
					outputContext.drawImage(sourceCanvas, 0, 0, width, height);
					const pixels = outputContext.getImageData(0, 0, width, height).data;
					const palette = quantize(pixels, 256, {
						clearAlpha: true,
						format: "rgba4444",
						oneBitAlpha: true,
					});
					const index = applyPalette(pixels, palette, "rgba4444");
					const transparentIndex = palette.findIndex((color) => color[3] === 0);
					gif.writeFrame(index, width, height, {
						delay,
						palette,
						...(frame === 0 ? { repeat: 0 } : {}),
						...(transparentIndex < 0 ? {} : { transparent: true, transparentIndex }),
					});
				}
				gif.finish();
				return gif.bytes();
			} finally {
				animation.destroy();
			}
		} finally {
			window.close();
		}
	});
}

function findFfmpeg(ffmpegPath?: string): string | undefined {
	const configured = ffmpegPath?.trim() || process.env.TSUKAIMA_FFMPEG_PATH?.trim();
	if (configured !== undefined && configured.length > 0) return configured;
	return Bun.which("ffmpeg") ?? undefined;
}

function run(
	command: string,
	args: readonly string[],
): Promise<{ readonly stderr: string; readonly stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stderr, stdout: "" });
			else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
		});
	});
}

/**
 * Convert a Telegram video sticker to GIF when ffmpeg is available. Returning undefined lets the
 * importer fall back to a still thumbnail or the raw webm format.
 */
export async function webmToGif(
	bytes: Uint8Array,
	options: AnimatedConversionOptions = {},
	ffmpegPath?: string,
): Promise<Uint8Array | undefined> {
	const ffmpeg = findFfmpeg(ffmpegPath);
	if (ffmpeg === undefined) return undefined;
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-sticker-webm-"));
	try {
		const input = join(directory, "input.webm");
		const output = join(directory, "output.gif");
		await writeFile(input, bytes);
		const fps = clamp(options.fps, DEFAULT_FPS, 1, MAX_FPS);
		const maxFrames = clamp(options.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_MAX_FRAMES);
		const width = clamp(options.width, 512, 32, MAX_SIZE);
		const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128`;
		await run(ffmpeg, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			input,
			"-vf",
			filter,
			"-frames:v",
			String(maxFrames),
			"-loop",
			"0",
			"-f",
			"gif",
			output,
		]);
		const result = new Uint8Array(await readFile(output));
		if (result.byteLength === 0) throw new Error("ffmpeg produced an empty GIF");
		return result;
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

export const defaultAnimatedConverter: AnimatedConverter = {
	available: true,
	convertTgs: async (bytes, options) => await tgsToGif(bytes, options),
	convertWebm: async (bytes, options) => await webmToGif(bytes, options),
};

export function createAnimatedConverter(
	input: {
		readonly ffmpegPath?: string;
		readonly tgs?: (bytes: Uint8Array, options?: AnimatedConversionOptions) => Promise<Uint8Array>;
		readonly webm?: (
			bytes: Uint8Array,
			options?: AnimatedConversionOptions,
		) => Promise<Uint8Array | undefined>;
	} = {},
): AnimatedConverter {
	return {
		available: true,
		convertTgs: input.tgs ?? (async (bytes, options) => await tgsToGif(bytes, options)),
		convertWebm:
			input.webm ?? (async (bytes, options) => await webmToGif(bytes, options, input.ffmpegPath)),
	};
}
