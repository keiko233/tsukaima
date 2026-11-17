import type { ConversationRouter } from "./conversation-router.ts";

export interface MentionIdentityStoreInput {
	readonly displayName: string;
	readonly externalId: string;
	readonly isBot?: boolean | undefined;
	readonly platform: string;
	readonly platformAccountId: string;
}

/** Host binding used by a channel to persist names it resolved for unknown mention ids. */
export interface MentionIdentityStore {
	remember(input: MentionIdentityStoreInput): Promise<void>;
}

/**
 * Persist a channel-resolved mention name through the same serialized identity upsert as
 * inbound senders, so later reads need no platform call and cannot race a duplicate identity.
 */
export function createMentionIdentityStore(
	router: () => ConversationRouter | undefined,
): MentionIdentityStore {
	return {
		async remember(input) {
			const conversationRouter = router();
			if (conversationRouter === undefined) return;
			await conversationRouter.rememberIdentity({
				displayName: input.displayName,
				externalId: input.externalId,
				kind: input.isBot === true ? "bot" : "human",
				platform: input.platform,
				platformAccountId: input.platformAccountId,
			});
		},
	};
}
