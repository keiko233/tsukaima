import { eq } from "drizzle-orm";
import { type ElainaDatabase, meta } from "@elaina/db";
import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const runtimeSettingsSchema = z.object({
	logLevel: logLevelSchema,
	openAiApiKey: z.string().min(1).optional(),
	openAiBaseUrl: z.string().url().optional(),
	openAiModelId: z.string().min(1).optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const runtimeSettingsPatchSchema = z
	.object({
		logLevel: logLevelSchema.optional(),
		openAiApiKey: z.union([z.string().min(1), z.null()]).optional(),
		openAiBaseUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
		openAiModelId: z.union([z.string().min(1), z.literal(""), z.null()]).optional(),
		// Legacy wire aliases for the onebot-napcat plugin config.
		onebotAccessToken: z.union([z.string().min(1), z.null()]).optional(),
		onebotWsUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
	})
	.refine(
		(input) =>
			input.logLevel !== undefined ||
			input.openAiApiKey !== undefined ||
			input.openAiBaseUrl !== undefined ||
			input.openAiModelId !== undefined ||
			input.onebotAccessToken !== undefined ||
			input.onebotWsUrl !== undefined,
		{ message: "At least one setting must be provided" },
	);

export type RuntimeSettingsPatch = z.infer<typeof runtimeSettingsPatchSchema>;

export interface PublicRuntimeSettings {
	readonly logLevel: RuntimeSettings["logLevel"];
	readonly openAiApiKeySet: boolean;
	readonly openAiBaseUrl?: string;
	readonly openAiModelId?: string;
}

const SETTINGS_KEY = "runtime-settings";

type SettingsValue = {
	logLevel: RuntimeSettings["logLevel"];
	openAiApiKey?: string;
	openAiBaseUrl?: string;
	openAiModelId?: string;
};

function normalize(input: RuntimeSettings): SettingsValue {
	return {
		logLevel: input.logLevel,
		...(input.openAiApiKey === undefined ? {} : { openAiApiKey: input.openAiApiKey }),
		...(input.openAiBaseUrl === undefined ? {} : { openAiBaseUrl: input.openAiBaseUrl }),
		...(input.openAiModelId === undefined ? {} : { openAiModelId: input.openAiModelId }),
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

export function publicRuntimeSettings(settings: RuntimeSettings): PublicRuntimeSettings {
	return {
		logLevel: settings.logLevel,
		openAiApiKeySet: settings.openAiApiKey !== undefined,
		...(settings.openAiBaseUrl === undefined ? {} : { openAiBaseUrl: settings.openAiBaseUrl }),
		...(settings.openAiModelId === undefined ? {} : { openAiModelId: settings.openAiModelId }),
	};
}

export async function patchRuntimeSettings(
	database: ElainaDatabase,
	patch: RuntimeSettingsPatch,
): Promise<RuntimeSettings> {
	const current = await readRuntimeSettings(database);
	const next: RuntimeSettings = {
		logLevel: patch.logLevel ?? current.logLevel,
	};
	const openAiApiKey =
		patch.openAiApiKey === null ? undefined : (patch.openAiApiKey ?? current.openAiApiKey);
	const openAiBaseUrl =
		patch.openAiBaseUrl === null || patch.openAiBaseUrl === ""
			? undefined
			: (patch.openAiBaseUrl ?? current.openAiBaseUrl);
	const openAiModelId =
		patch.openAiModelId === null || patch.openAiModelId === ""
			? undefined
			: (patch.openAiModelId ?? current.openAiModelId);
	if (openAiApiKey !== undefined) next.openAiApiKey = openAiApiKey;
	if (openAiBaseUrl !== undefined) next.openAiBaseUrl = openAiBaseUrl;
	if (openAiModelId !== undefined) next.openAiModelId = openAiModelId;
	return writeRuntimeSettings(database, next);
}
