import { describe, expect, test } from "bun:test";
import type { ChannelRequest, MessageEnvelope } from "@elaina/contracts";
import {
	createPluginContext,
	type AuditEntry,
	type ChannelAdapter,
	type PluginChannelRegistry,
	type PluginSettingsApi,
} from "@elaina/sdk";
import { ONEBOT_TRANSPORT_FACTORY_BINDING, oneBotNapCatPlugin } from "./index.ts";
import type {
	OneBotTransport,
	OneBotTransportEvents,
	OneBotTransportFactory,
} from "./protocol/index.ts";

class FakeTransport implements OneBotTransport {
	readonly sent: Array<{ action: string; params: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
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
		const parsed = JSON.parse(data) as {
			action: string;
			echo: string;
			params: Record<string, unknown>;
		};
		this.sent.push({ action: parsed.action, params: parsed.params });
		queueMicrotask(() => {
			this.#emit(
				"message",
				JSON.stringify({ data: { message_id: 500 }, echo: parsed.echo, retcode: 0 }),
			);
		});
	}

	emit(name: keyof OneBotTransportEvents): void {
		this.#emit(name);
	}

	#emit(name: string, payload?: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
	}
}

class Registry implements PluginChannelRegistry {
	readonly adapters = new Map<string, ChannelAdapter>();
	readonly envelopes: MessageEnvelope[] = [];
	readonly requests: ChannelRequest[] = [];

	register(adapter: ChannelAdapter): () => void {
		adapter.onEnvelope((envelope) => this.envelopes.push(envelope));
		adapter.onNotice?.((notice) => this.envelopes.push(notice as never));
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

async function createHarness(initial: Record<string, unknown>) {
	const registry = new Registry();
	const audits: AuditEntry[] = [];
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
		audit: { record: async (entry) => void audits.push(entry) },
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
	await oneBotNapCatPlugin.setup(context);
	const rpc = context.rpc as unknown as {
		invoke(method: string, input: unknown): Promise<unknown>;
	};
	const invokeRpc = rpc.invoke.bind(rpc);
	transports[0]?.emit("open");
	const applySettings = async (next: Record<string, unknown>) => {
		current = next;
		for (const listener of listeners) await listener(next);
	};
	return { applySettings, audits, context, invokeRpc, registry, transports };
}

const base = { wsUrl: "ws://napcat.test:3001" };
const groupBanInput = { durationSeconds: 60, groupId: "555", userId: "10001" };

describe("OneBot action policy and audit", () => {
	test("denies group management until enabled and only for configured admins", async () => {
		const harness = await createHarness(base);
		try {
			await expect(
				harness.context.tools.invoke("onebot-napcat.groupBan", groupBanInput, {
					conversationId: "1",
					userId: "admin-1",
				}),
			).rejects.toThrow("action-disabled:group-manage");
			expect(harness.audits.at(-1)).toMatchObject({
				action: "onebot-napcat.groupBan",
				result: "denied",
			});

			await harness.applySettings({ ...base, adminUsers: ["admin-1"], groupManage: true });
			await expect(
				harness.context.tools.invoke("onebot-napcat.groupBan", groupBanInput, {
					conversationId: "1",
					userId: "not-admin",
				}),
			).rejects.toThrow("admin-required");
			expect(harness.audits.at(-1)).toMatchObject({ result: "denied" });

			const allowed = await harness.context.tools.invoke("onebot-napcat.groupBan", groupBanInput, {
				conversationId: "1",
				userId: "admin-1",
			});
			expect(allowed.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("set_group_ban");
			expect(harness.audits.at(-1)).toMatchObject({
				action: "onebot-napcat.groupBan",
				result: "ok",
				targetId: "555",
				targetKind: "group-member",
			});
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("denies deleteGroupFile, self management, and raw actions by default", async () => {
		const harness = await createHarness(base);
		try {
			await expect(
				harness.context.tools.invoke(
					"onebot-napcat.deleteGroupFile",
					{ fileId: "f1", groupId: "555" },
					{ conversationId: "1", userId: "admin" },
				),
			).rejects.toThrow("action-disabled:delete-group-file");
			expect(harness.audits.at(-1)).toMatchObject({ result: "denied" });

			await expect(
				harness.context.tools.invoke(
					"onebot-napcat.setAvatar",
					{ file: "/tmp/a.png" },
					{ conversationId: "1", userId: "admin" },
				),
			).rejects.toThrow("action-disabled:self-manage");
			expect(harness.audits.at(-1)).toMatchObject({ result: "denied" });

			await expect(
				harness.context.tools.invoke(
					"onebot-napcat.rawAction",
					{ action: "get_login_info" },
					{ conversationId: "1", userId: "admin" },
				),
			).rejects.toThrow("raw-action-not-allowlisted");
			expect(harness.audits.at(-1)).toMatchObject({ result: "denied" });
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("allows destructive actions only when their flags, allowlist, and admin match", async () => {
		const harness = await createHarness({
			...base,
			adminUsers: ["admin"],
			deleteGroupFile: true,
			groupManage: true,
			rawActionAllowlist: ["get_login_info"],
			selfManage: true,
		});
		try {
			const deleteFile = await harness.context.tools.invoke(
				"onebot-napcat.deleteGroupFile",
				{ fileId: "f1", groupId: "555" },
				{ conversationId: "1", userId: "admin" },
			);
			expect(deleteFile.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("delete_group_file");

			const self = await harness.context.tools.invoke(
				"onebot-napcat.setAvatar",
				{ file: "/tmp/a.png" },
				{ conversationId: "1", userId: "admin" },
			);
			expect(self.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("set_qq_avatar");

			const raw = await harness.context.tools.invoke(
				"onebot-napcat.rawAction",
				{ action: "get_login_info" },
				{ conversationId: "1", userId: "admin" },
			);
			expect(raw.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("get_login_info");
			expect(harness.audits.filter((entry) => entry.result === "ok")).toHaveLength(3);
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("audits denied and successful RPC actions with the plugin namespace", async () => {
		const harness = await createHarness(base);
		try {
			const denied = await harness.invokeRpc("groupBan", groupBanInput);
			expect(denied).toEqual({ ok: false, reason: "action-disabled:group-manage" });
			expect(harness.audits.at(-1)).toMatchObject({
				action: "onebot-napcat.groupBan",
				result: "denied",
			});
			const sent = await harness.invokeRpc("send", {
				parts: [{ text: "hello", type: "text" }],
				target: { channelId: "onebot", kind: "private", platformConversationId: "10001" },
			});
			expect(sent).toEqual({ ok: true, result: { platformMessageId: "500" } });
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("send_private_msg");
			expect(harness.audits.at(-1)).toMatchObject({
				action: "onebot-napcat.send",
				result: "ok",
			});
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});
});
