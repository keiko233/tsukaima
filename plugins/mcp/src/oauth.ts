import { randomBytes } from "node:crypto";
import type {
	AddClientAuthentication,
	OAuthClientProvider,
	OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { createPrivateKeyJwtAuth } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpHttpAuthOAuth, McpOAuthSnapshot, McpOAuthStatus } from "@tsukaima/contracts";
import type { PluginStorage } from "@tsukaima/sdk";
import { isPlainObject } from "es-toolkit";

export const MCP_OAUTH_HOST_BINDING = "mcp.oauthHost";
export const MCP_OAUTH_STORAGE_KEY = "oauth";
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
const DEFAULT_CALLBACK_ORIGIN = "http://127.0.0.1:7420";
const PENDING_AUTH_TTL_MS = 15 * 60_000;

export interface McpOAuthCallbackParams {
	readonly code?: string;
	readonly error?: string;
	readonly errorDescription?: string;
	readonly state?: string;
}

export interface McpOAuthCallbackOutcome {
	readonly error?: string;
	readonly ok: boolean;
	readonly serverId?: string;
}

export interface McpOAuthHost {
	/** Public base URL of the Tsukaima server, used when no browser origin is supplied. */
	readonly publicUrl?: string;
	/** Registers the HTTP callback handler for `/api/mcp/oauth/callback`. */
	registerCallbackHandler?(
		handler: (params: McpOAuthCallbackParams) => Promise<McpOAuthCallbackOutcome>,
	): () => void;
}

export interface PendingMcpOAuthAuthorization {
	readonly authorizationUrl: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly redirectUrl: string;
	readonly state: string;
}

export interface PersistedMcpOAuthState {
	readonly clientInformation?: OAuthClientInformationMixed;
	readonly codeVerifier?: string;
	readonly discoveryState?: OAuthDiscoveryState;
	readonly lastAuthError?: string;
	readonly pending?: PendingMcpOAuthAuthorization;
	readonly tokenExpiresAt?: string;
	readonly tokens?: OAuthTokens;
	readonly updatedAt?: string;
}

export function defaultOAuthRedirectUrl(
	publicUrl: string | undefined,
	callbackOrigin?: string,
): string {
	const rawBase = callbackOrigin ?? publicUrl ?? DEFAULT_CALLBACK_ORIGIN;
	return new URL(MCP_OAUTH_CALLBACK_PATH, rawBase).toString();
}

export function validateCallbackOrigin(origin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		throw new Error("Invalid OAuth callback origin URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OAuth callback origin must use http or https");
	}
	return parsed.origin;
}

export function parseOAuthCallbackUrl(callbackUrl: string): McpOAuthCallbackParams {
	const parsed = new URL(callbackUrl);
	const code = parsed.searchParams.get("code") ?? undefined;
	const state = parsed.searchParams.get("state") ?? undefined;
	const error = parsed.searchParams.get("error") ?? undefined;
	const errorDescription = parsed.searchParams.get("error_description") ?? undefined;
	return {
		...(code === undefined ? {} : { code }),
		...(error === undefined ? {} : { error }),
		...(errorDescription === undefined ? {} : { errorDescription }),
		...(state === undefined ? {} : { state }),
	};
}

function isPendingExpired(pending: PendingMcpOAuthAuthorization, nowMs = Date.now()): boolean {
	const expiresMs = Date.parse(pending.expiresAt);
	return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

function parsePrivateKeyInput(raw: string): string | Record<string, unknown> {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) {
		const parsed: unknown = JSON.parse(trimmed);
		if (isPlainObject(parsed)) return parsed;
	}
	return raw;
}

function sanitizeStoredState(raw: unknown): PersistedMcpOAuthState | undefined {
	if (!isPlainObject(raw)) return undefined;
	const state: Record<string, unknown> = {};
	if (isPlainObject(raw.clientInformation) && typeof raw.clientInformation.client_id === "string") {
		state.clientInformation = raw.clientInformation;
	}
	if (typeof raw.codeVerifier === "string" && raw.codeVerifier.length > 0) {
		state.codeVerifier = raw.codeVerifier;
	}
	if (
		isPlainObject(raw.discoveryState) &&
		typeof raw.discoveryState.authorizationServerUrl === "string"
	) {
		state.discoveryState = raw.discoveryState;
	}
	if (typeof raw.lastAuthError === "string" && raw.lastAuthError.length > 0) {
		state.lastAuthError = raw.lastAuthError;
	}
	if (
		isPlainObject(raw.pending) &&
		typeof raw.pending.authorizationUrl === "string" &&
		typeof raw.pending.createdAt === "string" &&
		typeof raw.pending.expiresAt === "string" &&
		typeof raw.pending.redirectUrl === "string" &&
		typeof raw.pending.state === "string"
	) {
		state.pending = raw.pending;
	}
	if (typeof raw.tokenExpiresAt === "string") {
		state.tokenExpiresAt = raw.tokenExpiresAt;
	}
	if (isPlainObject(raw.tokens) && typeof raw.tokens.access_token === "string") {
		state.tokens = raw.tokens;
	}
	if (typeof raw.updatedAt === "string") {
		state.updatedAt = raw.updatedAt;
	}
	return state as PersistedMcpOAuthState;
}

/** Persistent per-server OAuth credential and session store backed by plugin global storage. */
export class McpOAuthStore {
	readonly #storage: PluginStorage;
	readonly #states = new Map<string, PersistedMcpOAuthState>();
	#loaded = false;
	#writeChain: Promise<void> = Promise.resolve();

	constructor(storage: PluginStorage) {
		this.#storage = storage;
	}

	async load(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		const stored = await this.#storage.global.get<unknown>(MCP_OAUTH_STORAGE_KEY);
		if (!isPlainObject(stored)) return;
		for (const [serverId, entry] of Object.entries(stored)) {
			const sanitized = sanitizeStoredState(entry);
			if (sanitized !== undefined) {
				this.#states.set(serverId, sanitized);
			}
		}
	}

	get(serverId: string): PersistedMcpOAuthState | undefined {
		return this.#states.get(serverId);
	}

	async update(
		serverId: string,
		updater: (current: PersistedMcpOAuthState) => PersistedMcpOAuthState | undefined,
	): Promise<PersistedMcpOAuthState | undefined> {
		const operation = this.#writeChain.then(async () => {
			await this.load();
			const current = this.#states.get(serverId) ?? {};
			const next = updater(current);
			if (next === undefined || Object.keys(next).length === 0) {
				this.#states.delete(serverId);
			} else {
				this.#states.set(serverId, next);
			}
			await this.#persist();
			return this.#states.get(serverId);
		});
		this.#writeChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async delete(serverId: string): Promise<void> {
		await this.update(serverId, () => undefined);
	}

	/** Atomically looks up and consumes a pending OAuth state token for callback handling. */
	async consumePendingState(
		stateToken: string,
	): Promise<
		{ readonly pending: PendingMcpOAuthAuthorization; readonly serverId: string } | undefined
	> {
		const operation = this.#writeChain.then(async () => {
			await this.load();
			for (const [serverId, entry] of this.#states.entries()) {
				const pending = entry.pending;
				if (pending === undefined || pending.state !== stateToken) continue;
				const { pending: _removed, ...rest } = entry;
				if (Object.keys(rest).length === 0) {
					this.#states.delete(serverId);
				} else {
					this.#states.set(serverId, rest);
				}
				await this.#persist();
				if (isPendingExpired(pending)) return undefined;
				return { pending, serverId };
			}
			return undefined;
		});
		this.#writeChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async #persist(): Promise<void> {
		const record: Record<string, PersistedMcpOAuthState> = {};
		for (const [serverId, state] of this.#states.entries()) {
			record[serverId] = state;
		}
		await this.#storage.global.set(MCP_OAUTH_STORAGE_KEY, record);
	}
}

export function oauthSecretsForRedaction(state: PersistedMcpOAuthState | undefined): string[] {
	if (state === undefined) return [];
	const values: string[] = [];
	if (state.tokens?.access_token) values.push(state.tokens.access_token);
	if (state.tokens?.refresh_token) values.push(state.tokens.refresh_token);
	if (state.clientInformation?.client_secret) values.push(state.clientInformation.client_secret);
	if (state.codeVerifier) values.push(state.codeVerifier);
	return values;
}

export function oauthSnapshotFor(
	authConfig: McpHttpAuthOAuth,
	state: PersistedMcpOAuthState | undefined,
	fallbackRedirectUrl: string,
): McpOAuthSnapshot {
	const activePending =
		state?.pending !== undefined && !isPendingExpired(state.pending) ? state.pending : undefined;
	const hasToken = state?.tokens?.access_token !== undefined;
	let status: McpOAuthStatus = "unauthenticated";
	if (activePending !== undefined) {
		status = "pending";
	} else if (hasToken) {
		status = "authorized";
	} else if (state?.lastAuthError !== undefined) {
		status = "error";
	}

	const clientId = authConfig.clientId ?? state?.clientInformation?.client_id;
	const issuer =
		state?.tokens?.issuer ??
		state?.clientInformation?.issuer ??
		state?.discoveryState?.authorizationServerUrl ??
		authConfig.expectedIssuer;
	const scope = state?.tokens?.scope ?? authConfig.scope;
	const redirectUrl =
		authConfig.grantType === "authorization_code"
			? (activePending?.redirectUrl ?? authConfig.redirectUri ?? fallbackRedirectUrl)
			: undefined;

	return {
		...(activePending === undefined
			? {}
			: {
					authorizationUrl: activePending.authorizationUrl,
					pendingExpiresAt: activePending.expiresAt,
				}),
		...(clientId === undefined ? {} : { clientId }),
		...(state?.tokenExpiresAt === undefined ? {} : { expiresAt: state.tokenExpiresAt }),
		grantType: authConfig.grantType,
		hasRefreshToken: state?.tokens?.refresh_token !== undefined,
		...(issuer === undefined ? {} : { issuer }),
		...(redirectUrl === undefined ? {} : { redirectUrl }),
		...(scope === undefined ? {} : { scope }),
		status,
	};
}

export interface McpOAuthProviderOptions {
	readonly authConfig: McpHttpAuthOAuth;
	readonly redirectUrl: string;
	readonly serverId: string;
	readonly store: McpOAuthStore;
}

/**
 * Bridges `@modelcontextprotocol/sdk`'s `OAuthClientProvider` to Tsukaima's persistent plugin
 * storage for both interactive `authorization_code` (PKCE + DCR/pre-registered) and
 * machine-to-machine `client_credentials` (`client_secret_*` / `private_key_jwt`).
 */
export class McpOAuthClientProvider implements OAuthClientProvider {
	readonly #authConfig: McpHttpAuthOAuth;
	readonly #redirectUrl: string;
	readonly #serverId: string;
	readonly #store: McpOAuthStore;
	#stateToken: string | undefined;
	#capturedRedirectUrl: string | undefined;
	readonly saveClientInformation?: (info: OAuthClientInformationMixed) => Promise<void>;
	readonly addClientAuthentication?: AddClientAuthentication;
	readonly prepareTokenRequest?: (scope?: string) => URLSearchParams | undefined;

	constructor(options: McpOAuthProviderOptions) {
		this.#authConfig = options.authConfig;
		this.#redirectUrl = options.redirectUrl;
		this.#serverId = options.serverId;
		this.#store = options.store;

		if (options.authConfig.clientMetadataUrl !== undefined) {
			this.clientMetadataUrl = options.authConfig.clientMetadataUrl;
		}

		// When a static clientId is paired with expectedIssuer, omit saveClientInformation so the
		// SDK enforces issuer pinning instead of re-registering dynamically against a different AS.
		if (
			options.authConfig.clientId === undefined ||
			options.authConfig.expectedIssuer === undefined
		) {
			this.saveClientInformation = async (info) => {
				await this.#store.update(this.#serverId, (current) => ({
					...current,
					clientInformation:
						this.#authConfig.clientId !== undefined
							? {
									client_id: this.#authConfig.clientId,
									...(info.issuer === undefined ? {} : { issuer: info.issuer }),
								}
							: info,
					updatedAt: new Date().toISOString(),
				}));
			};
		}

		if (
			options.authConfig.privateKey !== undefined &&
			(options.authConfig.grantType === "client_credentials" ||
				options.authConfig.tokenEndpointAuthMethod === "private_key_jwt")
		) {
			const clientId = options.authConfig.clientId;
			if (clientId === undefined) {
				throw new Error("clientId is required when privateKey is configured");
			}
			this.addClientAuthentication = createPrivateKeyJwtAuth({
				alg: options.authConfig.algorithm ?? "RS256",
				issuer: clientId,
				...(options.authConfig.jwtLifetimeSeconds === undefined
					? {}
					: { lifetimeSeconds: options.authConfig.jwtLifetimeSeconds }),
				privateKey: parsePrivateKeyInput(options.authConfig.privateKey),
				subject: clientId,
			});
		}

		if (options.authConfig.grantType === "client_credentials") {
			this.prepareTokenRequest = (scope) => {
				const params = new URLSearchParams({ grant_type: "client_credentials" });
				const resolved = scope ?? this.#authConfig.scope;
				if (resolved !== undefined && resolved.length > 0) {
					params.set("scope", resolved);
				}
				return params;
			};
		}
	}

	readonly clientMetadataUrl?: string;

	get hasCapturedRedirect(): boolean {
		return this.#capturedRedirectUrl !== undefined;
	}

	get redirectUrl(): string | undefined {
		if (this.#authConfig.grantType === "client_credentials") return undefined;
		return this.#authConfig.redirectUri ?? this.#redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		const isClientCredentials = this.#authConfig.grantType === "client_credentials";
		const defaultAuthMethod = isClientCredentials
			? this.#authConfig.privateKey !== undefined
				? "private_key_jwt"
				: "client_secret_basic"
			: this.#authConfig.clientSecret !== undefined
				? "client_secret_basic"
				: "none";
		const metadata: OAuthClientMetadata = {
			client_name: this.#authConfig.clientName ?? "Tsukaima",
			grant_types: isClientCredentials
				? ["client_credentials"]
				: ["authorization_code", "refresh_token"],
			redirect_uris:
				isClientCredentials || this.redirectUrl === undefined ? [] : [this.redirectUrl],
			...(isClientCredentials ? {} : { response_types: ["code"] }),
			...(this.#authConfig.scope === undefined ? {} : { scope: this.#authConfig.scope }),
			token_endpoint_auth_method: this.#authConfig.tokenEndpointAuthMethod ?? defaultAuthMethod,
		};
		return metadata;
	}

	state(): string {
		if (this.#stateToken === undefined) {
			this.#stateToken = randomBytes(32).toString("base64url");
		}
		return this.#stateToken;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const stored = this.#store.get(this.#serverId)?.clientInformation;
		if (this.#authConfig.clientId !== undefined) {
			const boundIssuer =
				this.#authConfig.expectedIssuer ??
				(stored?.client_id === this.#authConfig.clientId ? stored.issuer : undefined);
			return {
				client_id: this.#authConfig.clientId,
				...(this.#authConfig.clientSecret === undefined
					? {}
					: { client_secret: this.#authConfig.clientSecret }),
				...(boundIssuer === undefined ? {} : { issuer: boundIssuer }),
				...(this.#authConfig.tokenEndpointAuthMethod === undefined
					? {}
					: { token_endpoint_auth_method: this.#authConfig.tokenEndpointAuthMethod }),
			};
		}
		return stored;
	}

	tokens(): OAuthTokens | undefined {
		return this.#store.get(this.#serverId)?.tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const nowMs = Date.now();
		const tokenExpiresAt =
			typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
				? new Date(nowMs + tokens.expires_in * 1_000).toISOString()
				: undefined;
		await this.#store.update(this.#serverId, (current) => {
			const {
				codeVerifier: _verifier,
				lastAuthError: _error,
				pending: _pending,
				tokenExpiresAt: _oldExpiry,
				...rest
			} = current;
			return {
				...rest,
				...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
				tokens,
				updatedAt: new Date(nowMs).toISOString(),
			};
		});
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		if (this.#authConfig.grantType === "client_credentials") {
			throw new Error("redirectToAuthorization is not supported for client_credentials flow");
		}
		const redirectUrl = this.redirectUrl;
		if (redirectUrl === undefined) {
			throw new Error("OAuth redirectUrl is not available");
		}
		const nowMs = Date.now();
		const stateToken = this.state();
		this.#capturedRedirectUrl = authorizationUrl.toString();
		await this.#store.update(this.#serverId, (current) => {
			const { lastAuthError: _error, ...rest } = current;
			return {
				...rest,
				pending: {
					authorizationUrl: authorizationUrl.toString(),
					createdAt: new Date(nowMs).toISOString(),
					expiresAt: new Date(nowMs + PENDING_AUTH_TTL_MS).toISOString(),
					redirectUrl,
					state: stateToken,
				},
				updatedAt: new Date(nowMs).toISOString(),
			};
		});
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#store.update(this.#serverId, (current) => ({
			...current,
			codeVerifier,
			updatedAt: new Date().toISOString(),
		}));
	}

	codeVerifier(): string {
		const verifier = this.#store.get(this.#serverId)?.codeVerifier;
		if (verifier === undefined) {
			throw new Error("OAuth PKCE code verifier is missing or expired");
		}
		return verifier;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#store.get(this.#serverId)?.discoveryState;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		await this.#store.update(this.#serverId, (current) => ({
			...current,
			discoveryState: state,
			updatedAt: new Date().toISOString(),
		}));
	}

	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		await this.#store.update(this.#serverId, (current) => {
			if (scope === "all") return undefined;
			const next = { ...current };
			if (scope === "tokens") delete next.tokens;
			if (scope === "tokens") delete next.tokenExpiresAt;
			if (scope === "verifier") {
				delete next.codeVerifier;
				delete next.pending;
			}
			if (scope === "discovery") delete next.discoveryState;
			if (scope === "client") delete next.clientInformation;
			return next;
		});
	}
}
