import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyDshConfigKey,
	DSH_BASELINE_SECTIONS,
	DSH_VALUE_CLASSES,
	extractDshBaseline,
	isCredentialLikeKey,
	resolveDshBaselineTarget,
	sanitizeMemorySpace,
	type SnapshotSource,
} from "./index.ts";

const fixtureRoot = join(import.meta.dir, "../fixtures/dsh-baseline");
const source: SnapshotSource = [[fixtureRoot, "dsh-baseline"]];

async function fixtureSecretValues(): Promise<string[]> {
	const config = await fs.readFile(
		join(fixtureRoot, "home/.dsh/profiles/web/cordis.patch.yml"),
		"utf8",
	);
	return [...config.matchAll(/SYNTHETIC-[A-Z0-9-]+/g)].map((match) => match[0]);
}

describe("DSH baseline inventory", () => {
	test("extracts all ten sections from the local fixture with every value class applied", async () => {
		const baseline = await extractDshBaseline(source, {
			target: {
				host: "synthetic-host",
				project: "/synthetic/project",
				container: "synthetic-container",
			},
		});
		const inventory = baseline.inventory;

		expect(DSH_BASELINE_SECTIONS).toHaveLength(10);
		expect(Object.keys(inventory)).toEqual([...DSH_BASELINE_SECTIONS]);
		expect(baseline.target).toEqual({
			host: "synthetic-host",
			project: "/synthetic/project",
			container: "synthetic-container",
		});
		expect(inventory.versions).toEqual({
			image: "docker.io/runzhliu/deepseek-harness:0.2.1-rc.3-r1",
			cli: "0.2.1-rc.3",
		});
		expect(inventory.profile.name).toBe("dsh-profile-web");
		expect(inventory.profile.bundles).toContainEqual({
			name: "dsh-napcat",
			spec: "link:/workspace/work/dsh-napcat",
			version: "0.4.4",
		});
		expect(inventory.plugins).toContainEqual({
			id: "mcp-snowluma",
			packageName: "@deepseek-ai/dsh-mcp-snowluma",
			enabled: false,
			presets: [],
		});
		expect(inventory.plugins.find((plugin) => plugin.id === "dsh-napcat")?.enabled).toBe(true);

		const classes = new Set(inventory.configuration.entries.map((entry) => entry.classification));
		expect([...classes].toSorted()).toEqual([...DSH_VALUE_CLASSES].toSorted());
		for (const classification of DSH_VALUE_CLASSES) {
			expect(inventory.configuration.counts[classification]).toBeGreaterThan(0);
		}
		expect(inventory.tools).toHaveLength(26);
		expect(inventory.tools).toContain("napcat_memory_space");

		expect(inventory.memory.provider).toBe("dsh-mnemon");
		expect(inventory.memory.spaces).toEqual([
			"dsh-host",
			"napcat-group-<id>",
			"napcat-private-<id>",
			"workspace-<uuid>",
		]);
		expect(inventory.memory.databases[0]?.tables).toContainEqual({
			name: "insights",
			columns: [
				"id",
				"content",
				"category",
				"importance",
				"tags",
				"entities",
				"source",
				"access_count",
				"stored_at",
				"created_at",
				"updated_at",
				"deleted_at",
				"last_accessed_at",
				"embedding",
				"effective_importance",
			],
		});

		expect(inventory.memePacks.packCount).toBe(5);
		expect(inventory.memePacks.fileCount).toBe(32);
		expect(inventory.memePacks.schemaNames).toEqual(["memes"]);
		expect(inventory.memePacks.manifestFields).toContain("source");
		expect(inventory.schedules.taskCount).toBe(4);
		expect(inventory.schedules.statusClasses).toEqual(["cancelled", "done", "pending"]);
		expect(inventory.schedules.timingFields).toContain("cancelIfReplied");

		expect(inventory.sessions.fileCount).toBe(2);
		expect(inventory.sessions.compressedFileCount).toBe(1);
		expect(inventory.sessions.workspaceCount).toBe(2);
		expect(inventory.sessions.sessionRecordCount).toBe(2);
		expect(inventory.sessions.eventTypes).toContain("tool/result");
		expect(inventory.sessions.sessionFields).toContain("agentPreset");
		expect(inventory.sessions.eventFields).toContain("sourceEventSeqs");

		expect(inventory.ledgers.friendRequests.fields).toEqual([
			"at",
			"comment",
			"flag",
			"groupId",
			"kind",
			"seenAt",
			"subType",
			"userId",
		]);
		expect(inventory.ledgers.humanProfiles.profileFields).toContain("lastIgnoredReason");
		expect(inventory.ledgers.qaLedger.fields).toContain("canonical");
		expect(inventory.ledgers.adminAudit.fields).toContain("decision");
	});

	test("classifies unknown credential-like fields as secret and never emits their values", async () => {
		const baseline = await extractDshBaseline(source);
		const serialized = JSON.stringify(baseline);
		const entries = baseline.inventory.configuration.entries;

		for (const key of ["customWebhookSecret", "thirdPartyApiToken", "xAuthCredential"]) {
			const entry = entries.find((candidate) => candidate.key === key);
			expect(entry?.classification).toBe("secret");
			expect(entry?.configured).toBe(true);
		}
		expect(entries.find((entry) => entry.key === "legacyWebhookToken")).toMatchObject({
			classification: "secret",
			configured: false,
			state: "unconfigured",
		});
		expect(entries.find((entry) => entry.key === "imageEditToken")).toMatchObject({
			classification: "secret",
			configured: false,
			state: "unconfigured",
		});
		expect(entries.find((entry) => entry.key === "customWebhookSecret")?.state).toBe("configured");
		expect(entries.find((entry) => entry.key === "triggerKeywords")?.classification).toBe("policy");
		for (const secret of await fixtureSecretValues()) {
			expect(serialized).not.toContain(secret);
		}
		expect(serialized).not.toContain("synthetic-trigger");
	});

	test("classifies a standalone config document with only unknown credential fields", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "dsh-baseline-config-"));
		try {
			await fs.writeFile(
				join(directory, "cordis.patch.yml"),
				[
					"customWebhookSecret: SYNTHETIC-TEST-SECRET-DO-NOT-LEAK",
					"xAuthCredential: SYNTHETIC-SECOND-SECRET-DO-NOT-LEAK",
					"triggerKeywords:",
					"  - synthetic-trigger",
				].join("\n"),
			);
			const baseline = await extractDshBaseline([[directory, "config-only"]]);
			const entries = baseline.inventory.configuration.entries;
			expect(entries.find((entry) => entry.key === "customWebhookSecret")).toMatchObject({
				classification: "secret",
				state: "configured",
			});
			expect(entries.find((entry) => entry.key === "xAuthCredential")).toMatchObject({
				classification: "secret",
				state: "configured",
			});
			expect(entries.find((entry) => entry.key === "triggerKeywords")?.classification).toBe(
				"policy",
			);
			const serialized = JSON.stringify(baseline);
			expect(serialized).not.toContain("SYNTHETIC-TEST-SECRET-DO-NOT-LEAK");
			expect(serialized).not.toContain("SYNTHETIC-SECOND-SECRET-DO-NOT-LEAK");
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});

	test("keeps credential heuristics aware of keywords and public keys", () => {
		expect(classifyDshConfigKey("triggerKeywords")).toBe("policy");
		expect(classifyDshConfigKey("keywords")).toBe("safe");
		expect(classifyDshConfigKey("publicKey")).toBe("safe");
		expect(classifyDshConfigKey("keyboard")).toBe("safe");
		expect(classifyDshConfigKey("customWebhookSecret")).toBe("secret");
		expect(classifyDshConfigKey("thirdPartyApiToken")).toBe("secret");
		expect(classifyDshConfigKey("xAuthCredential")).toBe("secret");
		expect(classifyDshConfigKey("apiKeyEnv")).toBe("secret");
		expect(isCredentialLikeKey("webhookKey")).toBe(true);
		expect(isCredentialLikeKey("triggerKeywords")).toBe(false);
		expect(sanitizeMemorySpace("napcat-group-group_20001")).toBe("napcat-group-<id>");
	});

	test("never treats structural identifier keys as credentials", () => {
		for (const key of [
			"chatKey",
			"dayKey",
			"sessionKey",
			"primaryKey",
			"cacheKey",
			"sortKey",
			"foreignKey",
		]) {
			expect(isCredentialLikeKey(key)).toBe(false);
			expect(classifyDshConfigKey(key)).not.toBe("secret");
		}
		expect(isCredentialLikeKey("accessToken")).toBe(true);
		expect(sanitizeMemorySpace("workspace-<uuid>")).toBe("workspace-<uuid>");
		expect(sanitizeMemorySpace("napcat-private-<id>")).toBe("napcat-private-<id>");
	});

	test("reads the real .dsh/meme-packs and .mnemon live layout", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "dsh-live-layout-"));
		try {
			const packDirectory = join(directory, "workspace/.dsh/meme-packs/live-pack");
			await fs.mkdir(packDirectory, { recursive: true });
			await fs.writeFile(
				join(packDirectory, "manifest.json"),
				JSON.stringify({
					id: "live-pack",
					name: "Live Pack",
					version: "2.0.0",
					description: "synthetic fixture meme pack",
				}),
			);
			const packDatabase = new Database(join(packDirectory, "index.db"));
			packDatabase.run(
				"CREATE TABLE memes (path TEXT NOT NULL, tag TEXT, file_name TEXT NOT NULL, caption TEXT, keywords TEXT, mtime INTEGER, captioned_at TEXT)",
			);
			packDatabase.run(
				"INSERT INTO memes (path, file_name) VALUES ('synthetic.webp', 'synthetic.webp')",
			);
			packDatabase.close();

			const memoryDirectory = join(directory, "workspace/.mnemon/data/napcat-group-group_99999");
			await fs.mkdir(memoryDirectory, { recursive: true });
			const memoryDatabase = new Database(join(memoryDirectory, "mnemon.db"));
			memoryDatabase.run("CREATE TABLE insights (id TEXT PRIMARY KEY, content TEXT NOT NULL)");
			memoryDatabase.run(
				"CREATE TABLE edges (source_id TEXT NOT NULL, target_id TEXT NOT NULL, edge_type TEXT NOT NULL)",
			);
			memoryDatabase.close();

			await fs.mkdir(join(directory, "workspace/.mnemon/documents"), { recursive: true });
			await fs.writeFile(
				join(directory, "workspace/.mnemon/documents/index.json"),
				JSON.stringify({ version: 1, active: ["synthetic-active.md"], archived: [] }),
			);
			await fs.mkdir(join(directory, "workspace/.mnemon/runtime"), { recursive: true });
			await fs.writeFile(
				join(directory, "workspace/.mnemon/runtime/memories.json"),
				JSON.stringify({
					version: 1,
					entries: [{ id: "memory-1", content: "synthetic", tags: ["synthetic"] }],
				}),
			);

			const baseline = await extractDshBaseline([[directory, "dsh-live-layout"]]);
			expect(baseline.inventory.memePacks.packCount).toBe(1);
			expect(baseline.inventory.memePacks.packs[0]).toMatchObject({
				id: "live-pack",
				name: "Live Pack",
				version: "2.0.0",
				fileCount: 1,
			});
			expect(baseline.inventory.memePacks.schemaNames).toEqual(["memes"]);
			expect(baseline.inventory.memory.spaces).toEqual(["napcat-group-<id>"]);
			expect(baseline.inventory.memory.databases[0]?.tables.map((table) => table.name)).toEqual([
				"edges",
				"insights",
			]);
			expect(baseline.inventory.memory.documentFields).toEqual(["active", "archived", "version"]);
			expect(baseline.inventory.memory.runtimeFields).toEqual(["entries", "version"]);
			expect(baseline.inventory.memory.runtimeEntryFields).toEqual(["content", "id", "tags"]);
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});

	test("reads sanitized audit/meme-packs.json and audit/sessions.json summaries", async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), "dsh-audit-summary-"));
		try {
			await fs.mkdir(join(directory, "audit"), { recursive: true });
			await fs.writeFile(
				join(directory, "audit/meme-packs.json"),
				JSON.stringify({
					packCount: 1,
					fileCount: 4,
					schemaNames: ["memes"],
					manifestFields: ["id"],
					packs: [
						{
							id: "audit-pack",
							name: "Audit Pack",
							version: "1.2.3",
							manifestFields: ["id"],
							tables: [{ name: "memes", columns: ["path", "caption"] }],
							fileCount: 4,
						},
					],
				}),
			);
			await fs.writeFile(
				join(directory, "audit/sessions.json"),
				JSON.stringify({
					fileCount: 12,
					compressedFileCount: 10,
					workspaceCount: 3,
					sessionRecordCount: 3,
					recordTypes: ["session", "assistant/message"],
					sessionFields: ["type", "id", "agentPreset"],
					eventFields: ["type", "seq", "data"],
					eventTypes: ["assistant/message", "tool/result"],
				}),
			);

			const baseline = await extractDshBaseline([[directory, "audit-only"]]);
			expect(baseline.inventory.memePacks.packCount).toBe(1);
			expect(baseline.inventory.memePacks.fileCount).toBe(4);
			expect(baseline.inventory.memePacks.packs[0]?.tables).toEqual([
				{ name: "memes", columns: ["path", "caption"] },
			]);
			expect(baseline.inventory.sessions).toEqual({
				fileCount: 12,
				compressedFileCount: 10,
				workspaceCount: 3,
				sessionRecordCount: 3,
				recordTypes: ["assistant/message", "session"],
				sessionFields: ["agentPreset", "id", "type"],
				eventFields: ["data", "seq", "type"],
				eventTypes: ["assistant/message", "tool/result"],
			});
		} finally {
			await fs.rm(directory, { force: true, recursive: true });
		}
	});
});

describe("DSH baseline target resolution", () => {
	test("reads host, project, and container from flags or environment without defaults", () => {
		expect(resolveDshBaselineTarget({}, {})).toEqual({
			host: null,
			project: null,
			container: null,
		});
		expect(
			resolveDshBaselineTarget(
				{},
				{
					DSH_AUDIT_HOST: "env-host",
					DSH_AUDIT_PROJECT: "/env/project",
					DSH_AUDIT_CONTAINER: "env-container",
				},
			),
		).toEqual({
			host: "env-host",
			project: "/env/project",
			container: "env-container",
		});
		expect(
			resolveDshBaselineTarget(
				{ host: "flag-host", project: "/flag/project", container: "flag-container" },
				{
					DSH_AUDIT_HOST: "env-host",
					DSH_AUDIT_PROJECT: "/env/project",
					DSH_AUDIT_CONTAINER: "env-container",
				},
			),
		).toEqual({
			host: "flag-host",
			project: "/flag/project",
			container: "flag-container",
		});
	});
});
