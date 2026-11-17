import { eq } from "drizzle-orm";
import { meta, type TsukaimaDatabase } from "@tsukaima/db";
import { z } from "zod";
import type { Logger } from "../logging.ts";
import { githubRequest } from "./github-app-service.ts";

/**
 * User login through the GitHub OAuth device flow, the same exchange `gh auth login` performs.
 *
 * The operator sees an eight-character code, enters it at `github.com/login/device`, and the card
 * polls until GitHub issues a user token. That token acts as the operator, so it is treated as a
 * credential: stored outside the repository, never returned by an API, and used only for the
 * duration of one git or REST call.
 */

export type GitHubOAuthErrorCode =
	| "github_oauth_denied"
	| "github_oauth_expired"
	| "github_oauth_not_started"
	| "github_oauth_unavailable";

export class GitHubOAuthError extends Error {
	readonly code: GitHubOAuthErrorCode;

	constructor(code: GitHubOAuthErrorCode, message: string) {
		super(message);
		this.name = "GitHubOAuthError";
		this.code = code;
	}
}

export interface GitHubOAuthStatus {
	readonly clientId: string | null;
	readonly configured: boolean;
	readonly login: string | null;
	readonly scopes: string[];
}

export interface GitHubDeviceStart {
	readonly expiresAt: string;
	readonly intervalSeconds: number;
	readonly userCode: string;
	readonly verificationUri: string;
}

export type GitHubDevicePoll =
	| { readonly status: "authorized"; readonly login: string }
	| { readonly status: "pending" }
	| { readonly status: "slow_down"; readonly intervalSeconds: number }
	| { readonly status: "expired" }
	| { readonly status: "denied" }
	| { readonly status: "idle" };

export interface GitHubOAuthServiceOptions {
	readonly apiBaseUrl?: string;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly fetcher?: typeof fetch;
	readonly logger?: Logger;
	readonly now?: () => number;
}

const OAUTH_KEY = "github-oauth";
const DEFAULT_SCOPE = "repo";
const REQUEST_TIMEOUT_MS = 15_000;

const storedSchema = z.object({
	addedAtMs: z.number().int().nonnegative(),
	clientId: z.string().min(1),
	login: z.string().min(1),
	scopes: z.array(z.string()),
	token: z.string().min(1),
});

/** The device endpoints live on the web host, not on `api.github.com`. */
export function deviceBaseUrl(apiBaseUrl: string): string {
	const url = new URL(apiBaseUrl);
	if (url.hostname === "api.github.com") return "https://github.com";
	return `${url.protocol}//${url.host}`;
}

interface DeviceCodeResponse {
	readonly device_code: string;
	readonly error?: string;
	readonly error_description?: string;
	readonly expires_in: number;
	readonly interval?: number;
	readonly user_code: string;
	readonly verification_uri: string;
}

interface TokenResponse {
	readonly access_token?: string;
	readonly error?: string;
	readonly error_description?: string;
	readonly interval?: number;
	readonly scope?: string;
}

export class GitHubOAuthService {
	readonly #apiBaseUrl: string;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #fetcher: typeof fetch;
	readonly #logger: Logger | undefined;
	readonly #now: () => number;
	#session:
		| {
				readonly clientId: string;
				readonly deviceCode: string;
				expiresAtMs: number;
				intervalMs: number;
		  }
		| undefined;

	constructor(options: GitHubOAuthServiceOptions) {
		this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
		this.#database = options.database;
		this.#fetcher = options.fetcher ?? fetch;
		this.#logger = options.logger?.child("tsukaima::server::github-oauth");
		this.#now = options.now ?? Date.now;
	}

	async status(): Promise<GitHubOAuthStatus> {
		const stored = await this.#read();
		if (stored === undefined) {
			return { clientId: null, configured: false, login: null, scopes: [] };
		}
		return {
			clientId: stored.clientId,
			configured: true,
			login: stored.login,
			scopes: stored.scopes,
		};
	}

	async token(): Promise<string | undefined> {
		return (await this.#read())?.token;
	}

	async start(clientId: string): Promise<GitHubDeviceStart> {
		const payload = await this.#post<DeviceCodeResponse>("/login/device/code", {
			client_id: clientId,
			scope: DEFAULT_SCOPE,
		});
		if (
			typeof payload.device_code !== "string" ||
			payload.device_code.length === 0 ||
			typeof payload.user_code !== "string" ||
			payload.user_code.length === 0 ||
			typeof payload.verification_uri !== "string" ||
			typeof payload.expires_in !== "number" ||
			!Number.isFinite(payload.expires_in) ||
			payload.expires_in <= 0
		) {
			const detail = payload.error_description ?? payload.error;
			throw new GitHubOAuthError(
				"github_oauth_unavailable",
				detail === undefined
					? "GitHub did not return a device code; check the OAuth Client ID (it must belong to an OAuth App, not a GitHub App)"
					: `GitHub rejected the device-code request: ${detail}`,
			);
		}
		const expiresAtMs = this.#now() + payload.expires_in * 1000;
		const intervalMs = Math.max(5, payload.interval ?? 5) * 1000;
		this.#session = {
			clientId,
			deviceCode: payload.device_code,
			expiresAtMs,
			intervalMs,
		};
		this.#logger?.info("github device flow started", { expiresIn: payload.expires_in });
		return {
			expiresAt: new Date(expiresAtMs).toISOString(),
			intervalSeconds: intervalMs / 1000,
			userCode: payload.user_code,
			verificationUri: payload.verification_uri,
		};
	}

	async poll(): Promise<GitHubDevicePoll> {
		const session = this.#session;
		if (session === undefined) return { status: "idle" };
		if (this.#now() >= session.expiresAtMs) {
			this.#session = undefined;
			return { status: "expired" };
		}
		const payload = await this.#post<TokenResponse>("/login/oauth/access_token", {
			client_id: session.clientId,
			device_code: session.deviceCode,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (typeof payload.access_token === "string" && payload.access_token.length > 0) {
			const login = await this.#verify(payload.access_token);
			const scopes = (payload.scope ?? "")
				.split(",")
				.map((scope) => scope.trim())
				.filter((scope) => scope.length > 0);
			await this.#write({
				addedAtMs: this.#now(),
				clientId: session.clientId,
				login,
				scopes,
				token: payload.access_token,
			});
			this.#session = undefined;
			this.#logger?.info("github user authorized", { login, scopes: scopes.length });
			return { status: "authorized", login };
		}
		switch (payload.error) {
			case "authorization_pending":
				return { status: "pending" };
			case "slow_down":
				// GitHub asks for at least five more seconds between polls.
				session.intervalMs = Math.max(session.intervalMs + 5_000, (payload.interval ?? 0) * 1000);
				return { status: "slow_down", intervalSeconds: session.intervalMs / 1000 };
			case "expired_token":
				this.#session = undefined;
				return { status: "expired" };
			case "access_denied":
				this.#session = undefined;
				return { status: "denied" };
			default:
				throw new GitHubOAuthError(
					"github_oauth_unavailable",
					payload.error_description ?? payload.error ?? "GitHub rejected the device flow",
				);
		}
	}

	async clear(): Promise<GitHubOAuthStatus> {
		const database = this.#database();
		if (database !== undefined) {
			await database.delete(meta).where(eq(meta.key, OAUTH_KEY));
		}
		this.#session = undefined;
		this.#logger?.info("github user signed out");
		return await this.status();
	}

	async #verify(token: string): Promise<string> {
		const user = await githubRequest<{ login?: string }>({
			apiBaseUrl: this.#apiBaseUrl,
			fetcher: this.#fetcher,
			path: "/user",
			token,
		});
		if (typeof user.login !== "string" || user.login.length === 0) {
			throw new GitHubOAuthError("github_oauth_unavailable", "GitHub did not return a user login");
		}
		return user.login;
	}

	async #post<T>(path: string, params: Record<string, string>): Promise<T> {
		const response = await this.#fetcher(`${deviceBaseUrl(this.#apiBaseUrl)}${path}`, {
			body: new URLSearchParams(params).toString(),
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).catch((error: unknown) => {
			throw new GitHubOAuthError(
				"github_oauth_unavailable",
				`GitHub device flow is unreachable: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		if (!response.ok) {
			const detail = await response
				.json()
				.then((body: unknown) => {
					if (typeof body !== "object" || body === null) return undefined;
					const value = body as { error_description?: unknown; error?: unknown };
					if (typeof value.error_description === "string" && value.error_description.length > 0) {
						return value.error_description;
					}
					if (typeof value.error === "string" && value.error.length > 0) return value.error;
					return undefined;
				})
				.catch(() => undefined);
			throw new GitHubOAuthError(
				"github_oauth_unavailable",
				detail === undefined
					? `GitHub responded ${response.status} for ${path}; check the OAuth Client ID (it must belong to an OAuth App, not a GitHub App)`
					: `GitHub rejected the request (${response.status}): ${detail}`,
			);
		}
		return (await response.json()) as T;
	}

	async #read(): Promise<z.infer<typeof storedSchema> | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const rows = await database.select().from(meta).where(eq(meta.key, OAUTH_KEY)).limit(1);
		const raw = rows[0]?.value;
		if (raw === undefined) return undefined;
		try {
			const parsed = storedSchema.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}

	async #write(value: z.infer<typeof storedSchema>): Promise<void> {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		const serialized = JSON.stringify(value);
		await database
			.insert(meta)
			.values({ key: OAUTH_KEY, value: serialized })
			.onConflictDoUpdate({ target: meta.key, set: { value: serialized } });
	}
}
