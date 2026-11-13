import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChannelAdapter,
	type ChannelDiagnostics,
	type TsukaimaPlugin,
	type PluginToolInvocationResult,
	type SendResult,
	pluginManifestSchema,
} from "@tsukaima/sdk";
import { createFakeModel } from "@tsukaima/core";
import { messagePartsText, type MessagePart } from "@tsukaima/contracts";
import { auditLog, chatObjects, conversations } from "@tsukaima/db";
import { builtinPlugins } from "../src/plugins/builtin.ts";
import { loadConfig } from "../src/config.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

class FakeChannelAdapter implements ChannelAdapter {
	readonly id = "test-channel";
	readonly kind = "test";
	readonly sent: { parts: readonly MessagePart[]; platformConversationId: string }[] = [];
	connected = true;

	capabilities(): readonly "send"[] {
		return ["send"];
	}

	diagnostics(): ChannelDiagnostics {
		return {
			configured: true,
			connected: this.connected,
			eventCount: 0,
			state: this.connected ? "open" : "closed",
		};
	}

	async start(): Promise<void> {}

	async stop(): Promise<void> {}

	async send(
		target: { readonly platformConversationId: string },
		parts: readonly MessagePart[],
	): Promise<SendResult> {
		if (!this.connected) throw new Error("disconnected");
		this.sent.push({ parts, platformConversationId: target.platformConversationId });
		return { platformMessageId: `sent-${this.sent.length}` };
	}

	onEnvelope(): void {}
}

let adapter: FakeChannelAdapter | undefined;

const fakeChannelPlugin: TsukaimaPlugin = {
	manifest: pluginManifestSchema.parse({
		apiVersion: "1",
		kind: "first-party",
		name: "test-channel",
		permissions: ["channel.send"],
		version: "0.1.0",
	}),
	setup(context) {
		adapter = new FakeChannelAdapter();
		context.channels?.register(adapter);
	},
};

function createLifecycle(directory: string, responses: string[]): TsukaimaLifecycle {
	return new TsukaimaLifecycle(loadConfig({ TSUKAIMA_DATA_DIR: directory, TSUKAIMA_PORT: "7420" }), {
		model: createFakeModel({ responses }),
		plugins: [...builtinPlugins, fakeChannelPlugin],
	});
}

async function createConversation(
	lifecycle: TsukaimaLifecycle,
	label: string,
): Promise<{ chatId: string; conversationId: string; durableConversationId: string }> {
	const host = lifecycle.conversationHost;
	const database = lifecycle.domainDatabase;
	if (host === undefined || database === undefined) throw new Error("lifecycle not ready");
	const durableConversationId = await host.createConversation();
	const chatId = randomUUID();
	const conversationId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		channelId: "test-channel",
		createdAt: now,
		id: chatId,
		kind: "private",
		platformConversationId: label,
		title: `Chat ${label}`,
		updatedAt: now,
	});
	await database.insert(conversations).values({
		channelId: "test-channel",
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId,
		id: conversationId,
		isReceiving: 1,
		kind: "private",
		platformConversationId: label,
		title: "Main",
		updatedAt: now,
	});
	return { chatId, conversationId, durableConversationId };
}

async function seedActiveState(
	lifecycle: TsukaimaLifecycle,
	conversationId: string,
	options: { readonly warmness?: number } = {},
): Promise<void> {
	const context = lifecycle.pluginHost.context("proactive-scheduler");
	if (context?.database === undefined) throw new Error("plugin database unavailable");
	const now = Date.now();
	await context.database.query(
		`INSERT INTO plugin_proactive_scheduler_state
		 (conversation_id, last_message_at_ms, last_inbound_at_ms, inbound_count, unanswered_streak, refused_count, active_hours_histogram_json, warmness, openers_json, daily_count, hourly_count, updated_at_ms)
		 VALUES (?, ?, ?, ?, 0, 0, '{}', ?, '[]', 0, 0, ?)
		 ON CONFLICT(conversation_id) DO UPDATE SET
		  last_message_at_ms = excluded.last_message_at_ms,
		  last_inbound_at_ms = excluded.last_inbound_at_ms,
		  inbound_count = excluded.inbound_count,
		  unanswered_streak = 0,
		  silence_until_ms = NULL,
		  last_outbound_at_ms = NULL,
		  warmness = excluded.warmness,
		  daily_count = 0,
		  hourly_count = 0,
		  updated_at_ms = excluded.updated_at_ms`,
		[conversationId, now - 30 * 60_000, now - 30 * 60_000, 10, options.warmness ?? 1, now],
	);
}

async function enablePolicy(lifecycle: TsukaimaLifecycle): Promise<void> {
	await lifecycle.pluginHost.invokeRpc("proactive-scheduler.policies.save", {
		patch: { enabled: true, probability: 1 },
		scope: "global",
	});
}

function sentTexts(): string[] {
	return adapter?.sent.map((entry) => messagePartsText(entry.parts)) ?? [];
}

function toolText(result: PluginToolInvocationResult): string {
	if (!result.ok) return JSON.stringify(result);
	return result.result.content.map((entry) => entry.text).join("\n");
}

describe("proactive-scheduler host integration", () => {
	test("creates namespaced tables and keeps proactive disabled by default", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-proactive-"));
		directories.push(directory);
		const lifecycle = createLifecycle(directory, []);
		await lifecycle.start();
		try {
			const context = lifecycle.pluginHost.context("proactive-scheduler");
			expect(context?.database?.prefix).toBe("plugin_proactive_scheduler_");
			expect(context?.tasks).toBeDefined();
			expect(context?.conversations).toBeDefined();
			const tables = (await lifecycle.domainDatabase?.$client
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plugin_proactive_scheduler_%'",
				)
				.all()) as { name: string }[];
			expect(tables.map((row) => row.name).toSorted()).toEqual([
				"plugin_proactive_scheduler_decisions",
				"plugin_proactive_scheduler_policies",
				"plugin_proactive_scheduler_state",
				"plugin_proactive_scheduler_tasks",
			]);
			const overview = (await lifecycle.pluginHost.invokeRpc(
				"proactive-scheduler.overview",
				undefined,
			)) as {
				enabled: boolean;
				globalPolicy: { enabled: boolean };
			};
			expect(overview.enabled).toBe(false);
			expect(overview.globalPolicy.enabled).toBe(false);

			const conversation = await createConversation(lifecycle, "default-off");
			await seedActiveState(lifecycle, conversation.conversationId);
			const simulation = (await lifecycle.pluginHost.invokeRpc("proactive-scheduler.simulate", {
				conversationId: conversation.conversationId,
			})) as { rows: { eligible: boolean; reason?: string }[] };
			expect(simulation.rows[0]).toEqual(
				expect.objectContaining({ eligible: false, reason: "disabled" }),
			);
			expect(adapter?.sent).toHaveLength(0);
		} finally {
			await lifecycle.stop();
		}
	});

	test("runs a proactive tick, consumes markers, and blocks disconnected channels", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-proactive-"));
		directories.push(directory);
		const responses: string[] = [];
		const lifecycle = createLifecycle(directory, responses);
		await lifecycle.start();
		try {
			await enablePolicy(lifecycle);
			const delivered = await createConversation(lifecycle, "delivered");
			await seedActiveState(lifecycle, delivered.conversationId);
			responses.push("hello proactive");
			const tick = (await lifecycle.pluginHost.invokeRpc(
				"proactive-scheduler.tick",
				undefined,
			)) as {
				delivered: number;
			};
			expect(tick.delivered).toBe(1);
			expect(sentTexts()).toContain("hello proactive");

			const skipped = await createConversation(lifecycle, "skipped");
			await seedActiveState(lifecycle, skipped.conversationId);
			responses.push("TSUKAIMA_SKIP");
			await lifecycle.pluginHost.invokeRpc("proactive-scheduler.tick", undefined);
			expect(sentTexts()).not.toContain("TSUKAIMA_SKIP");
			const decisions = (await lifecycle.pluginHost.invokeRpc(
				"proactive-scheduler.decisions.list",
				{ conversationId: skipped.conversationId },
			)) as { decisions: { gateResult: string; marker: string | null }[] };
			expect(decisions.decisions[0]).toEqual(
				expect.objectContaining({ gateResult: "suppressed", marker: "skip" }),
			);

			const unavailable = await createConversation(lifecycle, "unavailable");
			await seedActiveState(lifecycle, unavailable.conversationId);
			if (adapter !== undefined) adapter.connected = false;
			const before = adapter?.sent.length ?? 0;
			await lifecycle.pluginHost.invokeRpc("proactive-scheduler.tick", undefined);
			expect(adapter?.sent.length).toBe(before);
			const unavailableDecisions = (await lifecycle.pluginHost.invokeRpc(
				"proactive-scheduler.decisions.list",
				{ conversationId: unavailable.conversationId },
			)) as { decisions: { gateResult: string; skippedReason: string | null }[] };
			expect(unavailableDecisions.decisions[0]).toEqual(
				expect.objectContaining({
					gateResult: "skipped",
					skippedReason: "channel_disconnected",
				}),
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("enforces task persistence across restart and tool scope/admin bounds", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-proactive-"));
		directories.push(directory);
		const responses: string[] = [];
		const first = createLifecycle(directory, responses);
		await first.start();
		let taskId = "";
		let firstConversation = "";
		let secondConversation = "";
		try {
			firstConversation = (await createConversation(first, "first")).conversationId;
			secondConversation = (await createConversation(first, "second")).conversationId;
			const created = (await first.pluginHost.invokeRpc("proactive-scheduler.tasks.create", {
				conversationId: firstConversation,
				delayMs: 3_600_000,
				kind: "remind",
				prompt: "persisted task",
			})) as { id: string };
			taskId = created.id;
			const cross = await first.pluginHost.invokeTool(
				"proactive-scheduler.schedule",
				{ conversationId: secondConversation, delayMs: 1_000, prompt: "cross" },
				{ conversationId: firstConversation, isAdmin: false },
			);
			expect(toolText(cross)).toContain("cross_conversation_denied");
			const deniedAudit = await first.domainDatabase?.select().from(auditLog);
			expect(
				deniedAudit?.some(
					(entry) =>
						entry.action === "proactive.tool.denied" &&
						entry.reason === "cross_conversation_denied",
				),
			).toBe(true);

			const blocked = await first.pluginHost.invokeTool(
				"proactive-scheduler.cancel",
				{ scope: "global" },
				{ conversationId: firstConversation, isAdmin: false },
			);
			expect(toolText(blocked)).toContain("admin_required");

			const listed = (await first.pluginHost.invokeRpc("proactive-scheduler.tasks.list", {
				conversationId: firstConversation,
			})) as { tasks: { id: string; status: string }[] };
			expect(listed.tasks).toContainEqual(
				expect.objectContaining({ id: taskId, status: "scheduled" }),
			);
			const hosted = await first.pluginTasks.list("proactive-scheduler", {
				kind: "proactive-scheduler.run",
			});
			expect(hosted.some((task) => task.status === "pending")).toBe(true);
		} finally {
			await first.stop();
		}

		const second = createLifecycle(directory, responses);
		await second.start();
		try {
			const listed = (await second.pluginHost.invokeRpc("proactive-scheduler.tasks.list", {
				conversationId: firstConversation,
			})) as { tasks: { id: string; status: string }[] };
			expect(listed.tasks).toContainEqual(
				expect.objectContaining({ id: taskId, status: "scheduled" }),
			);
			const hosted = await second.pluginTasks.list("proactive-scheduler", {
				kind: "proactive-scheduler.run",
			});
			expect(hosted.some((task) => task.status === "pending")).toBe(true);

			const adminCancelled = await second.pluginHost.invokeTool(
				"proactive-scheduler.cancel",
				{ scope: "global" },
				{ conversationId: firstConversation, isAdmin: true, role: "admin" },
			);
			expect(toolText(adminCancelled)).toContain("cancelled");
			const after = (await second.pluginHost.invokeRpc("proactive-scheduler.tasks.list", {
				conversationId: firstConversation,
			})) as { tasks: { id: string; status: string }[] };
			expect(after.tasks.find((task) => task.id === taskId)?.status).toBe("cancelled");

			const resetBlocked = second.pluginHost.invokeRpc("proactive-scheduler.policies.reset", {});
			await expect(resetBlocked).rejects.toThrow("confirm");
			await second.pluginHost.invokeRpc("proactive-scheduler.policies.reset", { confirm: true });
			const audit = await second.domainDatabase?.select().from(auditLog);
			expect(audit?.some((entry) => entry.action === "proactive.policy.reset")).toBe(true);
			expect(secondConversation.length).toBeGreaterThan(0);
		} finally {
			await second.stop();
		}
	});
});
