import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ChannelRequest, MessageEnvelope } from "@elaina/contracts";
import type { OneBotTransport, OneBotTransportFactory } from "@elaina/onebot";
import {
	createPluginContext,
	pluginManifestSchema,
	type ChannelAdapter,
	type PluginChannelRegistry,
	type PluginSettingsApi,
} from "@elaina/sdk";
import { ONEBOT_TRANSPORT_FACTORY_BINDING, oneBotNapCatPlugin } from "./index.ts";

class FakeTransport implements OneBotTransport {
	readonly sent: string[] = [];
	closeCount = 0;
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
	}

	on(name: string, listener: (...args: never[]) => void): void {
		const listeners = this.#listeners.get(name) ?? [];
		listeners.push(listener);
		this.#listeners.set(name, listeners);
	}

	send(data: string): void {
		this.sent.push(data);
		const parsed = JSON.parse(data) as { echo: string };
		this.emit(
			"message",
			JSON.stringify({ data: { message_id: 7 }, echo: parsed.echo, retcode: 0 }),
		);
	}

	emit(name: string, payload?: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
	}
}

class TestChannelRegistry implements PluginChannelRegistry {
	readonly adapters = new Map<string, ChannelAdapter>();
	readonly envelopes: MessageEnvelope[] = [];
	readonly requests: ChannelRequest[] = [];

	register(adapter: ChannelAdapter): () => void {
		adapter.onEnvelope((envelope) => this.envelopes.push(envelope));
		adapter.onRequest?.((request) => this.requests.push(request));
		this.adapters.set(adapter.id, adapter);
		return () => this.adapters.delete(adapter.id);
	}

	get(channelId: string): ChannelAdapter | undefined {
		return this.adapters.get(channelId);
	}

	list(): readonly ChannelAdapter[] {
		return [...this.adapters.values()];
	}
}

const privateMessage = {
	message: [{ data: { text: "hello" }, type: "text" }],
	message_id: 100,
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Keiko", user_id: 10_001 },
	time: 123,
	user_id: 10_001,
} as const;

function createHarness(initial: Record<string, unknown>) {
	const registry = new TestChannelRegistry();
	const transports: FakeTransport[] = [];
	const transportFactory: OneBotTransportFactory = () => {
		const transport = new FakeTransport();
		transports.push(transport);
		return transport;
	};
	const listeners = new Set<(next: unknown) => Promise<void> | void>();
	let current = initial;
	const settings: PluginSettingsApi = {
		get: async () => current,
		onChange: (handler) => {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
	};
	const context = createPluginContext({
		channels: registry,
		dependencies: {
			get: <T>(key: string) =>
				(key === ONEBOT_TRANSPORT_FACTORY_BINDING ? transportFactory : undefined) as T | undefined,
		},
		grantedPermissions: oneBotNapCatPlugin.manifest.permissions,
		manifest: oneBotNapCatPlugin.manifest,
		pluginId: "onebot-napcat",
		settings,
	});
	const applySettings = async (next: Record<string, unknown>) => {
		current = next;
		for (const listener of listeners) await listener(next);
	};
	return { applySettings, context, registry, transports };
}

describe("onebot-napcat plugin", () => {
	test("manifest matches the packaged elaina.plugin.json", async () => {
		const packaged = pluginManifestSchema.parse(
			JSON.parse(await readFile(new URL("../elaina.plugin.json", import.meta.url), "utf8")),
		);
		expect(oneBotNapCatPlugin.manifest).toEqual(packaged);
	});

	test("registers a channel adapter and forwards inbound events", async () => {
		const harness = createHarness({ wsUrl: "ws://napcat.test:3001" });
		await oneBotNapCatPlugin.setup(harness.context);

		const adapter = harness.registry.get("onebot");
		expect(adapter?.kind).toBe("onebot-v11");
		expect(adapter?.capabilities()).toContain("send");
		expect(harness.transports).toHaveLength(1);
		expect(adapter?.diagnostics()).toEqual(
			expect.objectContaining({ configured: true, connected: false, restartRequired: false }),
		);

		harness.transports[0]?.emit("open");
		expect(adapter?.diagnostics().connected).toBe(true);

		harness.transports[0]?.emit("message", JSON.stringify(privateMessage));
		expect(harness.registry.envelopes).toHaveLength(1);
		expect(harness.registry.envelopes[0]?.channelId).toBe("onebot");

		await adapter?.send({ channelId: "onebot", kind: "private", platformConversationId: "10001" }, [
			{ text: "hi", type: "text" },
		]);
		expect(harness.transports[0]?.sent.at(0)).toContain("send_private_msg");

		await oneBotNapCatPlugin.teardown?.(harness.context);
		expect(harness.registry.list()).toHaveLength(0);
	});

	test("restarts the connection only when the connection settings change", async () => {
		const harness = createHarness({ wsUrl: "ws://first.test:3001" });
		await oneBotNapCatPlugin.setup(harness.context);
		expect(harness.transports).toHaveLength(1);

		await harness.applySettings({ wsUrl: "ws://first.test:3001" });
		expect(harness.transports).toHaveLength(1);

		await harness.applySettings({ wsUrl: "ws://second.test:3001" });
		expect(harness.transports).toHaveLength(2);
		expect(harness.transports[0]?.closeCount).toBe(1);
		expect(harness.registry.get("onebot")?.diagnostics().state).toBe("connecting");

		await harness.applySettings({ accessToken: "dummy-token", wsUrl: "ws://second.test:3001" });
		expect(harness.transports).toHaveLength(3);
		expect(harness.transports[1]?.closeCount).toBe(1);
	});

	test("stays idle while no WebSocket URL is configured", async () => {
		const harness = createHarness({});
		await oneBotNapCatPlugin.setup(harness.context);
		expect(harness.registry.list()).toHaveLength(0);
		expect(harness.transports).toHaveLength(0);
	});
});
