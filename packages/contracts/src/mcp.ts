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

export const mcpHttpTransportSchema = z.object({
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

export const mcpServerStateSchema = z.enum(["disconnected", "connecting", "connected", "error"]);

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

export const mcpToolInfoSchema = z.object({
	description: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown()),
	name: z.string().min(1),
});

export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

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
		headers: z.record(z.string(), z.string()).optional(),
		type: z.literal("http"),
		url: z.string().url(),
	}),
]);

export const mcpServerConfigViewSchema = z.object({
	allowedTools: z.array(z.string()),
	configured: z.boolean(),
	deferred: z.boolean(),
	disabledTools: z.array(z.string()),
	enabled: z.boolean(),
	id: z.string().min(1),
	name: z.string().min(1),
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
	state: mcpServerStateSchema,
	tools: z.array(mcpToolInfoSchema),
});

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export const mcpServerDeleteResultSchema = z.object({
	deleted: z.boolean(),
	id: z.string().min(1),
});
