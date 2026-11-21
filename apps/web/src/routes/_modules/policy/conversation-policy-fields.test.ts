import { describe, expect, test } from "bun:test";
import {
	type ConversationPolicy,
	conversationPolicyPatchSchema,
	conversationPolicySchema,
	defaultConversationPolicy,
} from "@tsukaima/contracts";
import { toPolicyPatch } from "./policy-patch";

const draft = (): ConversationPolicy =>
	structuredClone(conversationPolicySchema.parse(defaultConversationPolicy));

describe("toPolicyPatch nullable clears", () => {
	test("cleared nullable overrides serialize as explicit null", () => {
		const policy = draft();
		delete policy.pacing.allowedTools;
		delete policy.sidechat.model;
		delete policy.generation.temperature;
		delete policy.generation.topP;
		delete policy.generation.stop;
		delete policy.gate.model;
		const patch = toPolicyPatch(policy);
		expect(patch.pacing?.allowedTools).toBeNull();
		expect(patch.sidechat?.model).toBeNull();
		expect(patch.generation?.temperature).toBeNull();
		expect(patch.generation?.topP).toBeNull();
		expect(patch.generation?.stop).toBeNull();
		expect(patch.gate?.model).toBeNull();
		// The wire schema accepts the explicit clears, so mergeConversationPolicy can remove them.
		expect(conversationPolicyPatchSchema.parse(patch)).toMatchObject({
			gate: { model: null },
			generation: { stop: null, temperature: null, topP: null },
			pacing: { allowedTools: null },
			sidechat: { model: null },
		});
		expect(Object.values(patch.generation ?? {}).every((value) => value !== undefined)).toBe(true);
	});

	test("populated overrides are preserved verbatim", () => {
		const policy = draft();
		policy.pacing.allowedTools = ["memory.recall"];
		policy.sidechat.model = "synthetic-model";
		policy.generation.temperature = 0.7;
		policy.generation.topP = 0.9;
		policy.generation.stop = ["</synthetic>"];
		policy.gate.model = "synthetic-gate-model";
		const patch = toPolicyPatch(policy);
		expect(patch.pacing?.allowedTools).toEqual(["memory.recall"]);
		expect(patch.sidechat?.model).toBe("synthetic-model");
		expect(patch.generation?.temperature).toBe(0.7);
		expect(patch.generation?.topP).toBe(0.9);
		expect(patch.generation?.stop).toEqual(["</synthetic>"]);
		expect(patch.gate?.model).toBe("synthetic-gate-model");
	});
});
