import { compile } from "@inlang/paraglide-js";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const pluginsDir = join(root, "plugins");
const entries = await readdir(pluginsDir, { withFileTypes: true });

for (const entry of entries) {
	if (!entry.isDirectory()) continue;
	const dir = join(pluginsDir, entry.name);
	if (!existsSync(join(dir, "elaina.plugin.json"))) continue;
	const project = join(dir, "project.inlang");
	try {
		await compile({
			emitGitIgnore: false,
			emitReadme: false,
			emitTsDeclarations: true,
			outdir: join(dir, "src/paraglide"),
			project,
			strategy: ["baseLocale"],
		});
		console.log(`compiled plugin i18n: ${entry.name}`);
	} catch (error) {
		console.error(`failed to compile plugin i18n: ${entry.name}`, error);
		process.exitCode = 1;
	}
}
