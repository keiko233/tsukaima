import { and, desc, eq, or, sql } from "drizzle-orm";
import {
	chatObjects,
	conversations as conversationsTable,
	messages as messagesTable,
	type TsukaimaDatabase,
} from "@tsukaima/db";
import type { PluginSettingsStore } from "./plugin-settings.ts";

export interface ImCallerContextOverrides {
	readonly channelId?: string | undefined;
	readonly chatKind?: string | undefined;
	readonly isAdmin?: boolean | undefined;
	readonly platformConversationId?: string | undefined;
	readonly role?: string | undefined;
	readonly senderPlatformId?: string | undefined;
	/**
	 * Host-bound sender of the active turn. When present it is authoritative: the resolver
	 * never falls back to "latest ambient inbound message", which a group member could change
	 * between turn admission and tool execution. `null` means the turn has no human sender
	 * (for example a proactive background turn) and admin status must fail closed.
	 */
	readonly turnBoundSender?: string | null | undefined;
	readonly userId?: string | undefined;
}

export interface ResolvedImCallerContext {
	readonly channelId?: string;
	readonly chatKind?: string;
	readonly domainConversationId?: string;
	readonly isAdmin?: boolean;
	readonly platformConversationId?: string;
	readonly role?: string;
	readonly senderPlatformId?: string;
	readonly userId?: string;
}

export interface ResolveImCallerContextInput {
	readonly conversationId: string | undefined;
	readonly database: TsukaimaDatabase | undefined;
	readonly overrides?: ImCallerContextOverrides;
	readonly settings: PluginSettingsStore;
}

/**
 * Shared fail-closed caller and trusted-admin resolver used by both `PluginHost` and
 * `workspace-tools` so IM authorization never drifts between plugin tools and host tools.
 *
 * The caller identity comes from the latest persisted inbound message (rowid is the final
 * tiebreaker for same-millisecond turns), never from a client-supplied override. A missing row,
 * unreadable settings, or malformed admin list leaves `isAdmin` undefined so callers fail closed.
 */
export async function resolveImCallerContext(
	input: ResolveImCallerContextInput,
): Promise<ResolvedImCallerContext> {
	const overrides = input.overrides ?? {};
	const conversation = input.conversationId;
	let resolvedChannelId =
		overrides.channelId ??
		(conversation !== undefined && conversation.includes(":")
			? (conversation.split(":")[0] ?? "")
			: undefined);
	let resolvedDomainConversationId: string | undefined;
	let resolvedPlatformConversationId = overrides.platformConversationId;
	let resolvedChatKind = overrides.chatKind;
	let resolvedSenderPlatformId = overrides.senderPlatformId;
	let resolvedUserId = overrides.userId;
	const turnBoundSender = overrides.turnBoundSender;
	const senderIsTurnBound = turnBoundSender !== undefined;
	if (senderIsTurnBound) {
		resolvedSenderPlatformId = turnBoundSender ?? undefined;
		resolvedUserId = turnBoundSender ?? undefined;
	}
	let resolvedIsAdmin = overrides.isAdmin;
	let resolvedRole = overrides.role;

	const database = input.database;
	if (conversation !== undefined && database !== undefined) {
		try {
			const [row] = await database
				.select({ chat: chatObjects, conversation: conversationsTable })
				.from(conversationsTable)
				.leftJoin(chatObjects, eq(chatObjects.id, conversationsTable.chatObjectId))
				.where(
					or(
						eq(conversationsTable.durableConversationId, conversation),
						eq(conversationsTable.id, conversation),
					),
				)
				.limit(1);
			if (row !== undefined) {
				resolvedDomainConversationId = row.conversation.id;
				resolvedChannelId = row.conversation.channelId ?? row.chat?.channelId ?? resolvedChannelId;
				resolvedChatKind = resolvedChatKind ?? row.chat?.kind ?? row.conversation.kind;
				resolvedPlatformConversationId =
					resolvedPlatformConversationId ??
					row.conversation.platformConversationId ??
					row.chat?.platformConversationId ??
					undefined;
				if (resolvedUserId === undefined || resolvedSenderPlatformId === undefined) {
					if (row.conversation.kind === "private") {
						const privatePeerId =
							row.conversation.platformConversationId ??
							row.chat?.platformConversationId ??
							undefined;
						resolvedUserId = resolvedUserId ?? privatePeerId;
						resolvedSenderPlatformId = resolvedSenderPlatformId ?? privatePeerId;
					}
					// A group turn with a known (or deliberately absent) turn sender must never fall
					// back to the latest persisted inbound row: that is the TOCTOU an ambient admin
					// message exploits after a non-admin triggered the turn.
					if (
						!senderIsTurnBound &&
						(resolvedUserId === undefined || resolvedSenderPlatformId === undefined)
					) {
						const [latestInbound] = await database
							.select({ senderExternalId: messagesTable.senderExternalId })
							.from(messagesTable)
							.where(
								and(
									eq(messagesTable.conversationId, row.conversation.id),
									eq(messagesTable.direction, "inbound"),
								),
							)
							.orderBy(
								desc(messagesTable.occurredAt),
								desc(messagesTable.ingestedAt),
								desc(sql`${messagesTable}.rowid`),
							)
							.limit(1);
						if (
							typeof latestInbound?.senderExternalId === "string" &&
							latestInbound.senderExternalId.trim().length > 0
						) {
							const trimmedSender = latestInbound.senderExternalId.trim();
							resolvedUserId = resolvedUserId ?? trimmedSender;
							resolvedSenderPlatformId = resolvedSenderPlatformId ?? trimmedSender;
						}
					}
				}
			}
		} catch {}
	}

	// WebUI and workspace are already authenticated administrator surfaces; IM kinds still
	// require an explicit trusted sender below. An explicit `isAdmin: false` override wins.
	if (resolvedChatKind === "webui" || resolvedChatKind === "workspace") {
		if (resolvedIsAdmin === undefined) resolvedIsAdmin = true;
		if (resolvedIsAdmin) resolvedRole = resolvedRole ?? "admin";
	}

	// Trusted-admin membership applies to IM conversations only. `task`, `plugin`, and unknown
	// kinds stay fail-closed even when the bound sender happens to be an IM administrator.
	const adminEligible = resolvedChatKind === "private" || resolvedChatKind === "group";
	if (adminEligible && resolvedIsAdmin === undefined && resolvedUserId !== undefined) {
		try {
			const onebotSettings = await input.settings.read("onebot-napcat");
			const adminUsers = Array.isArray(
				(onebotSettings as { adminUsers?: unknown } | undefined)?.adminUsers,
			)
				? (onebotSettings as { adminUsers: unknown[] }).adminUsers
						.filter((entry): entry is string => typeof entry === "string")
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0)
				: [];
			if (adminUsers.includes(resolvedUserId)) {
				resolvedIsAdmin = true;
				resolvedRole = resolvedRole ?? "admin";
			}
		} catch {}
	}

	return {
		...(resolvedChannelId === undefined || resolvedChannelId.length === 0
			? {}
			: { channelId: resolvedChannelId }),
		...(resolvedChatKind === undefined ? {} : { chatKind: resolvedChatKind }),
		...(resolvedDomainConversationId === undefined
			? {}
			: { domainConversationId: resolvedDomainConversationId }),
		...(resolvedIsAdmin === undefined ? {} : { isAdmin: resolvedIsAdmin }),
		...(resolvedPlatformConversationId === undefined
			? {}
			: { platformConversationId: resolvedPlatformConversationId }),
		...(resolvedRole === undefined ? {} : { role: resolvedRole }),
		...(resolvedSenderPlatformId === undefined
			? {}
			: { senderPlatformId: resolvedSenderPlatformId }),
		...(resolvedUserId === undefined ? {} : { userId: resolvedUserId }),
	};
}
