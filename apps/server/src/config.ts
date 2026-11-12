import { z } from "zod";

const configurationSchema = z.object({
	adminEmail: z.string().email().optional(),
	adminPassword: z.string().min(1).optional(),
	adminUsername: z.string().min(1).optional(),
	authSecret: z.string().min(32).optional(),
	dataDir: z.string().min(1),
	host: z.string().min(1),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	openAiApiKey: z.string().min(1).optional(),
	openAiBaseUrl: z.string().url().optional(),
	openAiModelId: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65_535),
	publicUrl: z.string().url(),
	secureCookies: z.boolean(),
	webOrigin: z.string().url().optional(),
});

export type TsukaimaConfig = z.infer<typeof configurationSchema>;

export function loadConfig(env: Record<string, string | undefined>): TsukaimaConfig {
	const port = Number(env.TSUKAIMA_PORT ?? "7420");
	const publicUrl = env.TSUKAIMA_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
	const config = configurationSchema.parse({
		adminEmail: env.TSUKAIMA_ADMIN_EMAIL || undefined,
		adminPassword: env.TSUKAIMA_ADMIN_PASSWORD || undefined,
		adminUsername: env.TSUKAIMA_ADMIN_USERNAME || undefined,
		authSecret: env.TSUKAIMA_AUTH_SECRET || env.BETTER_AUTH_SECRET || undefined,
		dataDir: env.TSUKAIMA_DATA_DIR ?? "./data",
		host: env.TSUKAIMA_HOST ?? "127.0.0.1",
		logLevel: env.TSUKAIMA_LOG_LEVEL ?? "info",
		openAiApiKey: env.TSUKAIMA_OPENAI_API_KEY || undefined,
		openAiBaseUrl: env.TSUKAIMA_OPENAI_BASE_URL || undefined,
		openAiModelId: env.TSUKAIMA_OPENAI_MODEL_ID || undefined,
		port,
		publicUrl,
		secureCookies: env.TSUKAIMA_AUTH_SECURE_COOKIES === "true" || publicUrl.startsWith("https://"),
		webOrigin: env.TSUKAIMA_WEB_ORIGIN || undefined,
	});

	if (env.NODE_ENV === "production" && config.authSecret === undefined) {
		throw new Error("TSUKAIMA_AUTH_SECRET (or BETTER_AUTH_SECRET) is required in production");
	}

	return config;
}
