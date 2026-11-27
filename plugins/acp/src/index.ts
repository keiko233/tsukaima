import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { MessagePart } from "@tsukaima/contracts";
import type {
	PluginContext,
	PluginImageReference,
	PluginModelPort,
	PluginTool,
	TsukaimaPlugin,
} from "@tsukaima/sdk";
import { z } from "zod";
import {
	acpPresetSchema,
	acpProviderIdForProfile,
	createPresetProfile,
	readAcpProfiles,
	resolveAcpProfiles,
	type ResolvedAcpProfile,
} from "./config.ts";
import { AcpRuntimeInstaller } from "./installer.ts";
import { ACP_PATHS_BINDING, ACP_PLUGIN_ID, acpManifest } from "./manifest.ts";
import { createAcpModelPort, type CreateAcpModelPortOptions } from "./model-port.ts";
import { createStdioAcpConnector, probeAcpProfile } from "./probe.ts";
import { AcpProcessManager, type AcpManagedClient, type AcpSpawnSpec } from "./process-manager.ts";
import {
	AcpVideoJobRegistry,
	createAcpModelProvider,
	runSandboxedAcpCapability,
} from "./provider.ts";

export * from "./manifest.ts";
export * from "./config.ts";
export * from "./protocol.ts";
export {
	AcpProcessManager,
	buildAcpProcessEnv,
	type AcpAcquireOptions,
	type AcpClientInitializeParams,
	type AcpClientLike,
	type AcpClientSessionHandlers,
	type AcpManagedClient,
	type AcpNewSessionInfo,
	type AcpNewSessionParams,
	type AcpProcessEnvOptions,
	type AcpProcessManagerOptions,
	type AcpProcessSnapshot,
	type AcpPromptCapabilities,
	type AcpPromptParams,
	type AcpSessionConfigOption,
	type AcpSessionContext,
	type AcpSessionModelInfo,
	type AcpSessionModels,
	type AcpSessionNotification,
	type AcpSetModelParams,
	type AcpSpawnSpec,
	type AcpWithSessionOptions,
} from "./process-manager.ts";
export * from "./artifacts.ts";
export * from "./installer.ts";
export * from "./probe.ts";
export * from "./model-port.ts";
export * from "./provider.ts";

export interface AcpHostPathsBinding {
	readonly artifactsRootDir?: string;
	readonly toolsRootDir?: string;
}

export type AcpModelPortFactory = (options: CreateAcpModelPortOptions) => PluginModelPort;

export interface AcpPluginOptions {
	readonly connect?: (spec: AcpSpawnSpec) => Promise<AcpManagedClient>;
	readonly createModelPort?: AcpModelPortFactory;
	readonly installer?: AcpRuntimeInstaller;
}

const probeInputSchema = z.object({
	args: z.array(z.string()).optional(),
	command: z.string().trim().min(1).optional(),
	cwd: z.string().trim().optional(),
	env: z.record(z.string(), z.string()).optional(),
	preset: acpPresetSchema.optional(),
	profileId: z.string().trim().min(1).optional(),
	requestTimeoutMs: z.number().int().min(1_000).max(900_000).optional(),
});

const runtimeActionInputSchema = z.object({
	id: z.string().trim().min(1).optional(),
	packageName: z.string().trim().min(1).optional(),
});

interface AcpPluginRuntime {
	artifactsRootDir: string;
	readonly connect: (spec: AcpSpawnSpec) => Promise<AcpManagedClient>;
	readonly createModelPort: AcpModelPortFactory;
	installer: AcpRuntimeInstaller;
	processManager: AcpProcessManager;
	readonly providers: Map<string, () => void>;
	readonly settingsUnsubscribers: Set<() => void>;
	toolRegistered: boolean;
	toolsRootDir: string;
	readonly videoJobs: AcpVideoJobRegistry;
}

const runtimes = new WeakMap<PluginContext, AcpPluginRuntime>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPluginSettings(context: PluginContext): Promise<Record<string, unknown>> {
	return ((await context.settings?.get()) ?? {}) as Record<string, unknown>;
}

function resolvePaths(
	context: PluginContext,
	raw: Record<string, unknown>,
): { readonly artifactsRootDir: string; readonly toolsRootDir: string } {
	const binding = context.dependencies?.get<AcpHostPathsBinding>(ACP_PATHS_BINDING);
	const envDataDir = process.env.TSUKAIMA_DATA_DIR?.trim();
	const defaultBase =
		envDataDir !== undefined && envDataDir.length > 0
			? resolve(envDataDir, "acp")
			: join(homedir(), ".tsukaima", "acp");
	const configuredTools =
		typeof raw.toolsRootDir === "string" && raw.toolsRootDir.trim().length > 0
			? raw.toolsRootDir.trim()
			: undefined;
	const configuredArtifacts =
		typeof raw.artifactsRootDir === "string" && raw.artifactsRootDir.trim().length > 0
			? raw.artifactsRootDir.trim()
			: undefined;
	return {
		artifactsRootDir:
			configuredArtifacts ?? binding?.artifactsRootDir ?? join(defaultBase, "artifacts"),
		toolsRootDir: configuredTools ?? binding?.toolsRootDir ?? join(defaultBase, "tools"),
	};
}

function createRuntime(
	context: PluginContext,
	raw: Record<string, unknown>,
	options: AcpPluginOptions = {},
): AcpPluginRuntime {
	const existing = runtimes.get(context);
	const paths = resolvePaths(context, raw);
	if (existing !== undefined) {
		if (
			existing.toolsRootDir !== paths.toolsRootDir ||
			existing.artifactsRootDir !== paths.artifactsRootDir
		) {
			existing.toolsRootDir = paths.toolsRootDir;
			existing.artifactsRootDir = paths.artifactsRootDir;
			if (options.installer === undefined) {
				existing.installer = new AcpRuntimeInstaller({
					...(context.audit === undefined ? {} : { audit: context.audit }),
					logger: context.logger,
					toolsRootDir: paths.toolsRootDir,
				});
			}
		}
		return existing;
	}

	const connect = options.connect ?? createStdioAcpConnector();
	const createModelPort = options.createModelPort ?? createAcpModelPort;
	const processManager = new AcpProcessManager({
		connect,
		toolsRootDir: paths.toolsRootDir,
	});
	const installer =
		options.installer ??
		new AcpRuntimeInstaller({
			...(context.audit === undefined ? {} : { audit: context.audit }),
			logger: context.logger,
			toolsRootDir: paths.toolsRootDir,
		});
	const runtime: AcpPluginRuntime = {
		artifactsRootDir: paths.artifactsRootDir,
		connect,
		createModelPort,
		installer,
		processManager,
		providers: new Map(),
		settingsUnsubscribers: new Set(),
		toolRegistered: false,
		toolsRootDir: paths.toolsRootDir,
		videoJobs: new AcpVideoJobRegistry(),
	};
	runtimes.set(context, runtime);
	return runtime;
}

function syncProviders(
	context: PluginContext,
	runtime: AcpPluginRuntime,
	raw: Record<string, unknown>,
): readonly ResolvedAcpProfile[] {
	const paths = resolvePaths(context, raw);
	if (runtime.toolsRootDir !== paths.toolsRootDir) {
		runtime.toolsRootDir = paths.toolsRootDir;
	}
	runtime.artifactsRootDir = paths.artifactsRootDir;

	const profiles = resolveAcpProfiles(raw);
	const desired = new Set(profiles.map((profile) => profile.providerId));
	for (const [providerId, unregister] of runtime.providers) {
		if (!desired.has(providerId)) {
			unregister();
			runtime.providers.delete(providerId);
			const profileId = providerId.replace(/^acp:/u, "");
			void runtime.processManager.invalidateProfile(profileId);
		}
	}
	for (const profile of profiles) {
		runtime.providers.get(profile.providerId)?.();
		runtime.providers.delete(profile.providerId);
		const unregister = context.models.registerProvider(
			createAcpModelProvider({
				artifactsRootDir: runtime.artifactsRootDir,
				createPortImpl: (portOptions) =>
					runtime.createModelPort({
						logger: context.logger.child?.(`acp.${profile.id}`) ?? context.logger,
						...(portOptions.onMessage === undefined
							? {}
							: {
									onMessage: (message) => {
										portOptions.onMessage?.(message);
									},
								}),
						processManager: runtime.processManager,
						profile,
						toolsRootDir: runtime.toolsRootDir,
					}),
				logger: context.logger.child?.(`acp.${profile.id}`) ?? context.logger,
				processManager: runtime.processManager,
				profile,
				videoJobs: runtime.videoJobs,
			}),
		);
		runtime.providers.set(profile.providerId, unregister);
	}
	return profiles;
}

function createRunCapabilityTool(context: PluginContext, runtime: AcpPluginRuntime): PluginTool {
	return {
		description:
			"Run a sandboxed custom ACP CLI capability (such as specialized asset generation) and automatically store and send any generated media to the current conversation.",
		lazy: true,
		modelName: "acp_run_capability",
		name: `${ACP_PLUGIN_ID}.run_capability`,
		parameters: {
			additionalProperties: false,
			properties: {
				modelId: {
					description: "Optional model id to select inside the ACP session.",
					type: "string",
				},
				profileId: {
					description: "ACP profile id to invoke.",
					type: "string",
				},
				prompt: {
					description: "Instruction for the ACP capability run.",
					type: "string",
				},
				referenceMediaIds: {
					description: "Optional stored image media IDs to stage into the sandbox.",
					items: { type: "string" },
					type: "array",
				},
				sendToChat: {
					description:
						"Deliver extracted images/videos/audios to the current conversation (default true).",
					type: "boolean",
				},
			},
			required: ["profileId", "prompt"],
			type: "object",
		},
		requiredPermissions: ["media.read", "media.write", "channel.send"],
		surface: "both",
		async execute(input, toolContext) {
			const raw = await readPluginSettings(context);
			const profiles = resolveAcpProfiles(raw);
			const profileId = typeof input.profileId === "string" ? input.profileId.trim() : "";
			const promptText = typeof input.prompt === "string" ? input.prompt.trim() : "";
			if (profileId.length === 0 || promptText.length === 0) {
				throw new Error("profileId and prompt are required");
			}
			const profile = profiles.find((candidate) => candidate.id === profileId);
			if (profile === undefined || !profile.supportsCapabilityTool) {
				throw new Error(`ACP profile "${profileId}" does not expose run_capability`);
			}
			if (
				(toolContext.chatKind === "private" || toolContext.chatKind === "group") &&
				!profile.allowedCapabilityChat &&
				toolContext.isAdmin !== true
			) {
				throw new Error(`ACP capability on profile "${profileId}" is not enabled for IM chat`);
			}

			const referenceImages: PluginImageReference[] = [];
			if (Array.isArray(input.referenceMediaIds) && context.media !== undefined) {
				for (const mediaId of input.referenceMediaIds) {
					if (typeof mediaId !== "string" || mediaId.trim().length === 0) continue;
					const record = await context.media.findById(mediaId.trim());
					if (record === undefined || (record.kind !== "image" && record.kind !== "sticker")) {
						throw new Error(`Reference media ${mediaId} is missing or not an image`);
					}
					const bytes = await context.media.readBytes(record.id);
					referenceImages.push({ bytes, mimeType: record.mimeType });
				}
			}

			const output = await runSandboxedAcpCapability({
				artifactsRootDir: runtime.artifactsRootDir,
				...(typeof input.modelId === "string" && input.modelId.trim().length > 0
					? { modelId: input.modelId.trim() }
					: {}),
				processManager: runtime.processManager,
				profile,
				promptText,
				...(referenceImages.length === 0 ? {} : { referenceImages }),
				...(toolContext.signal === undefined ? {} : { signal: toolContext.signal }),
			});

			const storedParts: MessagePart[] = [];
			const storedIds: string[] = [];
			const previewImages: { readonly data: string; readonly mimeType: string }[] = [];
			if (context.media !== undefined) {
				for (const image of output.images) {
					const stored = await context.media.store({
						bytes: image.bytes,
						kind: "image",
						metadata: { plugin: ACP_PLUGIN_ID, profileId: profile.id },
						mimeType: image.mimeType,
						source: "generated",
					});
					storedIds.push(stored.id);
					storedParts.push({
						mediaId: stored.id,
						mimeType: stored.mimeType,
						sha256: stored.sha256,
						sizeBytes: stored.sizeBytes,
						type: "image",
					});
					previewImages.push({
						data: Buffer.from(image.bytes).toString("base64"),
						mimeType: stored.mimeType,
					});
				}
				for (const video of output.videos) {
					const stored = await context.media.store({
						bytes: video.bytes,
						kind: "video",
						metadata: { plugin: ACP_PLUGIN_ID, profileId: profile.id },
						mimeType: video.mimeType,
						source: "generated",
					});
					storedIds.push(stored.id);
					storedParts.push({
						mediaId: stored.id,
						mimeType: stored.mimeType,
						sha256: stored.sha256,
						sizeBytes: stored.sizeBytes,
						type: "video",
					});
				}
				for (const audio of output.audios) {
					const stored = await context.media.store({
						bytes: audio.bytes,
						kind: "audio",
						metadata: { plugin: ACP_PLUGIN_ID, profileId: profile.id },
						mimeType: audio.mimeType,
						source: "generated",
					});
					storedIds.push(stored.id);
					storedParts.push({
						mediaId: stored.id,
						mimeType: stored.mimeType,
						sha256: stored.sha256,
						sizeBytes: stored.sizeBytes,
						type: "audio",
					});
				}
			}

			let delivered = false;
			if (
				input.sendToChat !== false &&
				storedParts.length > 0 &&
				toolContext.conversationId !== undefined &&
				context.outbound !== undefined
			) {
				await context.outbound.sendToConversation({
					conversationId: toolContext.conversationId,
					parts: storedParts,
				});
				delivered = true;
			}

			return {
				content: [
					{
						text: JSON.stringify({
							delivered,
							mediaIds: storedIds,
							profileId: profile.id,
							text: output.assistantText,
						}),
						type: "text",
					},
				],
				...(previewImages.length === 0 ? {} : { images: previewImages }),
			};
		},
	};
}

function syncCapabilityTool(
	context: PluginContext,
	runtime: AcpPluginRuntime,
	profiles: readonly ResolvedAcpProfile[],
): void {
	const shouldRegister = profiles.some((profile) => profile.supportsCapabilityTool);
	const toolName = `${ACP_PLUGIN_ID}.run_capability`;
	if (shouldRegister && !runtime.toolRegistered) {
		context.tools.register(createRunCapabilityTool(context, runtime));
		runtime.toolRegistered = true;
	} else if (!shouldRegister && runtime.toolRegistered) {
		context.tools.unregister(toolName);
		runtime.toolRegistered = false;
	}
}

function reportStatus(context: PluginContext, raw: Record<string, unknown>): void {
	const profiles = resolveAcpProfiles(raw);
	if (profiles.length === 0) {
		context.ui.setStatus({
			code: "status_unconfigured",
			level: "unknown",
			summary: "No ACP CLI profiles enabled",
		});
		return;
	}
	const enabledModels = profiles.reduce(
		(total, profile) => total + profile.enabledModels.length,
		0,
	);
	const imageEnabled = profiles.filter((profile) => profile.supportsImageGeneration).length;
	const videoEnabled = profiles.filter((profile) => profile.supportsVideoGeneration).length;
	context.ui.setStatus({
		code: "status_configured",
		details: {
			profiles: profiles.map((profile) => acpProviderIdForProfile(profile.id)).join(", "),
		},
		level: "ok",
		metrics: {
			imageProfiles: imageEnabled,
			models: enabledModels,
			profiles: profiles.length,
			videoProfiles: videoEnabled,
		},
		summary: `${profiles.length} ACP profile(s) · ${enabledModels} models`,
	});
}

export function createAcpPlugin(options: AcpPluginOptions = {}): TsukaimaPlugin {
	return {
		manifest: acpManifest,
		async prepare(context) {
			const raw = await readPluginSettings(context);
			const runtime = createRuntime(context, raw, options);
			const profiles = syncProviders(context, runtime, raw);
			syncCapabilityTool(context, runtime, profiles);
			const unsubscribe = context.settings?.onChange((value) => {
				const nextRaw = isRecord(value) ? value : {};
				const updated = syncProviders(context, runtime, nextRaw);
				syncCapabilityTool(context, runtime, updated);
			});
			if (unsubscribe !== undefined) runtime.settingsUnsubscribers.add(unsubscribe);
			context.logger.info("ACP plugin providers prepared", {
				profiles: profiles.length,
			});
		},
		async setup(context) {
			const raw = await readPluginSettings(context);
			const runtime = createRuntime(context, raw, options);
			reportStatus(context, raw);
			const unsubscribe = context.settings?.onChange((value) => {
				reportStatus(context, isRecord(value) ? value : {});
			});
			if (unsubscribe !== undefined) runtime.settingsUnsubscribers.add(unsubscribe);

			context.rpc.register("probe", async (input) => {
				const parsed = probeInputSchema.parse(input ?? {});
				const currentRaw = await readPluginSettings(context);
				const profiles = readAcpProfiles(currentRaw);
				const matched =
					parsed.profileId === undefined
						? undefined
						: profiles.find((candidate) => candidate.id === parsed.profileId);
				const base =
					matched ??
					(() => {
						const preset = createPresetProfile(parsed.preset ?? "custom", {
							id: parsed.profileId ?? "probe",
							...(parsed.command === undefined ? {} : { command: parsed.command }),
						});
						return {
							allowedCapabilityChat: preset.allowedCapabilityChat,
							args: preset.args,
							command: preset.command,
							...(preset.cwd === undefined || preset.cwd.length === 0 ? {} : { cwd: preset.cwd }),
							enableAsModelProvider: preset.enableAsModelProvider,
							enabled: preset.enabled,
							env: preset.env,
							id: preset.id,
							idleTtlMs: preset.idleTtlMs,
							models: preset.models,
							...(preset.name === undefined || preset.name.length === 0
								? {}
								: { name: preset.name }),
							preset: preset.preset,
							providerId: acpProviderIdForProfile(preset.id),
							requestTimeoutMs: preset.requestTimeoutMs,
							supportsCapabilityTool: preset.supportsCapabilityTool,
							supportsImageGeneration: preset.supportsImageGeneration,
							supportsVideoGeneration: preset.supportsVideoGeneration,
							toolBridgeMode: preset.toolBridgeMode,
						};
					})();
				const targetProfile = {
					...base,
					...(parsed.args === undefined ? {} : { args: parsed.args }),
					...(parsed.command === undefined ? {} : { command: parsed.command }),
					...(parsed.cwd === undefined || parsed.cwd.length === 0 ? {} : { cwd: parsed.cwd }),
					env: {
						...base.env,
						...parsed.env,
					},
					...(parsed.requestTimeoutMs === undefined
						? {}
						: { requestTimeoutMs: parsed.requestTimeoutMs }),
				};
				return await probeAcpProfile(targetProfile, {
					artifactsRootDir: runtime.artifactsRootDir,
					toolsRootDir: runtime.toolsRootDir,
				});
			});

			context.rpc.register("runtime.status", async () => await runtime.installer.status());
			context.rpc.register("runtime.install", async (input) => {
				const parsed = runtimeActionInputSchema.parse(input ?? {});
				return await runtime.installer.install({
					...(parsed.id === undefined ? {} : { id: parsed.id }),
					...(parsed.packageName === undefined ? {} : { packageName: parsed.packageName }),
				});
			});
			context.rpc.register("runtime.uninstall", async (input) => {
				const parsed = runtimeActionInputSchema.parse(input ?? {});
				return await runtime.installer.uninstall({
					...(parsed.id === undefined ? {} : { id: parsed.id }),
					...(parsed.packageName === undefined ? {} : { packageName: parsed.packageName }),
				});
			});
			context.logger.info("ACP plugin ready", {
				artifactsRootDir: runtime.artifactsRootDir,
				toolsRootDir: runtime.toolsRootDir,
			});
		},
		async teardown(context) {
			const runtime = runtimes.get(context);
			if (runtime === undefined) return;
			runtimes.delete(context);
			runtime.videoJobs.dispose();
			for (const unregister of runtime.providers.values()) unregister();
			runtime.providers.clear();
			if (runtime.toolRegistered) {
				context.tools.unregister(`${ACP_PLUGIN_ID}.run_capability`);
				runtime.toolRegistered = false;
			}
			for (const unsubscribe of runtime.settingsUnsubscribers) unsubscribe();
			runtime.settingsUnsubscribers.clear();
			await runtime.processManager.disposeAll();
			context.ui.setStatus(null);
			context.logger.info("ACP plugin stopped");
		},
	};
}

export const acpPlugin: TsukaimaPlugin = createAcpPlugin();

export default acpPlugin;
