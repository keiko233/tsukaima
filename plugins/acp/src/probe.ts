import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadAcpProfile } from "./config.ts";
import { withArtifactSandbox } from "./artifacts.ts";
import {
	AcpProcessManager,
	type AcpManagedClient,
	type AcpPromptCapabilities,
	type AcpSpawnSpec,
} from "./process-manager.ts";
import {
	connectAcpStdio,
	type AcpClient,
	type AcpContentBlock,
	type AcpModelInfo,
	type AcpPromptInput,
} from "./protocol.ts";

export interface StdioAcpConnectorOptions {
	readonly onInitialized?: (client: AcpClient, result: unknown) => void;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/** Creates an `AcpProcessManager` connector backed by `connectAcpStdio`. */
export function createStdioAcpConnector(
	options: StdioAcpConnectorOptions = {},
): (spec: AcpSpawnSpec) => Promise<AcpManagedClient> {
	return async (spec) => {
		const requestTimeoutMs = options.timeoutMs ?? spec.profile.requestTimeoutMs;
		const client = connectAcpStdio({
			args: spec.args,
			command: spec.command,
			cwd: spec.cwd,
			env: spec.env,
			requestTimeoutMs,
		});
		return {
			get closed() {
				return client.closed;
			},
			close: () => client.close(),
			initialize: async (params) => {
				const result = await client.initialize(params.clientInfo, { timeoutMs: requestTimeoutMs });
				options.onInitialized?.(client, result);
				return result;
			},
			newSession: async (params) => {
				const result = await client.newSession(
					{
						cwd: params.cwd,
						...(params.mcpServers === undefined ? {} : { mcpServers: params.mcpServers as never }),
					},
					{
						...(options.signal === undefined ? {} : { signal: options.signal }),
						timeoutMs: requestTimeoutMs,
					},
				);
				return {
					availableModels: result.availableModels.map((model) => ({
						modelId: model.id,
						...(model.name === undefined ? {} : { name: model.name }),
						...(model.description === undefined ? {} : { description: model.description }),
					})),
					...(result.configOptions === undefined
						? {}
						: {
								configOptions: result.configOptions.map((option) => ({
									id: option.id,
									name: option.name,
									type: option.type ?? "select",
									...(option.currentValue === undefined
										? {}
										: { currentValue: option.currentValue }),
									...(option.options === undefined ? {} : { options: option.options }),
								})),
							}),
					sessionId: result.sessionId,
				};
			},
			prompt: (params) =>
				client.prompt({
					...(params as Omit<AcpPromptInput, "prompt">),
					prompt: params.prompt as readonly AcpContentBlock[],
				}),
			setModel: (params) => client.setModel(params, { timeoutMs: requestTimeoutMs }),
			setSessionHandlers: (sessionId: string, handlers: unknown) =>
				client.setSessionHandlers(sessionId, handlers as never),
		} as AcpManagedClient;
	};
}

export interface AcpProbeResult {
	readonly ok: boolean;
	readonly profileId: string;
	readonly agentInfo?: {
		readonly name?: string;
		readonly title?: string;
		readonly version?: string;
	};
	readonly models: readonly AcpModelInfo[];
	readonly promptCapabilities?: AcpPromptCapabilities;
	readonly availableCommands: readonly string[];
	readonly stderr?: string;
	readonly error?: string;
}

export async function probeAcpProfile(
	profile: ReadAcpProfile,
	options: {
		readonly artifactsRootDir?: string;
		readonly hostEnv?: Readonly<Record<string, string | undefined>>;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
		readonly toolsRootDir?: string;
	} = {},
): Promise<AcpProbeResult> {
	const timeoutMs = Math.min(options.timeoutMs ?? 20_000, profile.requestTimeoutMs);
	const artifactsRootDir = options.artifactsRootDir ?? join(tmpdir(), "tsukaima-acp-probe");
	let capturedClient: AcpClient | undefined;
	let initResult: unknown;
	const manager = new AcpProcessManager({
		connect: createStdioAcpConnector({
			onInitialized: (client, result) => {
				capturedClient = client;
				initResult = result;
			},
			...(options.signal === undefined ? {} : { signal: options.signal }),
			timeoutMs,
		}),
		...(options.hostEnv === undefined ? {} : { hostEnv: options.hostEnv }),
		initializeParams: {
			clientInfo: { name: "tsukaima-acp-probe", version: "0.36.0" },
		},
		...(options.toolsRootDir === undefined ? {} : { toolsRootDir: options.toolsRootDir }),
	});

	try {
		return await withArtifactSandbox(
			artifactsRootDir,
			`probe-${profile.id}`,
			async ({ artifactDir }) => {
				const session = await manager.withSession(
					profile,
					{
						capabilitiesKey: "probe",
						cwd: profile.cwd ?? artifactDir,
						...(options.signal === undefined ? {} : { signal: options.signal }),
					},
					(ctx) => ctx,
				);
				const initRecord = isRecord(initResult) ? initResult : {};
				const agentCaps = isRecord(initRecord.agentCapabilities)
					? initRecord.agentCapabilities
					: undefined;
				const promptCapsRaw = isRecord(agentCaps?.promptCapabilities)
					? agentCaps.promptCapabilities
					: undefined;
				const promptCapabilities: AcpPromptCapabilities | undefined =
					promptCapsRaw === undefined
						? undefined
						: {
								...(typeof promptCapsRaw.audio === "boolean" ? { audio: promptCapsRaw.audio } : {}),
								...(typeof promptCapsRaw.embeddedContext === "boolean"
									? { embeddedContext: promptCapsRaw.embeddedContext }
									: {}),
								...(typeof promptCapsRaw.image === "boolean" ? { image: promptCapsRaw.image } : {}),
							};
				const agentInfoRaw = isRecord(initRecord.agentInfo) ? initRecord.agentInfo : undefined;
				const agentInfo =
					agentInfoRaw === undefined
						? undefined
						: {
								...(typeof agentInfoRaw.name === "string" ? { name: agentInfoRaw.name } : {}),
								...(typeof agentInfoRaw.title === "string" ? { title: agentInfoRaw.title } : {}),
								...(typeof agentInfoRaw.version === "string"
									? { version: agentInfoRaw.version }
									: {}),
							};

				const models: AcpModelInfo[] = (session.availableModels ?? []).map((model) => ({
					id: model.modelId,
					...(model.name === undefined ? {} : { name: model.name }),
					...(model.description === undefined ? {} : { description: model.description }),
				}));
				const stderr = capturedClient?.getStderr().trim();
				return {
					availableCommands: [],
					models,
					ok: true,
					profileId: profile.id,
					...(agentInfo === undefined ? {} : { agentInfo }),
					...(promptCapabilities === undefined ? {} : { promptCapabilities }),
					...(stderr === undefined || stderr.length === 0 ? {} : { stderr: stderr.slice(-1024) }),
				};
			},
		);
	} catch (error) {
		const stderr = capturedClient?.getStderr().trim();
		return {
			availableCommands: [],
			error: error instanceof Error ? error.message : String(error),
			models: [],
			ok: false,
			profileId: profile.id,
			...(stderr === undefined || stderr.length === 0 ? {} : { stderr: stderr.slice(-1024) }),
		};
	} finally {
		await manager.disposeAll();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
