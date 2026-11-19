import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createHostSandbox, DomainCodingStore, type ReloadController } from "@tsukaima/coding";
import { createOpenAICompatibleModelPort } from "@tsukaima/core";
import { conversations, runtimeRestarts } from "@tsukaima/db";
import type { MessageEnvelope } from "@tsukaima/contracts";
import { providerSafeToolName } from "@tsukaima/sdk";
import { SELF_ITERATION_HOST_BINDING } from "@tsukaima-plugin/self-iteration";
import { loadConfig } from "../src/config.ts";
import { TsukaimaLifecycle } from "../src/lifecycle.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

interface CapturedRequest {
	readonly messages: readonly unknown[];
	readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
}

function createCapturingModel() {
	const requests: CapturedRequest[] = [];
	const model = createOpenAICompatibleModelPort(
		{
			apiKey: "test-key",
			baseUrl: "http://self-iteration.invalid/v1",
			fetch: (async (_input, init) => {
				requests.push(JSON.parse(String(init?.body ?? "{}")) as CapturedRequest);
				return new Response(
					JSON.stringify({
						choices: [{ finish_reason: "stop", message: { content: "noted" } }],
						id: `response-${requests.length}`,
						model: "capture-model",
						usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
					}),
					{ headers: { "content-type": "application/json" }, status: 200 },
				);
			}) as typeof fetch,
		},
		[{ capabilities: ["basic-chat", "tool-use"], modelId: "capture-model" }],
	);
	return { model, requests };
}

const envelope = (id: string, channelId = "onebot-self-iteration"): MessageEnvelope => ({
	channelId,
	channelKind: "onebot-v11",
	conversationKey: { kind: "private", peerId: "qq-user" },
	id,
	mentions: [],
	parts: [{ text: "hello", type: "text" }],
	sender: { displayName: "QQ user", id: "qq-user", platformId: "qq-user" },
	source: { messageId: id, timestampMs: Date.now() },
});

async function fixture() {
	const root = await fs.mkdtemp(join(tmpdir(), "tsukaima-self-iteration-server-"));
	directories.push(root);
	const repo = join(root, "repo");
	await fs.mkdir(join(repo, "src"), { recursive: true });
	await fs.writeFile(join(repo, "README.md"), "# Server fixture\n");
	await fs.writeFile(join(repo, "package.json"), '{"name":"fixture"}\n');
	const git = (args: readonly string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=test", "-c", "user.email=test@tsukaima.invalid", ...args],
			{
				cwd: repo,
			},
		);
	git(["init", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-m", "initial"]);
	const store = new DomainCodingStore(join(root, "domain.sqlite"));
	const reloads: string[] = [];
	const reload: ReloadController = {
		async reload(componentId, context) {
			reloads.push(`${componentId}:${context.reason}`);
			return { message: "reloaded", reloadedAtMs: Date.now(), success: true };
		},
	};
	const { model, requests } = createCapturingModel();
	const lifecycle = new TsukaimaLifecycle(
		loadConfig({ TSUKAIMA_DATA_DIR: join(root, "data"), TSUKAIMA_PORT: "7422" }),
		{
			env: {},
			model,
			pluginBindings: new Map([
				[
					SELF_ITERATION_HOST_BINDING,
					{
						healthCheck: async () => ({ checkedAtMs: Date.now(), ok: true }),
						reload,
						repositoryRoot: repo,
						// The host backend is the Compose default; pinning it keeps the isolated
						// exec/check tools withheld regardless of whether bubblewrap is installed.
						sandbox: createHostSandbox({
							repositoryPath: repo,
							worktreeRoot: join(root, "worktrees"),
						}),
						store,
						worktreeRoot: join(root, "worktrees"),
					},
				],
			]),
		},
	);
	return { lifecycle, reloads, requests };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
}

describe("self-iteration runtime", () => {
	test("registers the plugin without maintenance model tools", async () => {
		const { lifecycle } = await fixture();
		await lifecycle.start();
		try {
			const rows = await lifecycle.pluginHost.list();
			const plugin = rows.find((entry) => entry.id === "self-iteration");
			expect(plugin).toBeDefined();
			// Without OS isolation the shell and check tools are withheld, not offered.
			expect([...(plugin?.tools ?? [])].toSorted()).toEqual([
				"self-iteration.analyze",
				"self-iteration.build",
				"self-iteration.diff",
				"self-iteration.edit",
				"self-iteration.propose",
				"self-iteration.status",
				"self-iteration.test",
				"self-iteration.upstream",
				"self-iteration.worktree",
			]);
			expect(
				(plugin?.tools ?? []).some((tool) =>
					/deploy|rollback|backup|reload|approve|reject/u.test(tool),
				),
			).toBe(false);
			const overview = await lifecycle.pluginHost.invokeRpc(
				"self-iteration.overview",
				{},
				"self-iteration",
			);
			expect(overview).toEqual(
				expect.objectContaining({ stats: expect.objectContaining({ tasks: 0 }) }),
			);
		} finally {
			await lifecycle.stop();
		}
	});

	test("normal QQ conversations never see coding tools, even with an explicit capability", async () => {
		const { lifecycle, requests } = await fixture();
		await lifecycle.start();
		try {
			await lifecycle.conversationPolicy.update({
				policy: { pacing: { burstMaxMessages: 1 } },
				scope: "global",
			});
			const normal = await lifecycle.conversationRouter.ingest(envelope("normal-1"));
			expect(normal.ignored).toBe(false);
			await waitFor(() => (requests.length >= 1 ? true : undefined));
			const normalTools = requests[0]?.tools?.map((tool) => tool.function?.name ?? "") ?? [];
			expect(normalTools).not.toContain(providerSafeToolName("self-iteration.analyze"));
			expect(normalTools).not.toContain(providerSafeToolName("self-iteration.worktree"));
			expect(normalTools.some((name) => name.includes("self_iteration"))).toBe(false);

			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database not ready");
			const [conversation] = await database
				.select()
				.from(conversations)
				.where(eq(conversations.id, normal.sessionId))
				.limit(1);
			if (conversation === undefined) throw new Error("conversation not found");
			await lifecycle.conversationPolicy.update({
				conversationId: conversation.id,
				policy: { capabilities: ["coding"] },
				scope: "conversation",
			});
			await lifecycle.conversationRouter.ingest(envelope("coding-1"));
			await waitFor(() => (requests.length >= 2 ? true : undefined));
			const codingTools = requests[1]?.tools?.map((tool) => tool.function?.name ?? "") ?? [];
			expect(codingTools).not.toContain(providerSafeToolName("self-iteration.analyze"));
			expect(codingTools).not.toContain(providerSafeToolName("self-iteration.edit"));
			expect(codingTools.some((name) => name.includes("self_iteration"))).toBe(false);

			// Background/proactive turns reach the same conversation, so a stale capability grant
			// must not expose coding tools outside the workspace role.
			const analyze = lifecycle.pluginHost
				.tools()
				.find((tool) => tool.name === "self-iteration.analyze");
			if (analyze === undefined) throw new Error("analyze tool not registered");
			const chatPolicy = await lifecycle.pluginHost.toolPolicyContext(analyze, {
				conversationId: conversation.durableConversationId,
			});
			expect(chatPolicy.conversationCapabilities).not.toContain("coding");
			expect(chatPolicy.taskKind).not.toBe("coding");
		} finally {
			await lifecycle.stop();
		}
	}, 20_000);

	test("settles a scheduled deployment only when a supervised restart resumes the process", async () => {
		const { lifecycle } = await fixture();
		await lifecycle.start();
		try {
			const database = lifecycle.domainDatabase;
			if (database === undefined) throw new Error("database not ready");
			const store = new DomainCodingStore(() => database);
			const task = await store.createTask({
				baseRef: "HEAD",
				constraints: {
					allowedCommands: ["bun"],
					maxOutputBytes: 1024,
					pathAllowlist: ["src"],
					timeoutMs: 1_000,
				},
				goal: "Scheduled deployment",
				mode: "proposal",
				sourceConversationId: "workspace:webui",
			});
			const proposal = await store.createProposal({
				artifactMetadata: null,
				changedFiles: ["src/app.ts"],
				diff: "diff --git a/src/app.ts b/src/app.ts",
				diffChecksum: "d".repeat(64),
				envChanges: [],
				motivation: "test",
				requiresRestart: true,
				riskAssessment: "low",
				rollbackNotes: "revert",
				sourceRevision: "abc",
				taskId: task.id,
				testResult: { exitCode: 0, failed: 0, passed: true, stderr: "", stdout: "", total: 1 },
				title: "Scheduled",
			});
			await store.transition(proposal.id, "pending_approval");
			await store.transition(proposal.id, "approved");
			await store.transition(proposal.id, "deploying");
			await store.updateTask(task.id, { status: "deploying" });
			const deployment = await store.createDeployment({
				appliedIdentity: { diffChecksum: "d".repeat(64), revision: "abc" },
				artifactMetadata: null,
				createdBy: "admin",
				previousIdentity: { diffChecksum: "b".repeat(64), revision: "base" },
				proposalId: proposal.id,
				rollbackPlan: "revert",
				sourceRevision: "abc",
				status: "scheduled",
				taskId: task.id,
			});
			const now = Date.now();
			await database.insert(runtimeRestarts).values({
				completedAtMs: null,
				createdAtMs: now - 1_000,
				executeAtMs: now - 500,
				id: "supervised-restart",
				metadataJson: JSON.stringify({ deploymentId: deployment.id, proposalId: proposal.id }),
				mode: "update",
				reason: "self-iteration deployment",
				requestedBy: "self-iteration",
				status: "executing",
				updatedAtMs: now - 500,
			});
			// Without evidence of the live artifact, a resumed restart is not success.
			const originalCommit = process.env.TSUKAIMA_COMMIT;
			const originalPatch = process.env.TSUKAIMA_PATCH_SHA256;
			delete process.env.TSUKAIMA_COMMIT;
			delete process.env.TSUKAIMA_PATCH_SHA256;
			try {
				await lifecycle.restartCoordinator.recover();
			} finally {
				if (originalCommit !== undefined) process.env.TSUKAIMA_COMMIT = originalCommit;
				if (originalPatch !== undefined) process.env.TSUKAIMA_PATCH_SHA256 = originalPatch;
			}
			expect((await store.getDeployment(deployment.id))?.status).toBe("manual_apply_required");
			expect((await store.getProposal(proposal.id))?.status).toBe("deploying");

			// A matching commit alone is not enough: the image must also carry the approved patch.
			// This is the exact case where the proposal's sourceRevision is only the worktree base.
			await database
				.update(runtimeRestarts)
				.set({ completedAtMs: null, status: "executing" })
				.where(eq(runtimeRestarts.id, "supervised-restart"));
			process.env.TSUKAIMA_COMMIT = "abc";
			delete process.env.TSUKAIMA_PATCH_SHA256;
			try {
				await lifecycle.restartCoordinator.recover();
			} finally {
				if (originalCommit === undefined) delete process.env.TSUKAIMA_COMMIT;
				else process.env.TSUKAIMA_COMMIT = originalCommit;
				if (originalPatch === undefined) delete process.env.TSUKAIMA_PATCH_SHA256;
				else process.env.TSUKAIMA_PATCH_SHA256 = originalPatch;
			}
			expect((await store.getDeployment(deployment.id))?.status).toBe("manual_apply_required");
			expect((await store.getProposal(proposal.id))?.status).toBe("deploying");

			// The same resumed intent settles as deployed once revision and patch are both proven.
			await database
				.update(runtimeRestarts)
				.set({ completedAtMs: null, status: "executing" })
				.where(eq(runtimeRestarts.id, "supervised-restart"));
			process.env.TSUKAIMA_COMMIT = "abc";
			process.env.TSUKAIMA_PATCH_SHA256 = "d".repeat(64);
			try {
				await lifecycle.restartCoordinator.recover();
			} finally {
				if (originalCommit === undefined) delete process.env.TSUKAIMA_COMMIT;
				else process.env.TSUKAIMA_COMMIT = originalCommit;
				if (originalPatch === undefined) delete process.env.TSUKAIMA_PATCH_SHA256;
				else process.env.TSUKAIMA_PATCH_SHA256 = originalPatch;
			}
			expect((await store.getDeployment(deployment.id))?.status).toBe("deployed");
			expect((await store.getProposal(proposal.id))?.status).toBe("deployed");
			expect((await store.getTask(task.id))?.status).toBe("completed");
		} finally {
			await lifecycle.stop();
		}
	});
});
