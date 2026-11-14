import { Api } from "grammy";

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog", "www.t.me"]);
const SET_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/u;

export interface TelegramSticker {
	readonly emoji?: string;
	readonly fileId: string;
	readonly fileUniqueId: string;
	readonly height: number;
	readonly isAnimated: boolean;
	readonly isVideo: boolean;
	readonly thumbnailFileId?: string;
	readonly type: string;
	readonly width: number;
}

export interface TelegramStickerSet {
	readonly isAnimated: boolean;
	readonly isVideo: boolean;
	readonly name: string;
	readonly stickers: readonly TelegramSticker[];
	readonly stickerType: string;
	readonly thumbnailFileId?: string;
	readonly title: string;
}

export interface TelegramStickerSetReference {
	readonly setName: string;
	readonly sourceUrl: string;
}

/**
 * Accept the links people actually paste: `https://t.me/addstickers/name`, `tg://addstickers?set=name`,
 * a bare set name, and the `addstickers/name` shorthand.
 */
export function parseTelegramStickerSetReference(value: string): TelegramStickerSetReference {
	const input = value.trim();
	if (input.length === 0) throw new Error("Telegram sticker set link or name is required");
	if (/^tg:\/\//iu.test(input)) {
		const url = new URL(input);
		if (url.hostname.toLowerCase() !== "addstickers") {
			throw new Error("Telegram link must use tg://addstickers or a t.me/addstickers URL");
		}
		const setName = (url.searchParams.get("set") ?? "").trim();
		assertSetName(setName);
		return { setName, sourceUrl: `https://t.me/addstickers/${setName}` };
	}
	if (/^https?:\/\//iu.test(input)) {
		const url = new URL(input);
		if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) {
			throw new Error("Only t.me or telegram.me sticker-set links are supported");
		}
		const path = url.pathname.replace(/\/+$/u, "");
		const match = /^\/addstickers\/([^/]+)$/u.exec(path);
		const fromPath = match?.[1];
		const fromQuery = url.searchParams.get("set") ?? undefined;
		const setName = decodeURIComponent(fromPath ?? fromQuery ?? "").trim();
		assertSetName(setName);
		return { setName, sourceUrl: `https://t.me/addstickers/${setName}` };
	}
	const shorthand = /^(?:addstickers\/)?([^/?#\s]+)$/u.exec(input)?.[1] ?? "";
	assertSetName(shorthand);
	return { setName: shorthand, sourceUrl: `https://t.me/addstickers/${shorthand}` };
}

function assertSetName(value: string): void {
	if (!SET_NAME_PATTERN.test(value)) {
		throw new Error(
			"Invalid Telegram sticker-set name; expected 1-64 letters, digits, or underscores",
		);
	}
}

export interface TelegramStickerClientOptions {
	readonly apiBaseUrl?: string;
	readonly fetch?: typeof fetch;
	readonly timeoutSeconds?: number;
	readonly token: string;
}

export interface TelegramDownloadedFile {
	readonly bytes: Uint8Array;
	readonly filePath: string;
	readonly fileSize?: number;
}

export interface TelegramStickerSource {
	downloadFile(fileId: string): Promise<TelegramDownloadedFile>;
	getStickerSet(name: string): Promise<TelegramStickerSet>;
}

function normalizeApiBaseUrl(value: string | undefined): string {
	const raw = (value ?? "https://api.telegram.org").trim().replace(/\/+$/u, "");
	if (!/^https?:\/\//iu.test(raw)) throw new Error("Telegram API base URL must be http(s)");
	return raw;
}

function telegramError(error: unknown): Error {
	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		const description = typeof record.description === "string" ? record.description : "";
		const code = typeof record.error_code === "number" ? record.error_code : undefined;
		if (description.length > 0) {
			return new Error(`Telegram API error${code === undefined ? "" : ` ${code}`}: ${description}`);
		}
	}
	return error instanceof Error ? error : new Error(String(error));
}

/** Thin Bot API client built on grammY's typed `Api` class. */
export class TelegramStickerClient implements TelegramStickerSource {
	readonly #api: Api;
	readonly #apiRoot: string;
	readonly #fetch: typeof fetch;
	readonly #token: string;

	constructor(options: TelegramStickerClientOptions) {
		const token = options.token.trim();
		if (token.length === 0) throw new Error("Telegram bot token is required");
		this.#token = token;
		this.#apiRoot = normalizeApiBaseUrl(options.apiBaseUrl);
		this.#fetch = options.fetch ?? fetch;
		this.#api = new Api(token, {
			apiRoot: this.#apiRoot,
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			timeoutSeconds: Math.max(5, options.timeoutSeconds ?? 60),
		});
	}

	async getStickerSet(name: string): Promise<TelegramStickerSet> {
		try {
			const set = await this.#api.getStickerSet(name);
			const isAnimated = set.stickers.some((sticker) => sticker.is_animated);
			const isVideo = set.stickers.some((sticker) => sticker.is_video);
			return {
				isAnimated,
				isVideo,
				name: set.name,
				stickers: set.stickers.map((sticker) => ({
					...(sticker.emoji === undefined ? {} : { emoji: sticker.emoji }),
					fileId: sticker.file_id,
					fileUniqueId: sticker.file_unique_id,
					height: sticker.height,
					isAnimated: sticker.is_animated,
					isVideo: sticker.is_video,
					...(sticker.thumbnail === undefined
						? {}
						: { thumbnailFileId: sticker.thumbnail.file_id }),
					type: sticker.type,
					width: sticker.width,
				})),
				stickerType: set.sticker_type,
				...(set.thumbnail === undefined ? {} : { thumbnailFileId: set.thumbnail.file_id }),
				title: set.title,
			};
		} catch (error) {
			throw telegramError(error);
		}
	}

	async downloadFile(fileId: string): Promise<TelegramDownloadedFile> {
		let file;
		try {
			file = await this.#api.getFile(fileId);
		} catch (error) {
			throw telegramError(error);
		}
		if (file.file_path === undefined || file.file_path.length === 0) {
			throw new Error("Telegram did not return a download path for this sticker");
		}
		const url = `${this.#apiRoot}/file/bot${this.#token}/${file.file_path}`;
		let response: Response;
		try {
			response = await this.#fetch(url);
		} catch (error) {
			throw new Error(
				`Telegram file download failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (!response.ok) {
			throw new Error(`Telegram file download failed with HTTP ${response.status}`);
		}
		return {
			bytes: new Uint8Array(await response.arrayBuffer()),
			filePath: file.file_path,
			...(file.file_size === undefined ? {} : { fileSize: file.file_size }),
		};
	}
}
