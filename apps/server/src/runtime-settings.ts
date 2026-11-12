import { eq } from "drizzle-orm";
import { type ElainaDatabase, meta } from "@elaina/db";
import { z } from "zod";

export const runtimeSettingsSchema = z.object({
	logLevel: z.enum(["debug", "info", "warn", "error"]),
	onebotAccessToken: z.string().min(1).optional(),
	onebotWsUrl: z.string().url().optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

const SETTINGS_KEY = "runtime-settings";

type SettingsValue = {
	logLevel: RuntimeSettings["logLevel"];
	onebotAccessToken?: string;
	onebotWsUrl?: string;
};

function normalize(input: RuntimeSettings): SettingsValue {
	return {
		logLevel: input.logLevel,
		...(input.onebotAccessToken === undefined
			? {}
			: { onebotAccessToken: input.onebotAccessToken }),
		...(input.onebotWsUrl === undefined ? {} : { onebotWsUrl: input.onebotWsUrl }),
	};
}

function parse(value: unknown): RuntimeSettings | undefined {
	const result = runtimeSettingsSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function parseValue(value: string | undefined): RuntimeSettings | undefined {
	if (value === undefined) return undefined;
	try {
		return parse(JSON.parse(value) as unknown);
	} catch {
		return undefined;
	}
}

export async function readRuntimeSettings(
	database: ElainaDatabase | undefined,
): Promise<RuntimeSettings> {
	if (database === undefined) {
		return { logLevel: "info" };
	}
	const rows = await database.select().from(meta).where(eq(meta.key, SETTINGS_KEY)).limit(1);
	return parseValue(rows[0]?.value) ?? { logLevel: "info" };
}

export async function writeRuntimeSettings(
	database: ElainaDatabase,
	input: RuntimeSettings,
): Promise<RuntimeSettings> {
	const value = JSON.stringify(normalize(runtimeSettingsSchema.parse(input)));
	await database
		.insert(meta)
		.values({ key: SETTINGS_KEY, value })
		.onConflictDoUpdate({ target: meta.key, set: { value } });
	return runtimeSettingsSchema.parse(JSON.parse(value) as unknown);
}
