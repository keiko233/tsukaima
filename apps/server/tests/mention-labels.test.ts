import { describe, expect, test } from "bun:test";
import { collectMentionIds, replaceMentionIds } from "../src/services/mention-labels.ts";

describe("mention labels", () => {
	test("collects every distinct mention id", () => {
		const ids = collectMentionIds("@10001 ping @10001 and @10002");
		expect([...ids]).toEqual(["10001", "10002"]);
		expect(collectMentionIds("no mentions here").size).toBe(0);
	});

	test("replaces known ids and leaves everything else untouched", () => {
		const labels = new Map([["10001", "ExampleUser"]]);
		expect(replaceMentionIds("@10001 ping", labels)).toBe("@ExampleUser ping");
		expect(replaceMentionIds("[@10001] hi", labels)).toBe("[@ExampleUser] hi");
		expect(replaceMentionIds("@10001示例", labels)).toBe("@ExampleUser示例");
		expect(replaceMentionIds("@10003 ping", labels)).toBe("@10003 ping");
	});

	test("does not treat address fragments or longer numbers as mentions", () => {
		const labels = new Map([
			["12345", "must not appear"],
			["1234567890123", "must not appear"],
		]);
		expect(replaceMentionIds("mail me at user@10001.example", labels)).toBe(
			"mail me at user@10001.example",
		);
		expect(replaceMentionIds("@1234567890123", labels)).toBe("@1234567890123");
		expect(replaceMentionIds("@123", labels)).toBe("@123");
	});
});
