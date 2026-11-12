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

export type ElainaConfig = z.infer<typeof configurationSchema>;

export function loadConfig(env: Record<string, string | undefined>): ElainaConfig {
	const config = configurationSchema.parse({
		dataDir: env.ELAINA_DATA_DIR ?? "./data",
		host: env.ELAINA_HOST ?? "127.0.0.1",
		logLevel: env.ELAINA_LOG_LEVEL ?? "info",
		onebotAccessToken: env.ELAINA_ONEBOT_ACCESS_TOKEN || undefined,
		onebotWsUrl: env.ELAINA_ONEBOT_WS_URL || undefined,
		openAiApiKey: env.ELAINA_OPENAI_API_KEY || undefined,
		openAiBaseUrl: env.ELAINA_OPENAI_BASE_URL || undefined,
		openAiModelId: env.ELAINA_OPENAI_MODEL_ID || undefined,
		port: Number(env.ELAINA_PORT ?? "7420"),
		webOrigin: env.ELAINA_WEB_ORIGIN ?? "http://127.0.0.1:7421",
	});

	if (
		config.onebotWsUrl &&
		!config.onebotWsUrl.startsWith("ws://") &&
		!config.onebotWsUrl.startsWith("wss://")
	) {
		throw new Error("ELAINA_ONEBOT_WS_URL must use ws:// or wss://");
	}

	return config;
}
