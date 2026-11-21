import { describe, expect, test } from "bun:test";
import { isDirectSendToolName } from "../src/services/tool-names.ts";

describe("direct channel send tool-name resolution", () => {
	test("matches canonical, clean, double-underscore, and hashed channel send names", () => {
		for (const name of [
			"onebot-napcat.send",
			"onebot-napcat_send",
			"onebot_napcat__send",
			"onebot-napcat_send_9fa1ce39",
			"onebot-napcat.sendForward",
			"onebot-napcat_sendForward",
			"onebot-napcat.send_message",
			"onebot-napcat_send_message",
		]) {
			expect(isDirectSendToolName(name)).toBe(true);
		}
	});

	test("never matches workspace or sticker tools that merely end in send", () => {
		for (const name of [
			"workspace_send",
			"workspace.send",
			"workspace_send_message",
			"sticker-meme_send",
			"sticker-meme.send",
			"sticker-meme_send_9fa1ce39",
			"onebot-napcat.sendFile",
			"send",
		]) {
			expect(isDirectSendToolName(name)).toBe(false);
		}
	});
});
