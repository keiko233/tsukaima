import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@elaina/contracts";
import type { ChannelAdapter, ChannelCapability, ChannelDiagnostics } from "@elaina/sdk";
import { ChannelRegistry } from "../src/services/channel-registry.ts";

class FakeAdapter implements ChannelAdapter {
	readonly id = "capability-channel";
	readonly kind = "fake";
	constructor(readonly caps: readonly ChannelCapability[]) {}
	capabilities() {
		return this.caps;
	}
	diagnostics(): ChannelDiagnostics {
		return { configured: true, connected: true, state: "open" };
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async send(): Promise<{ platformMessageId?: string }> {
		return {};
	}
	onEnvelope(_handler: (envelope: MessageEnvelope) => void): void {}
}

describe("channel capability narrowing", () => {
	test("combines legacy/granular capabilities and applies host/conversation narrowing", () => {
		const registry = new ChannelRegistry();
		registry.register(new FakeAdapter(["send", "interact"]));

		expect(registry.hasCapability("capability-channel", "send.image")).toBe(true);
		expect(registry.hasCapability("capability-channel", "interact.poke")).toBe(true);

		registry.narrow("capability-channel", { deny: ["send.image"] });
		expect(registry.hasCapability("capability-channel", "send.image")).toBe(false);
		expect(registry.hasCapability("capability-channel", "send.text")).toBe(true);

		registry.narrow("capability-channel", { allow: ["interact.poke"] }, "conversation-1");
		expect(registry.capabilities("capability-channel", "conversation-1")).toContain(
			"interact.poke",
		);
		expect(registry.hasCapability("capability-channel", "send.text", "conversation-1")).toBe(false);
	});
});
