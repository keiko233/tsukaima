import type { PluginLogger } from "@tsukaima/sdk";
import { createSafeLogger } from "../logging.ts";

/**
 * Optional channel-side mention naming.
 *
 * OneBot `at` segments normally carry only the target id. When the target has never spoken in
 * this account there is no local identity to read a name from, so the channel asks NapCat once
 * and persists the answer through `OneBotMentionNameStore`. Everything here is best effort: a
 * missing connection, a refused action, or a timeout leaves the mention as the id.
 */

const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const MAX_FAILURE_CACHE_TTL_MS = 30_000;
const ONEBOT_PLATFORM = "onebot-v11";

export type OneBotMentionNameInput = {
	readonly groupId?: string | undefined;
	readonly userId: string;
};

export type OneBotMentionNameResolver = (
	input: OneBotMentionNameInput,
) => Promise<string | undefined>;

export type OneBotMentionNameStoreInput = {
	readonly displayName: string;
	readonly externalId: string;
	readonly isBot?: boolean | undefined;
	readonly platform: string;
	readonly platformAccountId: string;
};

/** Host-owned persistence for names discovered for platforms ids with no identity row yet. */
export interface OneBotMentionNameStore {
	remember(input: OneBotMentionNameStoreInput): Promise<void> | void;
}

type CacheEntry = {
	readonly expiresAtMs: number;
	readonly name: string | undefined;
};

const nonEmpty = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const nameFrom = (raw: unknown, keys: readonly string[]): string | undefined => {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	for (const key of keys) {
		const name = nonEmpty(record[key]);
		if (name !== undefined) return name;
	}
	return undefined;
};

/** `card` is the group-specific display name; the nickname is the account-wide fallback. */
const groupMemberName = (raw: unknown): string | undefined =>
	nameFrom(raw, ["card", "nickname", "nick"]);

const strangerName = (raw: unknown): string | undefined =>
	nameFrom(raw, ["nickname", "nick", "name"]);

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export interface OneBotMentionNameResolverOptions {
	readonly botAccountId?: string | undefined;
	readonly cacheTtlMs?: number | undefined;
	readonly channelId: string;
	readonly logger?: PluginLogger | undefined;
	readonly now?: (() => number) | undefined;
	readonly readAction: (action: string, params: Record<string, unknown>) => Promise<unknown>;
	readonly store?: OneBotMentionNameStore | undefined;
}

/**
 * Build a TTL-cached resolver backed by NapCat reads.
 *
 * Group cards win over account nicknames because the mention text is rendered inside that group.
 * `get_stranger_info` covers people who share no group with the bot. Both calls go through the
 * existing idempotent `readAction` retry path.
 */
export function createOneBotMentionNameResolver(
	options: OneBotMentionNameResolverOptions,
): OneBotMentionNameResolver {
	const logger = createSafeLogger(options.logger);
	const now = options.now ?? Date.now;
	const cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
	const cache = new Map<string, CacheEntry>();

	return async (input) => {
		const userId = input.userId.trim();
		if (userId.length === 0) return undefined;
		const groupId = input.groupId?.trim();
		const key = groupId === undefined ? `private:${userId}` : `group:${groupId}:${userId}`;
		const nowMs = now();
		const cached = cache.get(key);
		if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.name;

		let name: string | undefined;
		let failed = false;
		if (groupId !== undefined) {
			try {
				const info = await options.readAction("get_group_member_info", {
					group_id: groupId,
					no_cache: false,
					user_id: userId,
				});
				name = groupMemberName(info);
			} catch (error) {
				logger.debug("OneBot group member name lookup failed", {
					error: errorMessage(error),
					groupId,
					userId,
				});
			}
		}
		if (name === undefined) {
			try {
				const info = await options.readAction("get_stranger_info", {
					no_cache: false,
					user_id: userId,
				});
				name = strangerName(info);
			} catch (error) {
				failed = true;
				logger.debug("OneBot stranger name lookup failed", {
					error: errorMessage(error),
					userId,
				});
			}
		}

		const ttlMs =
			name === undefined && failed ? Math.min(cacheTtlMs, MAX_FAILURE_CACHE_TTL_MS) : cacheTtlMs;
		cache.set(key, { expiresAtMs: nowMs + ttlMs, name });
		if (name === undefined) return undefined;

		if (options.store !== undefined) {
			try {
				await options.store.remember({
					displayName: name,
					externalId: userId,
					isBot: options.botAccountId === userId,
					platform: ONEBOT_PLATFORM,
					platformAccountId: options.channelId,
				});
			} catch {
				// Persistence is an optimization for later reads; the resolved name still renders.
			}
		}
		return name;
	};
}
