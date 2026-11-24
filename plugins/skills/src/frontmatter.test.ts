import { describe, expect, test } from "bun:test";
import { parseSkillDocument, validateSkillFields } from "./frontmatter.ts";

describe("parseSkillDocument", () => {
	test("strips a BOM, normalizes CRLF, and removes leading body blank lines", () => {
		const parsed = parseSkillDocument(
			"\uFEFF---\r\nname: demo\r\ndescription: Demo skill\r\n---\r\n\r\n# Body\r\nLine\r\n",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.document.frontmatter).toEqual({ description: "Demo skill", name: "demo" });
		expect(parsed.document.body).toBe("# Body\nLine\n");
	});

	test("accepts trailing spaces after the closing fence", () => {
		const parsed = parseSkillDocument("---\nname: demo\ndescription: Demo\n---   \nBody\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.document.body).toBe("Body\n");
	});

	test("accepts an empty frontmatter mapping", () => {
		const parsed = parseSkillDocument("---\n---\nBody\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.document.frontmatter).toEqual({});
		expect(parsed.document.body).toBe("Body\n");
	});

	test("rejects a missing opening fence, an unclosed fence, invalid YAML, and non-mapping YAML", () => {
		expect(parseSkillDocument("name: demo\n---\nBody").ok).toBe(false);
		expect(parseSkillDocument("---\nname: demo\nBody").ok).toBe(false);
		expect(parseSkillDocument("---\nname: [unclosed\n---\nBody").ok).toBe(false);
		expect(parseSkillDocument("---\n- one\n- two\n---\nBody").ok).toBe(false);
	});

	test("never includes document contents in a parse error", () => {
		const marker = "private-marker-value";
		const parsed = parseSkillDocument(`---\nname: [${marker}\n---\nBody`);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.message).not.toContain(marker);
	});
});

describe("validateSkillFields", () => {
	test("normalizes description whitespace and keeps optional fields", () => {
		const result = validateSkillFields(
			{
				"allowed-tools": "read_file  write_file",
				compatibility: "x".repeat(600),
				description: "  A\tvery\nnoisy\u0001description.  ",
				license: "MIT",
				metadata: { author: "synthetic", ignored: 42 },
				name: "demo-skill",
				unknown: "ignored",
			},
			"demo-skill",
		);
		expect(result.diagnostics).toEqual([]);
		expect(result.fields).toEqual({
			allowedTools: ["read_file", "write_file"],
			compatibility: "x".repeat(500),
			description: "A very noisy description.",
			license: "MIT",
			metadata: { author: "synthetic", ignored: "42" },
			name: "demo-skill",
		});
	});

	test("accepts Hermes-style frontmatter without dropping useful metadata", () => {
		const result = validateSkillFields(
			{
				"allowed-tools": ["read_file", "write_file"],
				description: "Hermes-style skill",
				env: ["TOKEN"],
				metadata: {
					author: "synthetic",
					flags: ["a", "b"],
					nested: { level: 2 },
				},
				name: "hermes-skill",
				requires: ["git", "node >=18"],
				tags: ["ops", "deploy"],
				version: "1.2.3",
			},
			"hermes-skill",
		);
		expect(result.diagnostics).toEqual([]);
		expect(result.fields).toEqual({
			allowedTools: ["read_file", "write_file"],
			description: "Hermes-style skill",
			env: ["TOKEN"],
			metadata: {
				author: "synthetic",
				env: "TOKEN",
				flags: "a, b",
				nested: '{"level":2}',
				requires: "git, node >=18",
				tags: "ops, deploy",
				version: "1.2.3",
			},
			name: "hermes-skill",
			requires: ["git", "node >=18"],
			tags: ["ops", "deploy"],
			version: "1.2.3",
		});
	});

	test("accepts comma-separated tags and an allowed_tools alias", () => {
		const result = validateSkillFields(
			{
				allowed_tools: "read_file, write_file",
				description: "Demo",
				name: "demo",
				tags: "ops, deploy",
			},
			"demo",
		);
		expect(result.fields?.allowedTools).toEqual(["read_file", "write_file"]);
		expect(result.fields?.tags).toEqual(["ops", "deploy"]);
	});

	test("a directory/name mismatch is a warning and still loads", () => {
		const result = validateSkillFields(
			{ description: "Demo", name: "document-name" },
			"directory-name",
		);
		expect(result.fields?.name).toBe("document-name");
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "name_directory_mismatch", level: "warning" }),
		]);
	});

	test("rejects a missing or invalid name and a missing description", () => {
		const noName = validateSkillFields({ description: "Demo" }, "demo");
		expect(noName.fields).toBeUndefined();
		expect(noName.diagnostics.map((entry) => entry.code)).toEqual(["name_missing"]);

		const badName = validateSkillFields({ description: "Demo", name: "Bad Name" }, "bad-name");
		expect(badName.fields).toBeUndefined();
		expect(badName.diagnostics.map((entry) => entry.code)).toEqual(["name_invalid"]);

		const noDescription = validateSkillFields({ name: "demo", description: "   " }, "demo");
		expect(noDescription.fields).toBeUndefined();
		expect(noDescription.diagnostics.map((entry) => entry.code)).toEqual(["description_missing"]);
	});

	test("truncates an over-long description with a warning", () => {
		const result = validateSkillFields({ description: "y".repeat(2_000), name: "demo" }, "demo");
		expect(result.fields?.description).toHaveLength(1_024);
		expect(result.diagnostics.map((entry) => entry.code)).toEqual(["description_too_long"]);
	});
});
