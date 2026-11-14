import { join } from "node:path";
import { logLevelSchema } from "@elaina/contracts";
import { z } from "zod";

const DEFAULT_LOG_BUFFER_CAPACITY = 5_000;

const configurationSchema = z.object({
	adminEmail: z.string().email().optional(),
	adminPassword: z.string().min(1).optional(),
	adminUsername: z.string().min(1).optional(),
	authSecret: z.string().min(32).optional(),
	backupDrillIntervalMs: z.number().int().positive().optional(),
	backupDrillRoot: z.string().min(1).optional(),
	dataDir: z.string().min(1),
	host: z.string().min(1),
	logBufferCapacity: z.number().int().positive().max(100_000),
	logDir: z.string().min(1).optional(),
	logFileEnabled: z.boolean(),
	logLevel: logLevelSchema,
	logLevelFromEnv: z.boolean(),
	logRetentionDays: z.number().int().positive().optional(),
	port: z.number().int().min(1).max(65_535),
	publicUrl: z.string().url(),
	secureCookies: z.boolean(),
	webOrigin: z.string().url().optional(),
	/** Additional origins accepted by Better Auth's origin check, comma-separated in env. */
	trustedOrigins: z.array(z.string().url()),
	/** Reverse proxies whose forwarded client IP headers may be trusted. */
	trustedProxies: z.array(z.string().min(1)),
});

export type ElainaConfig = z.infer<typeof configurationSchema>;

function parseOptionalPositiveInt(
	rawValue: string | undefined,
	envName: string,
): number | undefined {
	const trimmed = rawValue?.trim() ?? "";
	if (trimmed === "") return undefined;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${envName} must be a positive integer`);
	}
	return parsed;
}

export function loadConfig(env: Record<string, string | undefined>): ElainaConfig {
	const port = Number(env.ELAINA_PORT ?? "7420");
	const publicUrl = env.ELAINA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
	const isProduction = env.NODE_ENV === "production";
	const webOrigin = env.ELAINA_WEB_ORIGIN || (isProduction ? undefined : "http://127.0.0.1:7421");
	const trustedOrigins = (env.ELAINA_TRUSTED_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
	const trustedProxies = (env.ELAINA_TRUSTED_PROXIES ?? "")
		.split(",")
		.map((proxy) => proxy.trim())
		.filter((proxy) => proxy.length > 0);
	const rawDrillInterval = env.ELAINA_BACKUP_DRILL_INTERVAL_MS?.trim() ?? "";
	const parsedDrillInterval = rawDrillInterval === "" ? undefined : Number(rawDrillInterval);
	if (
		parsedDrillInterval !== undefined &&
		(!Number.isFinite(parsedDrillInterval) || parsedDrillInterval < 0)
	) {
		throw new Error(
			"ELAINA_BACKUP_DRILL_INTERVAL_MS must be a non-negative number of milliseconds",
		);
	}
	// Zero disables the scheduler, matching the documented "unset or 0" behavior.
	const backupDrillIntervalMs =
		parsedDrillInterval === undefined || parsedDrillInterval === 0
			? undefined
			: parsedDrillInterval;

	const dataDir = env.ELAINA_DATA_DIR ?? "./data";
	const rawLogLevel = env.ELAINA_LOG_LEVEL?.trim();
	const logLevelFromEnv = rawLogLevel !== undefined && rawLogLevel.length > 0;
	const logBufferCapacity =
		parseOptionalPositiveInt(env.ELAINA_LOG_BUFFER_CAPACITY, "ELAINA_LOG_BUFFER_CAPACITY") ??
		DEFAULT_LOG_BUFFER_CAPACITY;
	const logRetentionDays = parseOptionalPositiveInt(
		env.ELAINA_LOG_RETENTION_DAYS,
		"ELAINA_LOG_RETENTION_DAYS",
	);
	const logFileEnabled = env.ELAINA_LOG_FILE_ENABLED?.trim().toLowerCase() !== "false";
	const rawLogDir = env.ELAINA_LOG_DIR?.trim();
	const logDir = logFileEnabled
		? rawLogDir && rawLogDir.length > 0
			? rawLogDir
			: join(dataDir, "logs")
		: undefined;

	const config = configurationSchema.parse({
		adminEmail: env.ELAINA_ADMIN_EMAIL || undefined,
		adminPassword: env.ELAINA_ADMIN_PASSWORD || undefined,
		adminUsername: env.ELAINA_ADMIN_USERNAME || undefined,
		authSecret: env.ELAINA_AUTH_SECRET || env.BETTER_AUTH_SECRET || undefined,
		...(backupDrillIntervalMs === undefined ? {} : { backupDrillIntervalMs }),
		backupDrillRoot: env.ELAINA_BACKUP_DRILL_ROOT || undefined,
		dataDir,
		host: env.ELAINA_HOST ?? "127.0.0.1",
		logBufferCapacity,
		...(logDir === undefined ? {} : { logDir }),
		logFileEnabled,
		logLevel: logLevelFromEnv ? rawLogLevel : "info",
		logLevelFromEnv,
		...(logRetentionDays === undefined ? {} : { logRetentionDays }),
		port,
		publicUrl,
		secureCookies: env.ELAINA_AUTH_SECURE_COOKIES === "true" || publicUrl.startsWith("https://"),
		webOrigin,
		trustedOrigins: [
			...new Set([
				...(webOrigin === undefined ? [] : [webOrigin]),
				...(isProduction ? [] : ["http://localhost:7421"]),
				...trustedOrigins,
			]),
		],
		trustedProxies,
	});

	if (env.NODE_ENV === "production" && config.authSecret === undefined) {
		throw new Error("ELAINA_AUTH_SECRET (or BETTER_AUTH_SECRET) is required in production");
	}

	return config;
}
