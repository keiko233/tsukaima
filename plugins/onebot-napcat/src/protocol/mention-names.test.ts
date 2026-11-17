import { describe, expect, test } from "bun:test";
import {
	createOneBotMentionNameResolver,
	type OneBotMentionNameStoreInput,
} from "./mention-names.ts";

const config = { channelId: "acct-1" };

describe("OneBot mention name resolution", () => {
	test("prefers the group card and caches the result", async () => {
		const calls: string[] = [];
		const remembered: OneBotMentionNameStoreInput[] = [];
		const resolver = createOneBotMentionNameResolver({
			...config,
			readAction: async (action) => {
				calls.push(action);
				return { card: "Group Card", nickname: "Account Nickname" };
			},
			store: {
				remember: (input) => {
					remembered.push(input);
				},
			},
		});

		expect(await resolver({ groupId: "555", userId: "10002" })).toBe("Group Card");
		expect(await resolver({ groupId: "555", userId: "10002" })).toBe("Group Card");
		expect(calls).toEqual(["get_group_member_info"]);
		expect(remembered[0]).toMatchObject({
			displayName: "Group Card",
			externalId: "10002",
			platform: "onebot-v11",
			platformAccountId: "acct-1",
		});
	});

	test("falls back to stranger info when the group lookup fails", async () => {
		const calls: string[] = [];
		const resolver = createOneBotMentionNameResolver({
			...config,
			readAction: async (action) => {
				calls.push(action);
				if (action === "get_group_member_info") throw new Error("not a group member");
				return { nickname: "Stranger Name" };
			},
		});

		expect(await resolver({ groupId: "555", userId: "10003" })).toBe("Stranger Name");
		expect(calls).toEqual(["get_group_member_info", "get_stranger_info"]);
	});

	test("returns undefined and caches a failure instead of throwing", async () => {
		let calls = 0;
		const resolver = createOneBotMentionNameResolver({
			...config,
			readAction: async () => {
				calls += 1;
				throw new Error("platform offline");
			},
		});

		expect(await resolver({ userId: "10004" })).toBeUndefined();
		expect(await resolver({ userId: "10004" })).toBeUndefined();
		expect(calls).toBe(1);
	});
});
