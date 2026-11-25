import { describe, expect, test } from "bun:test";
import type { RestartStatus } from "@tsukaima/contracts";
import type { DurableExtension } from "@tsukaima/core";
import type { AuditEntry } from "@tsukaima/sdk";
import type { Logger } from "../src/logging.ts";
import {
	ADMIN_RUNTIME_TOOL_NAMES,
	authorizeAdminRuntimeToolCall,
	createAdminRuntimeToolsExtension,
	type AdminRuntimeRestartPort,
	type AdminRuntimeToolsOptions,
} from "../src/services/admin-runtime-tools.ts";

const logger = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	trace: () => undefined,
	warn: () => undefined,
} as unknown as Logger;

interface ScheduleCall {
	readonly delaySeconds?: number;
	readonly mode?: "restart" | "update";
	readonly reason?: string;
	readonly requestedBy?: string;
}

function restartStatus(overrides: Partial<RestartStatus> = {}): RestartStatus {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		executeAt: "2026-01-01T00:01:00.000Z",
		id: "restart-synthetic",
		mode: "restart",
		reason: "synthetic maintenance",
		requestedBy: "webui-admin",
		status: "scheduled",
		...overrides,
	};
}

function createPort(): {
	readonly cancels: (string | undefined)[];
	readonly port: AdminRuntimeRestartPort;
	readonly schedules: ScheduleCall[];
} {
	const cancels: (string | undefined)[] = [];
	const schedules: ScheduleCall[] = [];
	let current: RestartStatus | null = null;
	return {
		cancels,
		port: {
			cancel: async (reason) => {
				cancels.push(reason);
				if (current?.status !== "scheduled") return false;
				current = {
					...current,
					reason: reason ?? current.reason,
					status: "cancelled",
				};
				return true;
			},
			schedule: async (input) => {
				schedules.push(input);
				current = restartStatus({
					mode: input.mode ?? "restart",
					...(input.reason === undefined ? {} : { reason: input.reason }),
					requestedBy: input.requestedBy ?? "webui-admin",
					...(input.delaySeconds === undefined
						? {}
						: {
								executeAt: new Date(
									Date.parse("2026-01-01T00:00:00.000Z") + input.delaySeconds * 1_000,
								).toISOString(),
							}),
				});
				return current;
			},
			status: async () => current,
		},
		schedules,
	};
}

function decodeResult(result: unknown): unknown {
	const output = (result as { readonly output?: readonly unknown[] }).output;
	for (const part of output ?? []) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof part.text === "string"
		) {
			try {
				return JSON.parse(part.text);
			} catch {
				return part.text;
			}
		}
	}
	return undefined;
}

function extensionTool(extension: DurableExtension, name: string) {
	const found = (extension.tools ?? []).find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`Tool ${name} missing from ${extension.name}`);
	return found;
}

async function invokeTool(
	extension: DurableExtension,
	name: string,
	args: Record<string, unknown>,
	durableConversationId = "durable-webui-synthetic",
) {
	const tool = extensionTool(extension, name);
	return await tool.execute(
		args,
		{ conversationId: durableConversationId } as unknown as Parameters<typeof tool.execute>[1],
		undefined as never,
	);
}

function createExtension(input: {
	readonly authorize?: AdminRuntimeToolsOptions["authorize"];
	readonly port: AdminRuntimeRestartPort;
}): { readonly audits: AuditEntry[]; readonly extension: DurableExtension } {
	const audits: AuditEntry[] = [];
	const extension = createAdminRuntimeToolsExtension({
		audit: (entry) => {
			audits.push(entry);
		},
		authorize: input.authorize ?? (async () => ({ allowed: true, chatKind: "webui" })),
		logger,
		restart: input.port,
	});
	return { audits, extension };
}

describe("admin runtime authorization", () => {
	test("webui and workspace are allowed while unknown kinds and missing callers fail closed", () => {
		for (const chatKind of ["webui", "workspace"] as const) {
			expect(
				authorizeAdminRuntimeToolCall({
					caller: { chatKind, domainConversationId: "session-synthetic" },
					toolName: "runtime_restart",
				}),
			).toMatchObject({ allowed: true });
		}
		for (const caller of [
			{},
			{ chatKind: "task" },
			{ chatKind: "plugin" },
			{ chatKind: "unknown" },
		] as const) {
			expect(authorizeAdminRuntimeToolCall({ caller, toolName: "runtime_restart" })).toMatchObject({
				allowed: false,
				reason: "disallowed_chat_kind",
			});
		}
		expect(
			authorizeAdminRuntimeToolCall({
				caller: { chatKind: "webui" },
				toolName: "not_an_admin_tool",
			}),
		).toMatchObject({ allowed: false, reason: "unknown_admin_tool" });
	});

	test("non-admin IM callers are denied and a trusted admin sender is allowed", () => {
		for (const chatKind of ["private", "group"] as const) {
			expect(
				authorizeAdminRuntimeToolCall({
					caller: { chatKind, domainConversationId: "session-synthetic" },
					toolName: "runtime_restart",
				}),
			).toMatchObject({ allowed: false, reason: "admin_required" });
		}
		expect(
			authorizeAdminRuntimeToolCall({
				caller: {
					chatKind: "group",
					domainConversationId: "session-synthetic",
					isAdmin: true,
					senderPlatformId: "synthetic-admin",
				},
				toolName: "runtime_restart_cancel",
			}),
		).toMatchObject({ allowed: true, callerId: "synthetic-admin", isAdmin: true });
	});

	test("ADMIN_RUNTIME_TOOL_NAMES is the complete runtime maintenance surface", () => {
		expect([...ADMIN_RUNTIME_TOOL_NAMES]).toEqual([
			"runtime_restart",
			"runtime_restart_status",
			"runtime_restart_cancel",
		]);
	});
});

describe("admin runtime tools", () => {
	test("exposes deferred admin tools on both chat and coding surfaces", () => {
		const { extension } = createExtension({ port: createPort().port });
		expect(extension.name).toBe("tsukaima-admin-runtime-tools");
		expect(extension.tools?.map((tool) => tool.name)).toEqual([...ADMIN_RUNTIME_TOOL_NAMES]);
		for (const tool of extension.tools ?? []) {
			expect(tool).toMatchObject({ deferred: true, surface: "both" });
		}
	});

	test("schedules a graceful restart with defaults and a durable audit record", async () => {
		const fake = createPort();
		const { audits, extension } = createExtension({ port: fake.port });
		const result = await invokeTool(extension, "runtime_restart", {});
		expect(decodeResult(result)).toMatchObject({
			id: "restart-synthetic",
			mode: "restart",
			status: "scheduled",
		});
		expect(fake.schedules).toEqual([
			{ delaySeconds: 60, mode: "restart", requestedBy: "webui-admin" },
		]);
		expect(audits.at(-1)).toMatchObject({
			action: "admin-runtime.runtime_restart",
			result: "ok",
			targetKind: "admin-runtime",
		});
	});

	test("passes explicit delay, update mode, and reason through and attributes a workspace caller", async () => {
		const fake = createPort();
		const { audits, extension } = createExtension({
			authorize: async () => ({ allowed: true, chatKind: "workspace", sessionId: "session-1" }),
			port: fake.port,
		});
		const result = await invokeTool(extension, "runtime_restart", {
			delaySeconds: 300,
			mode: "update",
			reason: "apply maintenance window",
		});
		expect(decodeResult(result)).toMatchObject({
			id: "restart-synthetic",
			mode: "update",
			reason: "apply maintenance window",
			requestedBy: "workspace-agent",
		});
		expect(fake.schedules).toEqual([
			{
				delaySeconds: 300,
				mode: "update",
				reason: "apply maintenance window",
				requestedBy: "workspace-agent",
			},
		]);
		expect(audits.at(-1)).toMatchObject({
			action: "admin-runtime.runtime_restart",
			result: "ok",
		});
	});

	test("rejects an invalid delay before touching the coordinator", async () => {
		const fake = createPort();
		const { audits, extension } = createExtension({ port: fake.port });
		const result = await invokeTool(extension, "runtime_restart", { delaySeconds: 0 });
		expect(result).toMatchObject({ isError: true });
		expect(decodeResult(result)).toMatchObject({
			error: "delaySeconds must be an integer between 1 and 86400",
		});
		expect(fake.schedules).toEqual([]);
		expect(audits.at(-1)).toMatchObject({
			action: "admin-runtime.runtime_restart",
			result: "failed",
		});
	});

	test("a denied caller cannot schedule a restart and the denial is audited", async () => {
		const fake = createPort();
		const { audits, extension } = createExtension({
			authorize: async () => ({ allowed: false, reason: "admin_required" }),
			port: fake.port,
		});
		const result = await invokeTool(extension, "runtime_restart", {});
		expect(result).toMatchObject({ isError: true });
		expect(decodeResult(result)).toMatchObject({ error: "admin_required" });
		expect(fake.schedules).toEqual([]);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			action: "admin-runtime.runtime_restart",
			reason: "admin_required",
			result: "denied",
		});
	});

	test("a throwing or missing authorization check fails closed", async () => {
		const fake = createPort();
		const throwing = createAdminRuntimeToolsExtension({
			authorize: async () => {
				throw new Error("synthetic lookup failure");
			},
			logger,
			restart: fake.port,
		});
		const throwingResult = await invokeTool(throwing, "runtime_restart_cancel", {});
		expect(throwingResult).toMatchObject({ isError: true });
		expect(fake.cancels).toEqual([]);

		const missing = createAdminRuntimeToolsExtension({ logger, restart: fake.port });
		const missingResult = await invokeTool(missing, "runtime_restart_cancel", {});
		expect(missingResult).toMatchObject({ isError: true });
		expect(decodeResult(missingResult)).toMatchObject({ error: "authorization_unavailable" });
		expect(fake.cancels).toEqual([]);
	});

	test("status reports the newest intent and cancel cancels the active one", async () => {
		const fake = createPort();
		const { audits, extension } = createExtension({ port: fake.port });
		const empty = await invokeTool(extension, "runtime_restart_status", {});
		expect(decodeResult(empty)).toBeNull();

		await invokeTool(extension, "runtime_restart", {});
		const scheduled = await invokeTool(extension, "runtime_restart_status", {});
		expect(decodeResult(scheduled)).toMatchObject({
			id: "restart-synthetic",
			status: "scheduled",
		});

		const cancelled = await invokeTool(extension, "runtime_restart_cancel", {
			reason: "maintenance postponed",
		});
		expect(decodeResult(cancelled)).toMatchObject({
			cancelled: true,
			restart: { status: "cancelled" },
		});
		expect(fake.cancels).toEqual(["maintenance postponed"]);
		const afterCancel = await invokeTool(extension, "runtime_restart_status", {});
		expect(decodeResult(afterCancel)).toMatchObject({ status: "cancelled" });
		expect(audits.some((entry) => entry.action === "admin-runtime.runtime_restart_cancel")).toBe(
			true,
		);
	});
});
