import { describe, expect, test } from "bun:test";
import { OneBotChannel } from "./channel.ts";
import {
	bunReverseServerFactory,
	extractReverseAccessToken,
	isReverseAccessAllowed,
} from "./reverse.ts";
import type {
	OneBotConfig,
	OneBotReverseServer,
	OneBotReverseServerFactory,
	OneBotReverseServerOptions,
	OneBotTransport,
	OneBotTransportEvents,
} from "./types.ts";

const config = (overrides: Partial<OneBotConfig> = {}): OneBotConfig => ({
	accessToken: "secret",
	botAccountId: "99",
	channelId: "onebot-reverse",
	host: "127.0.0.1",
	mode: "reverse",
	port: 3_002,
	reconnect: { initialDelayMs: 1, jitterRatio: 0, maxDelayMs: 4 },
	...overrides,
});

class FakeTransport implements OneBotTransport {
	closeCount = 0;
	readonly sent: string[] = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
		this.emit("close");
	}

	on<Name extends keyof OneBotTransportEvents>(
		name: Name,
		listener: OneBotTransportEvents[Name],
	): void {
		const listeners = this.#listeners.get(name) ?? [];
		listeners.push(listener as (...args: never[]) => void);
		this.#listeners.set(name, listeners);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	emit(name: string): void {
		for (const listener of this.#listeners.get(name) ?? []) listener();
	}
}

const createReverseFactory = () => {
	const servers: Array<{
		options: OneBotReverseServerOptions;
		started: number;
		stopped: number;
		server: OneBotReverseServer;
	}> = [];
	const factory: OneBotReverseServerFactory = (options) => {
		const entry = {
			options,
			server: undefined as unknown as OneBotReverseServer,
			started: 0,
			stopped: 0,
		};
		entry.server = {
			port: options.port,
			async start() {
				entry.started += 1;
				return { port: options.port };
			},
			async stop() {
				entry.stopped += 1;
			},
		};
		servers.push(entry);
		return entry.server;
	};
	return { factory, servers };
};

const waitForSocket = (socket: WebSocket): Promise<string> =>
	new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string) => {
			if (timer !== undefined) clearTimeout(timer);
			resolve(value);
		};
		socket.addEventListener("open", () => finish("open"), { once: true });
		socket.addEventListener("error", () => finish("error"), { once: true });
		socket.addEventListener("close", () => finish("close"), { once: true });
		timer = setTimeout(() => finish("timeout"), 2_000);
	});

describe("OneBot reverse mode", () => {
	test("enforces bearer and query tokens", () => {
		expect(
			extractReverseAccessToken({ authorization: "Bearer secret" }, "ws://localhost/onebot"),
		).toBe("secret");
		expect(extractReverseAccessToken({}, "ws://localhost/onebot?access_token=query-secret")).toBe(
			"query-secret",
		);
		expect(isReverseAccessAllowed({ authorization: "Bearer secret" }, "ws://x", "secret")).toBe(
			true,
		);
		expect(isReverseAccessAllowed({}, "ws://x?access_token=secret", "secret")).toBe(true);
		expect(isReverseAccessAllowed({}, "ws://x", "secret")).toBe(false);
		expect(isReverseAccessAllowed({}, "ws://x", undefined)).toBe(true);
	});

	test("binds a reverse listener, accepts connections, and shuts down cleanly", async () => {
		const { factory, servers } = createReverseFactory();
		const channel = new OneBotChannel(config(), undefined, factory);
		await channel.start();
		expect(servers).toHaveLength(1);
		expect(servers[0]?.started).toBe(1);
		expect(servers[0]?.options.accessToken).toBe("secret");
		expect(servers[0]?.options.host).toBe("127.0.0.1");
		expect(servers[0]?.options.port).toBe(3_002);
		expect(channel.diagnostics).toMatchObject({ mode: "reverse", state: "connecting" });

		const transport = new FakeTransport();
		servers[0]?.options.onConnection(transport, {
			origin: "https://napcat.test",
			remoteAddress: "10.0.0.5",
		});
		transport.emit("open");
		expect(channel.diagnostics).toMatchObject({
			connected: true,
			mode: "reverse",
			origin: "https://napcat.test",
			remoteAddress: "10.0.0.5",
			state: "open",
		});

		const sent = channel.rawAction("get_login_info");
		expect(transport.sent[0]).toContain("get_login_info");
		transport.emit("message");
		await Bun.sleep(1);
		expect(channel.inFlightActions).toBe(1);
		channel.stop();
		expect(servers[0]?.stopped).toBe(1);
		expect(transport.closeCount).toBe(1);
		expect(channel.diagnostics.state).toBe("closed");
		await expect(sent).rejects.toThrow("OneBot connection closed");
	});

	test("real Bun reverse listener rejects unauthorized upgrades and accepts query tokens", async () => {
		const connected: Array<{ origin?: string; remoteAddress?: string }> = [];
		const rejected: string[] = [];
		const server = bunReverseServerFactory({
			accessToken: "secret",
			host: "127.0.0.1",
			onConnection: (_transport, info) => connected.push(info),
			onRejected: (info) => rejected.push(info.reason),
			port: 0,
		});
		const { port } = await server.start();
		try {
			const denied = new WebSocket(`ws://127.0.0.1:${port}/onebot`);
			expect(await waitForSocket(denied)).not.toBe("open");
			expect(rejected).toContain("unauthorized");

			const allowed = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=secret`);
			expect(await waitForSocket(allowed)).toBe("open");
			expect(connected).toHaveLength(1);
			allowed.close();
		} finally {
			await server.stop();
		}
	});

	test("records rejected-upgrade diagnostics", async () => {
		const { factory, servers } = createReverseFactory();
		const channel = new OneBotChannel(config(), undefined, factory);
		await channel.start();
		servers[0]?.options.onRejected?.({
			origin: "https://evil.test",
			reason: "unauthorized",
			remoteAddress: "10.0.0.9",
		});
		expect(channel.diagnostics).toMatchObject({
			lastErrorClass: "connect",
			origin: "https://evil.test",
			remoteAddress: "10.0.0.9",
		});
		channel.stop();
	});
});
