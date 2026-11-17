import { describe, expect, test } from "bun:test";
import {
	CHANGELOG_HEADER,
	classify,
	insertSection,
	parseSubject,
	renderSection,
} from "./changelog.ts";

describe("parseSubject", () => {
	test("splits type, scope, and text", () => {
		expect(parseSubject("feat(github): add device login")).toEqual({
			scope: "github",
			text: "add device login",
			type: "feat",
		});
		expect(parseSubject("fix: guard push")).toEqual({ text: "guard push", type: "fix" });
		expect(parseSubject("chore(release): 0.8.1")).toEqual({
			scope: "release",
			text: "0.8.1",
			type: "chore",
		});
	});

	test("keeps subjects that are not conventional commits", () => {
		expect(parseSubject("Release Tsukaima 0.2.0")).toEqual({
			text: "Release Tsukaima 0.2.0",
			type: "other",
		});
	});
});

describe("classify", () => {
	test("maps conventional types to changelog groups", () => {
		expect(classify("feat")).toBe("added");
		expect(classify("fix")).toBe("fixed");
		expect(classify("docs")).toBe("changed");
		expect(classify("chore")).toBe("skip");
		expect(classify("other")).toBe("changed");
	});
});

describe("renderSection", () => {
	test("groups commits and drops housekeeping", () => {
		const section = renderSection({
			commits: [
				{ hash: "aaaaaaa", subject: "feat(web): add repository card" },
				{ hash: "bbbbbbb", subject: "fix(server): guard push" },
				{ hash: "ccccccc", subject: "chore(release): 0.8.1" },
				{ hash: "ddddddd", subject: "docs: describe publishing" },
			],
			date: "2026-11-18",
			version: "0.9.0",
		});
		expect(section).toContain("## [0.9.0] - 2026-11-18");
		expect(section).toContain("### Added");
		expect(section).toContain("- web: add repository card (aaaaaaa)");
		expect(section).toContain("### Fixed");
		expect(section).toContain("- server: guard push (bbbbbbb)");
		expect(section).toContain("### Changed");
		expect(section).toContain("- describe publishing (ddddddd)");
		expect(section).not.toContain("chore(release)");
	});

	test("says so when nothing user-visible changed", () => {
		const section = renderSection({
			commits: [{ hash: "aaaaaaa", subject: "chore: tidy" }],
			date: "2026-11-18",
			version: "0.9.1",
		});
		expect(section).toContain("- No user-visible changes.");
	});
});

describe("insertSection", () => {
	test("puts the newest version first and replaces an existing section", () => {
		const older = "## [0.8.0] - 2026-11-17\n\n### Added\n- old thing (1111111)";
		const first = insertSection(
			CHANGELOG_HEADER,
			"0.8.0",
			"## [0.8.0] - 2026-11-17\n\n### Added\n- old thing (1111111)",
		);
		expect(first.startsWith(CHANGELOG_HEADER.trimEnd())).toBe(true);

		const second = insertSection(
			first,
			"0.9.0",
			"## [0.9.0] - 2026-11-18\n\n### Added\n- new thing (2222222)",
		);
		expect(second.indexOf("## [0.9.0]")).toBeLessThan(second.indexOf("## [0.8.0]"));

		const replaced = insertSection(
			second,
			"0.9.0",
			"## [0.9.0] - 2026-11-18\n\n### Fixed\n- corrected thing (3333333)",
		);
		expect(replaced).toContain("corrected thing (3333333)");
		expect(replaced).not.toContain("new thing (2222222)");
		expect(replaced).toContain(older.split("\n")[0] ?? "");
	});

	test("creates the header for an empty file", () => {
		const result = insertSection("", "0.1.0", "## [0.1.0] - 2026-11-16\n\n- first (aaaaaaa)");
		expect(result.startsWith("# Changelog")).toBe(true);
		expect(result).toContain("## [0.1.0]");
	});
});
