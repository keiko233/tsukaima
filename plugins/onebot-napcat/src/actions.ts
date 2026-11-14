import { messagePartSchema, type MessagePart } from "@elaina/contracts";
import type {
	AuditEntry,
	ChannelCapability,
	OutboundTarget,
	PluginAuditApi,
	PluginLogger,
} from "@elaina/sdk";
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

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const asString = (value: unknown, label: string): string => {
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${label} is required`);
};

const asNumber = (value: unknown, label: string): number => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error(`${label} must be a number`);
};

const asBoolean = (value: unknown, fallback = false): boolean =>
	typeof value === "boolean" ? value : fallback;

const asTarget = (value: unknown): OutboundTarget => {
	const record = asRecord(value);
	const kind = record.kind;
	if (kind !== "private" && kind !== "group")
		throw new Error("target.kind must be private or group");
	return {
		channelId: typeof record.channelId === "string" ? record.channelId : "onebot",
		kind,
		platformConversationId: asString(
			record.platformConversationId,
			"target.platformConversationId",
		),
	};
};

const asParts = (value: unknown): MessagePart[] => {
	if (!Array.isArray(value)) throw new Error("parts must be an array");
	return value.map((part, index) => {
		const parsed = messagePartSchema.safeParse(part);
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

	constructor(options: OneBotActionFacadeOptions) {
		this.#audit = options.audit;
		this.#getAdapter = options.getAdapter;
		this.#getSettings = options.getSettings;
		this.#logger = createSafeLogger(options.logger);
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
		const target = asRecord(input.target);
		if (method === "rawAction") return typeof input.action === "string" ? input.action : undefined;
		if (method === "send" || method === "sendForward" || method === "readHistory") {
			return typeof target.platformConversationId === "string"
				? target.platformConversationId
				: undefined;
		}
		return (
			(typeof input.groupId === "string" ? input.groupId : undefined) ??
			(typeof input.userId === "string" ? input.userId : undefined) ??
			(typeof input.messageId === "string" ? input.messageId : undefined) ??
			(typeof input.platformMessageId === "string" ? input.platformMessageId : undefined) ??
			(typeof input.fileId === "string" ? input.fileId : undefined)
		);
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
				const target = asTarget(input.target);
				const parts = asParts(input.parts);
				const reply = asStringOptional(input.replyToPlatformMessageId);
				if (asBoolean(input.forward)) return channel.sendForward(target, parts);
				return adapter.send(
					target,
					parts,
					reply === undefined ? undefined : { replyToPlatformMessageId: reply },
				);
			}
			case "sendForward":
				return channel.sendForward(asTarget(input.target), asParts(input.parts));
			case "lookupMessage":
				return channel.lookupMessage(asString(input.platformMessageId, "platformMessageId"));
			case "readHistory":
				return channel.readHistory(asTarget(input.target), {
					...(typeof input.limit === "number" ? { limit: input.limit } : {}),
					...(typeof input.sinceMs === "number" ? { sinceMs: input.sinceMs } : {}),
				});
			case "poke":
				return channel.poke(asTarget(input.target), asString(input.userId, "userId"));
			case "react":
				return channel.react(
					asString(input.messageId, "messageId"),
					asString(input.emojiId, "emojiId"),
					asBoolean(input.set, true),
				);
			case "setTyping":
				return channel.setTyping(asTarget(input.target), asBoolean(input.typing, true));
			case "deleteMessage":
				return channel.deleteMessage(asString(input.messageId, "messageId"));
			case "markRead":
				return channel.markRead(asString(input.messageId, "messageId"));
			case "listGroupFiles":
				return channel.listGroupFiles(asString(input.groupId, "groupId"));
			case "fetchGroupFile":
				return channel.fetchGroupFile(
					asString(input.groupId, "groupId"),
					asString(input.fileId, "fileId"),
					typeof input.busid === "number" ? input.busid : undefined,
				);
			case "uploadGroupFile":
				return channel.uploadGroupFile(
					asString(input.groupId, "groupId"),
					asString(input.file, "file"),
					asString(input.name, "name"),
					asStringOptional(input.folder),
				);
			case "deleteGroupFile":
				return channel.deleteGroupFile(
					asString(input.groupId, "groupId"),
					asString(input.fileId, "fileId"),
					typeof input.busid === "number" ? input.busid : undefined,
				);
			case "groupBan":
				return channel.groupBan(
					asString(input.groupId, "groupId"),
					asString(input.userId, "userId"),
					asNumber(input.durationSeconds, "durationSeconds"),
				);
			case "groupWholeBan":
				return channel.groupWholeBan(asString(input.groupId, "groupId"), asBoolean(input.enable));
			case "groupKick":
				return channel.groupKick(
					asString(input.groupId, "groupId"),
					asString(input.userId, "userId"),
					asBoolean(input.rejectAddRequest),
				);
			case "groupSetAdmin":
				return channel.groupSetAdmin(
					asString(input.groupId, "groupId"),
					asString(input.userId, "userId"),
					asBoolean(input.enable),
				);
			case "groupSetCard":
				return channel.groupSetCard(
					asString(input.groupId, "groupId"),
					asString(input.userId, "userId"),
					asString(input.card, "card"),
				);
			case "groupSetName":
				return channel.groupSetName(
					asString(input.groupId, "groupId"),
					asString(input.groupName, "groupName"),
				);
			case "groupLeave":
				return channel.groupLeave(asString(input.groupId, "groupId"), asBoolean(input.dismiss));
			case "groupSetSpecialTitle":
				return channel.groupSetSpecialTitle(
					asString(input.groupId, "groupId"),
					asString(input.userId, "userId"),
					asString(input.title, "title"),
				);
			case "setAvatar":
				return channel.setAvatar(asString(input.file, "file"));
			case "setProfile":
				return channel.setProfile(asRecord(input.profile));
			case "setLongnick":
				return channel.setLongnick(asString(input.longnick, "longnick"));
			case "setOnlineStatus":
				return channel.setOnlineStatus(
					asNumber(input.status, "status"),
					typeof input.extStatus === "number" ? input.extStatus : undefined,
					typeof input.batteryStatus === "number" ? input.batteryStatus : undefined,
				);
			case "rawAction":
				return channel.rawAction(asString(input.action, "action"), asRecord(input.params));
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
