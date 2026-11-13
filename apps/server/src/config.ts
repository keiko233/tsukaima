import { z } from "zod";

const configurationSchema = z.object({
	adminEmail: z.string().email().optional(),
	adminPassword: z.string().min(1).optional(),
	adminUsername: z.string().min(1).optional(),
	authSecret: z.string().min(32).optional(),
	backupDrillIntervalMs: z.number().int().positive().optional(),
	backupDrillRoot: z.string().min(1).optional(),
	dataDir: z.string().min(1),
	host: z.string().min(1),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
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
	const config = configurationSchema.parse({
		adminEmail: env.ELAINA_ADMIN_EMAIL || undefined,
		adminPassword: env.ELAINA_ADMIN_PASSWORD || undefined,
		adminUsername: env.ELAINA_ADMIN_USERNAME || undefined,
		authSecret: env.ELAINA_AUTH_SECRET || env.BETTER_AUTH_SECRET || undefined,
		...(backupDrillIntervalMs === undefined ? {} : { backupDrillIntervalMs }),
		backupDrillRoot: env.ELAINA_BACKUP_DRILL_ROOT || undefined,
		dataDir: env.ELAINA_DATA_DIR ?? "./data",
		host: env.ELAINA_HOST ?? "127.0.0.1",
		logLevel: env.ELAINA_LOG_LEVEL ?? "info",
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
