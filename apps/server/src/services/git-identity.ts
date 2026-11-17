import { eq } from "drizzle-orm";
import { meta, type TsukaimaDatabase } from "@tsukaima/db";
import { z } from "zod";

/**
 * The identity the server uses when it creates commits or merge commits.
 *
 * It lives in the domain database rather than `.git/config`: the checkout may be replaced by a
 * deploy, and a container has no global git identity. Servers merge with this identity, governed
 * worktrees receive it as `GIT_*` variables, and the operator can change it from Settings.
 */

export interface GitIdentity {
	readonly email: string;
	readonly name: string;
}

export const DEFAULT_GIT_IDENTITY: GitIdentity = {
	email: "tsukaima-upgrade@localhost",
	name: "tsukaima-upgrade",
};

const IDENTITY_KEY = "git-identity";

const identitySchema = z.object({
	email: z
		.string()
		.regex(/^[\w.+-]+@[\w.-]+$/u)
		.max(254),
	name: z.string().min(1).max(120),
});

export async function readGitIdentity(
	database: TsukaimaDatabase | undefined,
): Promise<GitIdentity> {
	if (database === undefined) return DEFAULT_GIT_IDENTITY;
	const rows = await database.select().from(meta).where(eq(meta.key, IDENTITY_KEY)).limit(1);
	const raw = rows[0]?.value;
	if (raw === undefined) return DEFAULT_GIT_IDENTITY;
	try {
		const parsed = identitySchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : DEFAULT_GIT_IDENTITY;
	} catch {
		return DEFAULT_GIT_IDENTITY;
	}
}

export async function writeGitIdentity(
	database: TsukaimaDatabase,
	input: GitIdentity,
): Promise<GitIdentity> {
	const identity = identitySchema.parse(input);
	const value = JSON.stringify(identity);
	await database
		.insert(meta)
		.values({ key: IDENTITY_KEY, value })
		.onConflictDoUpdate({ target: meta.key, set: { value } });
	return identity;
}

/** `git -c` arguments for a commit or merge the server owns. */
export function gitIdentityArgs(identity: GitIdentity): readonly string[] {
	return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

/** Environment form for commands inside a governed worktree, where `-c` is unavailable. */
export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
	return {
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_AUTHOR_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
	};
}
