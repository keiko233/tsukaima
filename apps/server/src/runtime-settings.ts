import { eq } from "drizzle-orm";
import { type TsukaimaDatabase, meta } from "@tsukaima/db";
import {
	runtimeSettingsPatchSchema,
	runtimeSettingsSchema,
	type RuntimeSettings,
	type RuntimeSettingsPatch,
} from "@tsukaima/contracts";

export { runtimeSettingsPatchSchema, runtimeSettingsSchema };
export type { RuntimeSettings, RuntimeSettingsPatch };

export interface PublicRuntimeSettings {
	readonly logLevel: RuntimeSettings["logLevel"];
	readonly modelProviderId?: string;
}

const SETTINGS_KEY = "runtime-settings";

type SettingsValue = {
	logLevel: RuntimeSettings["logLevel"];
	modelProviderId?: string;
};

function normalize(input: RuntimeSettings): SettingsValue {
	return {
		logLevel: input.logLevel,
		...(input.modelProviderId === undefined ? {} : { modelProviderId: input.modelProviderId }),
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
	if (database === undefined) return { logLevel: "info" };
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
		...(settings.modelProviderId === undefined
			? {}
			: { modelProviderId: settings.modelProviderId }),
	};
}

export async function patchRuntimeSettings(
	database: TsukaimaDatabase,
	patch: RuntimeSettingsPatch,
): Promise<RuntimeSettings> {
	const current = await readRuntimeSettings(database);
	const next: RuntimeSettings = { logLevel: patch.logLevel ?? current.logLevel };
	const modelProviderId =
		patch.modelProviderId === null || patch.modelProviderId === ""
			? undefined
			: (patch.modelProviderId ?? current.modelProviderId);
	if (modelProviderId !== undefined) next.modelProviderId = modelProviderId;
	return writeRuntimeSettings(database, next);
}
