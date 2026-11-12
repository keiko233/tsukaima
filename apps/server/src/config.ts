import { z } from "zod";

const configurationSchema = z.object({
	dataDir: z.string().min(1),
	host: z.string().min(1),
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	onebotAccessToken: z.string().min(1).optional(),
	onebotWsUrl: z.string().url().optional(),
	openAiApiKey: z.string().min(1).optional(),
	openAiBaseUrl: z.string().url().optional(),
	openAiModelId: z.string().min(1).optional(),
	port: z.number().int().min(1).max(65_535),
	webOrigin: z.string().url(),
});

export type TsukaimaConfig = z.infer<typeof configurationSchema>;

export function loadConfig(env: Record<string, string | undefined>): TsukaimaConfig {
	const config = configurationSchema.parse({
		dataDir: env.TSUKAIMA_DATA_DIR ?? "./data",
		host: env.TSUKAIMA_HOST ?? "127.0.0.1",
		logLevel: env.TSUKAIMA_LOG_LEVEL ?? "info",
		onebotAccessToken: env.TSUKAIMA_ONEBOT_ACCESS_TOKEN || undefined,
		onebotWsUrl: env.TSUKAIMA_ONEBOT_WS_URL || undefined,
		openAiApiKey: env.TSUKAIMA_OPENAI_API_KEY || undefined,
		openAiBaseUrl: env.TSUKAIMA_OPENAI_BASE_URL || undefined,
		openAiModelId: env.TSUKAIMA_OPENAI_MODEL_ID || undefined,
		port: Number(env.TSUKAIMA_PORT ?? "7420"),
		webOrigin: env.TSUKAIMA_WEB_ORIGIN ?? "http://127.0.0.1:7421",
	});

	if (
		config.onebotWsUrl &&
		!config.onebotWsUrl.startsWith("ws://") &&
		!config.onebotWsUrl.startsWith("wss://")
	) {
		throw new Error("TSUKAIMA_ONEBOT_WS_URL must use ws:// or wss://");
	}

	return config;
}
