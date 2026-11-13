import { describe, expect, test } from "bun:test";
import { SupervisedReloadController, type ReloadController } from "../src/reload.ts";
import type { HealthCheckResult } from "../src/types.ts";

function reloader(): ReloadController & { readonly calls: number } {
	const state = {
		calls: 0,
		async reload() {
			state.calls += 1;
			return { message: "reloaded", reloadedAtMs: 1, success: true };
		},
	};
	return state;
}

describe("SupervisedReloadController", () => {
	test("runs pre-health, reload, and post-health in order", async () => {
		const order: string[] = [];
		const controller = new SupervisedReloadController({
			healthCheck: () => {
				order.push("check");
				return { checkedAtMs: 0, ok: true } satisfies HealthCheckResult;
			},
			now: () => 10,
			reload: {
				async reload() {
					order.push("reload");
					return { message: "ok", reloadedAtMs: 10, success: true };
				},
			},
		});
		const outcome = await controller.reload("elaina", { reason: "test" });
		expect(outcome.success).toBe(true);
		expect(outcome.postCheck.ok).toBe(true);
		expect(order).toEqual(["check", "reload", "check"]);
	});

	test("skips reload when the pre-check fails", async () => {
		const reload = reloader();
		const controller = new SupervisedReloadController({
			healthCheck: () => ({ checkedAtMs: 0, message: "down", ok: false }),
			reload,
		});
		const outcome = await controller.reload("elaina", { reason: "test" });
		expect(outcome.success).toBe(false);
		expect(outcome.reload).toBeNull();
		expect(reload.calls).toBe(0);
	});

	test("invokes rollback once when the post-check fails", async () => {
		let checks = 0;
		const rollbacks: string[] = [];
		const controller = new SupervisedReloadController({
			healthCheck: () => {
				checks += 1;
				return {
					checkedAtMs: 0,
					...(checks === 2 ? { message: "unhealthy" } : {}),
					ok: checks === 1,
				};
			},
			reload: reloader(),
			rollback: (outcome) => {
				rollbacks.push(outcome.postCheck.message ?? "unknown");
			},
		});
		const outcome = await controller.reload("elaina", {
			context: undefined,
			reason: "test",
		} as never);
		expect(outcome.success).toBe(false);
		expect(outcome.rollbackAttempted).toBe(true);
		expect(rollbacks).toEqual(["unhealthy"]);
	});
});
