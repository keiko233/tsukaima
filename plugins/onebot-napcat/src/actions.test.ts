import { describe, expect, test } from "bun:test";
import {
	defaultConversationPolicy,
	type ChannelRequest,
	type MessageEnvelope,
} from "@tsukaima/contracts";
import {
	createPluginContext,
	type AuditEntry,
	type ChannelAdapter,
	type PluginChannelRegistry,
	type PluginConversationsApi,
	type PluginSettingsApi,
} from "@tsukaima/sdk";
import { ONEBOT_TRANSPORT_FACTORY_BINDING, oneBotNapCatPlugin } from "./index.ts";
import type {
	OneBotTransport,
	OneBotTransportEvents,
	OneBotTransportFactory,
} from "./protocol/index.ts";

class FakeTransport implements OneBotTransport {
	readonly sent: Array<{ action: string; params: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();
	respond: ((action: string, params: Record<string, unknown>) => unknown) | undefined;

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
		const responseData = this.respond?.(parsed.action, parsed.params) ?? { message_id: 500 };
		queueMicrotask(() => {
			this.#emit("message", JSON.stringify({ data: responseData, echo: parsed.echo, retcode: 0 }));
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

async function createHarness(
	initial: Record<string, unknown>,
	options?: { readonly conversations?: PluginConversationsApi },
) {
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
		...(options?.conversations === undefined ? {} : { conversations: options.conversations }),
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

	test("exposes structured JSON schemas for all registered OneBot tools", async () => {
		const harness = await createHarness(base);
		try {
			const tools = harness.context.tools.list();
			expect(tools.length).toBeGreaterThan(0);
			for (const tool of tools) {
				const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
				expect(properties).toBeDefined();
				expect(Object.keys(properties ?? {}).length).toBeGreaterThan(0);
			}
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("normalizes LLM-coerced and OneBot-style tool inputs for poke, send, and readHistory", async () => {
		const harness = await createHarness(base);
		try {
			const pokeTargetType = await harness.context.tools.invoke("onebot-napcat.poke", {
				target_id: "10002",
				target_type: "private",
			});
			expect(pokeTargetType.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "friend_poke",
				params: { user_id: "10002" },
			});

			const pokeScene = await harness.context.tools.invoke("onebot-napcat.poke", {
				scene: "private",
				user_id: "10002",
			});
			expect(pokeScene.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "friend_poke",
				params: { user_id: "10002" },
			});

			const pokeJsonTarget = await harness.context.tools.invoke("onebot-napcat.poke", {
				target: '{"kind": "private", "id": "10002"}',
				userId: "10002",
			});
			expect(pokeJsonTarget.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "friend_poke",
				params: { user_id: "10002" },
			});

			const pokeColonTarget = await harness.context.tools.invoke("onebot-napcat.poke", {
				target: "private:10002",
			});
			expect(pokeColonTarget.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "friend_poke",
				params: { user_id: "10002" },
			});

			const pokeGroup = await harness.context.tools.invoke("onebot-napcat.poke", {
				group_id: "20001",
				user_id: 10002,
			});
			expect(pokeGroup.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "group_poke",
				params: { group_id: "20001", user_id: "10002" },
			});

			const sendTargetType = await harness.context.tools.invoke("onebot-napcat.send", {
				parts: '[{"type": "text", "text": "Synthetic private message"}]',
				target_id: "10002",
				target_type: "private",
			});
			expect(sendTargetType.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "send_private_msg",
				params: {
					message: [{ data: { text: "Synthetic private message" }, type: "text" }],
					user_id: "10002",
				},
			});

			const sendScene = await harness.context.tools.invoke("onebot-napcat.send", {
				parts: '[{"type": "text", "text": "Synthetic private message"}]',
				scene: "private",
				user_id: "10002",
			});
			expect(sendScene.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "send_private_msg",
				params: {
					message: [{ data: { text: "Synthetic private message" }, type: "text" }],
					user_id: "10002",
				},
			});

			const sendShorthand = await harness.context.tools.invoke("onebot-napcat.send", {
				message: "Synthetic shorthand message",
				user_id: 10002,
			});
			expect(sendShorthand.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "send_private_msg",
				params: {
					message: [{ data: { text: "Synthetic shorthand message" }, type: "text" }],
					user_id: "10002",
				},
			});

			const history = await harness.context.tools.invoke("onebot-napcat.readHistory", {
				count: 5,
				message_type: "private",
				user_id: 10003,
			});
			expect(history.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)?.action).toBe("get_friend_msg_history");
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("defaults target to the current chat from toolContext, strips [msg:<id>] references, normalizes url/name parts, and marks high-frequency tools eager", async () => {
		const harness = await createHarness(base);
		try {
			const toolsByName = new Map(
				harness.context.tools.list().map((entry) => [entry.name, entry] as const),
			);
			expect(toolsByName.get("onebot-napcat.send")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.readHistory")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.viewImage")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.poke")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.react")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.listTargets")?.lazy).toBe(false);
			expect(toolsByName.get("onebot-napcat.groupBan")?.lazy).toBe(true);

			const currentGroupContext = {
				channelId: "onebot",
				chatKind: "group",
				conversationId: "conv-group-1",
				platformConversationId: "20001",
				senderPlatformId: "10005",
			};

			const implicitSend = await harness.context.tools.invoke(
				"onebot-napcat.send",
				{
					parts: [
						{ text: "Implicit group send", type: "text" },
						{ type: "image", url: "https://example.com/test.png" },
						{ name: "report.pdf", type: "file", url: "https://example.com/report.pdf" },
					],
				},
				currentGroupContext,
			);
			expect(implicitSend.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "send_group_msg",
				params: {
					group_id: "20001",
					message: [
						{ data: { text: "Implicit group send" }, type: "text" },
						{ data: { file: "https://example.com/test.png" }, type: "image" },
						{
							data: { file: "https://example.com/report.pdf", name: "report.pdf" },
							type: "file",
						},
					],
				},
			});

			const implicitPoke = await harness.context.tools.invoke(
				"onebot-napcat.poke",
				{ userId: "10008" },
				currentGroupContext,
			);
			expect(implicitPoke.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "group_poke",
				params: { group_id: "20001", user_id: "10008" },
			});

			const reactWithMsgRef = await harness.context.tools.invoke(
				"onebot-napcat.react",
				{ emojiId: "128077", messageId: "[msg:98765]" },
				currentGroupContext,
			);
			expect(reactWithMsgRef.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "set_msg_emoji_like",
				params: { emoji_id: "128077", message_id: "98765", set: true },
			});

			const forwardSingle = await harness.context.tools.invoke(
				"onebot-napcat.forwardMessage",
				{ messageId: "[msg:98765]" },
				currentGroupContext,
			);
			expect(forwardSingle.ok).toBe(true);
			expect(harness.transports[0]?.sent.at(-1)).toEqual({
				action: "forward_group_single_msg",
				params: { group_id: "20001", message_id: "98765" },
			});

			const targetsResult = await harness.context.tools.invoke(
				"onebot-napcat.listTargets",
				{},
				currentGroupContext,
			);
			expect(targetsResult.ok).toBe(true);
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("discovers missing allowed group/friend targets from NapCat and filters disabled policy rows", async () => {
		const currentGroup = {
			channelId: "onebot",
			chatObjectId: "chat-current",
			durableConversationId: "durable-current",
			id: "conv-current",
			kind: "group" as const,
			muted: false,
			platformConversationId: "20001",
			status: "active",
			title: "Current group",
			updatedAt: new Date().toISOString(),
		};
		const disabledGroup = {
			...currentGroup,
			chatObjectId: "chat-disabled",
			durableConversationId: "durable-disabled",
			id: "conv-disabled",
			platformConversationId: "20002",
			title: "Disabled group",
		};
		const allowedPrivate = {
			...currentGroup,
			chatObjectId: "chat-allowed-private",
			durableConversationId: "durable-allowed-private",
			id: "conv-allowed-private",
			kind: "private" as const,
			platformConversationId: "10004",
			title: "Allowed private chat",
		};
		const enabledPolicy = {
			...defaultConversationPolicy,
			trigger: { ...defaultConversationPolicy.trigger, groupAccess: "open" as const },
		};
		const disabledPolicy = {
			...defaultConversationPolicy,
			enabled: false,
			trigger: { ...defaultConversationPolicy.trigger, groupAccess: "disabled" as const },
		};
		const conversations: PluginConversationsApi = {
			get: async (id) => (id === currentGroup.id ? currentGroup : undefined),
			getPolicy: async (id) => (id === disabledGroup.id ? disabledPolicy : enabledPolicy),
			list: async () => [currentGroup, disabledGroup, allowedPrivate],
			recentMessages: async () => [],
			submitBackgroundTurn: async () => ({
				delivered: false,
				deliveryStatus: "skipped",
				skippedReason: "test_stub",
			}),
		};
		const harness = await createHarness(base, { conversations });
		const transport = harness.transports[0];
		if (transport === undefined) throw new Error("transport missing");
		transport.respond = (action) => {
			if (action === "get_group_list") {
				return [
					{ group_id: "20001", group_name: "Current group" },
					{ group_id: "20002", group_name: "Disabled group" },
					{ group_id: "20003", group_name: "Discovered group" },
				];
			}
			if (action === "get_friend_list") {
				return [
					{ nickname: "Discovered friend", remark: "Friend A", user_id: "10002" },
					{ nickname: "Another friend", user_id: "10003" },
				];
			}
			return { message_id: 500 };
		};
		try {
			const result = await harness.context.tools.invoke(
				"onebot-napcat.listTargets",
				{},
				{
					channelId: "onebot",
					chatKind: "group",
					conversationId: "conv-current",
					platformConversationId: "20001",
					senderPlatformId: "10005",
				},
			);
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("listTargets unavailable");
			const listed = (
				JSON.parse(result.result.content[0]?.text ?? "{}") as {
					targets: { platformConversationId: string }[];
				}
			).targets;
			expect(listed.map((target) => target.platformConversationId).toSorted()).toEqual([
				"10002",
				"10003",
				"10004",
				"20001",
				"20003",
			]);
			expect(transport.sent.some((entry) => entry.action === "get_group_list")).toBe(true);
			expect(transport.sent.some((entry) => entry.action === "get_friend_list")).toBe(true);
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});
});

describe("OneBot cross-chat fail-closed policy", () => {
	const currentContext = {
		channelId: "onebot",
		chatKind: "group",
		conversationId: "conv-current",
		platformConversationId: "20001",
		senderPlatformId: "10005",
	};
	const currentGroup = {
		channelId: "onebot",
		chatObjectId: "chat-current",
		durableConversationId: "durable-current",
		id: "conv-current",
		kind: "group" as const,
		muted: false,
		platformConversationId: "20001",
		status: "active",
		title: "Current group",
		updatedAt: new Date().toISOString(),
	};
	const otherGroup = {
		...currentGroup,
		chatObjectId: "chat-other",
		durableConversationId: "durable-other",
		id: "conv-other",
		platformConversationId: "30001",
		title: "Allowlisted group",
	};
	const openPolicy = {
		...defaultConversationPolicy,
		trigger: { ...defaultConversationPolicy.trigger, groupAccess: "open" as const },
	};
	const allowlistPolicy = {
		...defaultConversationPolicy,
		trigger: {
			...defaultConversationPolicy.trigger,
			allowlist: [] as string[],
			groupAccess: "allowlist" as const,
		},
	};
	const conversationsFor = (
		list: () => Promise<readonly (typeof currentGroup)[]>,
	): PluginConversationsApi => ({
		get: async (id) => (id === currentGroup.id ? currentGroup : undefined),
		getPolicy: async (id) => (id === otherGroup.id ? allowlistPolicy : openPolicy),
		list,
		recentMessages: async () => [],
		submitBackgroundTurn: async () => ({
			delivered: false,
			deliveryStatus: "skipped",
			skippedReason: "test_stub",
		}),
	});

	test("denies allowlisted cross-chat targets for send, poke, and group-file actions", async () => {
		const conversations = conversationsFor(async () => [currentGroup, otherGroup]);
		const harness = await createHarness(base, { conversations });
		try {
			const calls: Array<[string, Record<string, unknown>]> = [
				[
					"onebot-napcat.send",
					{
						parts: [{ text: "cross", type: "text" }],
						target: { kind: "group", platformConversationId: "30001" },
					},
				],
				[
					"onebot-napcat.sendForward",
					{
						parts: [{ text: "cross", type: "text" }],
						target: { kind: "group", platformConversationId: "30001" },
					},
				],
				[
					"onebot-napcat.forwardMessage",
					{ messageId: "[msg:1]", target: { kind: "group", platformConversationId: "30001" } },
				],
				[
					"onebot-napcat.poke",
					{ target: { kind: "group", platformConversationId: "30001" }, userId: "10008" },
				],
				["onebot-napcat.listGroupFiles", { groupId: "30001" }],
				["onebot-napcat.fetchGroupFile", { fileId: "file-1", groupId: "30001" }],
				[
					"onebot-napcat.uploadGroupFile",
					{ file: "file:///tmp/synthetic.txt", groupId: "30001", name: "synthetic.txt" },
				],
			];
			for (const [tool, input] of calls) {
				await expect(harness.context.tools.invoke(tool, input, currentContext)).rejects.toThrow(
					"cross-chat-target-not-allowed",
				);
			}
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("a conversation policy read failure fails closed instead of allowing a cross-chat action", async () => {
		const conversations = conversationsFor(async () => {
			throw new Error("synthetic conversation DB failure");
		});
		const harness = await createHarness(base, { conversations });
		try {
			await expect(
				harness.context.tools.invoke(
					"onebot-napcat.poke",
					{ target: { kind: "group", platformConversationId: "30001" }, userId: "10008" },
					currentContext,
				),
			).rejects.toThrow("cross-chat-target-denied");
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});

	test("an unparseable cross-chat target is denied before execution", async () => {
		const harness = await createHarness(base);
		try {
			await expect(
				harness.context.tools.invoke(
					"onebot-napcat.listGroupFiles",
					{},
					{ ...currentContext, chatKind: "private", platformConversationId: "10005" },
				),
			).rejects.toThrow("cross-chat-target-invalid");
		} finally {
			await oneBotNapCatPlugin.teardown?.(harness.context);
		}
	});
});
