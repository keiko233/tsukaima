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
	readonly chatModel?: RuntimeSettings["chatModel"];
	readonly chatThinking?: RuntimeSettings["chatThinking"];
	readonly logLevel: RuntimeSettings["logLevel"];
	readonly modelProviderId?: string;
	readonly sidechatModelId?: string;
	readonly workspaceModel?: RuntimeSettings["workspaceModel"];
	readonly workspaceThinking?: RuntimeSettings["workspaceThinking"];
}

const SETTINGS_KEY = "runtime-settings";

/**
 * `TSUKAIMA_LOG_LEVEL` is a bootstrap default for a fresh install, not a per-restart override:
 * the operator's persisted choice (including `trace`) must survive a redeploy. Startup only
 * applies the environment value when no runtime settings have been saved yet.
 */
export const DEFAULT_LOG_LEVEL = "info" as const;

type SettingsValue = {
	chatModel?: RuntimeSettings["chatModel"];
	chatThinking?: RuntimeSettings["chatThinking"];
	logLevel: RuntimeSettings["logLevel"];
	modelProviderId?: string;
	sidechatModelId?: string;
	workspaceModel?: RuntimeSettings["workspaceModel"];
	workspaceThinking?: RuntimeSettings["workspaceThinking"];
};

function normalize(input: RuntimeSettings): SettingsValue {
	return {
		...(input.chatModel === undefined ? {} : { chatModel: input.chatModel }),
		...(input.chatThinking === undefined ? {} : { chatThinking: input.chatThinking }),
		logLevel: input.logLevel,
		...(input.modelProviderId === undefined ? {} : { modelProviderId: input.modelProviderId }),
		...(input.sidechatModelId === undefined ? {} : { sidechatModelId: input.sidechatModelId }),
		...(input.workspaceModel === undefined ? {} : { workspaceModel: input.workspaceModel }),
		...(input.workspaceThinking === undefined
			? {}
			: { workspaceThinking: input.workspaceThinking }),
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
	if (database === undefined) return { logLevel: DEFAULT_LOG_LEVEL };
	const rows = await database.select().from(meta).where(eq(meta.key, SETTINGS_KEY)).limit(1);
	return parseValue(rows[0]?.value) ?? { logLevel: DEFAULT_LOG_LEVEL };
}

/**
 * `TSUKAIMA_LOG_LEVEL` is a bootstrap default for a fresh install, not a per-restart override:
 * the operator's persisted choice (including `trace`) must survive a redeploy. Startup only
 * applies it when no runtime settings have been saved yet.
 */
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
		...(settings.chatModel === undefined ? {} : { chatModel: settings.chatModel }),
		...(settings.chatThinking === undefined ? {} : { chatThinking: settings.chatThinking }),
		logLevel: settings.logLevel,
		...(settings.modelProviderId === undefined
			? {}
			: { modelProviderId: settings.modelProviderId }),
		...(settings.sidechatModelId === undefined
			? {}
			: { sidechatModelId: settings.sidechatModelId }),
		...(settings.workspaceModel === undefined ? {} : { workspaceModel: settings.workspaceModel }),
		...(settings.workspaceThinking === undefined
			? {}
			: { workspaceThinking: settings.workspaceThinking }),
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
	const sidechatModelId =
		patch.sidechatModelId === null || patch.sidechatModelId === ""
			? undefined
			: (patch.sidechatModelId ?? current.sidechatModelId);
	if (sidechatModelId !== undefined) next.sidechatModelId = sidechatModelId;
	const chatModel = patch.chatModel === null ? undefined : (patch.chatModel ?? current.chatModel);
	if (chatModel !== undefined) next.chatModel = chatModel;
	const workspaceModel =
		patch.workspaceModel === null ? undefined : (patch.workspaceModel ?? current.workspaceModel);
	if (workspaceModel !== undefined) next.workspaceModel = workspaceModel;
	const chatThinking =
		patch.chatThinking === null ? undefined : (patch.chatThinking ?? current.chatThinking);
	if (chatThinking !== undefined) next.chatThinking = chatThinking;
	const workspaceThinking =
		patch.workspaceThinking === null
			? undefined
			: (patch.workspaceThinking ?? current.workspaceThinking);
	if (workspaceThinking !== undefined) next.workspaceThinking = workspaceThinking;
	return writeRuntimeSettings(database, next);
}
