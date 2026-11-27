import { describe, expect, test } from "bun:test";
import { delimiter, join } from "node:path";
import type { ReadAcpProfile } from "./config.ts";
import {
	AcpProcessManager,
	buildAcpProcessEnv,
	type AcpClientInitializeParams,
	type AcpClientSessionHandlers,
	type AcpManagedClient,
	type AcpNewSessionInfo,
	type AcpNewSessionParams,
	type AcpSpawnSpec,
} from "./process-manager.ts";

const SYNTHETIC_HOME = "/home/synthetic";
const SYNTHETIC_TOOLS_ROOT = "/opt/synthetic-acp-tools";

function createProfile(overrides: Partial<ReadAcpProfile> = {}): ReadAcpProfile {
	return {
		allowedCapabilityChat: false,
		args: ["--stdio"],
		command: "synthetic-acp",
		enableAsModelProvider: true,
		enabled: true,
		env: {},
		id: "synthetic-profile",
		idleTtlMs: 60_000,
		models: [],
		preset: "custom",
		providerId: "acp:synthetic-profile",
		requestTimeoutMs: 30_000,
		supportsCapabilityTool: false,
		supportsImageGeneration: false,
		supportsVideoGeneration: false,
		toolBridgeMode: "disabled",
		...overrides,
	};
}

class FakeClient implements AcpManagedClient {
	closed = false;
	closeCalls = 0;
	initializeCalls = 0;
	modelCalls: readonly { readonly modelId: string; readonly sessionId: string }[] = [];
	newSessionCalls: AcpNewSessionParams[] = [];
	promptCalls = 0;

	async initialize(_params: AcpClientInitializeParams): Promise<unknown> {
		this.initializeCalls += 1;
		return {};
	}

	async newSession(
		params: AcpNewSessionParams,
		_handlers?: AcpClientSessionHandlers,
	): Promise<AcpNewSessionInfo> {
		this.newSessionCalls.push(params);
		return {
			availableModels: [],
			configOptions: [],
			currentModelId: "synthetic-model",
			promptCapabilities: { image: false },
			sessionId: `session-${this.newSessionCalls.length}`,
		};
	}

	async prompt(): Promise<unknown> {
		this.promptCalls += 1;
		return { stopReason: "end_turn" };
	}

	async setModel(params: { readonly modelId: string; readonly sessionId: string }): Promise<void> {
		this.modelCalls = [...this.modelCalls, params];
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.closed = true;
	}
}

interface SyntheticManager {
	readonly clients: FakeClient[];
	readonly manager: AcpProcessManager;
	readonly specs: AcpSpawnSpec[];
}

function createManager(now: () => number = Date.now): SyntheticManager {
	const clients: FakeClient[] = [];
	const specs: AcpSpawnSpec[] = [];
	const manager = new AcpProcessManager({
		connect: async (spec) => {
			specs.push(spec);
			const client = new FakeClient();
			clients.push(client);
			return client;
		},
		hostEnv: {
			HOME: SYNTHETIC_HOME,
			PATH: ["/usr/bin", "/bin"].join(delimiter),
		},
		now,
		reaperIntervalMs: 3_600_000,
	});
	return { clients, manager, specs };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("condition was not reached");
}

describe("buildAcpProcessEnv", () => {
	test("scrubs host secrets while preserving baseline keys and merging profile settings", () => {
		const toolsBin = join(SYNTHETIC_TOOLS_ROOT, "node_modules", ".bin");
		const env = buildAcpProcessEnv({
			hostEnv: {
				ANTHROPIC_API_KEY: "placeholder",
				DATABASE_URL: "placeholder",
				HOME: SYNTHETIC_HOME,
				LANG: "C.UTF-8",
				ONEBOT_ACCESS_TOKEN: "placeholder",
				OPENAI_API_KEY: "placeholder",
				PATH: ["/usr/bin", "/bin"].join(delimiter),
				TSUKAIMA_OPENAI_API_KEY: "placeholder",
				TZ: "UTC",
			},
			profileEnv: {
				ACP_PROFILE_FLAG: "enabled",
				TZ: "Asia/Taipei",
			},
			toolsRootDir: SYNTHETIC_TOOLS_ROOT,
		});

		expect(env.HOME).toBe(SYNTHETIC_HOME);
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.TZ).toBe("Asia/Taipei");
		expect(env.ACP_PROFILE_FLAG).toBe("enabled");
		expect(env.PATH?.split(delimiter).slice(0, 5)).toEqual([
			toolsBin,
			join(SYNTHETIC_HOME, ".local", "bin"),
			join(SYNTHETIC_HOME, ".bun", "bin"),
			"/usr/bin",
			"/bin",
		]);
		expect(env.TSUKAIMA_OPENAI_API_KEY).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ONEBOT_ACCESS_TOKEN).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});
});

describe("AcpProcessManager", () => {
	test("lazily reuses one initialized process across sessions", async () => {
		const { clients, manager, specs } = createManager();
		const profile = createProfile();
		const options = { capabilitiesKey: "tools-enabled", cwd: "/workspace/synthetic" };
		try {
			const first = await manager.withSession(profile, options, (session) => ({
				cwd: session.cwd,
				sessionId: session.sessionId,
			}));
			const second = await manager.withSession(profile, options, (session) => ({
				cwd: session.cwd,
				sessionId: session.sessionId,
			}));

			expect(first).toEqual({ cwd: "/workspace/synthetic", sessionId: "session-1" });
			expect(second).toEqual({ cwd: "/workspace/synthetic", sessionId: "session-2" });
			expect(clients).toHaveLength(1);
			expect(specs).toHaveLength(1);
			expect(specs[0]?.env.PATH).toContain(join(SYNTHETIC_HOME, ".bun", "bin"));
			expect(clients[0]?.initializeCalls).toBe(1);
			expect(clients[0]?.newSessionCalls).toHaveLength(2);
			expect(manager.activeCount()).toBe(1);
			expect(manager.snapshot()).toMatchObject([
				{
					activeSessions: 0,
					capabilitiesKey: "tools-enabled",
					closed: false,
					cwd: "/workspace/synthetic",
					profileId: profile.id,
				},
			]);
		} finally {
			await manager.disposeAll();
		}
	});

	test("evicts a closed client and lazily initializes a replacement", async () => {
		const { clients, manager } = createManager();
		const profile = createProfile();
		try {
			const first = await manager.acquire(profile, { cwd: "/workspace/synthetic" });
			clients[0]!.closed = true;
			const second = await manager.acquire(profile, { cwd: "/workspace/synthetic" });

			expect(second).not.toBe(first);
			expect(clients).toHaveLength(2);
			expect(clients[1]?.initializeCalls).toBe(1);
			expect(manager.activeCount()).toBe(1);
		} finally {
			await manager.disposeAll();
		}
	});

	test("invalidates every process for one profile without touching others", async () => {
		const { clients, manager } = createManager();
		const alpha = createProfile({ id: "alpha", providerId: "acp:alpha" });
		const beta = createProfile({ id: "beta", providerId: "acp:beta" });
		try {
			await manager.acquire(alpha, { cwd: "/workspace/one" });
			await manager.acquire(alpha, { cwd: "/workspace/two" });
			await manager.acquire(beta, { cwd: "/workspace/one" });
			expect(manager.activeCount()).toBe(3);

			await manager.invalidateProfile(alpha.id);

			expect(manager.activeCount()).toBe(1);
			expect(clients[0]?.closeCalls).toBe(1);
			expect(clients[1]?.closeCalls).toBe(1);
			expect(clients[2]?.closeCalls).toBe(0);
			expect(manager.snapshot().map((entry) => entry.profileId)).toEqual([beta.id]);

			const replacement = await manager.acquire(alpha, { cwd: "/workspace/one" });
			expect(replacement).not.toBe(clients[0]);
			expect(clients[3]?.initializeCalls).toBe(1);
		} finally {
			await manager.disposeAll();
		}
	});

	test("reaps idle processes but keeps recently used ones", async () => {
		let now = 1_000;
		const { clients, manager } = createManager(() => now);
		const profile = createProfile({ idleTtlMs: 50 });
		try {
			await manager.acquire(profile, { cwd: "/workspace/synthetic" });
			now = 1_049;
			expect(await manager.reapIdle()).toBe(0);
			expect(clients[0]?.closeCalls).toBe(0);

			now = 1_051;
			expect(await manager.reapIdle()).toBe(1);
			expect(clients[0]?.closeCalls).toBe(1);
			expect(manager.activeCount()).toBe(0);
		} finally {
			await manager.disposeAll();
		}
	});

	test("periodically reaps idle processes with an unref'd timer", async () => {
		let now = 0;
		const clients: FakeClient[] = [];
		const profile = createProfile({ idleTtlMs: 5 });
		const periodic = new AcpProcessManager({
			connect: async () => {
				const client = new FakeClient();
				clients.push(client);
				return client;
			},
			now: () => now,
			reaperIntervalMs: 5,
		});
		try {
			await periodic.acquire(profile, { cwd: "/workspace/synthetic" });
			now = 100;
			await waitFor(() => periodic.activeCount() === 0);
			expect(clients[0]?.closeCalls).toBe(1);
		} finally {
			await periodic.disposeAll();
		}
	});

	test("disposes all clients and rejects new work", async () => {
		const { clients, manager } = createManager();
		const profile = createProfile();
		await manager.acquire(profile, { cwd: "/workspace/one" });
		await manager.acquire(profile, { cwd: "/workspace/two" });

		await manager.disposeAll();

		expect(manager.activeCount()).toBe(0);
		expect(clients.map((client) => client.closeCalls)).toEqual([1, 1]);
		await expect(manager.acquire(profile)).rejects.toThrow("disposed");
	});

	test("serializes single-session calls and aborts queued work", async () => {
		const { manager } = createManager();
		const profile = createProfile();
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		try {
			const first = manager.withSession(
				profile,
				{ cwd: "/workspace/synthetic", singleSessionOnly: true },
				async () => {
					events.push("first:start");
					await firstGate;
					events.push("first:end");
				},
			);
			await waitFor(() => events.includes("first:start"));

			const second = manager.withSession(
				profile,
				{ cwd: "/workspace/synthetic", singleSessionOnly: true },
				() => {
					events.push("second:start");
				},
			);
			await Bun.sleep(5);
			expect(events).toEqual(["first:start"]);

			const abortController = new AbortController();
			const third = manager.withSession(
				profile,
				{
					cwd: "/workspace/synthetic",
					signal: abortController.signal,
					singleSessionOnly: true,
				},
				() => {
					events.push("third:start");
				},
			);
			abortController.abort();
			await expect(third).rejects.toMatchObject({ name: "AbortError" });

			releaseFirst?.();
			await Promise.all([first, second]);
			expect(events).toEqual(["first:start", "first:end", "second:start"]);
		} finally {
			await manager.disposeAll();
		}
	});

	test("aborts a slow startup and closes the late client", async () => {
		const clients: FakeClient[] = [];
		let releaseConnect: (() => void) | undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const manager = new AcpProcessManager({
			connect: async () => {
				await connectGate;
				const client = new FakeClient();
				clients.push(client);
				return client;
			},
			reaperIntervalMs: 3_600_000,
		});
		const abortController = new AbortController();
		try {
			const pending = manager.acquire(createProfile(), {
				cwd: "/workspace/synthetic",
				signal: abortController.signal,
			});
			abortController.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });

			releaseConnect?.();
			await waitFor(() => clients[0]?.closed === true);
			expect(clients[0]?.closeCalls).toBe(1);
			expect(manager.activeCount()).toBe(0);
		} finally {
			releaseConnect?.();
			await manager.disposeAll();
		}
	});
});
