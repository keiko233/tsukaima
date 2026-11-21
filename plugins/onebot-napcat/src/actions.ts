import { messagePartSchema, type ConversationPolicy, type MessagePart } from "@tsukaima/contracts";
import type {
	AuditEntry,
	ChannelCapability,
	OutboundTarget,
	PluginAuditApi,
	PluginConversationsApi,
	PluginLogger,
	PluginMediaApi,
	PluginOutboundApi,
} from "@tsukaima/sdk";
import type { OneBotChannelAdapter } from "./adapter.ts";
import type { OneBotPluginConfig } from "./config.ts";
import { createSafeLogger } from "./logging.ts";

export type OneBotActionActor = {
	readonly actorId?: string;
	readonly actorKind?: "user" | "agent" | "plugin" | "system";
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly conversationId?: string;
	readonly platformConversationId?: string;
	readonly senderPlatformId?: string;
	/** WebUI RPCs are already authenticated by the host and count as an administrator. */
	readonly trustedAdmin?: boolean;
};

type ActionDescriptor = {
	readonly capability: ChannelCapability;
	readonly destructive?: "delete-group-file" | "group-manage" | "raw" | "self-manage";
	readonly targetKind: string;
};

const DESCRIPTORS = {
	deleteGroupFile: {
		capability: "upload",
		destructive: "delete-group-file",
		targetKind: "group-file",
	},
	deleteMessage: { capability: "interact", targetKind: "message" },
	fetchGroupFile: { capability: "read-media", targetKind: "group-file" },
	forwardMessage: { capability: "send", targetKind: "conversation" },
	groupBan: { capability: "group-manage", destructive: "group-manage", targetKind: "group-member" },
	groupKick: {
		capability: "group-manage",
		destructive: "group-manage",
		targetKind: "group-member",
	},
	groupLeave: { capability: "group-manage", destructive: "group-manage", targetKind: "group" },
	groupSetAdmin: {
		capability: "group-manage",
		destructive: "group-manage",
		targetKind: "group-member",
	},
	groupSetCard: {
		capability: "group-manage",
		destructive: "group-manage",
		targetKind: "group-member",
	},
	groupSetName: { capability: "group-manage", destructive: "group-manage", targetKind: "group" },
	groupSetSpecialTitle: {
		capability: "group-manage",
		destructive: "group-manage",
		targetKind: "group-member",
	},
	groupWholeBan: { capability: "group-manage", destructive: "group-manage", targetKind: "group" },
	listGroupFiles: { capability: "read-media", targetKind: "group" },
	listTargets: { capability: "read-info", targetKind: "conversation" },
	lookupMessage: { capability: "read-info", targetKind: "message" },
	markRead: { capability: "read-info", targetKind: "message" },
	poke: { capability: "interact", targetKind: "user" },
	rawAction: { capability: "raw", destructive: "raw", targetKind: "onebot-action" },
	react: { capability: "interact", targetKind: "message" },
	readHistory: { capability: "read-info", targetKind: "conversation" },
	send: { capability: "send", targetKind: "conversation" },
	sendForward: { capability: "send", targetKind: "conversation" },
	setAvatar: { capability: "group-manage", destructive: "self-manage", targetKind: "account" },
	setLongnick: { capability: "group-manage", destructive: "self-manage", targetKind: "account" },
	setOnlineStatus: {
		capability: "group-manage",
		destructive: "self-manage",
		targetKind: "account",
	},
	setProfile: { capability: "group-manage", destructive: "self-manage", targetKind: "account" },
	setTyping: { capability: "interact", targetKind: "conversation" },
	uploadGroupFile: { capability: "upload", targetKind: "group-file" },
	viewImage: { capability: "read-media", targetKind: "media" },
} as const satisfies Record<string, ActionDescriptor>;

export type OneBotActionMethod = keyof typeof DESCRIPTORS;
export const ONEBOT_ACTION_METHODS = Object.keys(DESCRIPTORS) as readonly OneBotActionMethod[];

const parseJsonIfString = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			return value;
		}
	}
	return value;
};

const asRecord = (value: unknown): Record<string, unknown> => {
	const parsed = parseJsonIfString(value);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
};

const toIdString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

/** Strip optional `[msg:<id>]` or `msg:<id>` reference wrappers from model-supplied message IDs. */
const cleanMessageId = (value: string): string => {
	const match = /^\[?msg:([^\]]+)\]?$/iu.exec(value.trim());
	return match?.[1]?.trim() ?? value.trim();
};

const pickId = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
	for (const key of keys) {
		const value = toIdString(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
};

const pickMessageId = (
	record: Record<string, unknown>,
	keys: readonly string[] = ["messageId", "message_id", "platformMessageId", "id"],
): string | undefined => {
	const raw = pickId(record, keys);
	return raw === undefined ? undefined : cleanMessageId(raw);
};

const asString = (value: unknown, label: string): string => {
	const id = toIdString(value);
	if (id !== undefined) return id;
	throw new Error(`${label} is required`);
};

const asNumber = (value: unknown, label: string): number => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new Error(`${label} must be a number`);
};

const asBoolean = (value: unknown, fallback = false): boolean => {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
};

const parseTargetColon = (
	raw: string,
): { kind: "private" | "group"; platformConversationId: string; userId?: string } | undefined => {
	const match = /^(private|group):([^:]+)(?::([^:]+))?$/u.exec(raw.trim());
	if (!match) return undefined;
	const kind = match[1] as "private" | "group";
	const platformConversationId = match[2]!.trim();
	const userId = match[3]?.trim();
	if (platformConversationId.length === 0) return undefined;
	return {
		kind,
		platformConversationId,
		...(userId !== undefined && userId.length > 0 ? { userId } : {}),
	};
};

const resolveKind = (
	targetRecord: Record<string, unknown>,
	rootRecord: Record<string, unknown>,
): "private" | "group" | undefined => {
	for (const candidate of [
		targetRecord.kind,
		targetRecord.type,
		targetRecord.targetKind,
		targetRecord.target_type,
		targetRecord.targetType,
		targetRecord.scene,
		targetRecord.chatType,
		targetRecord.message_type,
		targetRecord.messageType,
		rootRecord["target.kind"],
		rootRecord.kind,
		rootRecord.targetKind,
		rootRecord.target_type,
		rootRecord.targetType,
		rootRecord.scene,
		rootRecord.chatType,
		rootRecord.message_type,
		rootRecord.messageType,
		rootRecord.type,
	]) {
		if (candidate === "private" || candidate === "group") return candidate;
		if (candidate === "friend" || candidate === "user" || candidate === "direct") return "private";
	}
	return undefined;
};

const asTarget = (
	value: unknown,
	rootInput?: Record<string, unknown>,
	actor?: OneBotActionActor,
): OutboundTarget => {
	const root = rootInput ?? asRecord(value);
	const paramsRecord = asRecord(root.params);
	const effectiveRoot = Object.keys(paramsRecord).length > 0 ? { ...paramsRecord, ...root } : root;
	const rawTarget = value ?? effectiveRoot.target;
	if (typeof rawTarget === "string") {
		const colon = parseTargetColon(rawTarget);
		if (colon !== undefined) {
			return {
				channelId:
					typeof effectiveRoot.channelId === "string"
						? effectiveRoot.channelId
						: (actor?.channelId ?? "onebot"),
				kind: colon.kind,
				platformConversationId: colon.platformConversationId,
			};
		}
	}
	const record = asRecord(rawTarget);
	const groupId =
		pickId(record, ["groupId", "group_id"]) ?? pickId(effectiveRoot, ["groupId", "group_id"]);
	const validGroupId = groupId !== undefined && groupId !== "0" ? groupId : undefined;
	let kind = resolveKind(record, effectiveRoot);
	if (kind === undefined) {
		if (validGroupId !== undefined) {
			kind = "group";
		} else if (
			pickId(record, [
				"platformConversationId",
				"userId",
				"user_id",
				"targetId",
				"target_id",
				"peerId",
				"peer_id",
				"chatId",
				"chat_id",
				"qq",
				"id",
			]) !== undefined ||
			pickId(effectiveRoot, [
				"target.platformConversationId",
				"target.id",
				"platformConversationId",
				"userId",
				"user_id",
				"targetId",
				"target_id",
				"peerId",
				"peer_id",
				"chatId",
				"chat_id",
				"qq",
				"id",
			]) !== undefined
		) {
			kind = "private";
		} else if (
			(actor?.chatKind === "private" || actor?.chatKind === "group") &&
			actor.platformConversationId !== undefined
		) {
			kind = actor.chatKind;
		}
	}
	if (kind !== "private" && kind !== "group") {
		throw new Error("target.kind must be private or group");
	}
	const fallbackPlatformId = actor?.chatKind === kind ? actor.platformConversationId : undefined;
	const platformConversationId =
		kind === "group"
			? (pickId(record, [
					"platformConversationId",
					"groupId",
					"group_id",
					"targetId",
					"target_id",
					"chatId",
					"chat_id",
					"id",
				]) ??
				validGroupId ??
				pickId(effectiveRoot, [
					"target.platformConversationId",
					"target.id",
					"platformConversationId",
					"targetId",
					"target_id",
					"chatId",
					"chat_id",
					"id",
				]) ??
				fallbackPlatformId)
			: (pickId(record, [
					"platformConversationId",
					"userId",
					"user_id",
					"targetId",
					"target_id",
					"peerId",
					"peer_id",
					"chatId",
					"chat_id",
					"qq",
					"id",
				]) ??
				pickId(effectiveRoot, [
					"target.platformConversationId",
					"target.id",
					"platformConversationId",
					"userId",
					"user_id",
					"targetId",
					"target_id",
					"peerId",
					"peer_id",
					"chatId",
					"chat_id",
					"qq",
					"id",
				]) ??
				fallbackPlatformId);
	return {
		channelId:
			typeof record.channelId === "string"
				? record.channelId
				: typeof effectiveRoot.channelId === "string"
					? effectiveRoot.channelId
					: (actor?.channelId ?? "onebot"),
		kind,
		platformConversationId: asString(platformConversationId, "target.platformConversationId"),
	};
};

const resolveGroupId = (input: Record<string, unknown>, actor?: OneBotActionActor): string => {
	const explicit =
		pickId(input, ["groupId", "group_id"]) ??
		pickId(asRecord(input.target), ["groupId", "group_id", "platformConversationId", "id"]);
	const fallback = actor?.chatKind === "group" ? actor.platformConversationId : undefined;
	return asString(explicit ?? fallback, "groupId");
};

const normalizeCandidatePart = (raw: unknown): unknown => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const record = { ...(raw as Record<string, unknown>) };
	if (
		record.sourceUrl === undefined &&
		typeof record.url === "string" &&
		record.url.trim().length > 0
	) {
		record.sourceUrl = record.url.trim();
	}
	delete record.url;
	if (typeof record.sourceUrl === "string" && !/^https?:\/\//iu.test(record.sourceUrl)) {
		if (record.channelRef === undefined) {
			record.channelRef = record.sourceUrl;
		}
		delete record.sourceUrl;
	}
	if (
		record.fileName === undefined &&
		typeof record.name === "string" &&
		record.name.trim().length > 0
	) {
		record.fileName = record.name.trim();
	}
	delete record.name;
	if (
		record.type === "file" &&
		(typeof record.fileName !== "string" || record.fileName.trim().length === 0)
	) {
		record.fileName = "attachment";
	}
	return record;
};

const asParts = (value: unknown, rootInput?: Record<string, unknown>): MessagePart[] => {
	const root = rootInput ?? {};
	const paramsRecord = asRecord(root.params);
	const raw =
		value ??
		paramsRecord.parts ??
		root.text ??
		root.message ??
		root.content ??
		paramsRecord.text ??
		paramsRecord.message;
	const parsedValue = parseJsonIfString(raw);
	if (typeof parsedValue === "string" && parsedValue.length > 0) {
		return [{ text: parsedValue, type: "text" }];
	}
	const list =
		!Array.isArray(parsedValue) &&
		typeof parsedValue === "object" &&
		parsedValue !== null &&
		"type" in parsedValue
			? [parsedValue]
			: parsedValue;
	if (!Array.isArray(list)) throw new Error("parts must be an array");
	return list.map((part, index) => {
		const candidate = normalizeCandidatePart(
			typeof part === "string" ? { text: part, type: "text" } : parseJsonIfString(part),
		);
		const parsed = messagePartSchema.safeParse(candidate);
		if (!parsed.success) {
			throw new Error(
				`parts[${index}] is invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`,
			);
		}
		return parsed.data;
	});
};

export interface OneBotActionFacadeOptions {
	readonly audit: PluginAuditApi | undefined;
	readonly conversations?: PluginConversationsApi;
	readonly getAdapter: () => OneBotChannelAdapter | undefined;
	readonly getSettings: () => OneBotPluginConfig;
	readonly logger: PluginLogger;
	readonly media?: PluginMediaApi;
	/**
	 * Host-owned outbound path. Without it a send leaves no durable history, so the WebUI never
	 * shows it; tests that only assert transport traffic can omit it.
	 */
	readonly outbound?: PluginOutboundApi;
}

export type OneBotActionResult =
	| { readonly ok: true; readonly result: unknown }
	| { readonly ok: false; readonly reason: string };

/**
 * Capability + configuration + identity policy for every NapCat action. Reads retry inside
 * `OneBotChannel`; sends and destructive mutations never retry. Every attempt is audited.
 */
export class OneBotActionFacade {
	readonly #audit: PluginAuditApi | undefined;
	readonly #conversations: PluginConversationsApi | undefined;
	readonly #getAdapter: () => OneBotChannelAdapter | undefined;
	readonly #getSettings: () => OneBotPluginConfig;
	readonly #logger: PluginLogger;
	readonly #media: PluginMediaApi | undefined;
	readonly #outbound: PluginOutboundApi | undefined;

	constructor(options: OneBotActionFacadeOptions) {
		this.#audit = options.audit;
		this.#conversations = options.conversations;
		this.#getAdapter = options.getAdapter;
		this.#getSettings = options.getSettings;
		this.#logger = createSafeLogger(options.logger);
		this.#media = options.media;
		this.#outbound = options.outbound;
	}

	async run(
		method: OneBotActionMethod,
		input: unknown,
		actor: OneBotActionActor = {},
	): Promise<OneBotActionResult> {
		const descriptor = DESCRIPTORS[method];
		const data = asRecord(input);
		const targetId = this.#targetId(method, data, actor);
		const action = `onebot-napcat.${method}`;
		const startedAtMs = Date.now();
		this.#logger.trace("OneBot action invoked", {
			action,
			actorKind: actor.actorKind ?? "plugin",
			method,
			...(targetId === undefined ? {} : { targetId }),
		});
		const adapter = this.#getAdapter();
		if (adapter === undefined) {
			await this.#recordDenied(action, descriptor, actor, targetId, "channel-unavailable");
			this.#logCompletion(action, method, targetId, startedAtMs, "channel-unavailable");
			return { ok: false, reason: "channel-unavailable" };
		}
		const denial = await this.#authorize(descriptor, method, data, actor);
		if (denial !== undefined) {
			await this.#recordDenied(action, descriptor, actor, targetId, denial);
			this.#logCompletion(action, method, targetId, startedAtMs, denial);
			return { ok: false, reason: denial };
		}
		try {
			const result = await this.#execute(adapter, method, data, actor);
			await this.#record(action, descriptor, actor, targetId, "ok");
			this.#logCompletion(action, method, targetId, startedAtMs);
			return { ok: true, result };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.#logger.warn("OneBot action failed", { action, reason });
			await this.#record(action, descriptor, actor, targetId, "failed", reason);
			this.#logCompletion(action, method, targetId, startedAtMs, reason);
			return { ok: false, reason };
		}
	}

	#logCompletion(
		action: string,
		method: OneBotActionMethod,
		targetId: string | undefined,
		startedAtMs: number,
		reason?: string,
	): void {
		this.#logger.debug("OneBot action finished", {
			action,
			durationMs: Date.now() - startedAtMs,
			method,
			...(reason === undefined ? {} : { reason }),
			...(targetId === undefined ? {} : { targetId }),
		});
	}

	async #authorize(
		descriptor: ActionDescriptor,
		method: OneBotActionMethod,
		input: Record<string, unknown>,
		actor: OneBotActionActor,
	): Promise<string | undefined> {
		const adapter = this.#getAdapter();
		if (adapter === undefined) return "channel-unavailable";
		if (!adapter.capabilities().includes(descriptor.capability)) {
			return `capability-missing:${descriptor.capability}`;
		}
		if (
			actor.actorKind === "agent" &&
			(method === "send" ||
				method === "sendForward" ||
				method === "forwardMessage" ||
				method === "readHistory" ||
				method === "setTyping")
		) {
			try {
				const target = asTarget(input.target, input, actor);
				const isCrossChat =
					actor.platformConversationId !== undefined &&
					(target.platformConversationId !== actor.platformConversationId ||
						(actor.chatKind !== undefined && target.kind !== actor.chatKind));
				if (isCrossChat && this.#conversations !== undefined) {
					const list = await this.#conversations.list();
					const match = list.find(
						(entry) =>
							entry.kind === target.kind &&
							entry.platformConversationId === target.platformConversationId,
					);
					if (match?.muted === true) return "cross-chat-target-muted";
					if (match !== undefined) {
						const policy = await this.#conversations.getPolicy(match.id);
						const access =
							target.kind === "group" ? policy.trigger.groupAccess : policy.trigger.privateAccess;
						if (!policy.enabled || access === "disabled") {
							return "cross-chat-target-disabled";
						}
					}
				}
			} catch {
				// Let #execute surface specific validation errors when target cannot be resolved.
			}
		}
		const settings = this.#getSettings();
		const admin = this.#isAdmin(settings, actor);
		switch (descriptor.destructive) {
			case undefined:
				return undefined;
			case "delete-group-file":
				if (settings.deleteGroupFile !== true) return "action-disabled:delete-group-file";
				return admin ? undefined : "admin-required";
			case "group-manage":
				if (settings.groupManage !== true) return "action-disabled:group-manage";
				return admin ? undefined : "admin-required";
			case "self-manage":
				if (settings.selfManage !== true) return "action-disabled:self-manage";
				return admin ? undefined : "admin-required";
			case "raw": {
				const rawAction = asString(input.action, "action");
				const allowlist = settings.rawActionAllowlist ?? [];
				if (!allowlist.includes(rawAction)) return "raw-action-not-allowlisted";
				return admin ? undefined : "admin-required";
			}
		}
	}

	#isAdmin(settings: OneBotPluginConfig, actor: OneBotActionActor): boolean {
		if (actor.trustedAdmin === true) return true;
		if (actor.actorId === undefined) return false;
		return (settings.adminUsers ?? []).includes(actor.actorId);
	}

	#targetId(
		method: OneBotActionMethod,
		input: Record<string, unknown>,
		actor: OneBotActionActor = {},
	): string | undefined {
		if (method === "rawAction") return toIdString(input.action);
		if (
			method === "send" ||
			method === "sendForward" ||
			method === "forwardMessage" ||
			method === "readHistory" ||
			method === "setTyping"
		) {
			try {
				return asTarget(input.target, input, actor).platformConversationId;
			} catch {
				const target = asRecord(input.target);
				return (
					pickId(target, [
						"platformConversationId",
						"id",
						"targetId",
						"target_id",
						"userId",
						"user_id",
						"groupId",
						"group_id",
					]) ?? actor.platformConversationId
				);
			}
		}
		if (method === "poke") {
			const targetRecord = asRecord(input.target);
			const colon = typeof input.target === "string" ? parseTargetColon(input.target) : undefined;
			const userId =
				pickId(input, ["userId", "user_id", "targetId", "target_id", "qq", "id"]) ??
				pickId(targetRecord, ["userId", "user_id", "targetId", "target_id", "qq", "id"]) ??
				colon?.userId;
			if (userId !== undefined) return userId;
			try {
				return asTarget(input.target, input, actor).platformConversationId;
			} catch {
				return actor.senderPlatformId ?? actor.actorId ?? actor.platformConversationId;
			}
		}
		return (
			pickMessageId(input, ["messageId", "message_id", "platformMessageId"]) ??
			pickId(input, [
				"groupId",
				"group_id",
				"userId",
				"user_id",
				"mediaId",
				"sha256",
				"fileId",
				"file_id",
			]) ??
			actor.platformConversationId
		);
	}

	#resolvePokeTarget(
		input: Record<string, unknown>,
		actor: OneBotActionActor,
	): { readonly target: OutboundTarget; readonly userId: string } {
		const targetRecord = asRecord(input.target);
		const colon = typeof input.target === "string" ? parseTargetColon(input.target) : undefined;
		const explicitKind = resolveKind(targetRecord, input) ?? colon?.kind;
		const explicitGroupId =
			pickId(targetRecord, ["groupId", "group_id"]) ??
			pickId(input, ["groupId", "group_id"]) ??
			(colon?.kind === "group" ? colon.platformConversationId : undefined);
		const explicitUserId =
			pickId(input, ["userId", "user_id", "qq"]) ??
			pickId(targetRecord, ["userId", "user_id", "qq"]) ??
			colon?.userId;
		if (
			explicitKind === undefined &&
			explicitGroupId === undefined &&
			input.target === undefined &&
			actor.chatKind === "group" &&
			actor.platformConversationId !== undefined
		) {
			const target: OutboundTarget = {
				channelId: actor.channelId ?? "onebot",
				kind: "group",
				platformConversationId: actor.platformConversationId,
			};
			const poked =
				explicitUserId ??
				pickId(input, ["targetId", "target_id", "id"]) ??
				actor.senderPlatformId ??
				actor.actorId;
			return { target, userId: asString(poked, "userId") };
		}
		const target = asTarget(input.target, input, actor);
		const userId =
			explicitUserId ??
			(target.kind === "private"
				? target.platformConversationId
				: (pickId(input, ["targetId", "target_id", "id"]) ??
					pickId(targetRecord, ["targetId", "target_id", "id"]) ??
					actor.senderPlatformId ??
					actor.actorId));
		return { target, userId: asString(userId, "userId") };
	}

	async #execute(
		adapter: OneBotChannelAdapter,
		method: OneBotActionMethod,
		input: Record<string, unknown>,
		actor: OneBotActionActor = {},
	): Promise<unknown> {
		const channel = adapter.channel;
		if (channel === undefined) throw new Error("channel-unavailable");
		switch (method) {
			case "send": {
				const target = asTarget(input.target, input, actor);
				const parts = asParts(input.parts, input);
				const replyRaw = toIdString(
					input.replyToPlatformMessageId ?? input.reply_to_message_id ?? input.replyToMessageId,
				);
				const reply = replyRaw === undefined ? undefined : cleanMessageId(replyRaw);
				if (asBoolean(input.forward)) {
					const result = await channel.sendForward(target, parts);
					await this.#recordInteraction(target, "forward", parts);
					return result;
				}
				if (this.#outbound !== undefined) {
					return await this.#outbound.send({
						parts,
						target,
						...(reply === undefined ? {} : { options: { replyToPlatformMessageId: reply } }),
					});
				}
				return adapter.send(
					target,
					parts,
					reply === undefined ? undefined : { replyToPlatformMessageId: reply },
				);
			}
			case "sendForward": {
				const target = asTarget(input.target, input, actor);
				const parts = asParts(input.parts, input);
				const result = await channel.sendForward(target, parts);
				await this.#recordInteraction(target, "forward", parts);
				return result;
			}
			case "forwardMessage": {
				const target = asTarget(input.target, input, actor);
				const rawList = Array.isArray(input.messageIds)
					? input.messageIds
					: Array.isArray(input.message_ids)
						? input.message_ids
						: [];
				const singleId = pickMessageId(input, [
					"messageId",
					"message_id",
					"platformMessageId",
					"id",
				]);
				const messageIds = [
					...(singleId === undefined ? [] : [singleId]),
					...rawList
						.map((entry) => toIdString(entry))
						.filter((entry): entry is string => entry !== undefined)
						.map((entry) => cleanMessageId(entry)),
				];
				const uniqueIds = [...new Set(messageIds)];
				const result = await channel.forwardMessage(target, uniqueIds);
				await this.#recordInteraction(target, "forward");
				return result;
			}
			case "listTargets":
				return await this.#listTargets(adapter, input, actor);
			case "viewImage":
				return await this.#viewImage(adapter, input, actor);
			case "lookupMessage":
				return channel.lookupMessage(
					asString(
						pickMessageId(input, ["platformMessageId", "messageId", "message_id", "id"]),
						"platformMessageId",
					),
				);
			case "readHistory": {
				const limitRaw = input.limit ?? input.count;
				const limit = limitRaw === undefined ? undefined : asNumber(limitRaw, "limit");
				const sinceMs =
					input.sinceMs === undefined ? undefined : asNumber(input.sinceMs, "sinceMs");
				const items = await channel.readHistory(asTarget(input.target, input, actor), {
					...(limit === undefined ? {} : { limit }),
					...(sinceMs === undefined ? {} : { sinceMs }),
				});
				return items.map((item) => ({
					...item,
					ref: `[msg:${item.platformMessageId}]`,
				}));
			}
			case "poke": {
				const { target, userId: poked } = this.#resolvePokeTarget(input, actor);
				const result = await channel.poke(target, poked);
				await this.#recordInteraction(target, "poke", undefined, poked);
				return result;
			}
			case "react":
				return channel.react(
					asString(
						pickMessageId(input, ["messageId", "message_id", "platformMessageId"]),
						"messageId",
					),
					asString(pickId(input, ["emojiId", "emoji_id", "emoji"]), "emojiId"),
					asBoolean(input.set, true),
				);
			case "setTyping":
				return channel.setTyping(
					asTarget(input.target, input, actor),
					asBoolean(input.typing, true),
				);
			case "deleteMessage":
				return channel.deleteMessage(
					asString(
						pickMessageId(input, ["messageId", "message_id", "platformMessageId"]),
						"messageId",
					),
				);
			case "markRead":
				return channel.markRead(
					asString(
						pickMessageId(input, ["messageId", "message_id", "platformMessageId"]),
						"messageId",
					),
				);
			case "listGroupFiles":
				return channel.listGroupFiles(resolveGroupId(input, actor));
			case "fetchGroupFile":
				return channel.fetchGroupFile(
					resolveGroupId(input, actor),
					asString(pickId(input, ["fileId", "file_id"]), "fileId"),
					input.busid === undefined ? undefined : asNumber(input.busid, "busid"),
				);
			case "uploadGroupFile":
				return channel.uploadGroupFile(
					resolveGroupId(input, actor),
					asString(input.file, "file"),
					asString(input.name, "name"),
					asStringOptional(input.folder),
				);
			case "deleteGroupFile":
				return channel.deleteGroupFile(
					resolveGroupId(input, actor),
					asString(pickId(input, ["fileId", "file_id"]), "fileId"),
					input.busid === undefined ? undefined : asNumber(input.busid, "busid"),
				);
			case "groupBan":
				return channel.groupBan(
					resolveGroupId(input, actor),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asNumber(
						input.durationSeconds ?? input.duration_seconds ?? input.duration,
						"durationSeconds",
					),
				);
			case "groupWholeBan":
				return channel.groupWholeBan(resolveGroupId(input, actor), asBoolean(input.enable, true));
			case "groupKick":
				return channel.groupKick(
					resolveGroupId(input, actor),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asBoolean(input.rejectAddRequest ?? input.reject_add_request),
				);
			case "groupSetAdmin":
				return channel.groupSetAdmin(
					resolveGroupId(input, actor),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asBoolean(input.enable, true),
				);
			case "groupSetCard":
				return channel.groupSetCard(
					resolveGroupId(input, actor),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asString(input.card, "card"),
				);
			case "groupSetName":
				return channel.groupSetName(
					resolveGroupId(input, actor),
					asString(input.groupName ?? input.group_name ?? input.name, "groupName"),
				);
			case "groupLeave":
				return channel.groupLeave(
					resolveGroupId(input, actor),
					asBoolean(input.dismiss ?? input.is_dismiss),
				);
			case "groupSetSpecialTitle":
				return channel.groupSetSpecialTitle(
					resolveGroupId(input, actor),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asString(input.title ?? input.special_title ?? input.specialTitle, "title"),
				);
			case "setAvatar":
				return channel.setAvatar(asString(input.file, "file"));
			case "setProfile":
				return channel.setProfile(asRecord(input.profile ?? input));
			case "setLongnick":
				return channel.setLongnick(asString(input.longnick ?? input.longNick, "longnick"));
			case "setOnlineStatus":
				return channel.setOnlineStatus(
					asNumber(input.status, "status"),
					input.extStatus !== undefined || input.ext_status !== undefined
						? asNumber(input.extStatus ?? input.ext_status, "extStatus")
						: undefined,
					input.batteryStatus !== undefined || input.battery_status !== undefined
						? asNumber(input.batteryStatus ?? input.battery_status, "batteryStatus")
						: undefined,
				);
			case "rawAction":
				return channel.rawAction(asString(input.action, "action"), asRecord(input.params));
		}
	}

	async #listTargets(
		adapter: OneBotChannelAdapter,
		input: Record<string, unknown>,
		actor: OneBotActionActor,
	): Promise<{
		readonly currentChat?: {
			readonly channelId: string;
			readonly kind: "private" | "group";
			readonly platformConversationId: string;
		};
		readonly targets: readonly {
			readonly channelId: string;
			readonly conversationId?: string;
			readonly isCurrent: boolean;
			readonly kind: "private" | "group";
			readonly platformConversationId: string;
			readonly title: string;
		}[];
	}> {
		const requestedKind =
			input.kind === "private" || input.kind === "group" ? input.kind : undefined;
		const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
		const limit = Math.min(
			100,
			Math.max(1, input.limit === undefined ? 50 : asNumber(input.limit, "limit")),
		);
		const currentChat:
			| {
					readonly channelId: string;
					readonly kind: "private" | "group";
					readonly platformConversationId: string;
			  }
			| undefined =
			(actor.chatKind === "private" || actor.chatKind === "group") &&
			actor.platformConversationId !== undefined
				? {
						channelId: actor.channelId ?? adapter.id,
						kind: actor.chatKind,
						platformConversationId: actor.platformConversationId,
					}
				: undefined;
		interface TargetSummary {
			readonly channelId: string;
			readonly conversationId?: string;
			readonly isCurrent: boolean;
			readonly kind: "private" | "group";
			readonly platformConversationId: string;
			readonly title: string;
		}
		type PolicyView = ConversationPolicy;
		const policyAllowsTarget = (
			policy: PolicyView,
			kind: "private" | "group",
			id: string,
		): boolean => {
			if (!policy.enabled) return false;
			const access = kind === "group" ? policy.trigger.groupAccess : policy.trigger.privateAccess;
			if (access === "disabled") return false;
			return access !== "allowlist" || policy.trigger.allowlist.includes(id);
		};
		const matchesQuery = (title: string, id: string): boolean =>
			query.length === 0 || title.toLowerCase().includes(query) || id.toLowerCase().includes(query);

		const targets: TargetSummary[] = [];
		const seen = new Set<string>();
		const addTarget = (target: TargetSummary): boolean => {
			const key = `${target.kind}:${target.platformConversationId}`;
			if (seen.has(key) || targets.length >= limit) return false;
			seen.add(key);
			targets.push(target);
			return true;
		};
		let discoveryPolicy: PolicyView | undefined;
		if (this.#conversations !== undefined) {
			const list = await this.#conversations.list();
			for (const entry of list) {
				if (entry.kind !== "private" && entry.kind !== "group") continue;
				if (requestedKind !== undefined && entry.kind !== requestedKind) continue;
				const platformId = entry.platformConversationId ?? undefined;
				if (platformId === undefined || platformId.length === 0) continue;
				seen.add(`${entry.kind}:${platformId}`);
				if (entry.muted === true) continue;
				try {
					const policy = await this.#conversations.getPolicy(entry.id);
					const isCurrentEntry =
						currentChat?.kind === entry.kind && currentChat.platformConversationId === platformId;
					if (isCurrentEntry || discoveryPolicy === undefined) discoveryPolicy = policy;
					if (!policyAllowsTarget(policy, entry.kind, platformId)) continue;
				} catch {
					continue;
				}
				if (!matchesQuery(entry.title, platformId)) continue;
				addTarget({
					channelId: entry.channelId ?? adapter.id,
					conversationId: entry.id,
					isCurrent:
						currentChat?.kind === entry.kind && currentChat.platformConversationId === platformId,
					kind: entry.kind,
					platformConversationId: platformId,
					title: entry.title || `${entry.kind}:${platformId}`,
				});
			}
		}
		if (
			discoveryPolicy === undefined &&
			this.#conversations !== undefined &&
			actor.conversationId !== undefined
		) {
			try {
				discoveryPolicy = await this.#conversations.getPolicy(actor.conversationId);
			} catch {}
		}
		// The active chat is always a valid implicit target, even before its domain row exists.
		if (
			currentChat !== undefined &&
			!targets.some((target) => target.isCurrent) &&
			targets.length < limit
		) {
			seen.add(`${currentChat.kind}:${currentChat.platformConversationId}`);
			targets.push({
				channelId: currentChat.channelId,
				isCurrent: true,
				kind: currentChat.kind,
				platformConversationId: currentChat.platformConversationId,
				title: `${currentChat.kind}:${currentChat.platformConversationId}`,
			});
		}
		// NapCat may know about allowed chats Tsukaima has not seen yet. Only include discovery
		// results that are authorized by the same policy that governs the current conversation;
		// without a readable policy the list stays fail-closed.
		if (targets.length < limit) {
			const channel = adapter.channel;
			if (channel !== undefined) {
				if (requestedKind !== "private") {
					try {
						for (const group of await channel.listGroups()) {
							if (discoveryPolicy === undefined) break;
							if (!matchesQuery(group.title, group.groupId)) continue;
							if (!policyAllowsTarget(discoveryPolicy, "group", group.groupId)) continue;
							addTarget({
								channelId: adapter.id,
								isCurrent:
									currentChat?.kind === "group" &&
									currentChat.platformConversationId === group.groupId,
								kind: "group",
								platformConversationId: group.groupId,
								title: group.title,
							});
						}
					} catch (error) {
						this.#logger.debug("OneBot group discovery failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				if (requestedKind !== "group" && targets.length < limit) {
					try {
						for (const friend of await channel.listFriends()) {
							if (discoveryPolicy === undefined) break;
							if (!matchesQuery(friend.title, friend.userId)) continue;
							if (!policyAllowsTarget(discoveryPolicy, "private", friend.userId)) continue;
							addTarget({
								channelId: adapter.id,
								isCurrent:
									currentChat?.kind === "private" &&
									currentChat.platformConversationId === friend.userId,
								kind: "private",
								platformConversationId: friend.userId,
								title: friend.title,
							});
						}
					} catch (error) {
						this.#logger.debug("OneBot friend discovery failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		}
		return {
			...(currentChat === undefined ? {} : { currentChat }),
			targets,
		};
	}

	async #viewImage(
		adapter: OneBotChannelAdapter,
		input: Record<string, unknown>,
		actor: OneBotActionActor,
	): Promise<{
		readonly data: string;
		readonly mediaId?: string;
		readonly mimeType: string;
		readonly partType: "image" | "sticker";
		readonly platformMessageId?: string;
		readonly previewText?: string;
		readonly sha256?: string;
		readonly sizeBytes: number;
	}> {
		const channel = adapter.channel;
		if (channel === undefined) throw new Error("channel-unavailable");
		const requestedMessageId = pickMessageId(input, [
			"messageId",
			"message_id",
			"platformMessageId",
		]);
		const requestedMediaId = toIdString(input.mediaId ?? input.media_id);
		const requestedSha = toIdString(input.sha256);
		const requestedFile = toIdString(
			input.file ?? input.channelRef ?? input.url ?? input.sourceUrl,
		);
		let resolvedPart: Extract<MessagePart, { type: "image" | "sticker" }> | undefined;
		let resolvedPlatformMessageId = requestedMessageId;

		if (
			requestedMediaId === undefined &&
			requestedSha === undefined &&
			requestedFile === undefined &&
			this.#conversations !== undefined &&
			actor.conversationId !== undefined
		) {
			const recent = await this.#conversations.recentMessages(actor.conversationId, 25);
			const candidates = recent.toReversed();
			for (const message of candidates) {
				if (
					requestedMessageId !== undefined &&
					message.platformMessageId !== requestedMessageId &&
					message.id !== requestedMessageId
				) {
					continue;
				}
				const imagePart = (message.parts ?? []).find(
					(part): part is Extract<MessagePart, { type: "image" | "sticker" }> =>
						part.type === "image" || part.type === "sticker",
				);
				if (imagePart !== undefined) {
					resolvedPart = imagePart;
					resolvedPlatformMessageId =
						resolvedPlatformMessageId ?? message.platformMessageId ?? undefined;
					break;
				}
			}
		}

		const mediaId = requestedMediaId ?? resolvedPart?.mediaId;
		const sha256 = requestedSha ?? resolvedPart?.sha256;
		const mimeType = resolvedPart?.mimeType ?? "image/png";
		const partType = resolvedPart?.type ?? "image";

		if (this.#media !== undefined && (mediaId !== undefined || sha256 !== undefined)) {
			const record =
				mediaId !== undefined
					? await this.#media.findById(mediaId)
					: sha256 !== undefined
						? await this.#media.findBySha(sha256)
						: undefined;
			if (record !== undefined) {
				const bytes = await this.#media.readBytes(record.id);
				return {
					data: Buffer.from(bytes).toString("base64"),
					mediaId: record.id,
					mimeType: record.mimeType || mimeType,
					partType,
					...(resolvedPlatformMessageId === undefined
						? {}
						: { platformMessageId: resolvedPlatformMessageId }),
					...(resolvedPart?.previewText === undefined
						? {}
						: { previewText: resolvedPart.previewText }),
					sha256: record.sha256,
					sizeBytes: bytes.byteLength,
				};
			}
		}

		const fallbackPart: Extract<MessagePart, { type: "image" | "sticker" }> | undefined =
			resolvedPart ??
			(requestedFile !== undefined
				? /^https?:\/\//iu.test(requestedFile)
					? { sourceUrl: requestedFile, type: "image" }
					: { channelRef: requestedFile, type: "image" }
				: undefined);
		if (fallbackPart !== undefined) {
			const bytes = await channel.fetchMedia(fallbackPart);
			if (bytes !== undefined) {
				return {
					data: Buffer.from(bytes).toString("base64"),
					...(fallbackPart.mediaId === undefined ? {} : { mediaId: fallbackPart.mediaId }),
					mimeType: fallbackPart.mimeType ?? mimeType,
					partType: fallbackPart.type,
					...(resolvedPlatformMessageId === undefined
						? {}
						: { platformMessageId: resolvedPlatformMessageId }),
					...(fallbackPart.previewText === undefined
						? {}
						: { previewText: fallbackPart.previewText }),
					...(fallbackPart.sha256 === undefined ? {} : { sha256: fallbackPart.sha256 }),
					sizeBytes: bytes.byteLength,
				};
			}
		}
		throw new Error(
			"Requested image or sticker could not be resolved; pass a recent [msg:<id>], mediaId, or sha256 from this chat",
		);
	}

	/**
	 * Persist an interaction the platform already accepted. A history write must never fail the
	 * action itself, so a recording error only warns.
	 */
	async #recordInteraction(
		target: OutboundTarget,
		kind: "forward" | "poke",
		parts?: readonly MessagePart[],
		targetUserId?: string,
	): Promise<void> {
		const outbound = this.#outbound;
		if (outbound === undefined) return;
		const summary =
			kind === "poke"
				? `[poke] ${this.#getSettings().botAccountId ?? "tsukaima"} -> ${
						targetUserId ?? target.platformConversationId
					}`
				: `[forward] ${(parts ?? []).length} part(s) -> ${target.platformConversationId}`;
		try {
			await outbound.recordInteraction({
				nativeType: `notice:${kind}`,
				summary,
				target,
			});
		} catch (error) {
			this.#logger.warn("OneBot interaction history could not be recorded", {
				kind,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #recordDenied(
		action: string,
		descriptor: ActionDescriptor,
		actor: OneBotActionActor,
		targetId: string | undefined,
		reason: string,
	): Promise<void> {
		this.#logger.warn("OneBot action denied", { action, reason });
		await this.#record(action, descriptor, actor, targetId, "denied", reason);
	}

	async #record(
		action: string,
		descriptor: ActionDescriptor,
		actor: OneBotActionActor,
		targetId: string | undefined,
		result: AuditEntry["result"],
		reason?: string,
	): Promise<void> {
		if (this.#audit === undefined) return;
		try {
			await this.#audit.record({
				action,
				...(actor.actorId === undefined ? {} : { actorId: actor.actorId }),
				actorKind: actor.actorKind ?? "plugin",
				payload: { method: action, capability: descriptor.capability },
				...(reason === undefined ? {} : { reason }),
				result,
				...(targetId === undefined ? {} : { targetId }),
				targetKind: descriptor.targetKind,
			});
		} catch (error) {
			this.#logger.warn("OneBot action audit failed", {
				action,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

const asStringOptional = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;

export const ONEBOT_ACTION_PERMISSIONS: Record<OneBotActionMethod, readonly string[]> = {
	deleteGroupFile: ["channel.manage"],
	deleteMessage: ["channel.interact"],
	fetchGroupFile: ["channel.manage", "conversation.read"],
	forwardMessage: ["channel.send"],
	groupBan: ["channel.manage"],
	groupKick: ["channel.manage"],
	groupLeave: ["channel.manage"],
	groupSetAdmin: ["channel.manage"],
	groupSetCard: ["channel.manage"],
	groupSetName: ["channel.manage"],
	groupSetSpecialTitle: ["channel.manage"],
	groupWholeBan: ["channel.manage"],
	listGroupFiles: ["channel.manage", "conversation.read"],
	listTargets: ["conversation.read"],
	lookupMessage: ["conversation.read"],
	markRead: ["conversation.read"],
	poke: ["channel.interact"],
	rawAction: ["channel.raw"],
	react: ["channel.interact"],
	readHistory: ["conversation.read"],
	send: ["channel.send"],
	sendForward: ["channel.send"],
	setAvatar: ["channel.manage"],
	setLongnick: ["channel.manage"],
	setOnlineStatus: ["channel.manage"],
	setProfile: ["channel.manage"],
	setTyping: ["channel.interact"],
	uploadGroupFile: ["channel.manage"],
	viewImage: ["media.read", "conversation.read"],
};
