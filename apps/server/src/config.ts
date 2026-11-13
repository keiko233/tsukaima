import { z } from "zod";

const configurationSchema = z.object({
	adminEmail: z.string().email().optional(),
	adminPassword: z.string().min(1).optional(),
	adminUsername: z.string().min(1).optional(),
	authSecret: z.string().min(32).optional(),
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

export type TsukaimaConfig = z.infer<typeof configurationSchema>;

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
	const config = configurationSchema.parse({
		adminEmail: env.TSUKAIMA_ADMIN_EMAIL || undefined,
		adminPassword: env.TSUKAIMA_ADMIN_PASSWORD || undefined,
		adminUsername: env.TSUKAIMA_ADMIN_USERNAME || undefined,
		authSecret: env.TSUKAIMA_AUTH_SECRET || env.BETTER_AUTH_SECRET || undefined,
		dataDir: env.TSUKAIMA_DATA_DIR ?? "./data",
		host: env.TSUKAIMA_HOST ?? "127.0.0.1",
		logLevel: env.TSUKAIMA_LOG_LEVEL ?? "info",
		port,
		publicUrl,
		secureCookies: env.TSUKAIMA_AUTH_SECURE_COOKIES === "true" || publicUrl.startsWith("https://"),
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
