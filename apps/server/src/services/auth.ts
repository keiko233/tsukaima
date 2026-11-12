import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { adminCredentials, type ElainaDatabase } from "@elaina/db";
import type { Logger } from "../logging.ts";

/** Cookie carrying the admin session token. */
export const ADMIN_SESSION_COOKIE = "elaina_admin_session";

/**
 * Admin sessions live in memory only. A restart invalidates every WebUI session and the admin
 * signs in again; that keeps tokens off disk and is the right trade for a single-admin LAN
 * deployment. Tokens are never revived from cookies after a restart.
 */
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const BOOTSTRAP_RETRY_MS = 250;
const BOOTSTRAP_MAX_ATTEMPTS = 80;
const MAX_SESSIONS = 16;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 1_000;
const LOCKOUT_MAX_MS = 60_000;

export interface AdminSession {
	readonly username: string;
}

export type AdminLoginResult =
	| {
			readonly expiresAtMs: number;
			readonly ok: true;
			readonly token: string;
			readonly username: string;
	  }
	| { readonly ok: false; readonly reason: "invalid" | "unconfigured" }
	| { readonly ok: false; readonly reason: "locked"; readonly retryAfterMs: number };

/** First-start credential source. Only consulted while the database has no stored credential. */
export interface AdminCredentialBootstrap {
	readonly password?: string | undefined;
	readonly username?: string | undefined;
}

export interface AuthServiceOptions {
	readonly credential: AdminCredentialBootstrap;
	readonly database: () => ElainaDatabase | undefined;
	readonly logger: Logger;
}

interface StoredSession {
	readonly expiresAtMs: number;
	readonly tokenHash: Buffer;
	readonly username: string;
}

interface AdminCredential {
	readonly passwordHash: string;
	readonly username: string;
}

function sha256(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/**
 * Hashing both sides before `timingSafeEqual` keeps the comparison valid for values of different
 * lengths (which would otherwise throw) and avoids leaking length through early exits.
 */
function constantTimeEquals(left: string, right: string): boolean {
	return timingSafeEqual(sha256(left), sha256(right));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Admin authentication for the WebUI and the whole `admin/*` RPC surface.
 *
 * Credential bootstrap semantics: the database row is authoritative. Environment variables are
 * only read while the row is missing, so rotating `ELAINA_ADMIN_PASSWORD` later does NOT change
 * the stored password. When neither the database nor the environment provides a credential, the
 * service stays locked — there is intentionally no "unconfigured means allow" fallback.
 */
export class AuthService {
	readonly #credential: AdminCredentialBootstrap;
	readonly #database: () => ElainaDatabase | undefined;
	readonly #logger: Logger;
	readonly #sessions = new Map<string, StoredSession>();
	#bootstrapStarted = false;
	#current: AdminCredential | undefined;
	#stopped = false;
	#failures = 0;
	#initializePromise: Promise<void> | undefined;
	#lockedUntilMs = 0;

	constructor(options: AuthServiceOptions) {
		this.#credential = options.credential;
		this.#database = options.database;
		this.#logger = options.logger;
	}

	get sessionTtlSeconds(): number {
		return ADMIN_SESSION_TTL_MS / 1_000;
	}

	/**
	 * Kicks off the credential bootstrap in the background so the one-time "which env vars are
	 * missing" guidance lands in the startup log. The domain database only opens later in the
	 * lifecycle, so the bootstrap waits for it briefly.
	 */
	start(): void {
		if (this.#bootstrapStarted) return;
		this.#bootstrapStarted = true;
		void this.#bootstrap();
	}

	/**
	 * Cancel the pending credential bootstrap and drop every session. Idempotent, and called on
	 * shutdown before the domain database closes, so the bootstrap cannot race a closed handle.
	 */
	stop(): void {
		this.#stopped = true;
		this.#sessions.clear();
		this.#current = undefined;
	}

	async ensureInitialized(): Promise<void> {
		if (this.#initializePromise !== undefined) return this.#initializePromise;
		const database = this.#database();
		if (database === undefined) return;
		const promise = this.#loadCredential(database).catch((error: unknown) => {
			this.#initializePromise = undefined;
			throw error;
		});
		this.#initializePromise = promise;
		await promise;
	}

	async login(username: string, password: string): Promise<AdminLoginResult> {
		await this.ensureInitialized();
		const now = Date.now();
		if (this.#lockedUntilMs > now) {
			return { ok: false, reason: "locked", retryAfterMs: this.#lockedUntilMs - now };
		}
		const credential = this.#current;
		if (credential === undefined) return { ok: false, reason: "unconfigured" };

		const passwordOk = await this.#verifyPassword(password, credential.passwordHash);
		const usernameOk = constantTimeEquals(username, credential.username);
		if (!passwordOk || !usernameOk) {
			this.#failures += 1;
			if (this.#failures >= LOCKOUT_THRESHOLD) {
				const retryAfterMs = Math.min(
					LOCKOUT_BASE_MS * 2 ** (this.#failures - LOCKOUT_THRESHOLD),
					LOCKOUT_MAX_MS,
				);
				this.#lockedUntilMs = now + retryAfterMs;
				this.#logger.warn("admin sign-in locked after repeated failures", {
					failures: this.#failures,
					retryAfterMs,
				});
			}
			return { ok: false, reason: "invalid" };
		}

		this.#failures = 0;
		this.#lockedUntilMs = 0;
		const token = this.#issueSession(credential.username);
		this.#logger.info("admin signed in", { username: credential.username });
		return {
			expiresAtMs: Date.now() + ADMIN_SESSION_TTL_MS,
			ok: true,
			token,
			username: credential.username,
		};
	}

	logout(token: string | undefined): void {
		if (token === undefined) return;
		const digest = sha256(token);
		for (const [id, session] of this.#sessions) {
			if (timingSafeEqual(session.tokenHash, digest)) this.#sessions.delete(id);
		}
	}

	resolveSession(token: string | undefined): AdminSession | undefined {
		if (token === undefined || token.length === 0) return undefined;
		const digest = sha256(token);
		let matchedId: string | undefined;
		let matched: StoredSession | undefined;
		for (const [id, session] of this.#sessions) {
			if (timingSafeEqual(session.tokenHash, digest)) {
				matched = session;
				matchedId = id;
			}
		}
		if (matched === undefined || matchedId === undefined) return undefined;
		if (matched.expiresAtMs <= Date.now()) {
			this.#sessions.delete(matchedId);
			return undefined;
		}
		return { username: matched.username };
	}

	async status(
		token: string | undefined,
	): Promise<{ authenticated: boolean; configured: boolean; username?: string }> {
		await this.ensureInitialized();
		const session = this.resolveSession(token);
		return {
			authenticated: session !== undefined,
			configured: this.#current !== undefined,
			...(session === undefined ? {} : { username: session.username }),
		};
	}

	async #bootstrap(): Promise<void> {
		for (let attempt = 0; attempt < BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
			if (this.#stopped) return;
			if (this.#database() !== undefined) {
				try {
					await this.ensureInitialized();
				} catch (error) {
					if (this.#stopped) return;
					this.#logger.warn("admin credential bootstrap failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			await sleep(BOOTSTRAP_RETRY_MS);
		}
		if (this.#stopped) return;
		this.#logger.warn("admin credential bootstrap skipped: domain database not ready", {
			attempts: BOOTSTRAP_MAX_ATTEMPTS,
		});
	}

	#issueSession(username: string): string {
		const now = Date.now();
		for (const [id, session] of this.#sessions) {
			if (session.expiresAtMs <= now) this.#sessions.delete(id);
		}
		while (this.#sessions.size >= MAX_SESSIONS) {
			const oldest = this.#sessions.keys().next();
			if (oldest.done === true) break;
			this.#sessions.delete(oldest.value);
		}
		const token = randomBytes(32).toString("base64url");
		this.#sessions.set(randomUUID(), {
			expiresAtMs: now + ADMIN_SESSION_TTL_MS,
			tokenHash: sha256(token),
			username,
		});
		return token;
	}

	async #loadCredential(database: ElainaDatabase): Promise<void> {
		const [existing] = await database.select().from(adminCredentials).limit(1);
		if (existing !== undefined) {
			this.#current = { passwordHash: existing.passwordHash, username: existing.username };
			this.#logger.info("stored admin credential loaded", { username: existing.username });
			return;
		}

		const username = this.#credential.username;
		const password = this.#credential.password;
		if (username === undefined || password === undefined) {
			const missing = [
				...(username === undefined ? ["ELAINA_ADMIN_USERNAME"] : []),
				...(password === undefined ? ["ELAINA_ADMIN_PASSWORD"] : []),
			];
			this.#logger.warn(
				"admin credentials are not configured; WebUI sign-in and the admin API stay locked",
				{ missing },
			);
			return;
		}

		const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
		await database
			.insert(adminCredentials)
			.values({ id: "admin", passwordHash, username })
			.onConflictDoNothing();
		this.#current = { passwordHash, username };
		this.#logger.info("admin credential initialized from environment", { username });
	}

	async #verifyPassword(password: string, hash: string): Promise<boolean> {
		try {
			return await Bun.password.verify(password, hash);
		} catch (error) {
			this.#logger.error("admin password verification failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}
}

/** Extracts the session token from a raw `Cookie` header. */
export function readSessionToken(cookieHeader: string | null | undefined): string | undefined {
	if (cookieHeader === null || cookieHeader === undefined) return undefined;
	for (const part of cookieHeader.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
		const value = part.slice(separator + 1).trim();
		return value.length === 0 ? undefined : value;
	}
	return undefined;
}

/** `Secure` is intentionally omitted: the LAN deployment runs plain HTTP. Add it behind TLS. */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
	return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
	return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
