import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDomainDatabase, migrateDomainDatabase, type ElainaDatabase } from "@elaina/db";
import { createLogger } from "../src/logging.ts";
import { HookBus } from "../src/services/hook-bus.ts";
import { PluginTaskService } from "../src/services/plugin-task-service.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "elaina-plugin-tasks-"));
	directories.push(directory);
	const database = await openDomainDatabase(join(directory, "domain.sqlite"));
	migrateDomainDatabase(database);
	return database;
}

const logger = createLogger({ level: "error" });
const permissions = [
	"tasks.create",
	"tasks.get",
	"tasks.list",
	"tasks.cancel",
	"tasks.watch",
	"storage.global",
] as const;

describe("plugin task service", () => {
	test("creates, reads, lists, watches, dedupes, and cancels durable tasks", async () => {
		const database: ElainaDatabase = await setup();
		const hooks = new HookBus(logger);
		const created: unknown[] = [];
		const completed: unknown[] = [];
		hooks.on("task.created", (task) => created.push(task));
		hooks.on("task.completed", (task) => completed.push(task));
		const service = new PluginTaskService({ database, hooks, logger });
		const api = service.apiFor("demo", permissions);

		const task = await api.create({
			dedupeKey: "daily",
			kind: "reminder",
			payload: { text: "drink water" },
		});
		const duplicate = await api.create({
			dedupeKey: "daily",
			kind: "reminder",
			payload: { text: "ignored" },
		});
		expect(duplicate.id).toBe(task.id);
		expect(await api.get(task.id)).toEqual(
			expect.objectContaining({ id: task.id, kind: "reminder", pluginId: "demo" }),
		);
		expect((await api.list({ kind: "reminder" })).map((item) => item.id)).toEqual([task.id]);

		const watched: string[] = [];
		const unwatch = api.watch(task.id, (event) => watched.push(event.type));
		const cancelled = await api.cancel(task.id);
		unwatch();
		expect(cancelled?.status).toBe("cancelled");
		expect(watched).toEqual(["cancelled"]);
		expect(created).toHaveLength(1);
		expect(completed).toEqual([expect.objectContaining({ id: task.id, status: "cancelled" })]);
	});

	test("retries with backoff, repeats through the host scheduler, and narrows permissions", async () => {
		const database = await setup();
		const hooks = new HookBus(logger);
		let now = 1_000;
		const service = new PluginTaskService({
			database,
			hooks,
			logger,
			now: () => now,
			retryBaseMs: 10,
		});
		let retryAttempts = 0;
		let repeatRuns = 0;
		service.registerHandler("demo", "retry", () => {
			retryAttempts += 1;
			if (retryAttempts < 2) throw new Error("temporary");
			return { outcome: { done: true } };
		});
		service.registerHandler("demo", "repeat", () => {
			repeatRuns += 1;
		});

		const api = service.apiFor("demo", permissions);
		const retry = await api.create({ kind: "retry", maxAttempts: 2 });
		await service.tick();
		expect((await api.get(retry.id))?.attempts).toBe(1);
		expect((await api.get(retry.id))?.status).toBe("pending");
		now += 100;
		await service.tick();
		expect((await api.get(retry.id))?.status).toBe("completed");
		expect(retryAttempts).toBe(2);

		const repeat = await api.create({ intervalMs: 50, kind: "repeat" });
		await service.tick();
		expect(repeatRuns).toBe(1);
		expect((await api.get(repeat.id))?.status).toBe("pending");
		now += 51;
		await service.tick();
		expect(repeatRuns).toBe(2);

		const narrowed = await api.create({
			kind: "narrowed",
			permissions: ["storage.global"],
		});
		expect(narrowed.permissions.permissions).toEqual(["storage.global"]);
		await expect(api.create({ kind: "escalated", permissions: ["channel.send"] })).rejects.toThrow(
			"cannot escalate",
		);
		await expect(service.apiFor("demo", ["tasks.get"]).create({ kind: "denied" })).rejects.toThrow(
			"tasks.create",
		);
	});
});
