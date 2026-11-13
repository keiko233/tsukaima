import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { authSchema, authUser, type TsukaimaDatabase } from "@tsukaima/db";
import type { AuditEntry } from "@tsukaima/sdk";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { Logger } from "../logging.ts";

/** Better Auth owns the cookie; the prefix keeps it visibly scoped to Tsukaima. */
export const BETTER_AUTH_COOKIE_PREFIX = "tsukaima";

const DEFAULT_ADMIN_EMAIL = "admin@tsukaima.invalid";
const DATABASE_WAIT_ATTEMPTS = 80;
const DATABASE_WAIT_MS = 250;

export interface AdminCredentialBootstrap {
	readonly email?: string | undefined;
	readonly password?: string | undefined;
	readonly username?: string | undefined;
}

export interface AuthServiceOptions {
	readonly audit?: ((entry: AuditEntry) => Promise<void>) | undefined;
	readonly baseUrl: string;
	readonly credential: AdminCredentialBootstrap;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly logger: Logger;
	readonly secret?: string | undefined;
	readonly secureCookies: boolean;
	readonly trustedOrigins?: readonly string[] | undefined;
	readonly trustedProxies?: readonly string[] | undefined;
}

export interface AdminSession {
	readonly sessionId: string;
	readonly userId: string;
	readonly username: string;
}

export interface AuthStatusResult {
	readonly authenticated: boolean;
	readonly configured: boolean;
	readonly username?: string;
}

interface BetterAuthFactoryOptions {
	readonly baseUrl: string;
	readonly database: TsukaimaDatabase;
	readonly logger: Logger;
	readonly onSessionCreated: (session: {
		readonly id: string;
		readonly userId: string;
	}) => Promise<void>;
	readonly onSessionDeleted: (session: {
		readonly id: string;
		readonly userId: string;
	}) => Promise<void>;
	readonly secret?: string | undefined;
	readonly secureCookies: boolean;
	readonly trustedOrigins: readonly string[];
	readonly trustedProxies: readonly string[];
}

/**
 * Better Auth's built-in memory limiter is shared by module instance, which is undesirable for
 * multiple app instances in tests and processes. This storage is scoped to one Better Auth
 * instance and keeps the required check-and-increment atomic.
 */
function createRateLimitStorage() {
	const entries = new Map<string, { count: number; resetAtMs: number }>();
	return {
		consume: async (
			key: string,
			rule: { readonly max: number; readonly window: number },
		): Promise<{ allowed: boolean; retryAfter: number | null }> => {
			const now = Date.now();
			const existing = entries.get(key);
			if (existing === undefined || existing.resetAtMs <= now) {
				entries.set(key, { count: 1, resetAtMs: now + rule.window * 1_000 });
				return { allowed: true, retryAfter: null };
			}
			if (existing.count >= rule.max) {
				return {
					allowed: false,
					retryAfter: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1_000)),
				};
			}
			existing.count += 1;
			return { allowed: true, retryAfter: null };
		},
	};
}

function createBetterAuth(options: BetterAuthFactoryOptions) {
	return betterAuth({
		advanced: {
			cookiePrefix: BETTER_AUTH_COOKIE_PREFIX,
			ipAddress: {
				// Direct connections use the loopback address injected by AuthService.handle().
				// A reverse proxy must be explicitly listed in TSUKAIMA_TRUSTED_PROXIES before its
				// X-Forwarded-For chain is trusted.
				ipAddressHeaders:
					options.trustedProxies.length > 0
						? ["x-forwarded-for", "x-tsukaima-client-ip"]
						: ["x-tsukaima-client-ip"],
				...(options.trustedProxies.length === 0
					? {}
					: { trustedProxies: [...options.trustedProxies] }),
			},
			useSecureCookies: options.secureCookies,
		},
		appName: "Tsukaima",
		baseURL: options.baseUrl,
		database: drizzleAdapter(options.database, {
			provider: "sqlite",
			schema: authSchema,
		}),
		databaseHooks: {
			session: {
				create: { after: options.onSessionCreated },
				delete: { after: options.onSessionDeleted },
			},
			user: {
				create: {
					before: async () => {
						const [existing] = await options.database
							.select({ id: authUser.id })
							.from(authUser)
							.limit(1);
						return existing === undefined;
					},
				},
			},
		},
		emailAndPassword: {
			autoSignIn: false,
			enabled: true,
			// Kept enabled for the in-process bootstrap call. The HTTP handler above rejects all
			// public sign-up paths, and the user-create hook enforces the single-admin invariant.
			disableSignUp: false,
			maxPasswordLength: 128,
			minPasswordLength: 8,
		},
		logger: {
			disableColors: true,
			level: "warn",
			log: (level, message) => options.logger[level](`better-auth: ${message}`),
		},
		plugins: [username()],
		rateLimit: {
			customStorage: createRateLimitStorage(),
			customRules: {
				"/sign-in/username": { max: 5, window: 60 },
				"/sign-up/email": false,
			},
			enabled: true,
			max: 100,
			window: 60,
		},
		...(options.secret === undefined ? {} : { secret: options.secret }),
		session: {
			expiresIn: 7 * 24 * 60 * 60,
			updateAge: 24 * 60 * 60,
		},
		trustedOrigins: [...new Set([options.baseUrl, ...options.trustedOrigins])],
	});
}

type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function authUnavailable(message: string): Response {
	return new Response(JSON.stringify({ code: "SERVICE_UNAVAILABLE", message }), {
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
		},
		status: 503,
	});
}

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

/**
 * Adds the socket peer address for direct requests. The header is host-controlled, so a client
 * cannot use it to choose a rate-limit bucket. When a configured reverse proxy supplies
 * X-Forwarded-For, Better Auth strips that chain from the trusted proxy outward.
 */
function withClientAddress(request: Request, clientAddress: string | undefined): Request {
	if (clientAddress === undefined) return request;
	const headers = new Headers(request.headers);
	headers.set("x-tsukaima-client-ip", clientAddress);
	return new Request(request, { headers });
}

/**
 * Facade over Better Auth.
 *
 * Better Auth owns password hashing, credential and session rows, cookie signing, session
 * refresh, and sign-in rate limiting. Tsukaima only owns the single-admin bootstrap policy and the
 * oRPC/SSE guard seam. Public sign-up is never exposed: the first administrator is created through
 * the server-side Better Auth API, then `handle()` rejects every external sign-up request.
 */
export class AuthService {
	readonly #audit: ((entry: AuditEntry) => Promise<void>) | undefined;
	readonly #baseUrl: string;
	readonly #credential: AdminCredentialBootstrap;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #logger: Logger;
	readonly #secret: string | undefined;
	readonly #secureCookies: boolean;
	readonly #trustedOrigins: readonly string[];
	readonly #trustedProxies: readonly string[];
	#auth: BetterAuthInstance | undefined;
	#initialization: Promise<BetterAuthInstance> | undefined;
	#started = false;
	#stopped = false;

	constructor(options: AuthServiceOptions) {
		this.#audit = options.audit;
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#credential = options.credential;
		this.#database = options.database;
		this.#logger = options.logger;
		this.#secret = options.secret;
		this.#secureCookies = options.secureCookies;
		this.#trustedOrigins = (options.trustedOrigins ?? []).map((origin) =>
			origin.replace(/\/+$/, ""),
		);
		this.#trustedProxies = options.trustedProxies ?? [];
	}

	/** Starts the first-admin bootstrap in the background. Idempotent. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		void this.ensureInitialized().catch((error: unknown) => {
			if (this.#stopped) return;
			this.#logger.warn("admin authentication initialization failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/** Stops pending startup work. Better Auth itself holds no polling resources. */
	stop(): void {
		this.#stopped = true;
	}

	async ensureInitialized(): Promise<void> {
		await this.#ensureAuth();
	}

	/**
	 * Handles Better Auth's native HTTP routes. Public sign-up is disabled even though the
	 * server-side `signUpEmail` API remains available for the one-time bootstrap.
	 */
	async handle(request: Request, clientAddress?: string): Promise<Response> {
		const database = this.#database();
		if (database === undefined) return authUnavailable("Authentication is not ready");

		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/auth/sign-up")) return notFound();

		const auth = await this.#ensureAuth();
		const forwarded = withClientAddress(request, clientAddress);
		let response: Response;
		try {
			response = await auth.handler(forwarded);
		} catch (error) {
			this.#logger.error("Better Auth request failed", {
				error: error instanceof Error ? error.message : String(error),
				method: request.method,
				path: url.pathname,
			});
			return authUnavailable("Authentication request failed");
		}

		if (
			response.status >= 400 &&
			url.pathname.endsWith("/sign-in/username") &&
			response.status !== 429
		) {
			await this.#recordAudit({
				action: "admin.sign-in-denied",
				actorId: "admin:unknown",
				payload: { path: url.pathname },
				result: "denied",
				targetKind: "admin",
			});
		}
		return response;
	}

	/** Resolves the Better Auth database session carried by the request cookies. */
	async getSession(headers: Headers): Promise<AdminSession | undefined> {
		if (this.#database() === undefined) return undefined;
		try {
			const auth = await this.#ensureAuth();
			const result = await auth.api.getSession({ headers });
			if (result === null) return undefined;
			return {
				sessionId: result.session.id,
				userId: result.user.id,
				username: result.user.username ?? result.user.name,
			};
		} catch (error) {
			if (!this.#stopped) {
				this.#logger.warn("session lookup failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}

	async status(headers: Headers): Promise<AuthStatusResult> {
		const database = this.#database();
		if (database === undefined) return { authenticated: false, configured: false };
		const session = await this.getSession(headers);
		const [administrator] = await database.select({ id: authUser.id }).from(authUser).limit(1);
		return {
			authenticated: session !== undefined,
			configured: administrator !== undefined,
			...(session === undefined ? {} : { username: session.username }),
		};
	}

	async #ensureAuth(): Promise<BetterAuthInstance> {
		if (this.#auth !== undefined) return this.#auth;
		if (this.#initialization !== undefined) return this.#initialization;
		const initialization = this.#initialize().catch((error: unknown) => {
			this.#initialization = undefined;
			throw error;
		});
		this.#initialization = initialization;
		return initialization;
	}

	async #initialize(): Promise<BetterAuthInstance> {
		const database = await this.#waitForDatabase();
		if (this.#stopped) throw new Error("Authentication service stopped");
		const auth = createBetterAuth({
			baseUrl: this.#baseUrl,
			database,
			logger: this.#logger,
			onSessionCreated: async (session) => {
				const actorUsername = await this.#usernameFor(session.userId);
				await this.#recordAudit({
					action: "admin.sign-in",
					actorId: `admin:${actorUsername}`,
					payload: { sessionId: session.id },
					result: "ok",
					targetId: session.id,
					targetKind: "admin",
				});
			},
			onSessionDeleted: async (session) => {
				const actorUsername = await this.#usernameFor(session.userId);
				await this.#recordAudit({
					action: "admin.sign-out",
					actorId: `admin:${actorUsername}`,
					payload: { sessionId: session.id },
					result: "ok",
					targetId: session.id,
					targetKind: "admin",
				});
			},
			secret: this.#secret,
			secureCookies: this.#secureCookies,
			trustedOrigins: this.#trustedOrigins,
			trustedProxies: this.#trustedProxies,
		});

		this.#auth = auth;
		if (this.#stopped) {
			this.#auth = undefined;
			throw new Error("Authentication service stopped");
		}
		await this.#bootstrapAdministrator(auth, database);
		return auth;
	}

	async #waitForDatabase(): Promise<TsukaimaDatabase> {
		for (let attempt = 0; attempt < DATABASE_WAIT_ATTEMPTS; attempt += 1) {
			if (this.#stopped) throw new Error("Authentication service stopped");
			const database = this.#database();
			if (database !== undefined) return database;
			await sleep(DATABASE_WAIT_MS);
		}
		throw new Error("Domain database was not ready for Better Auth");
	}

	async #bootstrapAdministrator(auth: BetterAuthInstance, database: TsukaimaDatabase): Promise<void> {
		const [existing] = await database
			.select({ id: authUser.id, username: authUser.username })
			.from(authUser)
			.limit(1);
		if (existing !== undefined) {
			this.#logger.info("stored administrator loaded", {
				username: existing.username ?? existing.id,
			});
			return;
		}

		const usernameValue = this.#credential.username?.trim();
		const password = this.#credential.password;
		if (usernameValue === undefined || password === undefined) {
			const missing = [
				...(usernameValue === undefined ? ["TSUKAIMA_ADMIN_USERNAME"] : []),
				...(password === undefined ? ["TSUKAIMA_ADMIN_PASSWORD"] : []),
			];
			this.#logger.warn(
				"admin credentials are not configured; WebUI sign-in and the admin API stay locked",
				{ missing },
			);
			return;
		}

		try {
			await auth.api.signUpEmail({
				body: {
					email: this.#credential.email ?? DEFAULT_ADMIN_EMAIL,
					name: usernameValue,
					password,
					displayUsername: usernameValue,
					username: usernameValue,
				},
			});
			this.#logger.info("administrator initialized from environment", {
				username: usernameValue,
			});
		} catch (error) {
			const [created] = await database.select({ id: authUser.id }).from(authUser).limit(1);
			if (created !== undefined) {
				this.#logger.info("administrator already initialized", { username: usernameValue });
				return;
			}
			this.#logger.error("administrator bootstrap failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #usernameFor(userId: string): Promise<string> {
		const database = this.#database();
		if (database === undefined) return userId;
		try {
			const [user] = await database
				.select({ name: authUser.name, username: authUser.username })
				.from(authUser)
				.where(eq(authUser.id, userId))
				.limit(1);
			return user?.username ?? user?.name ?? userId;
		} catch {
			return userId;
		}
	}

	async #recordAudit(entry: AuditEntry): Promise<void> {
		if (this.#audit === undefined) return;
		try {
			await this.#audit(entry);
		} catch (error) {
			this.#logger.warn("authentication audit write failed", {
				action: entry.action,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
