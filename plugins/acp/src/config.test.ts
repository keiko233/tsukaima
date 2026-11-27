import { describe, expect, test } from "bun:test";
import { MODEL_CAPABILITIES } from "@tsukaima/sdk/model-capabilities";
import {
	acpModelCapabilities,
	acpProviderIdForProfile,
	createAcpModel,
	createPresetProfile,
	readAcpProfiles,
	resolveAcpProfiles,
	toAcpPluginModelDescriptor,
} from "./config.ts";
import { acpManifest } from "./manifest.ts";

describe("acp config and presets", () => {
	test("builds preset profiles for antigravity, codex, claude-code, and custom", () => {
		const agy = createPresetProfile("antigravity");
		expect(agy.command).toBe("agy");
		expect(agy.args).toEqual(["acp", "--stdio"]);
		expect(agy.supportsImageGeneration).toBe(true);
		expect(agy.supportsVideoGeneration).toBe(true);

		const codex = createPresetProfile("codex");
		expect(codex.command).toBe("codex-acp");
		expect(codex.supportsImageGeneration).toBe(true);
		expect(codex.supportsVideoGeneration).toBe(false);

		const claude = createPresetProfile("claude-code");
		expect(claude.command).toBe("claude-agent-acp");
		expect(claude.supportsImageGeneration).toBe(false);

		const custom = createPresetProfile("custom", { command: "my-acp", id: "my-cli" });
		expect(custom.id).toBe("my-cli");
		expect(custom.command).toBe("my-acp");
	});

	test("merges secret env values without leaking into manifest public keys", () => {
		expect(acpManifest.secretKeys).toEqual(["profileEnvSecrets"]);
		const raw = {
			profileEnvSecrets: {
				codex: { OPENAI_API_KEY: "sk-secret" },
			},
			profiles: [
				{
					command: "codex-acp",
					enabled: true,
					env: { CODEX_SANDBOX: "read-only" },
					id: "codex",
					models: [{ enabled: true, id: "gpt-5.4", supportsImageGeneration: true }],
					preset: "codex",
					supportsImageGeneration: true,
				},
				{
					command: "claude-agent-acp",
					enabled: false,
					id: "disabled-claude",
					models: [{ enabled: true, id: "claude-sonnet-4-5" }],
					preset: "claude-code",
				},
			],
		};

		const all = readAcpProfiles(raw);
		expect(all).toHaveLength(2);
		expect(all[0]?.env).toEqual({
			CODEX_SANDBOX: "read-only",
			OPENAI_API_KEY: "sk-secret",
		});

		const resolved = resolveAcpProfiles(raw);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]?.providerId).toBe(acpProviderIdForProfile("codex"));
	});

	test("computes capability tags and descriptors for chat and media-only profiles", () => {
		const model = createAcpModel("veo-3", {
			enabled: true,
			supportsImage: true,
			supportsImageGeneration: true,
			supportsReasoning: true,
			supportsSidechat: true,
			supportsTools: true,
			supportsVideoGeneration: true,
		});
		const chatCaps = acpModelCapabilities(model, {
			enableAsModelProvider: true,
			supportsImageGeneration: true,
			supportsVideoGeneration: true,
		});
		expect(chatCaps).toContain(MODEL_CAPABILITIES.basicChat);
		expect(chatCaps).toContain(MODEL_CAPABILITIES.imageGenerate);
		expect(chatCaps).toContain(MODEL_CAPABILITIES.videoGenerate);
		expect(chatCaps).toContain(MODEL_CAPABILITIES.videoImageToVideo);
		expect(chatCaps).toContain(MODEL_CAPABILITIES.decisionChoice);

		const mediaOnlyDescriptor = toAcpPluginModelDescriptor(model, {
			enableAsModelProvider: false,
			supportsImageGeneration: true,
			supportsVideoGeneration: true,
		});
		expect(mediaOnlyDescriptor.capabilities).not.toContain(MODEL_CAPABILITIES.basicChat);
		expect(mediaOnlyDescriptor.capabilities).not.toContain(MODEL_CAPABILITIES.toolUse);
		expect(mediaOnlyDescriptor.output).toEqual(["text", "image", "video"]);
	});
});
