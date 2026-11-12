import { z } from "zod";

const configurationSchema = z.object({
	adminPassword: z.string().min(1).optional(),
	adminUsername: z.string().min(1).optional(),
	dataDir: z.string().min(1),
	host: z.string().min(1),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	openAiApiKey: z.string().min(1).optional(),
	openAiBaseUrl: z.string().url().optional(),
	openAiModelId: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65_535),
});

export type TsukaimaConfig = z.infer<typeof configurationSchema>;

export function loadConfig(env: Record<string, string | undefined>): TsukaimaConfig {
	const config = configurationSchema.parse({
		adminPassword: env.TSUKAIMA_ADMIN_PASSWORD || undefined,
		adminUsername: env.TSUKAIMA_ADMIN_USERNAME || undefined,
		dataDir: env.TSUKAIMA_DATA_DIR ?? "./data",
		host: env.TSUKAIMA_HOST ?? "127.0.0.1",
		logLevel: env.TSUKAIMA_LOG_LEVEL ?? "info",
		openAiApiKey: env.TSUKAIMA_OPENAI_API_KEY || undefined,
		openAiBaseUrl: env.TSUKAIMA_OPENAI_BASE_URL || undefined,
		openAiModelId: env.TSUKAIMA_OPENAI_MODEL_ID || undefined,
		port: Number(env.TSUKAIMA_PORT ?? "7420"),
	});

	return config;
}
