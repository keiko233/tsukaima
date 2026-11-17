import { createHash, createSign } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { GitHubAppStatus } from "@tsukaima/contracts";
import { meta, type TsukaimaDatabase } from "@tsukaima/db";
import { z } from "zod";
import type { Logger } from "../logging.ts";

/**
 * GitHub App credentials and short-lived installation tokens.
 *
 * A GitHub App authenticates with a signed JWT (`iss` = App ID, at most ten minutes of validity)
 * and exchanges it for an installation token that expires within an hour. Nothing here is ever
 * returned by an RPC: callers see the App ID, the installation account, the declared permissions,
 * and a fingerprint. The private key stays on the data volume, and a token lives only in memory
 * and in the environment of a single git or REST call.
 */

export type GitHubAppErrorCode =
	| "github_app_forbidden"
	| "github_app_installation_not_found"
	| "github_app_installation_mismatch"
	| "github_app_invalid_private_key"
	| "github_app_rate_limited"
	| "github_app_unavailable"
	| "github_app_unauthorized";

export class GitHubAppError extends Error {
	readonly code: GitHubAppErrorCode;

	constructor(code: GitHubAppErrorCode, message: string) {
		super(message);
		this.name = "GitHubAppError";
		this.code = code;
	}
}

export interface GitHubAppConfig {
	readonly account: string;
	readonly addedAtMs: number;
	readonly appId: number;
	readonly installationId: number;
	readonly keyFingerprint: string;
	readonly permissions: Record<string, string>;
	readonly repositorySelection: "all" | "selected";
}

export interface InstallationToken {
	readonly expiresAtMs: number;
	readonly token: string;
}

export interface GitHubAppServiceOptions {
	readonly apiBaseUrl?: string;
	readonly dataDir: string;
	readonly database: () => TsukaimaDatabase | undefined;
	readonly fetcher?: typeof fetch;
	readonly logger?: Logger;
	readonly now?: () => number;
}

export interface GitHubRequestInput {
	readonly apiBaseUrl: string;
	readonly body?: unknown;
	readonly fetcher: typeof fetch;
	readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
	/** Distinguishes the configure-time 404 (installation missing) from a repository 404. */
	readonly notFoundCode?: "github_app_installation_not_found" | "github_app_unavailable";
	readonly path: string;
	readonly token: string;
}

const CONFIG_KEY = "github-app";
const SECRET_DIRECTORY = "secrets";
const SECRET_FILENAME = "github-app.pem";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;
/** Installation tokens last an hour; stop using one five minutes before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_ERROR_BODY_CHARS = 300;

const configSchema = z.object({
	account: z.string().min(1),
	addedAtMs: z.number().int().nonnegative(),
	appId: z.number().int().positive(),
	installationId: z.number().int().positive(),
	keyFingerprint: z.string().min(1),
	permissions: z.record(z.string(), z.string()),
	repositorySelection: z.enum(["all", "selected"]),
});

export function base64Url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/**
 * Sign the short-lived App JWT. `iat` is backdated a minute for clock skew and `exp` is nine
 * minutes ahead, which stays inside GitHub's ten-minute limit.
 */
export function signAppJwt(input: {
	readonly appId: number;
	readonly nowMs: number;
	readonly privateKey: string;
}): string {
	const issuedAt = Math.floor(input.nowMs / 1000) - 60;
	const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64Url(
		JSON.stringify({ exp: issuedAt + 600, iat: issuedAt, iss: input.appId }),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	signer.end();
	return `${header}.${payload}.${signer.sign(input.privateKey).toString("base64url")}`;
}

/** Stable, non-reversible identifier so the UI can show which key is loaded. */
export function appKeyFingerprint(privateKey: string): string {
	return createHash("sha256").update(privateKey).digest("hex").slice(0, 16);
}

/** Reject a malformed key before it is written to disk, with a message that names the problem. */
export function assertPrivateKey(privateKey: string): void {
	try {
		const signer = createSign("RSA-SHA256");
		signer.update("github-app-key-probe");
		signer.end();
		signer.sign(privateKey);
	} catch {
		throw new GitHubAppError(
			"github_app_invalid_private_key",
			"Private key could not be parsed; paste the whole .pem file downloaded from the App settings",
		);
	}
}

async function errorMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (text.length === 0) return `GitHub responded ${response.status}`;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
			const message = (parsed as { message: unknown }).message;
			if (typeof message === "string" && message.length > 0) {
				return message.slice(0, MAX_ERROR_BODY_CHARS);
			}
		}
	} catch {
		// Fall through to the raw body: it is already bounded and contains no credential.
	}
	return text.slice(0, MAX_ERROR_BODY_CHARS);
}

/** One authenticated REST call. Errors are typed and never echo the credential or the body. */
export async function githubRequest<T>(input: GitHubRequestInput): Promise<T> {
	const response = await input.fetcher(`${input.apiBaseUrl}${input.path}`, {
		body: input.body === undefined ? undefined : JSON.stringify(input.body),
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${input.token}`,
			...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
			"X-GitHub-Api-Version": API_VERSION,
		},
		method: input.method ?? "GET",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const detail = await errorMessage(response);
		const remaining = response.headers.get("x-ratelimit-remaining");
		if (response.status === 401) {
			throw new GitHubAppError(
				"github_app_unauthorized",
				`GitHub rejected the App credentials: ${detail}`,
			);
		}
		if (response.status === 404) {
			throw new GitHubAppError(
				input.notFoundCode ?? "github_app_unavailable",
				`GitHub resource not found: ${detail}`,
			);
		}
		if (response.status === 403 || response.status === 429) {
			if (remaining === "0") {
				throw new GitHubAppError("github_app_rate_limited", `GitHub rate limit reached: ${detail}`);
			}
			throw new GitHubAppError(
				"github_app_forbidden",
				`The installation is missing a required permission: ${detail}`,
			);
		}
		throw new GitHubAppError(
			"github_app_unavailable",
			`GitHub responded ${response.status}: ${detail}`,
		);
	}
	return (await response.json()) as T;
}

interface InstallationResponse {
	readonly account: { readonly login?: string } | null;
	readonly app_id: number;
	readonly permissions: Record<string, string>;
	readonly repository_selection: "all" | "selected";
}

interface TokenResponse {
	readonly expires_at: string;
	readonly token: string;
}

export class GitHubAppService {
	readonly #apiBaseUrl: string;
	readonly #dataDir: string;
	readonly #database: () => TsukaimaDatabase | undefined;
	readonly #fetcher: typeof fetch;
	readonly #logger: Logger | undefined;
	readonly #now: () => number;
	#cachedKey: string | undefined;
	#cachedToken: InstallationToken | undefined;
	#pendingToken: Promise<InstallationToken> | undefined;

	constructor(options: GitHubAppServiceOptions) {
		this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
		this.#dataDir = options.dataDir;
		this.#database = options.database;
		this.#fetcher = options.fetcher ?? fetch;
		this.#logger = options.logger?.child("tsukaima::server::github");
		this.#now = options.now ?? Date.now;
	}

	async status(): Promise<GitHubAppStatus> {
		const config = await this.#readConfig();
		if (config === undefined) {
			return {
				account: null,
				appId: null,
				configured: false,
				installationId: null,
				keyFingerprint: null,
				permissions: null,
				repositorySelection: null,
				tokenExpiresAt: null,
			};
		}
		return {
			account: config.account,
			appId: config.appId,
			configured: true,
			installationId: config.installationId,
			keyFingerprint: config.keyFingerprint,
			permissions: config.permissions,
			repositorySelection: config.repositorySelection,
			tokenExpiresAt:
				this.#cachedToken === undefined
					? null
					: new Date(this.#cachedToken.expiresAtMs).toISOString(),
		};
	}

	/**
	 * Validate and persist an installation. The write only happens after GitHub accepts the JWT,
	 * the installation exists, it belongs to this App, and it can mint a token.
	 */
	async configure(input: {
		readonly appId: number;
		readonly installationId: number;
		readonly privateKey: string;
	}): Promise<GitHubAppStatus> {
		assertPrivateKey(input.privateKey);
		const jwt = signAppJwt({
			appId: input.appId,
			nowMs: this.#now(),
			privateKey: input.privateKey,
		});
		const installation = await githubRequest<InstallationResponse>({
			apiBaseUrl: this.#apiBaseUrl,
			fetcher: this.#fetcher,
			notFoundCode: "github_app_installation_not_found",
			path: `/app/installations/${input.installationId}`,
			token: jwt,
		});
		if (installation.app_id !== input.appId) {
			throw new GitHubAppError(
				"github_app_installation_mismatch",
				`Installation ${input.installationId} belongs to App ${installation.app_id}, not ${input.appId}`,
			);
		}
		const account = installation.account?.login ?? "";
		if (account.length === 0) {
			throw new GitHubAppError(
				"github_app_installation_not_found",
				`Installation ${input.installationId} has no account login`,
			);
		}
		const token = await this.#mintToken(input.installationId, jwt);
		await this.#writePrivateKey(input.privateKey);
		const config: GitHubAppConfig = {
			account,
			addedAtMs: this.#now(),
			appId: input.appId,
			installationId: input.installationId,
			keyFingerprint: appKeyFingerprint(input.privateKey),
			permissions: installation.permissions,
			repositorySelection: installation.repository_selection,
		};
		await this.#writeConfig(config);
		this.#cachedKey = input.privateKey;
		this.#cachedToken = token;
		this.#logger?.info("github app configured", {
			account,
			appId: input.appId,
			installationId: input.installationId,
		});
		return await this.status();
	}

	async clear(): Promise<GitHubAppStatus> {
		const database = this.#database();
		if (database !== undefined) {
			await database.delete(meta).where(eq(meta.key, CONFIG_KEY));
		}
		await rm(this.#secretPath(), { force: true });
		this.#cachedKey = undefined;
		this.#cachedToken = undefined;
		this.#pendingToken = undefined;
		this.#logger?.info("github app cleared");
		return await this.status();
	}

	/** A valid installation token, minted or refreshed on demand. */
	async installationToken(): Promise<string> {
		return (await this.#token()).token;
	}

	/** The repository selection this installation can reach. */
	async repositories(): Promise<
		readonly { fullName: string; name: string; owner: string; private: boolean }[]
	> {
		const token = await this.installationToken();
		const response = await githubRequest<{
			repositories: {
				full_name: string;
				name: string;
				owner: { login: string };
				private: boolean;
			}[];
		}>({
			apiBaseUrl: this.#apiBaseUrl,
			fetcher: this.#fetcher,
			path: "/installation/repositories?per_page=100",
			token,
		});
		return response.repositories.map((repository) => ({
			fullName: repository.full_name,
			name: repository.name,
			owner: repository.owner.login,
			private: repository.private,
		}));
	}

	async #token(): Promise<InstallationToken> {
		if (
			this.#cachedToken !== undefined &&
			this.#cachedToken.expiresAtMs - this.#now() > TOKEN_REFRESH_MARGIN_MS
		) {
			return this.#cachedToken;
		}
		this.#pendingToken ??= this.#mintFromConfig().finally(() => {
			this.#pendingToken = undefined;
		});
		return await this.#pendingToken;
	}

	async #mintFromConfig(): Promise<InstallationToken> {
		const config = await this.#readConfig();
		if (config === undefined) {
			throw new GitHubAppError("github_app_unauthorized", "No GitHub App is configured");
		}
		const privateKey = await this.#readPrivateKey();
		assertPrivateKey(privateKey);
		const jwt = signAppJwt({ appId: config.appId, nowMs: this.#now(), privateKey });
		const token = await this.#mintToken(config.installationId, jwt);
		this.#cachedToken = token;
		return token;
	}

	async #mintToken(installationId: number, jwt: string): Promise<InstallationToken> {
		const response = await githubRequest<TokenResponse>({
			apiBaseUrl: this.#apiBaseUrl,
			fetcher: this.#fetcher,
			method: "POST",
			notFoundCode: "github_app_installation_not_found",
			path: `/app/installations/${installationId}/access_tokens`,
			token: jwt,
		});
		const expiresAtMs = Date.parse(response.expires_at);
		const token: InstallationToken = {
			expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.#now() + 60 * 60_000,
			token: response.token,
		};
		this.#cachedToken = token;
		return token;
	}

	#secretPath(): string {
		return join(this.#dataDir, SECRET_DIRECTORY, SECRET_FILENAME);
	}

	async #readPrivateKey(): Promise<string> {
		if (this.#cachedKey !== undefined) return this.#cachedKey;
		const key = await readFile(this.#secretPath(), "utf8").catch(() => undefined);
		if (key === undefined || key.trim().length === 0) {
			throw new GitHubAppError(
				"github_app_unauthorized",
				"The stored GitHub App private key is missing; configure the App again",
			);
		}
		this.#cachedKey = key;
		return key;
	}

	async #writePrivateKey(privateKey: string): Promise<void> {
		const directory = join(this.#dataDir, SECRET_DIRECTORY);
		await mkdir(directory, { mode: 0o700, recursive: true });
		await chmod(directory, 0o700).catch(() => undefined);
		const target = this.#secretPath();
		const temporary = `${target}.tmp`;
		await writeFile(temporary, privateKey, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, target);
	}

	async #readConfig(): Promise<GitHubAppConfig | undefined> {
		const database = this.#database();
		if (database === undefined) return undefined;
		const rows = await database.select().from(meta).where(eq(meta.key, CONFIG_KEY)).limit(1);
		const raw = rows[0]?.value;
		if (raw === undefined) return undefined;
		try {
			const parsed = configSchema.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}

	async #writeConfig(config: GitHubAppConfig): Promise<void> {
		const database = this.#database();
		if (database === undefined) throw new Error("Domain database is not ready");
		const value = JSON.stringify(config);
		await database
			.insert(meta)
			.values({ key: CONFIG_KEY, value })
			.onConflictDoUpdate({ target: meta.key, set: { value } });
	}
}
