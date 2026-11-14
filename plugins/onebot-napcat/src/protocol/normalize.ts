import {
	channelNoticeSchema,
	type ChannelNotice,
	type ChannelNoticeType,
	type ChannelRequest,
	type MessageEnvelope,
	type MessagePart,
} from "@tsukaima/contracts";
import type { PluginLogger } from "@tsukaima/sdk";
import { createSafeLogger, segmentTypeCounts, singleLinePreview } from "../logging.ts";
import type { OneBotIntervalRateLimiter } from "./rate-limit.ts";
import type {
	OneBotAudioTranscribe,
	OneBotAudioTranscribeInput,
	OneBotAudioTranscribeResult,
	OneBotEvent,
	OneBotForwardNode,
	OneBotSegment,
	OneBotVideoFrameExtractor,
} from "./types.ts";

const MEDIA_HASH_PATTERN = /^[0-9a-f]{64}$/iu;
const MAX_CARD_SUMMARY = 240;
const MAX_FORWARD_CHARS = 2_000;
const MAX_FORWARD_NODES = 20;
const MAX_FORWARD_TIMEOUT_MS = 5_000;
const MAX_STT_TIMEOUT_MS = 10_000;
const MAX_VIDEO_FRAMES = 4;

const asString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

const asNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

const safeLocalPath = (value: string): boolean => {
	if (value.includes("\0") || value.includes("..")) return false;
	if (!value.startsWith("/")) return false;
	return !/^[a-z][a-z0-9+.-]*:/iu.test(value);
};

const fileNameFrom = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	if (isHttpUrl(value)) {
		try {
			const name = new URL(value).pathname.split("/").filter(Boolean).at(-1);
			if (name !== undefined && name.length > 0) return decodeURIComponent(name);
		} catch {}
	}
	const safe = value.startsWith("file://") ? value.slice("file://".length) : value;
	const name = safe.split(/[\\/]/u).filter(Boolean).at(-1);
	return name !== undefined && name.length > 0 ? name : undefined;
};

type MediaReferences = {
	readonly channelRef?: string;
	readonly sha256?: string;
	readonly sourceUrl?: string;
};

const mediaReferences = (segment: OneBotSegment): MediaReferences => {
	const data = segment.data ?? {};
	const rawHash = asString(data.sha256) ?? asString(data.hash);
	const hash = rawHash !== undefined && MEDIA_HASH_PATTERN.test(rawHash) ? rawHash : undefined;
	const url = asString(data.url);
	const file = asString(data.file);
	const fileId = asString(data.file_id) ?? asString(data.fileId);
	const path = asString(data.path);
	let sourceUrl: string | undefined;
	let channelRef: string | undefined;

	if (url !== undefined && isHttpUrl(url)) sourceUrl = url;
	if (file !== undefined) {
		if (isHttpUrl(file)) sourceUrl ??= file;
		else if (file.startsWith("base64://") || file.startsWith("data:")) {
			channelRef ??= file;
		} else if (safeLocalPath(file)) channelRef ??= file;
	}
	if (path !== undefined && safeLocalPath(path)) channelRef ??= path;
	if (fileId !== undefined) channelRef ??= fileId;
	if (hash !== undefined)
		return {
			...(channelRef ? { channelRef } : {}),
			sha256: hash,
			...(sourceUrl ? { sourceUrl } : {}),
		};
	if (channelRef !== undefined || sourceUrl !== undefined) {
		return {
			...(channelRef === undefined ? {} : { channelRef }),
			...(sourceUrl === undefined ? {} : { sourceUrl }),
		};
	}
	// Never drop a valid message just because a segment lacked usable media metadata.
	return { channelRef: `onebot:${segment.type}:unknown` };
};

const displayMedia = (
	segment: OneBotSegment,
	type: "image" | "sticker",
): MessagePart | undefined => {
	const data = segment.data ?? {};
	// `sha256` must hold a content hash and nothing else. A URL or a file id is not a hash, and
	// storing one there made downstream code treat an un-fetched remote image as if its bytes
	// were already local — the WebUI rendered nothing and the model saw only a placeholder.
	const refs = mediaReferences(segment);
	const previewText = sanitizeText(asString(data.summary) ?? asString(data.name) ?? undefined);
	const size = asNumber(data.size) ?? asNumber(data.file_size);
	const common = {
		...refs,
		...(asString(data.mime_type) === undefined ? {} : { mimeType: asString(data.mime_type) }),
		...(size === undefined ? {} : { sizeBytes: size }),
		...(asNumber(data.width) === undefined ? {} : { width: asNumber(data.width) }),
		...(asNumber(data.height) === undefined ? {} : { height: asNumber(data.height) }),
		...(previewText === undefined ? {} : { previewText }),
	};
	return type === "image" ? { ...common, type: "image" } : { ...common, type: "sticker" };
};

const textPart = (segment: OneBotSegment): MessagePart | undefined => {
	const text = asString(segment.data?.text);
	return text === undefined ? undefined : { text, type: "text" };
};

const facePart = (segment: OneBotSegment): MessagePart | undefined => {
	const id = asString(segment.data?.id) ?? asString(segment.data?.face_id);
	if (id !== undefined) {
		return {
			channelRef: `face:${id}`,
			previewText: `face ${id}`,
			type: "sticker",
		};
	}
	return displayMedia(segment, "sticker");
};

const audioPart = (segment: OneBotSegment): MessagePart => {
	const data = segment.data ?? {};
	const refs = mediaReferences(segment);
	const durationMs = asNumber(data.duration) ?? asNumber(data.length);
	const mimeType = asString(data.mime_type) ?? asString(data.mimeType) ?? "audio/*";
	const fileName = asString(data.name) ?? asString(data.file_name);
	return {
		...refs,
		durationMs: durationMs ?? 0,
		mimeType,
		previewText: "voice message",
		transcriptStatus: "skipped",
		type: "audio",
		...(fileName === undefined ? {} : { previewText: `voice message (${fileName})` }),
	};
};

const videoPart = (segment: OneBotSegment): MessagePart => {
	const data = segment.data ?? {};
	const refs = mediaReferences(segment);
	const durationMs = asNumber(data.duration) ?? asNumber(data.length);
	const mimeType = asString(data.mime_type) ?? asString(data.mimeType) ?? "video/*";
	return {
		...refs,
		...(durationMs === undefined ? {} : { durationMs }),
		...(asString(data.width) === undefined ? {} : { width: asNumber(data.width) }),
		...(asString(data.height) === undefined ? {} : { height: asNumber(data.height) }),
		mimeType,
		previewText: "video",
		type: "video",
	};
};

const filePart = (segment: OneBotSegment): MessagePart => {
	const data = segment.data ?? {};
	const refs = mediaReferences(segment);
	const candidate =
		asString(data.name) ??
		asString(data.file_name) ??
		fileNameFrom(asString(data.file)) ??
		fileNameFrom(asString(data.url)) ??
		fileNameFrom(refs.channelRef) ??
		"file";
	const size = asNumber(data.size) ?? asNumber(data.file_size);
	return {
		...refs,
		fileName: candidate,
		...(asString(data.mime_type) === undefined ? {} : { mimeType: asString(data.mime_type) }),
		...(size === undefined ? {} : { sizeBytes: size }),
		previewText: candidate,
		type: "file",
	};
};

function sanitizeText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const withoutUrls = value
		.replace(/https?:\/\/\S+/giu, "[link]")
		.replace(/\b\d{5,}\b/gu, "[id]")
		.replace(/\s+/gu, " ")
		.trim();
	return withoutUrls.length > 0 ? withoutUrls.slice(0, MAX_CARD_SUMMARY) : undefined;
}

const cardSummary = (segment: OneBotSegment): string | undefined => {
	const data = segment.data ?? {};
	const raw =
		asString(data.data) ??
		asString(data.content) ??
		asString(data.json) ??
		asString(data.xml) ??
		asString(data.markdown);
	if (raw === undefined) return sanitizeText(asString(data.summary) ?? asString(data.title));
	if (segment.type === "json") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null) {
				const record = parsed as Record<string, unknown>;
				for (const key of ["prompt", "summary", "title", "desc"]) {
					const value = sanitizeText(asString(record[key]));
					if (value !== undefined) return value;
				}
				const meta = record.meta;
				if (typeof meta === "object" && meta !== null) {
					const value = sanitizeText(asString((meta as Record<string, unknown>).title));
					if (value !== undefined) return value;
				}
			}
		} catch {}
		return "[json-card]";
	}
	if (segment.type === "xml") {
		for (const tag of ["summary", "title", "brief"]) {
			const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "iu").exec(raw);
			const value = sanitizeText(match?.[1]?.replace(/<[^>]+>/gu, " "));
			if (value !== undefined) return value;
		}
		return "[xml-card]";
	}
	const withoutLinks = raw
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, "[image]")
		.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
	return sanitizeText(withoutLinks) ?? "[markdown-card]";
};

const cardPart = (segment: OneBotSegment): MessagePart => {
	const nativeType =
		segment.type === "markdown"
			? "markdown-card"
			: segment.type === "xml"
				? "xml-card"
				: "json-card";
	const summary = cardSummary(segment);
	return {
		diagnostic: "card payload withheld from the model by default",
		nativeType,
		rawRef: asString(segment.data?.id) ?? asString(segment.data?.file_id),
		summary: summary ?? `[${nativeType}]`,
		type: "channel-native",
	};
};

const forwardNode = (entry: unknown): OneBotForwardNode => {
	if (typeof entry !== "object" || entry === null) return {};
	const record = entry as Record<string, unknown>;
	const sender = record.sender;
	const senderRecord =
		typeof sender === "object" && sender !== null ? (sender as Record<string, unknown>) : {};
	const segments = Array.isArray(record.content)
		? (record.content as OneBotSegment[])
		: Array.isArray(record.message)
			? (record.message as OneBotSegment[])
			: undefined;
	const senderId = asString(senderRecord.user_id);
	const senderName =
		asString(senderRecord.card) ??
		asString(senderRecord.nickname) ??
		asString(senderRecord.user_id);
	const rawTime = asNumber(record.time);
	return {
		...(segments === undefined ? {} : { segments }),
		...(senderId === undefined ? {} : { senderId }),
		...(senderName === undefined ? {} : { senderName }),
		...(rawTime === undefined ? {} : { timestampMs: Math.floor(rawTime * 1_000) }),
	};
};

const forwardContentNodes = (segment: OneBotSegment): OneBotForwardNode[] => {
	const content = segment.data?.content;
	if (!Array.isArray(content)) return [];
	return content.map((node) => forwardNode(node));
};

const nodeText = (node: OneBotForwardNode): string => {
	if (node.text !== undefined) return node.text;
	return (node.segments ?? [])
		.map((segment) =>
			segment.type === "text" ? (asString(segment.data?.text) ?? "") : `[${segment.type}]`,
		)
		.join("")
		.trim();
};

const formatForwardNodes = (
	nodes: readonly OneBotForwardNode[],
	options: { maxChars: number; maxNodes: number },
): { nodes: number; text: string; truncated: boolean } => {
	const lines: string[] = [];
	let used = 0;
	let truncated = nodes.length > options.maxNodes;
	for (const [index, node] of nodes.slice(0, options.maxNodes).entries()) {
		const sender = node.senderName ?? node.senderId ?? "unknown";
		const text = nodeText(node).replace(/\s+/gu, " ").trim();
		if (text.length === 0) continue;
		const line = `${sender}: ${text}`;
		if (used + line.length + (lines.length === 0 ? 0 : 1) > options.maxChars) {
			const remaining = options.maxChars - used - (lines.length === 0 ? 0 : 1);
			if (remaining > 8) lines.push(`${line.slice(0, remaining - 3)}...`);
			truncated = true;
			break;
		}
		lines.push(line);
		used += line.length + (lines.length === 1 ? 0 : 1);
		if (index === options.maxNodes - 1 && index < nodes.length - 1) truncated = true;
	}
	return { nodes: nodes.length, text: lines.join("\n"), truncated };
};

const forwardPart = (
	segment: OneBotSegment,
	nodes: readonly OneBotForwardNode[] | undefined,
	options: { maxChars: number; maxNodes: number },
	diagnostic?: string,
): MessagePart => {
	const id = asString(segment.data?.id) ?? asString(segment.data?.file_id);
	const formatted = formatForwardNodes(nodes ?? [], options);
	const summary =
		formatted.text.length > 0
			? `[forward message]\n${formatted.text}${formatted.truncated ? "\n[...]" : ""}`
			: "[forward message: content unavailable]";
	return {
		diagnostic:
			diagnostic ?? (nodes === undefined ? "forward content requires get_forward_msg" : undefined),
		nativeType: "forward",
		...(id === undefined ? {} : { rawRef: id }),
		safeFields: { nodeCount: formatted.nodes, truncated: formatted.truncated },
		summary,
		type: "channel-native",
	};
};

const unknownPart = (segment: OneBotSegment): MessagePart => {
	const safeFields: Record<string, string | number | boolean | null> = {};
	if (segment.data !== undefined) {
		for (const [key, value] of Object.entries(segment.data)) {
			if (Object.keys(safeFields).length >= 10) break;
			if (typeof value === "string") safeFields[key] = value.slice(0, 120);
			else if (typeof value === "number" || typeof value === "boolean") safeFields[key] = value;
			else if (value === null) safeFields[key] = null;
		}
	}
	return {
		diagnostic: "unsupported segment preserved as channel-native",
		nativeType: segment.type,
		safeFields,
		summary: `[${segment.type}]`,
		type: "channel-native",
	};
};

type NormalizeOptions = {
	readonly audioRateLimiter?: OneBotIntervalRateLimiter | undefined;
	readonly audioTranscribe?: OneBotAudioTranscribe | undefined;
	readonly audioTranscribeMinIntervalMs?: number | undefined;
	readonly audioTranscribeTimeoutMs?: number | undefined;
	readonly extractVideoFrames?: OneBotVideoFrameExtractor | undefined;
	readonly fetchForward?: ((id: string) => Promise<unknown>) | undefined;
	readonly forwardMaxChars?: number | undefined;
	readonly forwardMaxNodes?: number | undefined;
	readonly forwardTimeoutMs?: number | undefined;
	readonly logger?: PluginLogger | undefined;
	readonly now?: (() => number) | undefined;
};

const segmentText = (segments: readonly OneBotSegment[]): string =>
	segments
		.map((segment) =>
			segment.type === "text" ? (asString(segment.data?.text) ?? "") : `[${segment.type}]`,
		)
		.join("");

/** Trace summary shared by the sync and async normalizers; payload stays out of the log. */
const traceNormalized = (
	logger: PluginLogger,
	event: OneBotEvent,
	parts: readonly MessagePart[],
	path: "sync" | "async",
): void => {
	const segments = event.message ?? [];
	const textPreview = singleLinePreview(segmentText(segments));
	logger.trace("OneBot inbound event normalized", {
		partCount: parts.length,
		partTypes: segmentTypeCounts(parts),
		path,
		postType: event.post_type,
		...(event.message_type === undefined ? {} : { messageType: event.message_type }),
		segmentTypes: segmentTypeCounts(segments),
		...(textPreview === undefined ? {} : { textPreview }),
	});
};

const syncPart = (
	segment: OneBotSegment,
	logger: PluginLogger = createSafeLogger(undefined),
): MessagePart | undefined => {
	switch (segment.type) {
		case "text":
			return textPart(segment);
		case "face":
			return facePart(segment);
		case "image":
			return displayMedia(segment, "image");
		case "record":
		case "audio":
			return audioPart(segment);
		case "video":
			return videoPart(segment);
		case "file":
			return filePart(segment);
		case "json":
		case "xml":
		case "markdown":
			return cardPart(segment);
		case "forward":
			return forwardPart(segment, forwardContentNodes(segment), {
				maxChars: MAX_FORWARD_CHARS,
				maxNodes: MAX_FORWARD_NODES,
			});
		case "reply":
		case "at":
			return undefined;
		default:
			logger.debug("OneBot segment preserved as channel-native", { segmentType: segment.type });
			return unknownPart(segment);
	}
};

const withTimeout = async <T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

const transcribeAudio = async (
	part: MessagePart & { type: "audio" },
	input: OneBotAudioTranscribeInput,
	options: NormalizeOptions,
	chatKey: string,
): Promise<MessagePart> => {
	if (options.audioTranscribe === undefined) return part;
	const logger = createSafeLogger(options.logger);
	if (options.audioRateLimiter?.tryAcquire(chatKey, options.now?.() ?? Date.now()) === false) {
		logger.debug("OneBot audio transcription rate limited", { chatKey });
		return {
			...part,
			previewText: "voice message (transcription rate limited)",
			transcriptStatus: "fallback",
		};
	}
	const startedAtMs = Date.now();
	try {
		const timeoutMs = Math.min(
			MAX_STT_TIMEOUT_MS,
			Math.max(100, options.audioTranscribeTimeoutMs ?? 15_000),
		);
		const result: OneBotAudioTranscribeResult = await withTimeout(
			Promise.resolve(options.audioTranscribe(input)),
			timeoutMs,
			"audio transcription",
		);
		const transcript =
			typeof result === "string" ? result : (result.transcript ?? result.text ?? "").trim();
		const status = typeof result === "string" ? "ok" : (result.status ?? "ok");
		if (transcript.length === 0 || status !== "ok") {
			logger.debug("OneBot audio transcription unavailable", {
				durationMs: Date.now() - startedAtMs,
				status,
				transcriptChars: transcript.length,
			});
			return {
				...part,
				previewText: "voice message (transcription unavailable)",
				transcriptStatus: status === "skipped" ? "skipped" : "fallback",
			};
		}
		logger.debug("OneBot audio transcription completed", {
			durationMs: Date.now() - startedAtMs,
			status,
			transcriptChars: transcript.length,
		});
		return { ...part, transcript, transcriptStatus: "ok" };
	} catch (error) {
		logger.warn("OneBot audio transcription failed", {
			durationMs: Date.now() - startedAtMs,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			...part,
			previewText: "voice message (transcription failed)",
			transcriptStatus: "failed",
		};
	}
};

const attachVideoFrames = async (
	part: MessagePart & { type: "video" },
	input: Parameters<OneBotVideoFrameExtractor>[0],
	options: NormalizeOptions,
): Promise<MessagePart> => {
	if (options.extractVideoFrames === undefined) return part;
	const logger = createSafeLogger(options.logger);
	const startedAtMs = Date.now();
	try {
		const frames = await withTimeout(
			Promise.resolve(options.extractVideoFrames(input)),
			5_000,
			"video frame extraction",
		);
		const bounded = frames.slice(0, MAX_VIDEO_FRAMES).filter((frame) => {
			return frame.mediaId !== undefined || frame.sha256 !== undefined;
		});
		logger.debug("OneBot video frame extraction completed", {
			durationMs: Date.now() - startedAtMs,
			frames: bounded.length,
			truncated: frames.length > bounded.length,
		});
		return bounded.length === 0 ? part : { ...part, frames: bounded };
	} catch (error) {
		logger.warn("OneBot video frame extraction failed", {
			durationMs: Date.now() - startedAtMs,
			error: error instanceof Error ? error.message : String(error),
		});
		return part;
	}
};

const expandForward = async (
	segment: OneBotSegment,
	options: NormalizeOptions,
): Promise<MessagePart> => {
	const logger = createSafeLogger(options.logger);
	const maxChars = options.forwardMaxChars ?? MAX_FORWARD_CHARS;
	const maxNodes = options.forwardMaxNodes ?? MAX_FORWARD_NODES;
	const id = asString(segment.data?.id) ?? asString(segment.data?.file_id);
	const inline = forwardContentNodes(segment);
	if (inline.length > 0) {
		logger.debug("OneBot forward bundle expanded inline", { nodeCount: inline.length });
		return forwardPart(segment, inline, { maxChars, maxNodes });
	}
	if (id === undefined || options.fetchForward === undefined) {
		logger.debug("OneBot forward expansion skipped", {
			reason: id === undefined ? "missing-id" : "no-fetch-hook",
		});
		return forwardPart(segment, undefined, { maxChars, maxNodes });
	}
	const startedAtMs = Date.now();
	try {
		const raw = await withTimeout(
			Promise.resolve(options.fetchForward(id)),
			Math.min(MAX_FORWARD_TIMEOUT_MS, Math.max(100, options.forwardTimeoutMs ?? 5_000)),
			"forward expansion",
		);
		const nodes = parseForwardNodes(raw);
		logger.debug("OneBot forward expansion completed", {
			durationMs: Date.now() - startedAtMs,
			nodeCount: nodes.length,
		});
		return forwardPart(segment, nodes, { maxChars, maxNodes });
	} catch (error) {
		logger.warn("OneBot forward expansion failed", {
			durationMs: Date.now() - startedAtMs,
			error: error instanceof Error ? error.message : String(error),
		});
		return forwardPart(segment, undefined, { maxChars, maxNodes }, "forward expansion failed");
	}
};

/** Parse `get_forward_msg` response data while tolerating NapCat's minor shape differences. */
export function parseForwardNodes(raw: unknown): OneBotForwardNode[] {
	if (typeof raw !== "object" || raw === null) return [];
	const record = raw as Record<string, unknown>;
	const messages = Array.isArray(record.messages)
		? record.messages
		: Array.isArray(record.message)
			? record.message
			: [];
	return messages.map((entry) => forwardNode(entry));
}

const normalizedParts = (
	segments: readonly OneBotSegment[],
	logger?: PluginLogger,
): MessagePart[] => {
	const parts: MessagePart[] = [];
	for (const segment of segments) {
		const part = syncPart(segment, createSafeLogger(logger));
		if (part !== undefined) parts.push(part);
	}
	return parts;
};

const mentionList = (segments: readonly OneBotSegment[] | undefined) => {
	const mentions: Array<{ all?: boolean; id?: string }> = [];
	for (const segment of segments ?? []) {
		if (segment.type !== "at") continue;
		const qq = asString(segment.data?.qq);
		if (qq === undefined) continue;
		mentions.push(qq === "all" ? { all: true } : { id: qq });
	}
	return mentions;
};

/**
 * Pick the best available display name. NapCat sends `card: ""` for friends without a
 * remark and `null` for some accounts, and both are valid platform payloads. A blank name
 * would fail the envelope contract (`displayName` requires >= 1 char) and silently drop the
 * whole message, so every candidate is trimmed and empty values are skipped.
 */
const nonEmpty = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const senderName = (event: OneBotEvent): string => {
	const sender = event.sender;
	return (
		nonEmpty(sender?.card) ??
		nonEmpty(sender?.nickname) ??
		asString(sender?.user_id ?? event.user_id) ??
		"unknown"
	);
};

const buildEnvelope = (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
	parts: MessagePart[],
): MessageEnvelope | undefined => {
	if (
		event.post_type !== "message" ||
		(event.message_type !== "private" && event.message_type !== "group")
	) {
		return undefined;
	}
	const senderId = asString(event.sender?.user_id ?? event.user_id);
	const messageId = asString(event.message_id);
	const peerId = event.message_type === "private" ? senderId : asString(event.group_id);
	if (senderId === undefined || messageId === undefined || peerId === undefined) return undefined;
	if (parts.length === 0) return undefined;
	const replyId = event.message?.find((segment) => segment.type === "reply")?.data?.id;
	const sender =
		event.message_type === "group" && event.sender?.role !== undefined
			? {
					displayName: senderName(event),
					groupRole: event.sender.role,
					id: senderId,
					platformId: senderId,
				}
			: {
					displayName: senderName(event),
					id: senderId,
					platformId: senderId,
				};
	return {
		channelId: config.channelId,
		channelKind: "onebot-v11",
		conversationKey:
			event.message_type === "group"
				? { groupId: peerId, kind: "group", peerId: senderId }
				: { kind: "private", peerId },
		id: messageId,
		mentions: mentionList(event.message),
		parts,
		raw: event,
		sender,
		source: {
			messageId,
			// Platform clock. Kept as evidence; never used for ordering.
			timestampMs: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time * 1_000 : 0,
			// Local clock. The OneBot host runs its own clock, so this is the only value that can
			// be compared against outbound rows written from `Date.now()`.
			receivedAtMs: Date.now(),
		},
		target:
			typeof replyId !== "string" && typeof replyId !== "number"
				? undefined
				: { replyToEnvelopeId: String(replyId) },
	};
};

const chatKeyFor = (event: OneBotEvent): string => {
	const groupId = asString(event.group_id);
	const senderId = asString(event.sender?.user_id ?? event.user_id);
	return groupId === undefined ? `private:${senderId ?? "unknown"}` : `group:${groupId}`;
};

/** Synchronous normalization for all parts whose enrichment does not need platform actions. */
export const normalizeOneBotEvent = (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
	logger?: PluginLogger,
): MessageEnvelope | undefined => {
	const safeLogger = createSafeLogger(logger);
	if (event.message === undefined) {
		safeLogger.debug("OneBot event has no message payload", { postType: event.post_type });
		return undefined;
	}
	const parts = normalizedParts(event.message, safeLogger);
	const envelope = buildEnvelope(event, config, parts);
	if (envelope === undefined) {
		safeLogger.debug("OneBot event not ingestable", {
			partCount: parts.length,
			postType: event.post_type,
			...(event.message_type === undefined ? {} : { messageType: event.message_type }),
		});
		return undefined;
	}
	traceNormalized(safeLogger, event, parts, "sync");
	return envelope;
};

/**
 * Async normalization used by the live channel. Only STT, video frames, and forward expansion
 * await platform hooks; everything else is resolved synchronously.
 */
export const normalizeOneBotEventAsync = async (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
	options: NormalizeOptions = {},
): Promise<MessageEnvelope | undefined> => {
	const logger = createSafeLogger(options.logger);
	if (event.message === undefined) {
		logger.debug("OneBot event has no message payload", { postType: event.post_type });
		return undefined;
	}
	const chatKey = chatKeyFor(event);
	const parts: MessagePart[] = [];
	for (const segment of event.message) {
		let part = syncPart(segment, logger);
		if (part === undefined) continue;
		if (segment.type === "forward") {
			part = await expandForward(segment, options);
		} else if (part.type === "audio" && options.audioTranscribe !== undefined) {
			part = await transcribeAudio(
				part,
				{
					chatKey,
					...(part.channelRef === undefined ? {} : { channelRef: part.channelRef }),
					...(part.durationMs === undefined ? {} : { durationMs: part.durationMs }),
					...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
					...(part.sourceUrl === undefined ? {} : { sourceUrl: part.sourceUrl }),
				},
				options,
				chatKey,
			);
		} else if (part.type === "video" && options.extractVideoFrames !== undefined) {
			part = await attachVideoFrames(
				part,
				{
					...(part.channelRef === undefined ? {} : { channelRef: part.channelRef }),
					...(part.durationMs === undefined ? {} : { durationMs: part.durationMs }),
					...(asString(event.message_id) === undefined
						? {}
						: { messageId: asString(event.message_id)! }),
					...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
					...(part.sourceUrl === undefined ? {} : { sourceUrl: part.sourceUrl }),
				},
				options,
			);
		}
		parts.push(part);
	}
	const envelope = buildEnvelope(event, config, parts);
	if (envelope === undefined) {
		logger.debug("OneBot event not ingestable", {
			partCount: parts.length,
			postType: event.post_type,
			...(event.message_type === undefined ? {} : { messageType: event.message_type }),
		});
		return undefined;
	}
	traceNormalized(logger, event, parts, "async");
	return envelope;
};

const noticeType = (event: OneBotEvent): ChannelNoticeType => {
	switch (event.notice_type) {
		case "notify":
			if (event.sub_type === "poke") return "poke";
			if (event.sub_type === "title") return "title";
			if (event.sub_type === "input_status") return "typing";
			return "unknown";
		case "friend_recall":
		case "group_recall":
			return "revoke";
		case "group_msg_emoji_like":
			return "reaction";
		case "group_ban":
			return "mute";
		case "group_upload":
			return "group-file";
		case "group_increase":
		case "group_decrease":
		case "group_admin":
		case "group_card":
			return "member-change";
		default:
			return event.notice_type === "group_ban" ? "ban" : "unknown";
	}
};

const noticeDetails = (event: OneBotEvent): Record<string, unknown> => {
	const details: Record<string, unknown> = {};
	if (event.sub_type !== undefined) details.subType = event.sub_type;
	if (event.duration !== undefined) details.duration = event.duration;
	if (event.operator_id !== undefined) details.operatorId = event.operator_id;
	if (event.file !== undefined) {
		details.file = {
			id: event.file.id,
			name: event.file.name,
			size: event.file.size,
			url: event.file.url,
		};
	}
	if (event.likes !== undefined) details.likes = event.likes;
	return details;
};

export const normalizeOneBotNotice = (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
	logger?: PluginLogger,
): ChannelNotice | undefined => {
	const safeLogger = createSafeLogger(logger);
	if (event.post_type !== "notice") {
		safeLogger.trace("OneBot notice ignored", { postType: event.post_type });
		return undefined;
	}
	const type = noticeType(event);
	const actorId = asString(
		event.user_id ?? (event.notice_type === "notify" ? event.target_id : undefined),
	);
	const targetUserId = asString(event.target_id);
	const targetMessageId = asString(event.message_id);
	const groupId = asString(event.group_id);
	const actorDisplayName = senderName(event);
	const isSelfTarget =
		type === "poke" &&
		targetUserId !== undefined &&
		(targetUserId === config.botAccountId || targetUserId === asString(event.self_id));
	const peerId = groupId ?? actorId ?? targetUserId;
	if (peerId === undefined) {
		safeLogger.debug("OneBot notice dropped without a peer", {
			noticeType: event.notice_type,
			subType: event.sub_type,
		});
		return undefined;
	}
	const idParts = [
		event.notice_type ?? "notice",
		event.sub_type ?? "",
		asString(event.time) ?? "",
		actorId ?? "",
		targetUserId ?? "",
		targetMessageId ?? "",
		asString(event.file?.id) ?? "",
	];
	const notice = {
		...(actorDisplayName.length === 0 ? {} : { actorDisplayName }),
		...(actorId === undefined ? {} : { actorId }),
		channelId: config.channelId,
		channelKind: "onebot-v11",
		conversationKey:
			groupId === undefined
				? { kind: "private" as const, peerId }
				: { groupId, kind: "group" as const, peerId: actorId ?? peerId },
		details: noticeDetails(event),
		id:
			asString(event.message_id) !== undefined ? `notice:${idParts.join(":")}` : idParts.join(":"),
		isSelfTarget,
		noticeType: type,
		occurredAtMs:
			Number.isSafeInteger(event.time) && event.time >= 0 ? event.time * 1_000 : Date.now(),
		raw: event,
		...(targetMessageId === undefined ? {} : { targetMessageId }),
		...(targetUserId === undefined ? {} : { targetUserId }),
	};
	return channelNoticeSchema.parse(notice);
};

export const normalizeOneBotRequest = (
	event: OneBotEvent,
	config: { botAccountId: string; channelId: string },
	logger?: PluginLogger,
): ChannelRequest | undefined => {
	const safeLogger = createSafeLogger(logger);
	if (event.post_type !== "request" || event.flag === undefined) {
		safeLogger.trace("OneBot request ignored", { postType: event.post_type });
		return undefined;
	}
	if (event.request_type !== "friend" && event.request_type !== "group") {
		safeLogger.debug("OneBot request dropped with unknown type", {
			requestType: event.request_type,
		});
		return undefined;
	}
	const requesterId = asString(event.user_id);
	if (requesterId === undefined) {
		safeLogger.debug("OneBot request dropped without a requester", {
			requestType: event.request_type,
		});
		return undefined;
	}
	const groupId = asString(event.group_id);
	if (event.request_type === "group" && groupId === undefined) {
		safeLogger.debug("OneBot group request dropped without a group", { requesterId });
		return undefined;
	}
	const subType = asString(event.sub_type);
	const kind =
		event.request_type === "friend"
			? "friend"
			: subType === "invite"
				? "group-invite"
				: "group-add";
	const accountId = asString(event.self_id) ?? config.botAccountId;
	safeLogger.debug("OneBot request normalized", { kind, requesterId });
	return {
		accountId,
		channelId: config.channelId,
		...(event.comment === undefined ? {} : { comment: event.comment }),
		flag: event.flag,
		...(groupId === undefined ? {} : { groupId }),
		kind,
		raw: event,
		receivedAtMs: Number.isSafeInteger(event.time) && event.time >= 0 ? event.time * 1_000 : 0,
		requesterId,
		...(asString(event.sender?.nickname) === undefined
			? {}
			: { requesterDisplayName: asString(event.sender?.nickname)! }),
		...(subType === undefined ? {} : { subType }),
	};
};
