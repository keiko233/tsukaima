import type { ConversationPolicy } from "@tsukaima/contracts";
import type {
	OutboundTarget,
	PluginContext,
	PluginConversationSummary,
	PluginLogger,
	ToolResult,
} from "@tsukaima/sdk";
import type { LearningService } from "./learning.ts";
import { sanitizeModelText, type StickerItem, type StickerPack } from "./domain.ts";
import { buildAnimatedFrameSheet, isAnimatedImage } from "./frame-sheet.ts";
import { elapsedMs, traceLog } from "./logging.ts";
import { toStickerMessagePart } from "./output.ts";
import {
	toCompactStickerCandidate,
	type StickerSearchInput,
	type StickerSelectionService,
} from "./selection.ts";
import type { StickerSemanticClassifier } from "./semantic.ts";
import type { StickerUrlImportService } from "./url-import.ts";

export interface StickerToolExtras {
	readonly learning?: LearningService;
	readonly resolveClassifier?: () => Promise<StickerSemanticClassifier>;
	readonly urlImport?: StickerUrlImportService;
}

const text = (value: string): ToolResult => ({ content: [{ text: value, type: "text" }] });

/** Bounded inspection payload; larger files are rejected instead of base64-encoded. */
const MAX_VIEW_IMAGE_BYTES = 5 * 1024 * 1024;

const asString = (input: Record<string, unknown>, key: string): string | undefined => {
	const value = input[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const pickTargetId = (
	source: Record<string, unknown> | undefined,
	keys: readonly string[],
): string | undefined => {
	if (source === undefined) return undefined;
	for (const key of keys) {
		const val = source[key];
		if (typeof val === "string" && val.trim().length > 0) return val.trim();
		if (typeof val === "number" && Number.isFinite(val)) return String(val);
	}
	return undefined;
};

const parseJsonObject = (value: unknown): Record<string, unknown> | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				const parsed = JSON.parse(trimmed) as unknown;
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
};

interface ResolvedStickerTarget {
	readonly explicitConversationId?: string;
	readonly isCrossChat: boolean;
	readonly outboundTarget?: OutboundTarget;
}

function resolveStickerTarget(
	input: Record<string, unknown>,
	invocation: {
		readonly channelId?: string;
		readonly chatKind?: string;
		readonly conversationId?: string;
		readonly platformConversationId?: string;
	},
): ResolvedStickerTarget {
	const rawTarget = parseJsonObject(input.target);
	const explicitConversationId = asString(input, "conversationId");
	const groupId =
		pickTargetId(input, ["groupId", "group_id"]) ??
		pickTargetId(rawTarget, ["groupId", "group_id"]);
	const userId =
		pickTargetId(input, ["userId", "user_id", "peerId", "peer_id", "qq"]) ??
		pickTargetId(rawTarget, ["userId", "user_id", "peerId", "peer_id", "qq"]);

	let kind = rawTarget?.kind as string | undefined;
	if (kind === undefined) {
		if (groupId !== undefined) kind = "group";
		else if (userId !== undefined) kind = "private";
	}

	let outboundTarget: OutboundTarget | undefined;
	if (kind === "group" || kind === "private") {
		const platformConversationId =
			(kind === "group" ? groupId : userId) ??
			pickTargetId(rawTarget, ["platformConversationId", "id", "chatId", "chat_id"]);
		if (platformConversationId !== undefined) {
			outboundTarget = {
				channelId: asString(rawTarget ?? {}, "channelId") ?? invocation.channelId ?? "onebot",
				kind,
				platformConversationId,
			};
		}
	}

	const isCrossChat =
		outboundTarget !== undefined
			? invocation.platformConversationId === undefined ||
				outboundTarget.platformConversationId !== invocation.platformConversationId ||
				(invocation.chatKind !== undefined && outboundTarget.kind !== invocation.chatKind)
			: explicitConversationId !== undefined &&
				invocation.conversationId !== undefined &&
				explicitConversationId !== invocation.conversationId;

	return {
		...(explicitConversationId === undefined ? {} : { explicitConversationId }),
		isCrossChat,
		...(outboundTarget === undefined ? {} : { outboundTarget }),
	};
}

async function checkStickerCrossChatPolicy(
	conversations: PluginContext["conversations"],
	target: ResolvedStickerTarget,
	callerConversationId: string | undefined,
): Promise<PluginConversationSummary | undefined> {
	if (conversations === undefined) {
		throw new Error("cross-chat-target-denied");
	}
	let list: readonly PluginConversationSummary[];
	try {
		list = await conversations.list();
	} catch {
		throw new Error("cross-chat-target-denied");
	}
	if (target.outboundTarget !== undefined) {
		const ot = target.outboundTarget;
		const match = list.find(
			(entry) =>
				entry.kind === ot.kind && entry.platformConversationId === ot.platformConversationId,
		);
		if (match === undefined) {
			throw new Error("cross-chat-target-unknown");
		}
		if (match.muted === true) {
			throw new Error("cross-chat-target-muted");
		}
		let policy: ConversationPolicy | undefined;
		try {
			policy = await conversations.getPolicy(match.id);
		} catch {
			throw new Error("cross-chat-target-denied");
		}
		if (policy === undefined) {
			throw new Error("cross-chat-target-unknown");
		}
		const trigger = policy.trigger;
		const access =
			ot.kind === "group" ? (trigger?.groupAccess ?? "open") : (trigger?.privateAccess ?? "open");
		if (policy.enabled === false || access === "disabled") {
			throw new Error("cross-chat-target-disabled");
		}
		if (
			access === "allowlist" &&
			Array.isArray(trigger?.allowlist) &&
			!trigger.allowlist.includes(ot.platformConversationId)
		) {
			throw new Error("cross-chat-target-not-allowed");
		}
		const allowedTargets = (policy as { allowedTargets?: readonly string[] }).allowedTargets;
		if (
			Array.isArray(allowedTargets) &&
			!allowedTargets.includes(`${ot.kind}:${ot.platformConversationId}`) &&
			!allowedTargets.includes(ot.platformConversationId)
		) {
			throw new Error("cross-chat-target-not-allowed");
		}

		if (callerConversationId !== undefined && callerConversationId !== match.id) {
			try {
				const callerPolicy = await conversations.getPolicy(callerConversationId);
				if (callerPolicy !== undefined) {
					const callerTrigger = callerPolicy.trigger;
					const callerAccess =
						ot.kind === "group"
							? (callerTrigger?.groupAccess ?? "open")
							: (callerTrigger?.privateAccess ?? "open");
					if (
						callerAccess === "allowlist" &&
						Array.isArray(callerTrigger?.allowlist) &&
						!callerTrigger.allowlist.includes(ot.platformConversationId)
					) {
						throw new Error("cross-chat-target-not-allowed");
					}
					const callerAllowed = (callerPolicy as { allowedTargets?: readonly string[] })
						.allowedTargets;
					if (
						Array.isArray(callerAllowed) &&
						!callerAllowed.includes(`${ot.kind}:${ot.platformConversationId}`) &&
						!callerAllowed.includes(ot.platformConversationId)
					) {
						throw new Error("cross-chat-target-not-allowed");
					}
				}
			} catch (err) {
				if (err instanceof Error && err.message === "cross-chat-target-not-allowed") {
					throw err;
				}
				throw new Error("cross-chat-target-denied", { cause: err });
			}
		}
		return match;
	}
	if (target.explicitConversationId !== undefined) {
		const cid = target.explicitConversationId;
		const match = list.find((entry) => entry.id === cid || entry.durableConversationId === cid);
		if (match === undefined) {
			throw new Error("cross-chat-target-unknown");
		}
		if (match.muted === true) {
			throw new Error("cross-chat-target-muted");
		}
		let policy: ConversationPolicy | undefined;
		try {
			policy = await conversations.getPolicy(match.id);
		} catch {
			throw new Error("cross-chat-target-denied");
		}
		if (policy === undefined) {
			throw new Error("cross-chat-target-unknown");
		}
		if (policy.enabled === false) {
			throw new Error("cross-chat-target-disabled");
		}
		return match;
	}
	return undefined;
}

const asStringList = (input: Record<string, unknown>, key: string): string[] | undefined => {
	const value = input[key];
	if (typeof value === "string") {
		return value
			.split(/[,，]/u)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	}
	if (!Array.isArray(value)) return undefined;
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
};

const searchInput = (input: Record<string, unknown>): StickerSearchInput => {
	const emotion = asString(input, "emotion");
	const packId = asString(input, "packId");
	const personaId = asString(input, "personaId");
	const query = asString(input, "query");
	const tags = asStringList(input, "tags");
	const limit =
		typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
	return {
		...(emotion === undefined ? {} : { emotion }),
		...(limit === undefined ? {} : { limit }),
		...(packId === undefined ? {} : { packId }),
		...(personaId === undefined ? {} : { personaId }),
		...(query === undefined ? {} : { query }),
		...(tags === undefined ? {} : { tags }),
	};
};

/** Registers model-visible sticker selection tools with host-enforced policies. */
export function registerStickerTools(
	context: PluginContext,
	selection: StickerSelectionService,
	logger?: PluginLogger,
	extras?: StickerToolExtras,
): void {
	const log = logger ?? context.logger;
	context.tools.register({
		description:
			"List all available, enabled sticker packs in the library with their packId, name, itemCount, tags, personaIds, and sampleEmotions. All enabled packs in the library are approved for use in chat (unless explicitly restricted to a different personaId). Use this tool to discover packs before searching or when a search returns no items.",
		async execute() {
			const startedAt = Date.now();
			traceLog(log, "sticker tool invoked", {
				tool: "sticker-meme.list_packs",
			});
			const packs = await selection.listAvailablePacks();
			log.debug("sticker tool completed", {
				durationMs: elapsedMs(startedAt),
				packCount: packs.length,
				tool: "sticker-meme.list_packs",
			});
			return text(
				JSON.stringify({
					count: packs.length,
					packs,
				}),
			);
		},
		lazy: false,
		name: "sticker-meme.list_packs",
		parameters: {
			properties: {},
			type: "object",
		},
		policy: {
			lazy: false,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "chat",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["media.read"],
	});
	context.tools.register({
		description:
			"Search approved, enabled stickers by semantic text, emotion, persona, pack name/id, or tags. Space- or comma-separated query terms are treated as alternatives (OR). All enabled packs in the library are approved for use in chat (unless explicitly restricted to a different personaId). Newly imported packs are available immediately; omit filters or use sticker-meme.list_packs to browse available packs. Candidate descriptions are compact previews (about 120 characters) so long vision descriptions do not bloat context; use sticker-meme.view with an itemId to inspect a specific sticker in full detail.",
		async execute(input) {
			const startedAt = Date.now();
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				tool: "sticker-meme.search",
			});
			const candidates = (await selection.search(search)).map(toCompactStickerCandidate);
			log.debug("sticker tool completed", {
				candidateCount: candidates.length,
				durationMs: elapsedMs(startedAt),
				tool: "sticker-meme.search",
			});
			if (candidates.length === 0) {
				const availablePacks = await selection.listAvailablePacks();
				return text(
					JSON.stringify({
						availablePacks,
						candidates: [],
						count: 0,
						hint: "No stickers matched the search criteria. All enabled sticker packs in the library are approved for chat use. Try browsing by packId, emotion, or omitting filters to view available stickers.",
					}),
				);
			}
			return text(
				JSON.stringify({
					candidates,
					count: candidates.length,
				}),
			);
		},
		name: "sticker-meme.search",
		parameters: {
			properties: {
				emotion: {
					description:
						"Emotion id or a natural-language alias, for example happy or 开心. Comma-separate to allow any of several.",
					type: "string",
				},
				limit: { maximum: 25, minimum: 1, type: "integer" },
				packId: {
					description:
						"Pack id, display name, or tag. Newly imported packs are searchable immediately by name.",
					type: "string",
				},
				personaId: { type: "string" },
				query: {
					description:
						"Any of several names, characters, emotions, or keywords. Separate alternatives with spaces or commas.",
					type: "string",
				},
				tags: { items: { type: "string" }, type: "array" },
			},
			type: "object",
		},
		policy: {
			lazy: false,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "chat",
			timeoutMs: 10_000,
		},
		requiredPermissions: ["media.read"],
	});
	context.tools.register({
		description:
			"Select and immediately send the best matching approved sticker in one step by query, emotion, itemId, packId, or tags. Supports sending to the current chat (when target is omitted) or an explicit private/group target or conversation (subject to cross-chat policy). All enabled packs in the library are approved for use in chat (unless explicitly restricted to a different personaId). Use sticker-meme.list_packs or omit filters to browse available packs. The sticker is delivered right away; do not write sticker directives or markers in your reply.",
		async execute(input, invocation) {
			const startedAt = Date.now();
			const conversationId = invocation.conversationId;
			if (conversationId === undefined || conversationId.trim().length === 0) {
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					reason: "missing_conversation",
					tool: "sticker-meme.send",
				});
				return text("A conversation is required to send a sticker.");
			}
			const targetResolution = resolveStickerTarget(input, invocation);
			let targetMatch: PluginConversationSummary | undefined;
			if (targetResolution.isCrossChat) {
				try {
					targetMatch = await checkStickerCrossChatPolicy(
						context.conversations,
						targetResolution,
						conversationId,
					);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					log.debug("sticker tool rejected", {
						durationMs: elapsedMs(startedAt),
						reason,
						tool: "sticker-meme.send",
					});
					throw error;
				}
			}
			const itemId = asString(input, "itemId");
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				itemId: itemId ?? null,
				tool: "sticker-meme.send",
			});
			const effectiveConversationId =
				targetMatch?.id ??
				targetMatch?.durableConversationId ??
				targetResolution.explicitConversationId ??
				conversationId;
			const { item, matchedBy, pack } = await selection.resolveForSend({
				...search,
				conversationId: effectiveConversationId,
				...(itemId === undefined ? {} : { itemId }),
			});
			const outbound = context.outbound;
			if (outbound === undefined) {
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					reason: "outbound_unavailable",
					tool: "sticker-meme.send",
				});
				return text("Sticker sending is unavailable: this host exposes no outbound channel.");
			}
			if (targetResolution.outboundTarget !== undefined) {
				await outbound.send({
					originConversationId: conversationId,
					parts: [toStickerMessagePart(item)],
					target: targetResolution.outboundTarget,
				});
			} else if (targetResolution.explicitConversationId !== undefined) {
				await outbound.sendToConversation({
					conversationId: effectiveConversationId,
					parts: [toStickerMessagePart(item)],
				});
			} else {
				await outbound.sendToConversation({
					conversationId,
					parts: [toStickerMessagePart(item)],
				});
			}
			log.debug("sticker tool completed", {
				durationMs: elapsedMs(startedAt),
				itemId: item.id,
				matchedBy,
				tool: "sticker-meme.send",
			});
			return text(
				JSON.stringify({
					itemId: item.id,
					matchedBy,
					name: item.name,
					packId: pack.id,
					packName: pack.name,
					sent: true,
					...(targetResolution.outboundTarget === undefined
						? {}
						: { target: targetResolution.outboundTarget }),
					...(targetResolution.isCrossChat
						? { targetConversationId: effectiveConversationId }
						: {}),
				}),
			);
		},
		lazy: false,
		name: "sticker-meme.send",
		parameters: {
			properties: {
				conversationId: {
					description:
						"Target conversation ID when sending across conversations. Defaults to the current conversation.",
					type: "string",
				},
				emotion: {
					description:
						"Emotion id or natural-language alias, for example happy or 开心. Comma-separate to allow any of several.",
					type: "string",
				},
				groupId: {
					description: "Target group ID (e.g. QQ group number) when sending across conversations.",
					type: "string",
				},
				itemId: { type: "string" },
				packId: { type: "string" },
				personaId: { type: "string" },
				query: {
					description:
						"Any of several names, characters, emotions, or keywords. Separate alternatives with spaces or commas.",
					type: "string",
				},
				tags: { items: { type: "string" }, type: "array" },
				target: {
					additionalProperties: true,
					description:
						"Explicit cross-conversation outbound target, e.g. { kind: 'group', platformConversationId: '12345' }.",
					properties: {
						channelId: { type: "string" },
						kind: { enum: ["private", "group", "webui", "workspace"], type: "string" },
						platformConversationId: { type: "string" },
					},
					type: "object",
				},
				userId: {
					description: "Target user ID (e.g. QQ user number) when sending across conversations.",
					type: "string",
				},
			},
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			lazy: false,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "chat",
			timeoutMs: 15_000,
		},
		requiredPermissions: ["media.read", "conversation.read", "channel.send"],
	});
	context.tools.register({
		description:
			"Deprecated legacy token picker. Prefer sticker-meme.send, which sends the chosen sticker immediately and needs no token or reply marker. This tool only returns a single-use send token for older callers.",
		async execute(input, invocation) {
			const startedAt = Date.now();
			const conversationId = invocation.conversationId;
			if (conversationId === undefined || conversationId.trim().length === 0) {
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					reason: "missing_conversation",
					tool: "sticker-meme.choose",
				});
				return text("A conversation is required to choose a sticker.");
			}
			const itemId = asString(input, "itemId");
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				itemId: itemId ?? null,
				tool: "sticker-meme.choose",
			});
			const result = await selection.choose({
				...search,
				conversationId,
				...(itemId === undefined ? {} : { itemId }),
			});
			log.debug("sticker tool completed", {
				chosenId: result.itemId,
				durationMs: elapsedMs(startedAt),
				tokenIssued: true,
				tool: "sticker-meme.choose",
			});
			return text(JSON.stringify(result));
		},
		name: "sticker-meme.choose",
		parameters: {
			properties: {
				emotion: { type: "string" },
				itemId: { type: "string" },
				packId: { type: "string" },
				personaId: { type: "string" },
				query: {
					description:
						"Any of several names, characters, emotions, or keywords. Separate alternatives with spaces or commas.",
					type: "string",
				},
				tags: { items: { type: "string" }, type: "array" },
			},
			type: "object",
		},
		policy: {
			conversationAllowlist: true,
			lazy: true,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "chat",
			timeoutMs: 15_000,
		},
		requiredPermissions: ["media.read", "conversation.read"],
	});

	if (extras?.learning !== undefined) {
		const learning = extras.learning;
		context.tools.register({
			description:
				"Steal/save a sticker or image from the current QQ/chat conversation into the sticker library so it can be reused later. Matches by messageId ([msg:<id>]), mediaId, sha256, or defaults to the latest sticker/image in this conversation.",
			async execute(input, invocation) {
				const startedAt = Date.now();
				const conversationId = invocation.conversationId;
				if (conversationId === undefined || conversationId.trim().length === 0) {
					return text("A conversation is required to steal a sticker.");
				}
				const conversations = context.conversations;
				if (conversations === undefined) {
					return text("Conversation history is unavailable on this host.");
				}
				const rawMessageId = asString(input, "messageId");
				const requestedMessageId = rawMessageId?.replace(/^\[?msg:([^\]]+)\]?$/iu, "$1");
				const requestedMediaId = asString(input, "mediaId");
				const requestedSha = asString(input, "sha256");
				const includeImages = input.includeImages !== false;
				const recent = (await conversations.recentMessages(conversationId, 50)).toReversed();
				let targetPart:
					| {
							readonly channelRef?: string | undefined;
							readonly mediaId?: string | undefined;
							readonly mimeType?: string | undefined;
							readonly previewText?: string | undefined;
							readonly sha256?: string | undefined;
							readonly type: "image" | "sticker";
					  }
					| undefined;
				for (const msg of recent) {
					if (
						requestedMessageId !== undefined &&
						msg.platformMessageId !== requestedMessageId &&
						msg.id !== requestedMessageId
					) {
						continue;
					}
					for (const part of msg.parts ?? []) {
						if (part.type !== "sticker" && (!includeImages || part.type !== "image")) continue;
						if (part.channelRef?.startsWith("face:") === true && part.mediaId === undefined) {
							continue;
						}
						if (requestedMediaId !== undefined && part.mediaId !== requestedMediaId) continue;
						if (requestedSha !== undefined && part.sha256 !== requestedSha) continue;
						if (part.mediaId === undefined && part.sha256 === undefined) continue;
						targetPart = part;
						break;
					}
					if (targetPart !== undefined) break;
				}
				if (targetPart === undefined) {
					return text(
						"No stealable sticker or image with stored media was found in recent messages of this conversation.",
					);
				}
				const classifier =
					extras.resolveClassifier === undefined ? undefined : await extras.resolveClassifier();
				const name = asString(input, "name") ?? targetPart.previewText;
				const description = asString(input, "description");
				const emotions = asStringList(input, "emotions");
				const keywords = asStringList(input, "keywords");
				const packId = asString(input, "packId");
				const result = await learning.stealMedia({
					approve: input.approve !== false,
					...(classifier === undefined ? {} : { classifier }),
					...(description === undefined ? {} : { description }),
					...(emotions === undefined ? {} : { emotions }),
					...(keywords === undefined ? {} : { keywords }),
					...(targetPart.mediaId === undefined ? {} : { mediaId: targetPart.mediaId }),
					...(targetPart.mimeType === undefined ? {} : { mimeType: targetPart.mimeType }),
					...(name === undefined ? {} : { name }),
					...(packId === undefined ? {} : { packId }),
					...(targetPart.sha256 === undefined ? {} : { sha256: targetPart.sha256 }),
					sourceConversationId: conversationId,
				});
				log.debug("sticker tool completed", {
					duplicate: result.duplicate,
					durationMs: elapsedMs(startedAt),
					itemId: result.item.id,
					tool: "sticker-meme.steal",
				});
				return text(
					JSON.stringify({
						duplicate: result.duplicate,
						itemId: result.item.id,
						mimeType: result.item.mimeType,
						name: result.item.name,
						packId: result.pack.id,
						packName: result.pack.name,
						stolen: true,
					}),
				);
			},
			lazy: false,
			name: "sticker-meme.steal",
			parameters: {
				properties: {
					approve: {
						description: "Immediately approve the stolen sticker for chat use (default true).",
						type: "boolean",
					},
					description: { type: "string" },
					emotions: { items: { type: "string" }, type: "array" },
					includeImages: {
						description: "Also match plain image parts in chat (default true).",
						type: "boolean",
					},
					keywords: { items: { type: "string" }, type: "array" },
					mediaId: { type: "string" },
					messageId: {
						description: "Optional platform message id or [msg:<id>] containing the sticker/image.",
						type: "string",
					},
					name: { type: "string" },
					packId: { description: "Optional target pack id or name.", type: "string" },
					sha256: { type: "string" },
				},
				type: "object",
			},
			policy: {
				conversationAllowlist: true,
				lazy: false,
				maxConcurrent: 4,
				maxPayloadBytes: 4_096,
				surface: "chat",
				timeoutMs: 20_000,
			},
			requiredPermissions: ["media.read", "media.write", "conversation.read"],
		});
	}

	if (extras?.urlImport !== undefined) {
		const urlImport = extras.urlImport;
		context.tools.register({
			description:
				"Download an image or video URL (including Twitter/X MP4 GIFs, PNG, JPG, GIF, WebP) and save it as a sticker in the library. Videos are automatically converted to animated GIFs for QQ compatibility.",
			async execute(input, invocation) {
				const startedAt = Date.now();
				const url = asString(input, "url");
				if (url === undefined) {
					return text("url is required.");
				}
				const classifier =
					extras.resolveClassifier === undefined ? undefined : await extras.resolveClassifier();
				const name = asString(input, "name");
				const description = asString(input, "description");
				const emotions = asStringList(input, "emotions");
				const keywords = asStringList(input, "keywords");
				const packId = asString(input, "packId");
				const result = await urlImport.importUrl({
					approve: input.approve !== false,
					...(classifier === undefined ? {} : { classifier }),
					...(description === undefined ? {} : { description }),
					...(emotions === undefined ? {} : { emotions }),
					...(keywords === undefined ? {} : { keywords }),
					...(name === undefined ? {} : { name }),
					...(packId === undefined ? {} : { packId }),
					...(invocation.conversationId === undefined
						? {}
						: { sourceConversationId: invocation.conversationId }),
					url,
				});
				log.debug("sticker tool completed", {
					convertedFromVideo: result.convertedFromVideo,
					duplicate: result.duplicate,
					durationMs: elapsedMs(startedAt),
					itemId: result.item.id,
					tool: "sticker-meme.import_url",
				});
				return text(
					JSON.stringify({
						convertedFromVideo: result.convertedFromVideo,
						duplicate: result.duplicate,
						itemId: result.item.id,
						mimeType: result.item.mimeType,
						name: result.item.name,
						originalMimeType: result.originalMimeType,
						packId: result.pack.id,
						packName: result.pack.name,
					}),
				);
			},
			lazy: true,
			name: "sticker-meme.import_url",
			parameters: {
				properties: {
					approve: { type: "boolean" },
					description: { type: "string" },
					emotions: { items: { type: "string" }, type: "array" },
					keywords: { items: { type: "string" }, type: "array" },
					name: { type: "string" },
					packId: { type: "string" },
					url: {
						description: "HTTP(S) URL to an image or video (e.g. Twitter MP4).",
						type: "string",
					},
				},
				required: ["url"],
				type: "object",
			},
			policy: {
				conversationAllowlist: true,
				lazy: true,
				maxConcurrent: 2,
				maxPayloadBytes: 4_096,
				surface: "chat",
				timeoutMs: 45_000,
			},
			requiredPermissions: ["media.read", "media.write"],
		});
	}

	context.tools.register({
		description:
			"Visually inspect one sticker from the library and return its image to you so you can describe what it shows. Resolve it by exact itemId (preferred, from sticker-meme.search or sticker-meme.send), or by query/emotion/packId/personaId/tags to inspect the top search match. Animated stickers are sampled into a single PNG contact sheet whose frames read left-to-right, top-to-bottom. Use this before sending a sticker you have not seen, or when its name and metadata are ambiguous.",
		async execute(input) {
			const startedAt = Date.now();
			const itemId = asString(input, "itemId");
			const search = searchInput(input);
			traceLog(log, "sticker tool invoked", {
				...search,
				itemId: itemId ?? null,
				tool: "sticker-meme.view",
			});
			let resolved: { readonly item: StickerItem; readonly pack: StickerPack };
			try {
				resolved = await selection.resolveForView({
					...search,
					...(itemId === undefined ? {} : { itemId }),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					itemId: itemId ?? null,
					reason,
					tool: "sticker-meme.view",
				});
				return text(reason);
			}
			const { item, pack } = resolved;
			const media = context.media;
			if (media === undefined) {
				return text("Sticker viewing is unavailable: this host exposes no media store.");
			}
			let imageBytes: Uint8Array;
			try {
				imageBytes = await media.readBytes(item.mediaId);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					itemId: item.id,
					reason: "media_unreadable",
					tool: "sticker-meme.view",
				});
				return text(`Sticker media is unavailable: ${reason}`);
			}
			if (imageBytes.byteLength > MAX_VIEW_IMAGE_BYTES) {
				log.debug("sticker tool rejected", {
					durationMs: elapsedMs(startedAt),
					itemId: item.id,
					reason: "media_too_large",
					tool: "sticker-meme.view",
				});
				return text(
					`Sticker image is too large to inspect: ${imageBytes.byteLength} bytes exceeds the ${MAX_VIEW_IMAGE_BYTES}-byte limit.`,
				);
			}
			let imageMimeType = item.mimeType;
			const animated = isAnimatedImage(item.mimeType, imageBytes);
			let frameSheetCount: number | undefined;
			let note: string | undefined;
			if (animated) {
				const sheet = await buildAnimatedFrameSheet(imageBytes, item.mimeType, { logger: log });
				if (sheet !== undefined) {
					imageBytes = sheet.bytes;
					imageMimeType = sheet.mimeType;
					frameSheetCount = sheet.frameCount;
					note = `Animated sticker sampled into a ${sheet.frameCount}-frame contact sheet; read the frames left-to-right, top-to-bottom as a time sequence.`;
				}
			}
			log.debug("sticker tool completed", {
				durationMs: elapsedMs(startedAt),
				frameSheetCount: frameSheetCount ?? null,
				imageMimeType,
				itemId: item.id,
				tool: "sticker-meme.view",
			});
			return {
				content: [
					{
						text: JSON.stringify({
							animated,
							description: sanitizeModelText(item.description),
							emotions: item.emotions,
							...(frameSheetCount === undefined ? {} : { frameSheetCount }),
							height: item.height,
							itemId: item.id,
							keywords: item.keywords,
							labels: item.semantic.labels,
							mimeType: item.mimeType,
							name: sanitizeModelText(item.name),
							...(note === undefined ? {} : { note }),
							packId: pack.id,
							packName: sanitizeModelText(pack.name),
							width: item.width,
						}),
						type: "text",
					},
				],
				images: [{ data: Buffer.from(imageBytes).toString("base64"), mimeType: imageMimeType }],
			};
		},
		lazy: false,
		name: "sticker-meme.view",
		parameters: {
			properties: {
				emotion: {
					description:
						"Emotion id or a natural-language alias, for example happy or 开心, used when itemId is omitted.",
					type: "string",
				},
				itemId: {
					description:
						"Exact sticker item id, for example from sticker-meme.search or sticker-meme.send.",
					type: "string",
				},
				packId: { type: "string" },
				personaId: { type: "string" },
				query: {
					description:
						"Any of several names, characters, emotions, or keywords, used when itemId is omitted.",
					type: "string",
				},
				tags: { items: { type: "string" }, type: "array" },
			},
			type: "object",
		},
		policy: {
			lazy: false,
			maxConcurrent: 4,
			maxPayloadBytes: 4_096,
			surface: "chat",
			timeoutMs: 15_000,
		},
		requiredPermissions: ["media.read"],
	});
}
