import { describe, expect, test } from "bun:test";
import { resolveRuntimeUrl } from "./runtime-url";

describe("resolveRuntimeUrl", () => {
	test("resolves API paths to same-origin absolute URLs", () => {
		expect(resolveRuntimeUrl("/rpc", "http://127.0.0.1:7421")).toBe("http://127.0.0.1:7421/rpc");
		expect(resolveRuntimeUrl("/events/stream", "https://tsukaima.example.com")).toBe(
			"https://tsukaima.example.com/events/stream",
		);
	});

	test("rejects a missing browser origin instead of returning a relative URL", () => {
		expect(() => resolveRuntimeUrl("/rpc", undefined)).toThrow("browser origin is unavailable");
	});
});
