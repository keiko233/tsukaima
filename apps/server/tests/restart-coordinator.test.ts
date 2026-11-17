import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chatObjects,
	conversations,
	migrateDomainDatabase,
	openDomainDatabase,
	runtimeRestarts,
} from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import { PromptHookService } from "../src/services/prompt-hooks.ts";
import { RestartCoordinator, type RestartIntent } from "../src/services/restart-coordinator.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function setup(
	options: {
		readonly onSettled?: (
			intent: RestartIntent,
			outcome: "cancelled" | "completed" | "interrupted",
		) => void;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-restart-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const logger = createLogger({ capacity: 100, level: "error", target: "test" });
	const hooks = new PromptHookService({ database: () => database, logger });
	const coordinator = new RestartCoordinator({
		database: () => database,
		hooks,
		logger,
		...(options.onSettled === undefined ? {} : { onSettled: options.onSettled }),
	});
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		createdAt: now,
		id: chatId,
		kind: "webui",
		title: "Restart",
		updatedAt: now,
	});
	await database.insert(conversations).values({
		chatObjectId: chatId,
		createdAt: now,
		durableConversationId: "1",
		id: sessionId,
		isReceiving: 1,
		kind: "webui",
		title: "Main",
		updatedAt: now,
	});
	return { coordinator, database, directory, hooks, sessionId };
}

async function waitForStatus(
	coordinator: RestartCoordinator,
	expected: "completed" | "cancelled" | "failed",
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if ((await coordinator.status())?.status === expected) return;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for restart status ${expected}`);
}

describe("restart coordinator", () => {
	test("injects the countdown into every session and executes the handler", async () => {
		const { coordinator, database, hooks, sessionId } = await setup();
		const handled = new Promise<RestartIntent>((resolve) => {
			coordinator.setHandler(resolve);
		});
		const scheduled = await coordinator.schedule({
			delayMs: 40,
			mode: "update",
			reason: "test update",
			requestedBy: "test",
		});
		expect(scheduled.status).toBe("scheduled");
		expect(await hooks.renderContext(sessionId)).toContain("restart and update");
		const intent = await Promise.race([handled, Bun.sleep(500).then(() => undefined)]);
		expect(intent?.mode).toBe("update");
		expect(intent?.reason).toBe("test update");
		await waitForStatus(coordinator, "completed");
		expect((await coordinator.status())?.status).toBe("completed");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("cancels a scheduled restart and clears its runtime hook", async () => {
		const { coordinator, database, hooks, sessionId } = await setup();
		await coordinator.schedule({
			delayMs: 5_000,
			mode: "restart",
			reason: "cancel me",
		});
		expect(await coordinator.cancel("test cancel")).toBe(true);
		expect((await coordinator.status())?.status).toBe("cancelled");
		expect(await hooks.renderContext(sessionId)).toBeUndefined();
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("completes an executing intent and re-arms a future scheduled intent on boot", async () => {
		const { coordinator, database, hooks, sessionId } = await setup();
		const now = Date.now();
		await database.insert(runtimeRestarts).values([
			{
				completedAtMs: null,
				createdAtMs: now - 2_000,
				executeAtMs: now - 1_000,
				id: "executing",
				metadataJson: "{}",
				mode: "update",
				reason: "already restarted",
				requestedBy: "test",
				status: "executing",
				updatedAtMs: now - 1_000,
			},
			{
				completedAtMs: null,
				createdAtMs: now,
				executeAtMs: now + 60_000,
				id: "scheduled",
				metadataJson: "{}",
				mode: "restart",
				reason: "still pending",
				requestedBy: "test",
				status: "scheduled",
				updatedAtMs: now,
			},
		]);
		await coordinator.recover();
		const rows = await database.select().from(runtimeRestarts);
		expect(rows.find((row) => row.id === "executing")?.status).toBe("completed");
		// A future intent is durable work that must resume, not a failure.
		expect(rows.find((row) => row.id === "scheduled")?.status).toBe("scheduled");
		// Its countdown is re-injected for chats after the restart.
		expect(await hooks.renderContext(sessionId)).toContain("restart");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("resumes an overdue scheduled intent instead of dropping it", async () => {
		const { coordinator, database, hooks } = await setup();
		const now = Date.now();
		await database.insert(runtimeRestarts).values({
			completedAtMs: null,
			createdAtMs: now - 120_000,
			executeAtMs: now - 60_000,
			id: "overdue",
			metadataJson: "{}",
			mode: "restart",
			reason: "deadline passed while down",
			requestedBy: "test",
			status: "scheduled",
			updatedAtMs: now - 60_000,
		});
		const handled = new Promise<RestartIntent>((resolve) => {
			coordinator.setHandler(resolve);
		});
		await coordinator.recover();
		const intent = await Promise.race([handled, Bun.sleep(2_000).then(() => undefined)]);
		expect(intent?.id).toBe("overdue");
		await waitForStatus(coordinator, "completed");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("repeated recovery is idempotent and does not duplicate the countdown hook", async () => {
		const { coordinator, database, hooks, sessionId } = await setup();
		const now = Date.now();
		await database.insert(runtimeRestarts).values({
			completedAtMs: null,
			createdAtMs: now,
			executeAtMs: now + 60_000,
			id: "idempotent",
			metadataJson: "{}",
			mode: "restart",
			reason: "recover twice",
			requestedBy: "test",
			status: "scheduled",
			updatedAtMs: now,
		});
		await coordinator.recover();
		await coordinator.recover();
		const rendered = await hooks.renderContext(sessionId);
		expect(rendered?.match(/will restart/gu)).toHaveLength(1);
		const count = await database
			.select()
			.from(runtimeRestarts)
			.where(eq(runtimeRestarts.id, "idempotent"));
		expect(count).toHaveLength(1);
		expect(count[0]?.status).toBe("scheduled");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("reports terminal outcomes only, never a settlement for a resumed intent", async () => {
		const settled: Array<{ readonly id: string; readonly outcome: string }> = [];
		const { coordinator, database, hooks } = await setup({
			onSettled: (intent, outcome) => settled.push({ id: intent.id, outcome }),
		});
		const now = Date.now();
		await database.insert(runtimeRestarts).values([
			{
				completedAtMs: null,
				createdAtMs: now - 2_000,
				executeAtMs: now - 1_000,
				id: "executing-deployment",
				metadataJson: JSON.stringify({ deploymentId: "deployment-1" }),
				mode: "update",
				reason: "already restarted",
				requestedBy: "test",
				status: "executing",
				updatedAtMs: now - 1_000,
			},
			{
				completedAtMs: null,
				createdAtMs: now,
				executeAtMs: now + 60_000,
				id: "resumed-deployment",
				metadataJson: JSON.stringify({ deploymentId: "deployment-2" }),
				mode: "restart",
				reason: "still pending",
				requestedBy: "test",
				status: "scheduled",
				updatedAtMs: now,
			},
		]);
		await coordinator.recover();
		expect(settled).toContainEqual({ id: "executing-deployment", outcome: "completed" });
		// A resumed intent is not settled; it still owns a scheduled deployment.
		expect(settled.some((entry) => entry.id === "resumed-deployment")).toBe(false);
		// Scheduling a newer intent supersedes the resumed one, which then settles as cancelled.
		const cancelled = await coordinator.schedule({ delayMs: 60_000, reason: "to cancel" });
		expect(settled).toContainEqual({ id: "resumed-deployment", outcome: "cancelled" });
		expect(await coordinator.cancel("admin cancelled")).toBe(true);
		expect(settled).toContainEqual({ id: cancelled.id, outcome: "cancelled" });
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("consumes a resolved restart-intent file and keeps unresolved ones", async () => {
		const { coordinator, database, directory, hooks } = await setup();
		const intentPath = join(directory, "restart-intent.json");
		const now = Date.now();
		await database.insert(runtimeRestarts).values({
			completedAtMs: now,
			createdAtMs: now - 1_000,
			executeAtMs: now - 500,
			id: "resolved-intent",
			metadataJson: "{}",
			mode: "update",
			reason: "done",
			requestedBy: "test",
			status: "completed",
			updatedAtMs: now,
		});
		expect(await coordinator.resumeIntentFile(intentPath)).toBe("missing");

		await Bun.write(intentPath, JSON.stringify({ id: "resolved-intent", mode: "update" }));
		expect(await coordinator.resumeIntentFile(intentPath)).toBe("consumed");
		expect(await Bun.file(intentPath).exists()).toBe(false);

		await Bun.write(intentPath, JSON.stringify({ id: "unknown-intent", mode: "update" }));
		expect(await coordinator.resumeIntentFile(intentPath)).toBe("unresolved");
		expect(await Bun.file(intentPath).exists()).toBe(true);

		await Bun.write(intentPath, "{ not json");
		expect(await coordinator.resumeIntentFile(intentPath)).toBe("unresolved");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});

	test("replays settlement for an intent that reached a terminal status before the deployment was settled", async () => {
		const settled: Array<{ readonly id: string; readonly outcome: string }> = [];
		const { coordinator, database, hooks } = await setup({
			onSettled: (intent, outcome) => settled.push({ id: intent.id, outcome }),
		});
		const now = Date.now();
		// The intent completed and was written terminal, then the process died before the
		// deployment row could be settled. Nothing else would ever trigger reconciliation.
		await database.insert(runtimeRestarts).values({
			completedAtMs: now - 500,
			createdAtMs: now - 2_000,
			executeAtMs: now - 1_000,
			id: "terminal-before-settlement",
			metadataJson: JSON.stringify({ deploymentId: "deployment-1" }),
			mode: "update",
			reason: "crashed after terminal write",
			requestedBy: "test",
			status: "completed",
			updatedAtMs: now - 500,
		});
		await coordinator.recover();
		expect(settled).toContainEqual({
			id: "terminal-before-settlement",
			outcome: "completed",
		});
		// Replaying on another boot is safe: settlement is idempotent.
		await coordinator.recover();
		expect(settled.filter((entry) => entry.id === "terminal-before-settlement")).toHaveLength(2);
		coordinator.close();
		hooks.close();
		database.$client.close();
	});
});

describe("restart coordinator without a handler", () => {
	test("does not consume a due intent; a later handler still runs it", async () => {
		const { coordinator, database, hooks } = await setup();
		await database.insert(runtimeRestarts).values({
			completedAtMs: null,
			createdAtMs: Date.now() - 1_000,
			executeAtMs: Date.now() - 500,
			id: "no-handler-yet",
			metadataJson: "{}",
			mode: "restart",
			reason: "handler registers after startup",
			requestedBy: "test",
			status: "scheduled",
			updatedAtMs: Date.now() - 500,
		});
		await coordinator.recover();
		// Give the re-arm path a chance to (incorrectly) fail the intent.
		await Bun.sleep(150);
		const [beforeHandler] = await database
			.select()
			.from(runtimeRestarts)
			.where(eq(runtimeRestarts.id, "no-handler-yet"));
		expect(beforeHandler?.status).toBe("scheduled");

		const handled = new Promise<RestartIntent>((resolve) => coordinator.setHandler(resolve));
		const intent = await Promise.race([handled, Bun.sleep(3_000).then(() => undefined)]);
		expect(intent?.id).toBe("no-handler-yet");
		await waitForStatus(coordinator, "completed");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});
});
