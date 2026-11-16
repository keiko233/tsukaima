import { join } from "node:path";
import { logLevelSchema } from "@tsukaima/contracts";
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
	/**
	 * Git remote treated as upstream by the WebUI upgrade center. `origin` is the conventional
	 * default; forks can point this at their own canonical remote.
	 */
	upgradeRemote: z.string().min(1),
	webDistDir: z.string().min(1),
	webOrigin: z.string().url().optional(),
	/** Additional origins accepted by Better Auth's origin check, comma-separated in env. */
	trustedOrigins: z.array(z.string().url()),
	/** Reverse proxies whose forwarded client IP headers may be trusted. */
	trustedProxies: z.array(z.string().min(1)),
});

export type TsukaimaConfig = z.infer<typeof configurationSchema>;

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

export function loadConfig(env: Record<string, string | undefined>): TsukaimaConfig {
	const port = Number(env.TSUKAIMA_PORT ?? "7420");
	const publicUrl = env.TSUKAIMA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
	const isProduction = env.NODE_ENV === "production";
	const webOrigin = env.TSUKAIMA_WEB_ORIGIN || (isProduction ? undefined : "http://127.0.0.1:7421");
	const trustedOrigins = (env.TSUKAIMA_TRUSTED_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
	const trustedProxies = (env.TSUKAIMA_TRUSTED_PROXIES ?? "")
		.split(",")
		.map((proxy) => proxy.trim())
		.filter((proxy) => proxy.length > 0);
	const rawDrillInterval = env.TSUKAIMA_BACKUP_DRILL_INTERVAL_MS?.trim() ?? "";
	const parsedDrillInterval = rawDrillInterval === "" ? undefined : Number(rawDrillInterval);
	if (
		parsedDrillInterval !== undefined &&
		(!Number.isFinite(parsedDrillInterval) || parsedDrillInterval < 0)
	) {
		throw new Error(
			"TSUKAIMA_BACKUP_DRILL_INTERVAL_MS must be a non-negative number of milliseconds",
		);
	}
	// Zero disables the scheduler, matching the documented "unset or 0" behavior.
	const backupDrillIntervalMs =
		parsedDrillInterval === undefined || parsedDrillInterval === 0
			? undefined
			: parsedDrillInterval;

	const dataDir = env.TSUKAIMA_DATA_DIR ?? "./data";
	const webDistDir = env.TSUKAIMA_WEB_DIST?.trim() || join(process.cwd(), "apps/web/dist");
	const rawLogLevel = env.TSUKAIMA_LOG_LEVEL?.trim();
	const logLevelFromEnv = rawLogLevel !== undefined && rawLogLevel.length > 0;
	const logBufferCapacity =
		parseOptionalPositiveInt(env.TSUKAIMA_LOG_BUFFER_CAPACITY, "TSUKAIMA_LOG_BUFFER_CAPACITY") ??
		DEFAULT_LOG_BUFFER_CAPACITY;
	const logRetentionDays = parseOptionalPositiveInt(
		env.TSUKAIMA_LOG_RETENTION_DAYS,
		"TSUKAIMA_LOG_RETENTION_DAYS",
	);
	const logFileEnabled = env.TSUKAIMA_LOG_FILE_ENABLED?.trim().toLowerCase() !== "false";
	const rawLogDir = env.TSUKAIMA_LOG_DIR?.trim();
	const logDir = logFileEnabled
		? rawLogDir && rawLogDir.length > 0
			? rawLogDir
			: join(dataDir, "logs")
		: undefined;

	const config = configurationSchema.parse({
		adminEmail: env.TSUKAIMA_ADMIN_EMAIL || undefined,
		adminPassword: env.TSUKAIMA_ADMIN_PASSWORD || undefined,
		adminUsername: env.TSUKAIMA_ADMIN_USERNAME || undefined,
		authSecret: env.TSUKAIMA_AUTH_SECRET || env.BETTER_AUTH_SECRET || undefined,
		...(backupDrillIntervalMs === undefined ? {} : { backupDrillIntervalMs }),
		backupDrillRoot: env.TSUKAIMA_BACKUP_DRILL_ROOT || undefined,
		dataDir,
		host: env.TSUKAIMA_HOST ?? "127.0.0.1",
		logBufferCapacity,
		...(logDir === undefined ? {} : { logDir }),
		logFileEnabled,
		logLevel: logLevelFromEnv ? rawLogLevel : "info",
		logLevelFromEnv,
		...(logRetentionDays === undefined ? {} : { logRetentionDays }),
		port,
		publicUrl,
		secureCookies: env.TSUKAIMA_AUTH_SECURE_COOKIES === "true" || publicUrl.startsWith("https://"),
		upgradeRemote: env.TSUKAIMA_UPGRADE_REMOTE?.trim() || "origin",
		webDistDir,
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
		throw new Error("TSUKAIMA_AUTH_SECRET (or BETTER_AUTH_SECRET) is required in production");
	}

	return config;
}
