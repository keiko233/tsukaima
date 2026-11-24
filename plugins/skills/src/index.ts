import { fileURLToPath } from "node:url";
import { isPlainObject } from "es-toolkit";
import type { PluginContext, TsukaimaPlugin } from "@tsukaima/sdk";
import { SkillCatalog } from "./catalog.ts";
import { parseSkillsConfig } from "./config.ts";
import { skillsManifest } from "./manifest.ts";
import { registerSkillsRpc } from "./rpc.ts";
import { registerSkillsTools } from "./tools.ts";

export {
	SKILLS_LOAD_MODEL_NAME,
	SKILLS_LOAD_TOOL,
	SKILLS_PLUGIN_ID,
	SKILLS_READ_RESOURCE_MODEL_NAME,
	SKILLS_READ_RESOURCE_TOOL,
	SKILLS_RPC_PREFIX,
	skillsManifest,
} from "./manifest.ts";
export {
	DEFAULT_SKILLS_MAX_CATALOG_CHARS,
	DEFAULT_SKILLS_REFRESH_INTERVAL_MS,
	MAX_SKILLS_MAX_CATALOG_CHARS,
	MAX_SKILLS_REFRESH_INTERVAL_SECONDS,
	MIN_SKILLS_MAX_CATALOG_CHARS,
	MIN_SKILLS_REFRESH_INTERVAL_SECONDS,
	defaultSkillRoot,
	parseSkillsConfig,
	type SkillsConfig,
	type SkillsEnvironment,
} from "./config.ts";
export {
	parseSkillDocument,
	validateSkillFields,
	type ParseSkillDocumentResult,
	type SkillDocument,
	type SkillFields,
	type ValidationResult,
} from "./frontmatter.ts";
export {
	isInside,
	normalizeRelative,
	readFileInside,
	resolveEntryInside,
	resolveInside,
	type PathFailure,
	type PathResult,
	type ReadTextResult,
	type RelativePath,
	type ResolvedFile,
} from "./paths.ts";
export {
	scanSkillRoots,
	walkSkillResources,
	type ScanOptions,
	type ScanResult,
	type SkillRecord,
	type SkillResourceListing,
	type WalkSkillResourcesOptions,
} from "./discovery.ts";
export {
	SkillCatalog,
	type SkillCatalogOptions,
	type SkillResourceFailure,
	type SkillResourceReadResult,
} from "./catalog.ts";
export { registerSkillsRpc } from "./rpc.ts";
export { registerSkillsTools } from "./tools.ts";

interface SkillsRuntime {
	readonly catalog: SkillCatalog;
	disposeSettings?: (() => void) | undefined;
}

const runtimes = new WeakMap<PluginContext, SkillsRuntime>();

function recordValue(value: unknown): Record<string, unknown> {
	return isPlainObject(value) ? value : {};
}

function updateStatus(context: PluginContext, catalog: SkillCatalog): void {
	const config = catalog.config;
	const snapshot = catalog.snapshot();
	const skills = snapshot.skills.length;
	const enabled = snapshot.skills.filter((skill) => skill.enabled).length;
	const diagnostics = snapshot.diagnostics.length;
	const roots = config.paths.length;
	const noPaths = roots === 0;
	context.ui.setStatus({
		code: noPaths ? "no_paths" : diagnostics > 0 ? "diagnostics" : "ready",
		level: noPaths || diagnostics > 0 ? "warning" : "ok",
		metrics: { diagnostics, enabled, roots, skills },
		summary: noPaths
			? "No skill roots are configured"
			: diagnostics > 0
				? `${enabled}/${skills} skill(s) enabled; ${diagnostics} diagnostic(s)`
				: `${enabled}/${skills} skill(s) ready`,
	});
}

export const skillsPlugin: TsukaimaPlugin = {
	manifest: skillsManifest,
	rootDir: fileURLToPath(new URL("../", import.meta.url)),
	async setup(context) {
		const settings = context.settings;
		const raw = settings === undefined ? {} : recordValue(await settings.get());
		const config = parseSkillsConfig(raw);
		const catalog = new SkillCatalog({
			config,
			logger: context.logger.child?.("catalog") ?? context.logger,
		});
		registerSkillsTools(context, catalog);
		registerSkillsRpc(context, catalog);
		const disposeSettings = settings?.onChange(async (next) => {
			catalog.configure(parseSkillsConfig(recordValue(next)));
			await catalog.rescan();
			updateStatus(context, catalog);
		});
		const runtime: SkillsRuntime = {
			catalog,
			...(disposeSettings === undefined ? {} : { disposeSettings }),
		};
		runtimes.set(context, runtime);
		try {
			await catalog.rescan();
		} catch (error) {
			// Discovery is designed not to throw, but a plugin setup failure must not stop the server.
			context.logger.warn("skills catalog initial scan failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		updateStatus(context, catalog);
		const snapshot = catalog.snapshot();
		context.logger.info("skills ready", {
			diagnostics: snapshot.diagnostics.length,
			enabled: snapshot.skills.filter((skill) => skill.enabled).length,
			roots: snapshot.roots,
			skills: snapshot.skills.length,
		});
	},
	async teardown(context) {
		const runtime = runtimes.get(context);
		if (runtime === undefined) return;
		runtimes.delete(context);
		runtime.disposeSettings?.();
		runtime.catalog.dispose();
		context.ui.setStatus(null);
		context.logger.info("skills stopped");
	},
};

export default skillsPlugin;
