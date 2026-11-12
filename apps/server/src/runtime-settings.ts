import { eq } from "drizzle-orm";
import { type TsukaimaDatabase, meta } from "@tsukaima/db";
import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const runtimeSettingsSchema = z.object({
	logLevel: logLevelSchema,
	openAiApiKey: z.string().min(1).optional(),
	openAiBaseUrl: z.string().url().optional(),
	openAiModelId: z.string().min(1).optional(),
	onebotAccessToken: z.string().min(1).optional(),
	onebotWsUrl: z.string().url().optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

export const runtimeSettingsPatchSchema = z
	.object({
		logLevel: logLevelSchema.optional(),
		openAiApiKey: z.union([z.string().min(1), z.null()]).optional(),
		openAiBaseUrl: z.union([z.string().url(), z.literal(""), z.null()]).optional(),
		openAiModelId: z.union([z.string().min(1), z.literal(""), z.null()]).optional(),
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
	readonly onebotAccessTokenSet: boolean;
	readonly onebotWsUrl?: string;
}

const SETTINGS_KEY = "runtime-settings";

type SettingsValue = {
	logLevel: RuntimeSettings["logLevel"];
	openAiApiKey?: string;
	openAiBaseUrl?: string;
	openAiModelId?: string;
	onebotAccessToken?: string;
	onebotWsUrl?: string;
};

function normalize(input: RuntimeSettings): SettingsValue {
	return {
		logLevel: input.logLevel,
		...(input.openAiApiKey === undefined ? {} : { openAiApiKey: input.openAiApiKey }),
		...(input.openAiBaseUrl === undefined ? {} : { openAiBaseUrl: input.openAiBaseUrl }),
		...(input.openAiModelId === undefined ? {} : { openAiModelId: input.openAiModelId }),
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
	database: TsukaimaDatabase | undefined,
): Promise<RuntimeSettings> {
	if (database === undefined) {
		return { logLevel: "info" };
	}
	const rows = await database.select().from(meta).where(eq(meta.key, SETTINGS_KEY)).limit(1);
	return parseValue(rows[0]?.value) ?? { logLevel: "info" };
}

export async function writeRuntimeSettings(
	database: TsukaimaDatabase,
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
		onebotAccessTokenSet: settings.onebotAccessToken !== undefined,
		...(settings.onebotWsUrl === undefined ? {} : { onebotWsUrl: settings.onebotWsUrl }),
	};
}

export async function patchRuntimeSettings(
	database: TsukaimaDatabase,
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
	const onebotAccessToken =
		patch.onebotAccessToken === null
			? undefined
			: (patch.onebotAccessToken ?? current.onebotAccessToken);
	const onebotWsUrl =
		patch.onebotWsUrl === null || patch.onebotWsUrl === ""
			? undefined
			: (patch.onebotWsUrl ?? current.onebotWsUrl);
	if (openAiApiKey !== undefined) next.openAiApiKey = openAiApiKey;
	if (openAiBaseUrl !== undefined) next.openAiBaseUrl = openAiBaseUrl;
	if (openAiModelId !== undefined) next.openAiModelId = openAiModelId;
	if (onebotAccessToken !== undefined) next.onebotAccessToken = onebotAccessToken;
	if (onebotWsUrl !== undefined) next.onebotWsUrl = onebotWsUrl;
	return writeRuntimeSettings(database, next);
}
