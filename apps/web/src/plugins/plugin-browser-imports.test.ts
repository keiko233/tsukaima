import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PLUGINS_ROOT = resolve(import.meta.dirname, "../../../../plugins");

/**
 * The plugin panel is loaded lazily in the browser. The `@tsukaima/sdk` barrel also exports
 * host-only bridges that import `node:crypto`; importing that barrel from a panel makes Vite
 * externalize the builtin and the panel dies on load. Type-only imports are erased, so scan
 * the real value-import graph instead of the source text.
 */
function relativeTarget(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.js`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
		join(base, "index.js"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

async function browserImportProblems(entry: string): Promise<string[]> {
	const problems: string[] = [];
	const visited = new Set<string>();

	const walk = async (file: string): Promise<void> => {
		if (visited.has(file)) return;
		visited.add(file);
		const code = await Bun.file(file).text();
		const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
		for (const imported of await transpiler.scanImports(code)) {
			if (imported.path === "@tsukaima/sdk") {
				problems.push(`${file} imports the host-only @tsukaima/sdk barrel`);
				continue;
			}
			if (imported.path.startsWith("node:")) {
				problems.push(`${file} imports ${imported.path}`);
				continue;
			}
			if (!imported.path.startsWith(".")) continue;
			const target = relativeTarget(file, imported.path);
			if (target !== undefined) await walk(target);
		}
	};

	await walk(entry);
	return problems;
}

describe("plugin browser imports", () => {
	test("panel entry graphs never reach host-only SDK or node builtins", async () => {
		const entries = [
			...new Bun.Glob("*/src/ui.tsx").scanSync({ cwd: PLUGINS_ROOT, onlyFiles: true }),
		];
		expect(entries.length).toBeGreaterThan(0);
		const results = await Promise.all(
			entries.map(async (entry) => ({
				entry,
				problems: await browserImportProblems(join(PLUGINS_ROOT, entry)),
			})),
		);
		expect(results.filter((result) => result.problems.length > 0)).toEqual([]);
	});
});
