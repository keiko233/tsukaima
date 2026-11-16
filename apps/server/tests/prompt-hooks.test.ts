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
} from "@tsukaima/db";
import { createLogger } from "../src/logging.ts";
import { PromptHookService } from "../src/services/prompt-hooks.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "tsukaima-hooks-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	const chatId = randomUUID();
	const sessionId = randomUUID();
	const now = new Date().toISOString();
	await database.insert(chatObjects).values({
		createdAt: now,
		id: chatId,
		kind: "webui",
		title: "Hooks",
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
	const hooks = new PromptHookService({
		database: () => database,
		logger: createLogger({ capacity: 100, level: "error", target: "test" }),
	});
	return { database, hooks, sessionId };
}

describe("prompt hooks", () => {
	test("injects context once and renders a live restart countdown", async () => {
		const { database, hooks, sessionId } = await setup();
		await hooks.add({
			createdBy: "test",
			kind: "context",
			prompt: "Remember what chat B said about the deploy window.",
			targetSessionId: sessionId,
		});
		expect(await hooks.renderContext(sessionId)).toContain("chat B");
		expect(await hooks.renderContext(sessionId)).toBeUndefined();

		await hooks.add({
			createdBy: "test",
			expiresAtMs: Date.now() + 120_000,
			kind: "runtime",
			metadata: {
				executeAtMs: Date.now() + 120_000,
				mode: "update",
			},
			prompt: "Restart pending.",
		});
		const countdown = await hooks.renderContext(sessionId);
		expect(countdown).toContain("restart and update");
		expect(countdown).toContain("minute");
		expect(await hooks.renderContext(sessionId)).toContain("restart and update");

		hooks.close();
		database.$client.close();
	});

	test("dispatches reserved work after a restart and supports future resume timers", async () => {
		const { database, hooks, sessionId } = await setup();
		const dispatched: string[] = [];
		await hooks.add({
			afterRestart: true,
			createdBy: "test",
			kind: "resume",
			prompt: "Resume the release verification.",
			status: "scheduled",
			targetSessionId: sessionId,
		});
		expect(
			await hooks.dispatchStartupResumes(async (hook) => {
				dispatched.push(hook.prompt);
			}),
		).toBe(1);
		expect(dispatched).toEqual(["Resume the release verification."]);
		expect(
			await hooks.dispatchStartupResumes(async (hook) => {
				dispatched.push(hook.prompt);
			}),
		).toBe(0);

		const later = await hooks.add({
			createdBy: "test",
			deliverAtMs: Date.now() + 40,
			kind: "resume",
			prompt: "Time-based reserved task.",
			status: "scheduled",
			targetSessionId: sessionId,
		});
		hooks.armResume(later, async (hook) => {
			dispatched.push(hook.prompt);
		});
		await Bun.sleep(120);
		expect(dispatched).toContain("Time-based reserved task.");

		hooks.close();
		database.$client.close();
	});
});
