import { messagePartSchema, type MessagePart } from "@tsukaima/contracts";
import type {
	AuditEntry,
	ChannelCapability,
	OutboundTarget,
	PluginAuditApi,
	PluginLogger,
	PluginOutboundApi,
} from "@tsukaima/sdk";
import type { OneBotChannelAdapter } from "./adapter.ts";
import type { OneBotPluginConfig } from "./config.ts";
import { createSafeLogger } from "./logging.ts";

export type OneBotActionActor = {
	readonly actorId?: string;
	readonly actorKind?: "user" | "agent" | "plugin" | "system";
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

const pickId = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
	for (const key of keys) {
		const value = toIdString(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
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

const asTarget = (value: unknown, rootInput?: Record<string, unknown>): OutboundTarget => {
	const root = rootInput ?? asRecord(value);
	const paramsRecord = asRecord(root.params);
	const effectiveRoot = Object.keys(paramsRecord).length > 0 ? { ...paramsRecord, ...root } : root;
	const rawTarget = value ?? effectiveRoot.target;
	if (typeof rawTarget === "string") {
		const colon = parseTargetColon(rawTarget);
		if (colon !== undefined) {
			return {
				channelId: typeof effectiveRoot.channelId === "string" ? effectiveRoot.channelId : "onebot",
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
		}
	}
	if (kind !== "private" && kind !== "group") {
		throw new Error("target.kind must be private or group");
	}
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
				]))
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
				]));
	return {
		channelId:
			typeof record.channelId === "string"
				? record.channelId
				: typeof effectiveRoot.channelId === "string"
					? effectiveRoot.channelId
					: "onebot",
		kind,
		platformConversationId: asString(platformConversationId, "target.platformConversationId"),
	};
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
		const candidate =
			typeof part === "string" ? { text: part, type: "text" } : parseJsonIfString(part);
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
	readonly getAdapter: () => OneBotChannelAdapter | undefined;
	readonly getSettings: () => OneBotPluginConfig;
	readonly logger: PluginLogger;
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
	readonly #getAdapter: () => OneBotChannelAdapter | undefined;
	readonly #getSettings: () => OneBotPluginConfig;
	readonly #logger: PluginLogger;
	readonly #outbound: PluginOutboundApi | undefined;

	constructor(options: OneBotActionFacadeOptions) {
		this.#audit = options.audit;
		this.#getAdapter = options.getAdapter;
		this.#getSettings = options.getSettings;
		this.#logger = createSafeLogger(options.logger);
		this.#outbound = options.outbound;
	}

	async run(
		method: OneBotActionMethod,
		input: unknown,
		actor: OneBotActionActor = {},
	): Promise<OneBotActionResult> {
		const descriptor = DESCRIPTORS[method];
		const data = asRecord(input);
		const targetId = this.#targetId(method, data);
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
		const denial = this.#authorize(descriptor, method, data, actor);
		if (denial !== undefined) {
			await this.#recordDenied(action, descriptor, actor, targetId, denial);
			this.#logCompletion(action, method, targetId, startedAtMs, denial);
			return { ok: false, reason: denial };
		}
		try {
			const result = await this.#execute(adapter, method, data);
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

	#authorize(
		descriptor: ActionDescriptor,
		method: OneBotActionMethod,
		input: Record<string, unknown>,
		actor: OneBotActionActor,
	): string | undefined {
		const adapter = this.#getAdapter();
		if (adapter === undefined) return "channel-unavailable";
		if (!adapter.capabilities().includes(descriptor.capability)) {
			return `capability-missing:${descriptor.capability}`;
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

	#targetId(method: OneBotActionMethod, input: Record<string, unknown>): string | undefined {
		if (method === "rawAction") return toIdString(input.action);
		if (
			method === "send" ||
			method === "sendForward" ||
			method === "readHistory" ||
			method === "setTyping"
		) {
			try {
				return asTarget(input.target, input).platformConversationId;
			} catch {
				const target = asRecord(input.target);
				return pickId(target, [
					"platformConversationId",
					"id",
					"targetId",
					"target_id",
					"userId",
					"user_id",
					"groupId",
					"group_id",
				]);
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
				return asTarget(input.target, input).platformConversationId;
			} catch {
				return undefined;
			}
		}
		return pickId(input, [
			"groupId",
			"group_id",
			"userId",
			"user_id",
			"messageId",
			"message_id",
			"platformMessageId",
			"fileId",
			"file_id",
		]);
	}

	async #execute(
		adapter: OneBotChannelAdapter,
		method: OneBotActionMethod,
		input: Record<string, unknown>,
	): Promise<unknown> {
		const channel = adapter.channel;
		if (channel === undefined) throw new Error("channel-unavailable");
		switch (method) {
			case "send": {
				const target = asTarget(input.target, input);
				const parts = asParts(input.parts, input);
				const reply = toIdString(
					input.replyToPlatformMessageId ?? input.reply_to_message_id ?? input.replyToMessageId,
				);
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
				const target = asTarget(input.target, input);
				const parts = asParts(input.parts, input);
				const result = await channel.sendForward(target, parts);
				await this.#recordInteraction(target, "forward", parts);
				return result;
			}
			case "lookupMessage":
				return channel.lookupMessage(
					asString(
						pickId(input, ["platformMessageId", "messageId", "message_id", "id"]),
						"platformMessageId",
					),
				);
			case "readHistory": {
				const limitRaw = input.limit ?? input.count;
				const limit = limitRaw === undefined ? undefined : asNumber(limitRaw, "limit");
				const sinceMs =
					input.sinceMs === undefined ? undefined : asNumber(input.sinceMs, "sinceMs");
				return channel.readHistory(asTarget(input.target, input), {
					...(limit === undefined ? {} : { limit }),
					...(sinceMs === undefined ? {} : { sinceMs }),
				});
			}
			case "poke": {
				const target = asTarget(input.target, input);
				const targetRecord = asRecord(input.target);
				const colon = typeof input.target === "string" ? parseTargetColon(input.target) : undefined;
				const userId =
					pickId(input, ["userId", "user_id", "qq"]) ??
					pickId(targetRecord, ["userId", "user_id", "qq"]) ??
					colon?.userId ??
					(target.kind === "private"
						? target.platformConversationId
						: (pickId(input, ["targetId", "target_id", "id"]) ??
							pickId(targetRecord, ["targetId", "target_id", "id"])));
				const poked = asString(userId, "userId");
				const result = await channel.poke(target, poked);
				await this.#recordInteraction(target, "poke", undefined, poked);
				return result;
			}
			case "react":
				return channel.react(
					asString(pickId(input, ["messageId", "message_id", "platformMessageId"]), "messageId"),
					asString(pickId(input, ["emojiId", "emoji_id", "emoji"]), "emojiId"),
					asBoolean(input.set, true),
				);
			case "setTyping":
				return channel.setTyping(asTarget(input.target, input), asBoolean(input.typing, true));
			case "deleteMessage":
				return channel.deleteMessage(
					asString(pickId(input, ["messageId", "message_id", "platformMessageId"]), "messageId"),
				);
			case "markRead":
				return channel.markRead(
					asString(pickId(input, ["messageId", "message_id", "platformMessageId"]), "messageId"),
				);
			case "listGroupFiles":
				return channel.listGroupFiles(asString(pickId(input, ["groupId", "group_id"]), "groupId"));
			case "fetchGroupFile":
				return channel.fetchGroupFile(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["fileId", "file_id"]), "fileId"),
					input.busid === undefined ? undefined : asNumber(input.busid, "busid"),
				);
			case "uploadGroupFile":
				return channel.uploadGroupFile(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(input.file, "file"),
					asString(input.name, "name"),
					asStringOptional(input.folder),
				);
			case "deleteGroupFile":
				return channel.deleteGroupFile(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["fileId", "file_id"]), "fileId"),
					input.busid === undefined ? undefined : asNumber(input.busid, "busid"),
				);
			case "groupBan":
				return channel.groupBan(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asNumber(
						input.durationSeconds ?? input.duration_seconds ?? input.duration,
						"durationSeconds",
					),
				);
			case "groupWholeBan":
				return channel.groupWholeBan(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asBoolean(input.enable, true),
				);
			case "groupKick":
				return channel.groupKick(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asBoolean(input.rejectAddRequest ?? input.reject_add_request),
				);
			case "groupSetAdmin":
				return channel.groupSetAdmin(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asBoolean(input.enable, true),
				);
			case "groupSetCard":
				return channel.groupSetCard(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(pickId(input, ["userId", "user_id", "qq"]), "userId"),
					asString(input.card, "card"),
				);
			case "groupSetName":
				return channel.groupSetName(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asString(input.groupName ?? input.group_name ?? input.name, "groupName"),
				);
			case "groupLeave":
				return channel.groupLeave(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
					asBoolean(input.dismiss ?? input.is_dismiss),
				);
			case "groupSetSpecialTitle":
				return channel.groupSetSpecialTitle(
					asString(pickId(input, ["groupId", "group_id"]), "groupId"),
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
	groupBan: ["channel.manage"],
	groupKick: ["channel.manage"],
	groupLeave: ["channel.manage"],
	groupSetAdmin: ["channel.manage"],
	groupSetCard: ["channel.manage"],
	groupSetName: ["channel.manage"],
	groupSetSpecialTitle: ["channel.manage"],
	groupWholeBan: ["channel.manage"],
	listGroupFiles: ["channel.manage", "conversation.read"],
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
};
