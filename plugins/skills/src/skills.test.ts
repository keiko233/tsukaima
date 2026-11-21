import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillDetailSchema, skillsSnapshotSchema } from "@tsukaima/contracts";
import {
	createPluginContext,
	type AuditEntry,
	type PluginContext,
	type PluginLogger,
} from "@tsukaima/sdk";
import { pluginManifestSchema } from "@tsukaima/sdk/manifest";
import { parseSkillsConfig, SkillCatalog, skillsPlugin } from "./index.ts";
import {
	SKILLS_LOAD_MODEL_NAME,
	SKILLS_LOAD_TOOL,
	SKILLS_READ_RESOURCE_MODEL_NAME,
	SKILLS_READ_RESOURCE_TOOL,
	skillsManifest,
} from "./manifest.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
	);
});

async function fixture(): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), "tsukaima-skills-plugin-"));
	directories.push(directory);
	return directory;
}

async function writeSkill(
	root: string,
	directory: string,
	fields: { readonly body?: string; readonly description: string; readonly name: string },
): Promise<string> {
	const target = join(root, directory);
	await fs.mkdir(target, { recursive: true });
	await fs.writeFile(
		join(target, "SKILL.md"),
		`---\nname: ${fields.name}\ndescription: ${fields.description}\n---\n${fields.body ?? "Body"}\n`,
	);
	return target;
}

const quietLogger: PluginLogger = {
	debug: () => {},
	error: () => {},
	info: () => {},
	trace: () => {},
	warn: () => {},
};

function makeContext(
	settingsValue: Record<string, unknown>,
	audits: AuditEntry[] = [],
): PluginContext {
	return createPluginContext({
		audit: { record: async (entry) => void audits.push(entry) },
		grantedPermissions: skillsManifest.permissions,
		logger: quietLogger,
		manifest: skillsManifest,
		pluginId: "skills",
		settings: {
			get: async () => settingsValue,
			onChange: () => () => {},
		},
	});
}

function rpc(context: PluginContext, method: string, input?: unknown): Promise<unknown> {
	const shortName = method.startsWith("skills.") ? method.slice(7) : method;
	return (
		context.rpc as unknown as {
			invoke(method: string, input?: unknown): Promise<unknown>;
		}
	).invoke(shortName, input);
}

async function invoke(
	context: PluginContext,
	name: string,
	input: Record<string, unknown>,
	chatKind = "group",
) {
	const result = await context.tools.invoke(name, input, { chatKind });
	if (!result.ok) throw new Error(`tool invocation failed: ${result.reason}`);
	return result.result;
}

function resultText(result: { readonly content: readonly { readonly text: string }[] }): string {
	return result.content.map((part) => part.text).join("\n");
}

function auditPayload(entry: AuditEntry | undefined): Record<string, unknown> {
	return typeof entry?.payload === "object" && entry.payload !== null
		? (entry.payload as Record<string, unknown>)
		: {};
}

describe("skills plugin", () => {
	test("manifest matches the packaged tsukaima.plugin.json", async () => {
		const packaged = (await Bun.file(
			new URL("../tsukaima.plugin.json", import.meta.url),
		).json()) as unknown;
		expect(pluginManifestSchema.parse(packaged)).toEqual(skillsManifest);
	});

	test("registers load and resource tools with stable model names", async () => {
		const root = await fixture();
		await writeSkill(root, "pdf-forms", {
			description: "Fill <pdf> forms",
			name: "pdf-forms",
		});
		const context = makeContext({ paths: [root] });
		await skillsPlugin.setup(context);
		try {
			const tools = context.tools.list();
			expect(tools.map((tool) => tool.name)).toEqual([SKILLS_LOAD_TOOL, SKILLS_READ_RESOURCE_TOOL]);
			expect(tools.map((tool) => tool.modelName)).toEqual([
				SKILLS_LOAD_MODEL_NAME,
				SKILLS_READ_RESOURCE_MODEL_NAME,
			]);

			const listing = await invoke(context, SKILLS_LOAD_TOOL, {});
			expect(resultText(listing)).toContain("pdf-forms: Fill <pdf> forms");

			const loaded = await invoke(context, SKILLS_LOAD_TOOL, { name: "pdf-forms" });
			expect(resultText(loaded)).toContain("Body");

			const unknown = await invoke(context, SKILLS_LOAD_TOOL, { name: "missing-skill" });
			expect(JSON.parse(resultText(unknown))).toEqual({ error: "unknown_skill" });
		} finally {
			await skillsPlugin.teardown?.(context);
		}
	});

	test("reads bundled resources and audits path denials without leaking absolute paths", async () => {
		const root = await fixture();
		const skill = await writeSkill(root, "pdf-forms", {
			description: "Fill PDF forms",
			name: "pdf-forms",
		});
		await fs.mkdir(join(skill, "templates"));
		await fs.writeFile(join(skill, "templates", "basic.txt"), "template body");
		await fs.writeFile(join(skill, ".hidden.txt"), "hidden");
		const audits: AuditEntry[] = [];
		const context = makeContext({ paths: [root] }, audits);
		await skillsPlugin.setup(context);
		try {
			const resource = await invoke(context, SKILLS_READ_RESOURCE_TOOL, {
				name: "pdf-forms",
				path: "templates/basic.txt",
			});
			expect(resultText(resource)).toBe("template body");

			const traversal = await invoke(context, SKILLS_READ_RESOURCE_TOOL, {
				name: "pdf-forms",
				path: "../secret.txt",
			});
			expect(JSON.parse(resultText(traversal))).toEqual({ error: "traversal" });
			expect(audits.some((entry) => entry.action === "skills.resource.denied")).toBe(true);
			expect(auditPayload(audits.at(-1))).toEqual({
				name: "pdf-forms",
				path: "../secret.txt",
				reason: "traversal",
			});

			const absolute = await invoke(context, SKILLS_READ_RESOURCE_TOOL, {
				name: "pdf-forms",
				path: "/synthetic/secret.txt",
			});
			expect(JSON.parse(resultText(absolute))).toEqual({ error: "absolute_path" });
			expect(auditPayload(audits.at(-1))).toEqual({
				name: "pdf-forms",
				reason: "absolute_path",
			});
			expect(JSON.stringify(audits)).not.toContain("/synthetic/secret.txt");

			const hidden = await invoke(context, SKILLS_READ_RESOURCE_TOOL, {
				name: "pdf-forms",
				path: ".hidden.txt",
			});
			expect(JSON.parse(resultText(hidden))).toEqual({ error: "invalid_path" });
		} finally {
			await skillsPlugin.teardown?.(context);
		}
	});

	test("exposes snapshot, rescan, get, and turn-context procedures", async () => {
		const root = await fixture();
		const skill = await writeSkill(root, "pdf-forms", {
			description: "Fill PDF forms",
			name: "pdf-forms",
		});
		await fs.mkdir(join(skill, "templates"));
		await fs.writeFile(join(skill, "templates", "basic.txt"), "template body");
		const context = makeContext({ paths: [root] });
		await skillsPlugin.setup(context);
		try {
			const snapshot = skillsSnapshotSchema.parse(await rpc(context, "skills.snapshot"));
			expect(snapshot.roots).toBe(1);
			expect(snapshot.skills.map((entry) => entry.name)).toEqual(["pdf-forms"]);

			const rescanned = skillsSnapshotSchema.parse(await rpc(context, "skills.rescan"));
			expect(rescanned.version).toBe(snapshot.version);

			const detail = skillDetailSchema.parse(
				await rpc(context, "skills.get", { name: "pdf-forms" }),
			);
			expect(detail.resources).toEqual([{ bytes: 13, path: "templates/basic.txt" }]);
			expect(await rpc(context, "skills.get", { name: "Bad Name" })).toEqual({});

			const turn = (await rpc(context, "skills.turnContext", { surface: "chat" })) as {
				text?: string;
			};
			expect(turn.text).toContain("<available_skills>");
			expect(turn.text).toContain("skill://pdf-forms/SKILL.md");
			expect(await rpc(context, "skills.turnContext", { surface: "invalid" })).toEqual({});
		} finally {
			await skillsPlugin.teardown?.(context);
		}
	});

	test("gates surfaces and resource reads from plugin config", async () => {
		const root = await fixture();
		await writeSkill(root, "chat-only", {
			description: "Chat only skill",
			name: "chat-only",
		});
		const audits: AuditEntry[] = [];
		const context = makeContext(
			{ allowResources: false, paths: [root], surfaces: ["chat"] },
			audits,
		);
		await skillsPlugin.setup(context);
		try {
			const workspace = await invoke(context, SKILLS_LOAD_TOOL, { name: "chat-only" }, "workspace");
			expect(JSON.parse(resultText(workspace))).toEqual({ error: "surface_disabled" });

			const resource = await invoke(context, SKILLS_READ_RESOURCE_TOOL, {
				name: "chat-only",
				path: "notes.txt",
			});
			expect(JSON.parse(resultText(resource))).toEqual({ error: "resources_disabled" });
			expect(auditPayload(audits.at(-1))).toEqual({
				name: "chat-only",
				path: "notes.txt",
				reason: "resources_disabled",
			});
			const turn = (await rpc(context, "skills.turnContext", { surface: "workspace" })) as {
				text?: string;
			};
			expect(turn).toEqual({});
		} finally {
			await skillsPlugin.teardown?.(context);
		}
	});

	test("updates the catalog when settings change", async () => {
		const root = await fixture();
		await writeSkill(root, "alpha", { description: "Alpha skill", name: "alpha" });
		let current: Record<string, unknown> = { paths: [root] };
		const listeners: ((next: Record<string, unknown>) => Promise<void> | void)[] = [];
		const context = createPluginContext({
			grantedPermissions: skillsManifest.permissions,
			logger: quietLogger,
			manifest: skillsManifest,
			pluginId: "skills",
			settings: {
				get: async () => current,
				onChange: (handler) => {
					listeners.push(handler as (next: Record<string, unknown>) => Promise<void> | void);
					return () => {};
				},
			},
		});
		await skillsPlugin.setup(context);
		try {
			const before = skillsSnapshotSchema.parse(await rpc(context, "skills.snapshot"));
			expect(before.skills).toHaveLength(1);
			current = { disabled: ["alpha"], paths: [root] };
			for (const listener of listeners) await listener(current);
			const after = skillsSnapshotSchema.parse(await rpc(context, "skills.snapshot"));
			expect(after.skills[0]?.enabled).toBe(false);
		} finally {
			await skillsPlugin.teardown?.(context);
		}
	});
});

describe("parseSkillsConfig", () => {
	test("resolves, dedupes, and clamps values without throwing", () => {
		const parsed = parseSkillsConfig(
			{
				allowResources: false,
				disabled: ["  alpha ", "", "beta"],
				maxCatalogChars: 10,
				paths: "docs:extra\nnested",
				refreshIntervalSeconds: 999_999,
				surfaces: ["chat", "bogus"],
			},
			"/synthetic/cwd",
		);
		expect(parsed.paths).toEqual([
			join("/synthetic/cwd", "docs"),
			join("/synthetic/cwd", "extra"),
			join("/synthetic/cwd", "nested"),
		]);
		expect([...parsed.disabled]).toEqual(["alpha", "beta"]);
		expect(parsed.allowResources).toBe(false);
		expect(parsed.maxCatalogChars).toBe(500);
		expect(parsed.refreshIntervalMs).toBe(3_600_000);
		expect([...parsed.surfaces]).toEqual(["chat"]);
	});

	test("falls back to both surfaces for absent or invalid input", () => {
		const parsed = parseSkillsConfig(null);
		expect(parsed.paths).toEqual([]);
		expect(parsed.allowResources).toBe(true);
		expect(parsed.maxCatalogChars).toBe(4_000);
		expect(parsed.refreshIntervalMs).toBe(30_000);
		expect([...parsed.surfaces].toSorted()).toEqual(["chat", "workspace"]);

		expect(
			parseSkillsConfig({ paths: ["docs", "docs", "./docs"] }, "/synthetic/cwd").paths,
		).toEqual([join("/synthetic/cwd", "docs")]);
	});
});

describe("SkillCatalog", () => {
	test("bumps the version only when the catalog signature changes", async () => {
		const root = await fixture();
		const skill = await writeSkill(root, "alpha", {
			description: "Alpha skill",
			name: "alpha",
		});
		const catalog = new SkillCatalog({
			config: parseSkillsConfig({ paths: [root] }),
			logger: quietLogger,
		});
		try {
			const first = await catalog.rescan();
			expect(first.version).toBe(1);
			const unchanged = await catalog.rescan();
			expect(unchanged.version).toBe(1);
			await fs.writeFile(
				join(skill, "SKILL.md"),
				"---\nname: alpha\ndescription: Alpha changed\n---\nBody\n",
			);
			const changed = await catalog.rescan();
			expect(changed.version).toBe(2);
		} finally {
			catalog.dispose();
		}
	});

	test("renders a sanitized, bounded catalog with a truncation note", async () => {
		const root = await fixture();
		await writeSkill(root, "alpha", {
			description: "Handles <pdf> & > forms",
			name: "alpha",
		});
		await writeSkill(root, "extended", {
			description: `Extended ${"x".repeat(300)}`,
			name: "extended",
		});
		const catalog = new SkillCatalog({
			config: parseSkillsConfig({ maxCatalogChars: 500, paths: [root] }),
			logger: quietLogger,
		});
		try {
			await catalog.rescan();
			const text = catalog.renderTurnContext("chat");
			expect(text).toBeDefined();
			expect(text).toContain("Bundled files can be read with read_skill_resource.");
			expect(text).not.toContain("<pdf>");
			expect(text).toContain("‹pdf›");
			expect(text).toContain("more skills not shown");
			expect(text?.length ?? 0).toBeLessThanOrEqual(500);
			expect(catalog.renderTurnContext("workspace")).toBe(text);
		} finally {
			catalog.dispose();
		}
	});

	test("drops the resource sentence when resources are disabled and respects surfaces", async () => {
		const root = await fixture();
		await writeSkill(root, "alpha", { description: "Alpha skill", name: "alpha" });
		const catalog = new SkillCatalog({
			config: parseSkillsConfig({ allowResources: false, paths: [root], surfaces: ["chat"] }),
			logger: quietLogger,
		});
		try {
			await catalog.rescan();
			const text = catalog.renderTurnContext("chat");
			expect(text).toBeDefined();
			expect(text).not.toContain("Bundled files can be read with read_skill_resource.");
			expect(catalog.renderTurnContext("workspace")).toBeUndefined();
			const read = await catalog.readResource("alpha", "notes.txt");
			expect(read).toEqual({ ok: false, reason: "resources_disabled" });
		} finally {
			catalog.dispose();
		}
	});

	test("lists depth-limited, non-hidden bundled resources in detail", async () => {
		const root = await fixture();
		const skill = await writeSkill(root, "alpha", {
			description: "Alpha skill",
			name: "alpha",
		});
		await fs.mkdir(join(skill, "nested", "deep"), { recursive: true });
		await fs.writeFile(join(skill, "nested", "one.txt"), "one");
		await fs.writeFile(join(skill, "nested", "deep", "two.txt"), "two");
		await fs.mkdir(join(skill, "nested", "deep", "too-deep"), { recursive: true });
		await fs.writeFile(join(skill, "nested", "deep", "too-deep", "three.txt"), "three");
		await fs.writeFile(join(skill, "nested", ".hidden"), "hidden");
		const catalog = new SkillCatalog({
			config: parseSkillsConfig({ paths: [root] }),
			logger: quietLogger,
		});
		try {
			await catalog.rescan();
			const detail = await catalog.loadDetail("alpha");
			expect(detail?.resources.map((entry) => entry.path)).toEqual([
				"nested/deep/two.txt",
				"nested/one.txt",
			]);
			expect(await catalog.loadDetail("missing")).toBeUndefined();
			expect(await catalog.readResource("missing", "notes.txt")).toEqual({
				ok: false,
				reason: "unknown_skill",
			});
		} finally {
			catalog.dispose();
		}
	});
});
