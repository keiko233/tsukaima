import { z } from "zod";

/**
 * Public placeholder for a configured secret value. Stdio `env` and HTTP `headers` hold
 * credentials; snapshots mask them so the WebUI can display and edit key names without
 * exposing values it never needs to read back.
 */
export const MCP_SECRET_MASK = "***";

/** Upper bound for one MCP server tool call; keeps a hung server from stalling a turn. */
export const MCP_MAX_TIMEOUT_MS = 600_000;

export const mcpStdioTransportSchema = z.object({
	args: z.array(z.string()).optional(),
	command: z.string().min(1),
	cwd: z.string().min(1).optional(),
	env: z.record(z.string(), z.string()).optional(),
	type: z.literal("stdio"),
});

export const mcpHttpAuthNoneSchema = z.object({
	type: z.literal("none"),
});

export const mcpHttpAuthBearerSchema = z.object({
	token: z.string().min(1),
	type: z.literal("bearer"),
});

export const mcpOAuthGrantTypeSchema = z.enum(["authorization_code", "client_credentials"]);

export type McpOAuthGrantType = z.infer<typeof mcpOAuthGrantTypeSchema>;

export const mcpOAuthTokenAuthMethodSchema = z.enum([
	"client_secret_basic",
	"client_secret_post",
	"none",
	"private_key_jwt",
]);

export type McpOAuthTokenAuthMethod = z.infer<typeof mcpOAuthTokenAuthMethodSchema>;

export const mcpHttpAuthOAuthBaseSchema = z.object({
	algorithm: z.string().min(1).optional(),
	clientId: z.string().min(1).optional(),
	clientMetadataUrl: z.string().url().optional(),
	clientName: z.string().min(1).max(128).optional(),
	clientSecret: z.string().min(1).optional(),
	expectedIssuer: z.string().url().optional(),
	grantType: mcpOAuthGrantTypeSchema.default("authorization_code"),
	jwtLifetimeSeconds: z.number().int().min(30).max(3600).optional(),
	privateKey: z.string().min(1).optional(),
	redirectUri: z.string().url().optional(),
	scope: z.string().min(1).optional(),
	tokenEndpointAuthMethod: mcpOAuthTokenAuthMethodSchema.optional(),
	type: z.literal("oauth"),
});

export const mcpHttpAuthOAuthSchema = mcpHttpAuthOAuthBaseSchema.superRefine((value, ctx) => {
	if (value.grantType === "client_credentials") {
		if (value.clientId === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "clientId is required for client_credentials grant",
				path: ["clientId"],
			});
		}
		if (value.clientSecret === undefined && value.privateKey === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "clientSecret or privateKey is required for client_credentials grant",
				path: ["clientSecret"],
			});
		}
		if (value.tokenEndpointAuthMethod === "private_key_jwt" && value.privateKey === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "privateKey is required when tokenEndpointAuthMethod is private_key_jwt",
				path: ["privateKey"],
			});
		}
	}
});

export type McpHttpAuthOAuth = z.infer<typeof mcpHttpAuthOAuthSchema>;

export const mcpHttpAuthSchema = z.discriminatedUnion("type", [
	mcpHttpAuthNoneSchema,
	mcpHttpAuthBearerSchema,
	mcpHttpAuthOAuthSchema,
]);

export type McpHttpAuth = z.infer<typeof mcpHttpAuthSchema>;

export const mcpHttpTransportSchema = z.object({
	auth: mcpHttpAuthSchema.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	type: z.literal("http"),
	url: z.string().url(),
});

/** Stdio spawns a local MCP process; HTTP covers Streamable HTTP and legacy SSE endpoints. */
export const mcpTransportSchema = z.discriminatedUnion("type", [
	mcpStdioTransportSchema,
	mcpHttpTransportSchema,
]);

export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpSurfaceSchema = z.enum(["chat", "workspace", "both"]);

export const mcpScopeSchema = z.enum(["everyone", "admin"]);

export type McpScope = z.infer<typeof mcpScopeSchema>;

export const mcpServerStateSchema = z.enum([
	"disconnected",
	"connecting",
	"connected",
	"auth_required",
	"error",
]);

export type McpServerState = z.infer<typeof mcpServerStateSchema>;

export const mcpServerConfigSchema = z.object({
	allowedTools: z.array(z.string().min(1)).optional(),
	deferred: z.boolean().default(true),
	disabledTools: z.array(z.string().min(1)).optional(),
	enabled: z.boolean().default(true),
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u, "MCP server ids use letters, digits, dots, dashes"),
	name: z.string().min(1).max(128),
	scope: mcpScopeSchema.default("admin"),
	surface: mcpSurfaceSchema.default("both"),
	timeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).default(30_000),
	transport: mcpTransportSchema,
});

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** An id may be omitted on create; the server derives a stable one from the name. */
export const mcpServerCreateSchema = z.object({
	allowedTools: z.array(z.string().min(1)).optional(),
	deferred: z.boolean().default(true),
	disabledTools: z.array(z.string().min(1)).optional(),
	enabled: z.boolean().default(true),
	id: mcpServerConfigSchema.shape.id.optional(),
	name: z.string().min(1).max(128),
	scope: mcpScopeSchema.default("admin"),
	surface: mcpSurfaceSchema.default("both"),
	timeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).default(30_000),
	transport: mcpTransportSchema,
});

export type McpServerCreate = z.infer<typeof mcpServerCreateSchema>;

/** Patch semantics: omitted fields stay unchanged, explicit empty arrays clear a filter. */
export const mcpServerUpdateSchema = z.object({
	allowedTools: z.array(z.string().min(1)).optional(),
	deferred: z.boolean().optional(),
	disabledTools: z.array(z.string().min(1)).optional(),
	enabled: z.boolean().optional(),
	id: z.string().min(1),
	name: z.string().min(1).max(128).optional(),
	scope: mcpScopeSchema.optional(),
	surface: mcpSurfaceSchema.optional(),
	timeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).optional(),
	transport: mcpTransportSchema.optional(),
});

export type McpServerUpdate = z.infer<typeof mcpServerUpdateSchema>;

export const mcpServerIdInputSchema = z.object({ id: z.string().min(1) });

export const mcpServerToggleInputSchema = z.object({
	enabled: z.boolean(),
	id: z.string().min(1),
});

export const mcpOAuthStartInputSchema = z.object({
	callbackOrigin: z.string().url().optional(),
	id: z.string().min(1),
});

export type McpOAuthStartInput = z.infer<typeof mcpOAuthStartInputSchema>;

export const mcpOAuthCompleteInputSchema = z
	.object({
		callbackUrl: z.string().url().optional(),
		code: z.string().min(1).optional(),
		id: z.string().min(1),
		state: z.string().min(1).optional(),
	})
	.refine((value) => value.callbackUrl !== undefined || value.code !== undefined, {
		message: "Either callbackUrl or code is required",
	});

export type McpOAuthCompleteInput = z.infer<typeof mcpOAuthCompleteInputSchema>;

export const mcpToolInfoSchema = z.object({
	description: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()),
	name: z.string().min(1),
});

export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

export const mcpHttpAuthViewSchema = z.discriminatedUnion("type", [
	mcpHttpAuthNoneSchema,
	z.object({
		token: z.string(),
		type: z.literal("bearer"),
	}),
	z.object({
		algorithm: z.string().optional(),
		clientId: z.string().optional(),
		clientMetadataUrl: z.string().optional(),
		clientName: z.string().optional(),
		clientSecret: z.string().optional(),
		expectedIssuer: z.string().optional(),
		grantType: mcpOAuthGrantTypeSchema,
		jwtLifetimeSeconds: z.number().int().optional(),
		privateKey: z.string().optional(),
		redirectUri: z.string().optional(),
		scope: z.string().optional(),
		tokenEndpointAuthMethod: mcpOAuthTokenAuthMethodSchema.optional(),
		type: z.literal("oauth"),
	}),
]);

/** Transport as shown to administrators: every secret value is replaced with the mask. */
export const mcpTransportViewSchema = z.discriminatedUnion("type", [
	z.object({
		args: z.array(z.string()).optional(),
		command: z.string().min(1),
		cwd: z.string().min(1).optional(),
		env: z.record(z.string(), z.string()).optional(),
		type: z.literal("stdio"),
	}),
	z.object({
		auth: mcpHttpAuthViewSchema.optional(),
		headers: z.record(z.string(), z.string()).optional(),
		type: z.literal("http"),
		url: z.string().url(),
	}),
]);

export const mcpOAuthStatusSchema = z.enum(["unauthenticated", "pending", "authorized", "error"]);

export type McpOAuthStatus = z.infer<typeof mcpOAuthStatusSchema>;

export const mcpOAuthSnapshotSchema = z.object({
	authorizationUrl: z.string().url().optional(),
	clientId: z.string().optional(),
	expiresAt: z.string().optional(),
	grantType: mcpOAuthGrantTypeSchema,
	hasRefreshToken: z.boolean(),
	issuer: z.string().optional(),
	pendingExpiresAt: z.string().optional(),
	redirectUrl: z.string().url().optional(),
	scope: z.string().optional(),
	status: mcpOAuthStatusSchema,
});

export type McpOAuthSnapshot = z.infer<typeof mcpOAuthSnapshotSchema>;

export const mcpServerConfigViewSchema = z.object({
	allowedTools: z.array(z.string()),
	configured: z.boolean(),
	deferred: z.boolean(),
	disabledTools: z.array(z.string()),
	enabled: z.boolean(),
	id: z.string().min(1),
	name: z.string().min(1),
	scope: mcpScopeSchema,
	/** Logical secret keys such as `env:API_KEY` or `header:Authorization`. */
	secretKeys: z.array(z.string()),
	surface: mcpSurfaceSchema,
	timeoutMs: z.number().int(),
	transport: mcpTransportViewSchema,
});

export type McpServerConfigView = z.infer<typeof mcpServerConfigViewSchema>;

export const mcpServerSnapshotSchema = mcpServerConfigViewSchema.extend({
	connectedAt: z.string().optional(),
	lastError: z.string().optional(),
	oauth: mcpOAuthSnapshotSchema.optional(),
	state: mcpServerStateSchema,
	tools: z.array(mcpToolInfoSchema),
});

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export const mcpServerDeleteResultSchema = z.object({
	deleted: z.boolean(),
	id: z.string().min(1),
});
