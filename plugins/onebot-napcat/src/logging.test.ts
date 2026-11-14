import { describe, expect, test } from "bun:test";
import type { PluginLogger } from "@tsukaima/sdk";
import { createPluginContext } from "@tsukaima/sdk";
import { OneBotActionFacade } from "./actions.ts";
import type { OneBotChannelAdapter } from "./adapter.ts";
import { ONEBOT_TRANSPORT_FACTORY_BINDING, oneBotNapCatPlugin } from "./index.ts";
import {
	createSafeLogger,
	redactLogString,
	safeEndpoint,
	scrubLogDetails,
	singleLinePreview,
} from "./logging.ts";
import { OneBotChannel } from "./protocol/channel.ts";
import { normalizeOneBotEventAsync } from "./protocol/normalize.ts";
import { bunReverseServerFactory } from "./protocol/reverse.ts";
import type {
	OneBotEvent,
	OneBotTransport,
	OneBotTransportEvents,
	OneBotTransportFactory,
} from "./protocol/types.ts";

type LogEntry = {
	readonly details: unknown;
	readonly level: "debug" | "error" | "info" | "trace" | "warn";
	readonly message: string;
	readonly target?: string;
};

const createCaptureLogger = () => {
	const entries: LogEntry[] = [];
	const make = (target?: string): PluginLogger => {
		const write =
			(level: LogEntry["level"]) =>
			(message: string, details?: unknown): void => {
				entries.push({ details, level, message, ...(target === undefined ? {} : { target }) });
			};
		const logger: PluginLogger = {
			debug: write("debug"),
			error: write("error"),
			info: write("info"),
			trace: write("trace"),
			warn: write("warn"),
		};
		logger.child = (nextTarget) =>
			make(target === undefined ? nextTarget : `${target}.${nextTarget}`);
		return logger;
	};
	return { entries, logger: make() };
};

const messages = (entries: readonly LogEntry[], level: LogEntry["level"]): string[] =>
	entries.filter((entry) => entry.level === level).map((entry) => entry.message);

const findEntry = (entries: readonly LogEntry[], message: string): LogEntry | undefined =>
	entries.find((entry) => entry.message === message);

const serialized = (entries: readonly LogEntry[]): string => JSON.stringify(entries);

const baseConfig = {
	botAccountId: "99",
	channelId: "onebot-logging",
	reconnect: { initialDelayMs: 1, jitterRatio: 0, maxDelayMs: 4 },
	url: "ws://napcat.test",
};

class FakeTransport implements OneBotTransport {
	readonly sent: unknown[] = [];
	readonly response = (data: string): void => {
		const parsed = JSON.parse(data) as { echo: string };
		this.emit(
			"message",
			JSON.stringify({ data: { message_id: 42 }, echo: parsed.echo, retcode: 0 }),
		);
	};
	closeCount = 0;
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
		this.emit("close");
	}

	emit(name: string, payload?: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
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
		const parsed = JSON.parse(data) as { action: string; echo: string; params: unknown };
		this.sent.push(parsed);
	}
}

describe("OneBot logging safety helpers", () => {
	test("redacts token-like keys, bearer headers, and query tokens", () => {
		const capture = createCaptureLogger();
		const logger = createSafeLogger(capture.logger);
		logger.info("connecting with access_token=query-secret", {
			accessToken: "top-secret",
			authorization: "Bearer bearer-secret",
			headerPreview: "Authorization: Bearer bearer-secret",
			nested: { apiKey: "key-secret", harmless: "visible" },
			url: "wss://napcat.test/onebot?access_token=query-secret",
		});
		const text = serialized(capture.entries);
		expect(text).not.toContain("top-secret");
		expect(text).not.toContain("bearer-secret");
		expect(text).not.toContain("key-secret");
		expect(text).not.toContain("query-secret");
		expect(text).toContain("Bearer [redacted]");
		expect(text).toContain("visible");
	});

	test("never returns a raw access token from a URL or string", () => {
		expect(redactLogString("wss://x.test/?access_token=abc123")).not.toContain("abc123");
		expect(safeEndpoint("wss://host.test:3001/onebot?access_token=abc123")).toBe(
			"wss://host.test:3001/onebot",
		);
		expect(scrubLogDetails({ token: "abc123" })).toEqual({ token: "[redacted]" });
	});

	test("collapses and bounds previews", () => {
		const preview = singleLinePreview(`${"a\n".repeat(300)}`);
		expect(preview).toBeDefined();
		expect(preview).not.toContain("\n");
		expect(preview?.length).toBeLessThanOrEqual(120);
	});
});

describe("OneBot channel logging", () => {
	test("logs lifecycle, sends, and inbound frames without the access token", async () => {
		const capture = createCaptureLogger();
		const transport = new FakeTransport();
		const transportFactory: OneBotTransportFactory = () => transport;
		const channel = new OneBotChannel(
			{ ...baseConfig, accessToken: "super-secret-token" },
			transportFactory,
			undefined,
			capture.logger,
		);
		await channel.start();
		transport.emit("open");
		expect(messages(capture.entries, "info")).toContain("OneBot WebSocket connected");

		const sent = channel.sendPrivate("10001", [{ text: "hello world", type: "text" }]);
		transport.response(JSON.stringify(transport.sent[0]));
		await sent;
		expect(messages(capture.entries, "debug")).toContain("OneBot action sent");
		expect(messages(capture.entries, "debug")).toContain("OneBot action completed");
		expect(messages(capture.entries, "trace")).toContain("OneBot outbound message");
		expect(findEntry(capture.entries, "OneBot outbound message")?.details).toMatchObject({
			action: "send_private_msg",
			textPreview: "hello world",
		});
		expect(findEntry(capture.entries, "OneBot action completed")?.details).toMatchObject({
			action: "send_private_msg",
			ok: true,
		});

		transport.emit(
			"message",
			JSON.stringify({
				message: [{ data: { text: "x".repeat(300) }, type: "text" }],
				message_id: 1,
				message_type: "private",
				post_type: "message",
				self_id: 99,
				sender: { user_id: 10_001 },
				time: 1,
				user_id: 10_001,
			}),
		);
		const inbound = findEntry(capture.entries, "OneBot inbound frame")?.details as {
			readonly postType?: string;
			readonly textPreview?: string;
		};
		expect(inbound?.postType).toBe("message");
		expect(inbound?.textPreview?.length).toBeLessThanOrEqual(120);

		transport.emit("message", "{not json");
		expect(messages(capture.entries, "warn")).toContain("OneBot malformed frame ignored");

		channel.stop();
		expect(messages(capture.entries, "info")).toContain("OneBot WebSocket disconnected");
		expect(serialized(capture.entries)).not.toContain("super-secret-token");
	});

	test("logs reconnect backoff and action timeouts", async () => {
		const capture = createCaptureLogger();
		const sockets: FakeTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeTransport();
			sockets.push(transport);
			return transport;
		};
		const channel = new OneBotChannel(
			{ ...baseConfig, actionTimeoutMs: 20 },
			factory,
			undefined,
			capture.logger,
		);
		await channel.start();
		sockets[0]?.emit("open");
		await expect(channel.rawAction("get_login_info")).rejects.toThrow("action timeout");
		expect(messages(capture.entries, "warn")).toContain("OneBot action timed out");

		sockets[0]?.emit("close");
		await Bun.sleep(10);
		const scheduled = findEntry(capture.entries, "OneBot reconnect scheduled")?.details as {
			readonly attempt?: number;
			readonly delayMs?: number;
		};
		expect(scheduled?.attempt).toBe(1);
		expect(scheduled?.delayMs).toBeGreaterThanOrEqual(0);
		sockets[1]?.emit("open");
		expect(channel.diagnostics.state).toBe("open");
		channel.stop();
		expect(serialized(capture.entries)).not.toContain("super-secret-token");
	});
});

describe("OneBot reverse logging", () => {
	test("logs accepted clients and auth rejections without the token", async () => {
		const capture = createCaptureLogger();
		const server = bunReverseServerFactory({
			accessToken: "reverse-secret",
			host: "127.0.0.1",
			logger: capture.logger,
			onConnection: () => undefined,
			onRejected: () => undefined,
			port: 0,
		});
		const { port } = await server.start();
		try {
			const denied = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=wrong-secret`);
			await waitForSocket(denied);
			expect(messages(capture.entries, "warn")).toContain("OneBot reverse connection rejected");
			expect(
				findEntry(capture.entries, "OneBot reverse connection rejected")?.details,
			).toMatchObject({ reason: "unauthorized" });

			const allowed = new WebSocket(`ws://127.0.0.1:${port}/onebot?access_token=reverse-secret`);
			expect(await waitForSocket(allowed)).toBe("open");
			expect(messages(capture.entries, "info")).toContain("OneBot reverse client accepted");
			allowed.close();
		} finally {
			await server.stop();
		}
		const text = serialized(capture.entries);
		expect(text).not.toContain("wrong-secret");
		expect(text).not.toContain("reverse-secret");
		expect(text).toContain("OneBot reverse listener starting");
	});
});

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

const event = (segment: { data: Record<string, unknown>; type: string }): OneBotEvent => ({
	message: [segment],
	message_id: "message-1",
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Test User", user_id: 10_001 },
	time: 100,
	user_id: 10_001,
});

describe("OneBot normalization logging", () => {
	test("logs audio transcription, video frames, and forward expansion counts", async () => {
		const capture = createCaptureLogger();
		await normalizeOneBotEventAsync(
			event({ data: { file_id: "voice-1" }, type: "record" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{ audioTranscribe: async () => "hello voice", logger: capture.logger },
		);
		expect(messages(capture.entries, "trace")).toContain("OneBot inbound event normalized");
		expect(
			findEntry(capture.entries, "OneBot audio transcription completed")?.details,
		).toMatchObject({ status: "ok", transcriptChars: 11 });

		await normalizeOneBotEventAsync(
			event({ data: { file_id: "video-1" }, type: "video" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{
				extractVideoFrames: () => [{ sha256: "a".repeat(64) }, { sha256: "b".repeat(64) }],
				logger: capture.logger,
			},
		);
		expect(
			findEntry(capture.entries, "OneBot video frame extraction completed")?.details,
		).toMatchObject({ frames: 2, truncated: false });

		await normalizeOneBotEventAsync(
			event({ data: { id: "forward-1" }, type: "forward" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{
				fetchForward: async () => ({
					messages: [
						{ content: [{ data: { text: "one" }, type: "text" }], sender: { nickname: "A" } },
						{ content: [{ data: { text: "two" }, type: "text" }], sender: { nickname: "B" } },
					],
				}),
				logger: capture.logger,
			},
		);
		expect(findEntry(capture.entries, "OneBot forward expansion completed")?.details).toMatchObject(
			{ nodeCount: 2 },
		);
	});

	test("warns when enrichment falls back", async () => {
		const capture = createCaptureLogger();
		await normalizeOneBotEventAsync(
			event({ data: { file_id: "voice-1" }, type: "record" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{
				audioTranscribe: async () => {
					throw new Error("stt offline");
				},
				logger: capture.logger,
			},
		);
		expect(messages(capture.entries, "warn")).toContain("OneBot audio transcription failed");

		await normalizeOneBotEventAsync(
			event({ data: { id: "forward-2" }, type: "forward" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{
				fetchForward: async () => {
					throw new Error("forward endpoint down");
				},
				logger: capture.logger,
			},
		);
		expect(messages(capture.entries, "warn")).toContain("OneBot forward expansion failed");

		await normalizeOneBotEventAsync(
			event({ data: { foo: "bar" }, type: "mystery-segment" }),
			{ botAccountId: "99", channelId: "onebot-logging" },
			{ logger: capture.logger },
		);
		expect(messages(capture.entries, "debug")).toContain(
			"OneBot segment preserved as channel-native",
		);
	});
});

describe("OneBot action facade logging", () => {
	const adapter = {
		capabilities: () => ["group-manage"],
		channel: { groupBan: async () => ({ ok: true }) },
	} as unknown as OneBotChannelAdapter;

	test("traces invocation and debugs completion with a duration", async () => {
		const capture = createCaptureLogger();
		const facade = new OneBotActionFacade({
			audit: undefined,
			getAdapter: () => adapter,
			getSettings: () => ({ groupManage: true }),
			logger: capture.logger,
		});
		const outcome = await facade.run(
			"groupBan",
			{ durationSeconds: 60, groupId: "555", userId: "10001" },
			{ actorKind: "user", trustedAdmin: true },
		);
		expect(outcome.ok).toBe(true);
		expect(findEntry(capture.entries, "OneBot action invoked")?.details).toMatchObject({
			actorKind: "user",
			method: "groupBan",
			targetId: "555",
		});
		const finished = findEntry(capture.entries, "OneBot action finished")?.details as {
			readonly durationMs?: number;
			readonly targetId?: string;
		};
		expect(finished?.targetId).toBe("555");
		expect(finished?.durationMs).toBeGreaterThanOrEqual(0);

		await facade.run("groupBan", { durationSeconds: 60, groupId: "555", userId: "10001" });
		expect(messages(capture.entries, "warn")).toContain("OneBot action denied");
	});
});

const createHarness = (initial: Record<string, unknown>) => {
	const capture = createCaptureLogger();
	const transports: FakeTransport[] = [];
	const transportFactory: OneBotTransportFactory = () => {
		const transport = new FakeTransport();
		transports.push(transport);
		return transport;
	};
	const listeners = new Set<(next: unknown) => Promise<void> | void>();
	let current = initial;
	const context = createPluginContext({
		channels: {
			get: () => undefined,
			list: () => [],
			register: () => () => undefined,
		},
		dependencies: {
			get: <T>(key: string) =>
				(key === ONEBOT_TRANSPORT_FACTORY_BINDING ? transportFactory : undefined) as T | undefined,
		},
		grantedPermissions: oneBotNapCatPlugin.manifest.permissions,
		logger: capture.logger,
		manifest: oneBotNapCatPlugin.manifest,
		pluginId: "onebot-napcat",
		settings: {
			get: async () => current,
			onChange: (handler) => {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
		},
	});
	const applySettings = async (next: Record<string, unknown>) => {
		current = next;
		for (const listener of listeners) await listener(next);
	};
	return { applySettings, capture, context, transports };
};

describe("OneBot plugin settings logging", () => {
	test("logs unchanged vs recreated settings, reconnect, and teardown without the token", async () => {
		const harness = createHarness({
			accessToken: "plugin-secret-token",
			wsUrl: "ws://napcat.test:3001?access_token=plugin-secret-token",
		});
		try {
			await oneBotNapCatPlugin.setup(harness.context);
			expect(messages(harness.capture.entries, "debug")).toContain(
				"OneBot connection settings changed; recreating the adapter",
			);

			await harness.applySettings({
				accessToken: "plugin-secret-token",
				wsUrl: "ws://napcat.test:3001?access_token=plugin-secret-token",
			});
			expect(messages(harness.capture.entries, "debug")).toContain(
				"OneBot settings unchanged; keeping the live channel",
			);

			await harness.applySettings({ accessToken: "plugin-secret-token", wsUrl: "ws://next.test" });
			expect(harness.transports).toHaveLength(2);

			const rpc = harness.context.rpc as unknown as {
				invoke(method: string, input: unknown): Promise<unknown>;
			};
			await rpc.invoke("reconnect", {});
			expect(messages(harness.capture.entries, "debug")).toContain("OneBot reconnect requested");

			await rpc.invoke("groupBan", { durationSeconds: 60, groupId: "555", userId: "10001" });
			expect(messages(harness.capture.entries, "trace")).toContain("OneBot action invoked");

			// Child loggers prove the plugin names its scopes rather than logging anonymously.
			expect(harness.capture.entries.some((entry) => entry.target === "adapter.channel")).toBe(
				true,
			);
			expect(harness.capture.entries.some((entry) => entry.target === "actions")).toBe(true);
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
		expect(messages(harness.capture.entries, "info")).toContain("OneBot plugin teardown");
		const text = serialized(harness.capture.entries);
		expect(text).not.toContain("plugin-secret-token");
	});
});
