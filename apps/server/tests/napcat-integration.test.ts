import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { messages } from "@elaina/db";
import {
	ONEBOT_TRANSPORT_FACTORY_BINDING,
	type OneBotTransport,
	type OneBotTransportFactory,
	type OneBotTransportEvents,
} from "@elaina-plugin/onebot-napcat";
import { createApp } from "../src/app.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

class FakeNapCatTransport implements OneBotTransport {
	closeCount = 0;
	readonly actions: Array<{ action: string; echo: string; params: Record<string, unknown> }> = [];
	readonly #listeners = new Map<string, Array<(...args: never[]) => void>>();

	close(): void {
		this.closeCount += 1;
		this.#emit("close");
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
		this.actions.push(parsed);
		queueMicrotask(() => {
			this.respond({ data: { message_id: 7_001 }, echo: parsed.echo, retcode: 0 });
		});
	}

	emitMessage(event: unknown): void {
		this.#emit("message", JSON.stringify(event));
	}

	emitOpen(): void {
		this.#emit("open");
	}

	respond(value: unknown): void {
		this.#emit("message", JSON.stringify(value));
	}

	#emit(name: string, payload?: string): void {
		for (const listener of this.#listeners.get(name) ?? []) {
			(listener as (...args: unknown[]) => void)(payload);
		}
	}
}

const privateEvent = (id: string, text: string) => ({
	message: [
		{ data: { text }, type: "text" },
		{ data: { file_id: "image-1", url: "https://cdn.test/a.png" }, type: "image" },
	],
	message_id: id,
	message_type: "private",
	post_type: "message",
	self_id: 99,
	sender: { card: "Keiko", user_id: 10_001 },
	time: Math.floor(Date.now() / 1_000),
	user_id: 10_001,
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("fake NapCat integration", () => {
	test("runs message, notice, action, and crash-reconnect flows through the lifecycle", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "elaina-napcat-integration-"));
		directories.push(directory);
		const transports: FakeNapCatTransport[] = [];
		const factory: OneBotTransportFactory = () => {
			const transport = new FakeNapCatTransport();
			transports.push(transport);
			return transport;
		};
		const { lifecycle } = createApp(
			{
				ELAINA_DATA_DIR: directory,
				ELAINA_ONEBOT_WS_URL: "ws://napcat:3001",
				ELAINA_PORT: "7420",
			},
			{
				pluginBindings: new Map([[ONEBOT_TRANSPORT_FACTORY_BINDING, factory]]),
				reply: { pendingGraceMs: 0 },
			},
		);
		await lifecycle.start();
		try {
			transports[0]?.emitOpen();
			expect(lifecycle.channels.get("onebot")?.diagnostics().connected).toBe(true);

			transports[0]?.emitMessage(privateEvent("integration-message-1", "hello media"));
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("Domain database not ready");
			const inbound = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(eq(messages.direction, "inbound"));
				return rows.find((row) => row.platformMessageId === "integration-message-1");
			});
			expect(JSON.parse(inbound.partsJson ?? "[]")).toEqual([
				{ text: "hello media", type: "text" },
				expect.objectContaining({ channelRef: "image-1", type: "image" }),
			]);

			transports[0]?.emitMessage({
				group_id: 555,
				notice_type: "notify",
				post_type: "notice",
				self_id: 99,
				sub_type: "poke",
				time: Math.floor(Date.now() / 1_000),
				target_id: 99,
				user_id: 10_001,
			});
			const notice = await waitFor(async () => {
				const rows = await database.select().from(messages).where(eq(messages.kind, "notice"));
				return rows[0];
			});
			expect(notice.direction).toBe("system");
			expect(notice.contentText).toContain("[poke]");

			const sent = await lifecycle.pluginHost.invokeRpc("onebot-napcat.send", {
				parts: [{ text: "integration reply", type: "text" }],
				target: { channelId: "onebot", kind: "private", platformConversationId: "10001" },
			});
			expect(sent).toEqual({ ok: true, result: { platformMessageId: "7001" } });
			expect(transports[0]?.actions.at(-1)?.action).toBe("send_private_msg");

			transports[0]?.close();
			const reconnected = await waitFor(async () =>
				transports.length >= 2 ? transports[1] : undefined,
			);
			reconnected.emitOpen();
			expect(lifecycle.channels.get("onebot")?.diagnostics()).toMatchObject({
				connected: true,
				state: "open",
			});
			reconnected.emitMessage(privateEvent("integration-message-2", "after crash"));
			const afterCrash = await waitFor(async () => {
				const rows = await database
					.select()
					.from(messages)
					.where(eq(messages.platformMessageId, "integration-message-2"));
				return rows[0];
			});
			expect(afterCrash.contentText).toContain("after crash");
		} finally {
			await lifecycle.stop();
		}
	});
});
