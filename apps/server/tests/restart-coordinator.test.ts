import { afterEach, describe, expect, test } from "bun:test";
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

async function setup() {
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
	return { coordinator, database, hooks, sessionId };
}

describe("restart coordinator", () => {
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

	test("recovers executing and interrupted restart intents on boot", async () => {
		const { coordinator, database, hooks } = await setup();
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
				reason: "unexpected stop",
				requestedBy: "test",
				status: "scheduled",
				updatedAtMs: now,
			},
		]);
		await coordinator.recover();
		const rows = await database.select().from(runtimeRestarts);
		expect(rows.find((row) => row.id === "executing")?.status).toBe("completed");
		expect(rows.find((row) => row.id === "scheduled")?.status).toBe("failed");
		coordinator.close();
		hooks.close();
		database.$client.close();
	});
});
