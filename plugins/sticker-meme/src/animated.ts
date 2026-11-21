import { createRequire } from "node:module";
import vm from "node:vm";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { PluginLogger } from "@tsukaima/sdk";
import type { Canvas as NodeCanvas } from "canvas";
import { findFfmpeg, runFfmpegCommand } from "./ffmpeg.ts";
import { elapsedMs, logErrorMessage } from "./logging.ts";
import { encodeGifFrames, type RgbaFrame } from "./padding-crop.ts";

export interface AnimatedConversionOptions {
	/** Output FPS. Defaults to 15 and is capped by the source frame rate. */
	readonly fps?: number;
	readonly height?: number;
	/** Maximum encoded frames. Defaults to 50. */
	readonly maxFrames?: number;
	readonly width?: number;
}

export interface AnimatedConverter {
	convertTgs(bytes: Uint8Array, options?: AnimatedConversionOptions): Promise<Uint8Array>;
	convertVideo(bytes: Uint8Array, options?: AnimatedConversionOptions): Promise<Uint8Array>;
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
const FRAME_FILE_PATTERN = /^frame-(\d+)\.png$/u;
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
	logger?: PluginLogger,
): Promise<Uint8Array> {
	return await serialize(async () => {
		const startedAt = Date.now();
		logger?.info("TGS animated sticker conversion started", {
			bytes: bytes.byteLength,
			fps: options.fps,
			maxFrames: options.maxFrames,
			width: options.width,
		});
		try {
			const { Canvas, loadImage } = await import("canvas");
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
				JSDOM: new (
					html: string,
					options: { pretendToBeVisual: boolean },
				) => { window: JsdomWindow };
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
					const readFrame = async (index: number): Promise<RgbaFrame> => {
						const timeSeconds = (index / frameCount) * durationSeconds;
						animation.goToAndStop(timeSeconds * sourceFps, true);
						await waitForRender();
						outputContext.clearRect(0, 0, width, height);
						outputContext.drawImage(sourceCanvas, 0, 0, width, height);
						const image = outputContext.getImageData(0, 0, width, height);
						return { data: image.data, height, width };
					};
					const encoded = await encodeGifFrames({
						delay,
						frameCount,
						height,
						readFrame,
						width,
					});
					logger?.debug("TGS animated sticker conversion completed", {
						boundsHeight: encoded.bounds.height,
						boundsWidth: encoded.bounds.width,
						bytes: encoded.bytes.byteLength,
						durationMs: elapsedMs(startedAt),
						format: "gif",
						frameCount,
						height,
						width,
					});
					return encoded.bytes;
				} finally {
					animation.destroy();
				}
			} finally {
				window.close();
			}
		} catch (error) {
			logger?.warn("TGS animated sticker conversion failed", {
				bytes: bytes.byteLength,
				durationMs: elapsedMs(startedAt),
				error: logErrorMessage(error),
			});
			throw error;
		}
	});
}

type CanvasModule = typeof import("canvas");

async function readPngFrame(path: string, canvasModule: CanvasModule): Promise<RgbaFrame> {
	const image = await canvasModule.loadImage(await readFile(path));
	const canvas = new canvasModule.Canvas(image.width, image.height);
	const context = canvas.getContext("2d");
	context.drawImage(image, 0, 0);
	return {
		data: context.getImageData(0, 0, image.width, image.height).data,
		height: image.height,
		width: image.width,
	};
}

/**
 * Telegram video stickers are WebM files with an alpha channel. ffmpeg extracts frames as
 * RGBA PNGs, then the shared GIF encoder trims the transparent padding and quantizes each frame.
 * WebM itself is never stored or delivered.
 */
export async function videoToGif(
	bytes: Uint8Array,
	options: AnimatedConversionOptions = {},
	ffmpegPath?: string,
	logger?: PluginLogger,
): Promise<Uint8Array> {
	const ffmpeg = findFfmpeg(ffmpegPath);
	if (ffmpeg === undefined) throw new Error("ffmpeg is unavailable for video sticker conversion");
	const startedAt = Date.now();
	logger?.info("video animated sticker conversion started", {
		bytes: bytes.byteLength,
		fps: options.fps,
		maxFrames: options.maxFrames,
		width: options.width,
	});
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-sticker-video-"));
	try {
		const input = join(directory, "input.webm");
		await writeFile(input, bytes);
		const fps = clamp(options.fps, DEFAULT_FPS, 1, MAX_FPS);
		const maxFrames = clamp(options.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_MAX_FRAMES);
		const width = clamp(options.width, 512, 32, MAX_SIZE);
		const framesPath = join(directory, "frame-%03d.png");
		try {
			await runFfmpegCommand(ffmpeg, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				input,
				"-vf",
				`fps=${fps},scale=${width}:-1:flags=lanczos,format=rgba`,
				"-frames:v",
				String(maxFrames),
				"-f",
				"image2",
				"-start_number",
				"0",
				framesPath,
			]);
		} catch (error) {
			logger?.warn("video animated sticker conversion failed", {
				bytes: bytes.byteLength,
				durationMs: elapsedMs(startedAt),
				error: logErrorMessage(error),
			});
			throw error;
		}
		const files = (await readdir(directory))
			.filter((file) => FRAME_FILE_PATTERN.test(file))
			.toSorted((left, right) => {
				const leftIndex = Number(FRAME_FILE_PATTERN.exec(left)?.[1] ?? 0);
				const rightIndex = Number(FRAME_FILE_PATTERN.exec(right)?.[1] ?? 0);
				return leftIndex - rightIndex;
			});
		if (files.length === 0) throw new Error("ffmpeg produced no video frames");
		const canvasModule = await import("canvas");
		const framePaths = files.map((file) => join(directory, file));
		const probe = await readPngFrame(framePaths[0] as string, canvasModule);
		const frameHeight = probe.height;
		const frameWidth = probe.width;
		const encoded = await encodeGifFrames({
			delay: Math.max(20, Math.round(1000 / fps)),
			frameCount: framePaths.length,
			height: frameHeight,
			readFrame: async (index) => await readPngFrame(framePaths[index] as string, canvasModule),
			width: frameWidth,
		});
		logger?.debug("video animated sticker conversion completed", {
			boundsHeight: encoded.bounds.height,
			boundsWidth: encoded.bounds.width,
			bytes: encoded.bytes.byteLength,
			durationMs: elapsedMs(startedAt),
			format: "gif",
			fps,
			frameCount: encoded.frameCount,
			height: frameHeight,
			width: frameWidth,
		});
		return encoded.bytes;
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

export const defaultAnimatedConverter: AnimatedConverter = {
	convertTgs: async (bytes, options) => await tgsToGif(bytes, options),
	convertVideo: async (bytes, options) => await videoToGif(bytes, options),
};

export function createAnimatedConverter(
	input: {
		readonly ffmpegPath?: string;
		readonly logger?: PluginLogger | undefined;
		readonly tgs?: (bytes: Uint8Array, options?: AnimatedConversionOptions) => Promise<Uint8Array>;
		readonly video?: (
			bytes: Uint8Array,
			options?: AnimatedConversionOptions,
		) => Promise<Uint8Array>;
	} = {},
): AnimatedConverter {
	const logger = input.logger;
	const customTgs = input.tgs;
	const customVideo = input.video;
	return {
		convertTgs: async (bytes, options) => {
			if (customTgs === undefined) return await tgsToGif(bytes, options, logger);
			const startedAt = Date.now();
			try {
				const result = await customTgs(bytes, options);
				logger?.debug("animated sticker conversion completed", {
					bytes: result.byteLength,
					durationMs: elapsedMs(startedAt),
					format: "gif",
					source: "tgs",
				});
				return result;
			} catch (error) {
				logger?.warn("animated sticker conversion failed", {
					durationMs: elapsedMs(startedAt),
					error: logErrorMessage(error),
					format: "gif",
					source: "tgs",
				});
				throw error;
			}
		},
		convertVideo: async (bytes, options) => {
			if (customVideo === undefined)
				return await videoToGif(bytes, options, input.ffmpegPath, logger);
			const startedAt = Date.now();
			try {
				const result = await customVideo(bytes, options);
				logger?.debug("animated sticker conversion completed", {
					bytes: result.byteLength,
					durationMs: elapsedMs(startedAt),
					format: "gif",
					source: "video",
				});
				return result;
			} catch (error) {
				logger?.warn("animated sticker conversion failed", {
					durationMs: elapsedMs(startedAt),
					error: logErrorMessage(error),
					format: "gif",
					source: "video",
				});
				throw error;
			}
		},
	};
}
