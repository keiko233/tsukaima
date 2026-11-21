import { classifyDshConfigKey } from "./dsh-baseline.ts";
import { type DecisionEntry, type DecisionReport, summarizeDecisions } from "./decision.ts";
import { sha256String, stableStringify } from "./fs.ts";
import { isHostSpecificKey, isIdentifyingKey, isSecretKey, redactSecrets } from "./secrets.ts";
import type { NormalizedSetting } from "./normalize.ts";

export const DSH_CONFIG_AREAS = [
	"provider-model",
	"napcat",
	"trigger-pacing",
	"persona-overrides",
	"memory",
	"meme",
	"search",
	"compaction-retention",
	"schedule-proactive",
	"admin-danger",
] as const;

export type DshConfigArea = (typeof DSH_CONFIG_AREAS)[number];

interface AreaDefinition {
	readonly target: string;
	readonly reason: string;
}

const AREA_DEFINITIONS: Readonly<Record<DshConfigArea, AreaDefinition>> = {
	"provider-model": {
		reason: "Maps provider/model defaults to the plugin model catalog and policy",
		target: "model_policies",
	},
	"admin-danger": {
		reason: "Maps admin and destructive-action permissions to Tsukaima policy",
		target: "policies.admin",
	},
	"compaction-retention": {
		reason: "Maps context compaction and retention to memory/context policy",
		target: "policies.memory",
	},
	meme: {
		reason: "Maps meme packs and media directories to sticker-meme import settings",
		target: "plugin.sticker-meme",
	},
	memory: {
		reason: "Maps memory spaces, shared memory, and cross-session windows to memory config",
		target: "plugin.memory",
	},
	napcat: {
		reason: "Maps NapCat transport and access policy to the onebot-napcat plugin",
		target: "plugin.onebot-napcat",
	},
	"persona-overrides": {
		reason: "Maps agent presets and persona overrides to persona bindings",
		target: "persona_bindings",
	},
	"schedule-proactive": {
		reason: "Maps schedule and proactive settings to the proactive-scheduler plugin",
		target: "plugin.proactive-scheduler",
	},
	search: {
		reason: "Maps search providers to the MCP server plugin",
		target: "plugin.mcp",
	},
	"trigger-pacing": {
		reason: "Maps trigger, pacing, burst, and media behavior to conversation policy",
		target: "policies.conversation",
	},
};

const AREA_KEYS: Readonly<Record<DshConfigArea, readonly string[]>> = {
	"provider-model": [
		"provider",
		"providers",
		"model",
		"models",
		"defaultmodel",
		"modelid",
		"capability",
		"fallback",
		"fallbacks",
		"temperature",
		"maxtokens",
		"maxoutputtokens",
		"thinkinglevel",
	],
	"admin-danger": [
		"admin",
		"admintitles",
		"danger",
		"dangerpolicy",
		"dangerwords",
		"dryrun",
		"mode",
		"allowgroupban",
		"allowgroupwholeban",
		"allowgroupkick",
		"allowgroupadmin",
		"allowgroupcard",
		"allowgroupname",
		"allowgroupleave",
		"allowgroupspecialtitle",
		"allowgroupaddrequest",
		"allowfriendaddrequest",
		"allowfriendremark",
		"allowdeletefriend",
		"allowdeleteunidirectionalfriend",
		"allowsetqqavatar",
		"allowsetqqprofile",
		"allowsetselflongnick",
		"allowsetonlinestatus",
		"allowsetdiyonlinestatus",
		"allowsendlike",
		"allowdeletegroupfile",
		"allowcreategroupfilefolder",
		"allowdeletegroupfilefolder",
		"allowmovegroupfile",
		"allowrenamegroupfile",
		"friendrequestevents",
		"friendrequestnotifyadmin",
		"friendrequestautoapprove",
		"friendrequestpendingttlminutes",
	],
	"compaction-retention": [
		"compact",
		"compactautoenabled",
		"compactthresholdtokens",
		"retention",
		"retentiondays",
		"contextwindow",
		"historylimit",
		"imagecacheretentiondays",
	],
	meme: [
		"meme",
		"memeenabled",
		"memeassticker",
		"memenudgeafter",
		"memeloosefallback",
		"memedirs",
		"meme-packs",
		"memeconfig",
	],
	memory: [
		"memory",
		"memorysharedenabled",
		"memorysharedwrite",
		"memoryprovider",
		"sharedmemory",
		"sharedmemorypath",
		"cross",
		"crosssessionenabled",
		"crossrecentminutes",
		"crossrecentlimit",
		"crossinjectmaxchars",
		"crossprivatetogroup",
		"crossstorepath",
		"perchatworkspace",
	],
	napcat: [
		"napcat",
		"accesstoken",
		"apikeyenv",
		"botqq",
		"host",
		"port",
		"url",
		"enabled",
		"dmpolicy",
		"allowfrom",
		"grouppolicy",
		"groupallowfrom",
		"noticeevents",
		"noticewake",
		"ptttotext",
		"ptttimeoutms",
		"pttminintervalms",
		"forwardexpand",
		"forwardmaxnodes",
		"forwardmaxchars",
		"forwardtimeoutms",
		"allowrelay",
		"ignoreself",
		"reconnectmaxattempts",
	],
	"persona-overrides": [
		"persona",
		"personas",
		"personaoverrides",
		"agentpreset",
		"presets",
		"preset",
		"personaids",
		"personabindings",
	],
	"schedule-proactive": [
		"schedule",
		"scheduleenabled",
		"schedulemaxperchat",
		"schedulemaxdelayminutes",
		"proactive",
		"proactiveenabled",
		"proactiverateperhour",
		"proactivechance",
		"proactivecooldownminutes",
		"protectivemaxperhour",
		"proactivequietHours".toLowerCase(),
		"protectiveminmessages",
		"proactivewindowminutes",
		"protectivetickenabled",
		"protectivetickminutes",
		"proactiveidleminutes",
		"protectivetickminutesl1",
		"protectivetickminutesl2",
		"proactiveusecannedlines",
		"proactivecontextlines",
		"proactivebubblebackoffminutes",
	],
	search: ["search", "searchprovider", "searchproviders", "websearch", "mcp", "mcpwebsearch"],
	"trigger-pacing": [
		"trigger",
		"triggerkeywords",
		"requiremention",
		"participationmode",
		"burst",
		"burstsettlems",
		"burstmaxwaitms",
		"burstmaxmessages",
		"burstlongchars",
		"replycooldownseconds",
		"stickerpolicy",
		"staticeveryturns",
		"typingindicator",
		"facefallback",
		"sendintervalms",
		"streamnarration",
		"repetitionrewrite",
		"replyasquote",
		"splitmaxchars",
		"outboundimagemaxbytes",
		"imageflattentransparent",
		"imageflattenbackground",
		"imageflattenmaxedge",
		"videopeekmaxbytes",
		"videopeekframes",
		"imageedittimeoutseconds",
		"imagecache",
		"imagecachemaxbytes",
		"imagecachedailycap",
	],
};

function areaKeys(area: DshConfigArea): Set<string> {
	return new Set(AREA_KEYS[area]);
}

const KEY_AREAS = new Map<string, DshConfigArea>();
for (const area of DSH_CONFIG_AREAS) {
	for (const key of areaKeys(area)) {
		if (!KEY_AREAS.has(key)) KEY_AREAS.set(key, area);
	}
}

const PLUGIN_AREAS: Readonly<Record<string, DshConfigArea>> = {
	"agent-default-model": "provider-model",
	"agent-preset-registry": "persona-overrides",
	"dsh-napcat": "napcat",
	"llm-pi-ai": "provider-model",
	"mcp-web-search-safe": "search",
	"search-fetch": "search",
};

/**
 * DSH cross-session keys (normalized) mapped onto `ConversationPolicy.crossSession`. Kept as
 * plain strings so this package does not depend on `@tsukaima/contracts`.
 */
export const DSH_CROSS_SESSION_POLICY_FIELDS: Readonly<Record<string, string>> = {
	crosssessionenabled: "enabled",
	crossrecentminutes: "windowMinutes",
	crossrecentlimit: "maxEntries",
	crossinjectmaxchars: "maxChars",
	crossprivatetogroup: "privateToGroup",
};

const CROSS_SESSION_POLICY_TARGET = "policies.conversation.crossSession";

/**
 * Build a `ConversationPolicyPatch["crossSession"]`-shaped object from mapped DSH leaves.
 * `crossPrivateToGroup: true` maps to `text`; anything else fails closed to `none`.
 * Out-of-range numbers are left for the policy schema to reject during import review.
 */
export function crossSessionPolicyPatchFromDsh(
	leaves: readonly MappedConfigLeaf[],
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const leaf of leaves) {
		if (leaf.action !== "remap" && leaf.action !== "direct") continue;
		const field = DSH_CROSS_SESSION_POLICY_FIELDS[normalizeKey(leaf.key)];
		if (field === undefined) continue;
		if (field === "privateToGroup") {
			patch[field] = leaf.safeValue === true ? "text" : "none";
		} else if (field === "enabled") {
			if (typeof leaf.safeValue === "boolean") patch[field] = leaf.safeValue;
		} else if (typeof leaf.safeValue === "number" && Number.isInteger(leaf.safeValue)) {
			patch[field] = leaf.safeValue;
		}
	}
	return patch;
}

const POLICY_KEYS = new Set<string>();
for (const area of DSH_CONFIG_AREAS) {
	for (const key of areaKeys(area)) POLICY_KEYS.add(key);
}

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function classifyConfigArea(path: readonly string[], key: string): DshConfigArea {
	const pluginId = path.find(
		(segment, index) => index > 0 && /plugin|dsh|agent|mcp/i.test(segment),
	);
	if (pluginId && PLUGIN_AREAS[pluginId] !== undefined) {
		return PLUGIN_AREAS[pluginId]!;
	}
	const normalized = normalizeKey(key);
	const keyArea = KEY_AREAS.get(normalized);
	if (keyArea !== undefined) {
		return keyArea;
	}
	for (const segment of [...path].toReversed()) {
		const normalizedSegment = normalizeKey(segment);
		const area = KEY_AREAS.get(normalizedSegment) ?? PLUGIN_AREAS[segment];
		if (area !== undefined) {
			return area;
		}
	}
	const joined = [...path, key].map(normalizeKey).join("");
	if (/persona|preset/.test(joined)) return "persona-overrides";
	if (/memor|mnemon/.test(joined)) return "memory";
	if (/meme|sticker/.test(joined)) return "meme";
	if (/search|websearch/.test(joined)) return "search";
	if (/compact|retention/.test(joined)) return "compaction-retention";
	if (/schedule|proactive/.test(joined)) return "schedule-proactive";
	if (/danger|admin|permission/.test(joined)) return "admin-danger";
	if (/trigger|pacing|burst/.test(joined)) return "trigger-pacing";
	if (/napcat|onebot/.test(joined)) return "napcat";
	if (/model|provider|llm/.test(joined)) return "provider-model";
	return "admin-danger";
}

interface ConfigLeaf {
	readonly path: string;
	readonly segments: readonly string[];
	readonly key: string;
	readonly value: unknown;
}

function collectLeaves(value: Record<string, unknown>, path: readonly string[] = []): ConfigLeaf[] {
	const leaves: ConfigLeaf[] = [];
	for (const [key, child] of Object.entries(value)) {
		if (isRecord(child)) {
			const nested = collectLeaves(child, [...path, key]);
			if (nested.length > 0) {
				leaves.push(...nested);
			} else {
				leaves.push({
					key,
					path: [...path, key].join("."),
					segments: [...path, key],
					value: child,
				});
			}
		} else {
			leaves.push({ key, path: [...path, key].join("."), segments: [...path, key], value: child });
		}
	}
	return leaves;
}

function configRoots(value: unknown): Record<string, unknown>[] {
	const roots: Record<string, unknown>[] = [];
	const visit = (current: unknown, path: readonly string[]): void => {
		if (Array.isArray(current)) {
			current.forEach((item, index) => visit(item, [...path, String(index)]));
			return;
		}
		if (!isRecord(current)) return;
		if (path.some((segment) => /config|settings|options/i.test(segment))) {
			roots.push(current);
		}
		for (const [key, child] of Object.entries(current)) {
			if (isRecord(child) || Array.isArray(child)) visit(child, [...path, key]);
		}
	};
	visit(value, []);
	if (roots.length === 0 && isRecord(value)) {
		const plugins = value.plugins;
		if (isRecord(plugins)) {
			for (const [pluginId, plugin] of Object.entries(plugins)) {
				if (isRecord(plugin) && (isRecord(plugin.config) || isRecord(plugin.settings))) {
					roots.push({
						...(isRecord(plugin.config) ? plugin.config : {}),
						...(isRecord(plugin.settings) ? plugin.settings : {}),
						pluginSource: pluginId,
					});
				}
			}
		}
	}
	return roots;
}

export interface MappedConfigLeaf {
	readonly area: DshConfigArea;
	readonly source: string;
	readonly key: string;
	readonly target: string;
	readonly action: DecisionEntry["action"];
	readonly reason: string;
	readonly valueClass: ReturnType<typeof classifyDshConfigKey>;
	readonly redacted: boolean;
	readonly safeValue?: unknown;
}

export interface ConfigMappingResult {
	readonly areas: Readonly<
		Record<DshConfigArea, { readonly present: boolean; readonly keys: number }>
	>;
	readonly entries: readonly DecisionEntry[];
	readonly leaves: readonly MappedConfigLeaf[];
	readonly report: DecisionReport;
	readonly settings: readonly NormalizedSetting[];
}

function mapLeaf(leaf: ConfigLeaf, prefix: string): MappedConfigLeaf {
	const normalizedKey = normalizeKey(leaf.key);
	const valueClass = classifyDshConfigKey(leaf.key);
	const hostSpecific = isHostSpecificKey(leaf.key);
	const identifying = isIdentifyingKey(leaf.key);
	const secret = isSecretKey(leaf.key) || valueClass === "secret";
	const area = classifyConfigArea(leaf.segments.slice(0, -1), leaf.key);
	const definition = AREA_DEFINITIONS[area];
	const known = POLICY_KEYS.has(normalizedKey);
	const isPolicy = valueClass === "policy" || known;
	const source = `${prefix}.${leaf.path}`;
	if (secret) {
		return {
			action: "discard",
			area,
			key: leaf.key,
			reason: "Credential/token values are never imported",
			redacted: true,
			source,
			target: `${definition.target}.${leaf.key}`,
			valueClass,
		};
	}
	if (hostSpecific) {
		return {
			action: "discard",
			area,
			key: leaf.key,
			reason: "Host/network-specific values are not portable and are stripped",
			redacted: true,
			source,
			target: `${definition.target}.${leaf.key}`,
			valueClass,
		};
	}
	if (identifying) {
		return {
			action: "review",
			area,
			key: leaf.key,
			reason: "Identifying values require an explicit administrator mapping",
			redacted: true,
			source,
			target: `${definition.target}.${leaf.key}`,
			valueClass,
		};
	}
	const crossSessionField = DSH_CROSS_SESSION_POLICY_FIELDS[normalizedKey];
	if (crossSessionField !== undefined) {
		return {
			action: "remap",
			area,
			key: leaf.key,
			reason: "Maps DSH cross-session windows to conversation cross-session policy",
			redacted: false,
			safeValue: leaf.value,
			source,
			target: `${CROSS_SESSION_POLICY_TARGET}.${crossSessionField}`,
			valueClass,
		};
	}
	if (isPolicy) {
		return {
			action: "remap",
			area,
			key: leaf.key,
			reason: definition.reason,
			redacted: false,
			safeValue: leaf.value,
			source,
			target: `${definition.target}.${leaf.key}`,
			valueClass,
		};
	}
	if (valueClass === "safe" && !known) {
		return {
			action: "review",
			area,
			key: leaf.key,
			reason: "Unknown setting requires review before import",
			redacted: false,
			source,
			target: `${definition.target}.${leaf.key}`,
			valueClass,
		};
	}
	return {
		action: "direct",
		area,
		key: leaf.key,
		reason: "Compatible scalar copied directly",
		redacted: false,
		safeValue: leaf.value,
		source,
		target: `${definition.target}.${leaf.key}`,
		valueClass,
	};
}

function settingForLeaf(leaf: MappedConfigLeaf, prefix: string): NormalizedSetting[] {
	if (leaf.action === "discard" || leaf.action === "review") {
		return [];
	}
	const safe =
		leaf.action === "remap" || leaf.action === "direct"
			? redactSecrets({ [leaf.key]: leaf.safeValue }, { includeHostSpecific: true }).value
			: {};
	return [
		{
			canonicalId: `dsh_setting_${sha256String(`${prefix}:${leaf.source}`).slice(7, 23)}`,
			category: leaf.area,
			requiresManualDecision: false,
			secretsDetected: leaf.redacted ? [leaf.source] : [],
			sourceHash: sha256String(stableStringify({ key: leaf.key, value: safe })),
			sourceId: `${prefix}:${leaf.source}`,
			sourceSystem: "dsh",
			target: leaf.target,
			valueJson: JSON.stringify(safe),
		},
	];
}

export function mapDshConfig(
	config: unknown,
	options: { readonly source?: string } = {},
): ConfigMappingResult {
	const prefix = options.source ?? "config";
	const roots = configRoots(config);
	const leaves =
		roots.length > 0
			? roots.flatMap((root, index) =>
					collectLeaves(root).map((leaf) => ({
						leaf,
						prefix: `${prefix}.${typeof root.pluginSource === "string" ? root.pluginSource : index}`,
					})),
				)
			: isRecord(config)
				? collectLeaves(config).map((leaf) => ({ leaf, prefix }))
				: [];
	const mapped = leaves.map(({ leaf, prefix: rootPrefix }) => mapLeaf(leaf, rootPrefix));
	const areaKeysPresent = new Map<DshConfigArea, number>();
	for (const leaf of mapped) {
		areaKeysPresent.set(leaf.area, (areaKeysPresent.get(leaf.area) ?? 0) + 1);
	}
	const entries: DecisionEntry[] = mapped.map((leaf) => ({
		action: leaf.action,
		area: leaf.area,
		key: leaf.key,
		reason: leaf.reason,
		redacted: leaf.redacted,
		source: leaf.source,
		target: leaf.target,
		valueClass: leaf.valueClass,
	}));
	for (const area of DSH_CONFIG_AREAS) {
		if (!areaKeysPresent.has(area)) {
			entries.push({
				action: "review",
				area,
				reason: "No source setting found for this required DSH config area",
				source: `area:${area}`,
				target: AREA_DEFINITIONS[area].target,
			});
		}
	}
	const areas = Object.fromEntries(
		DSH_CONFIG_AREAS.map((area) => [
			area,
			{ keys: areaKeysPresent.get(area) ?? 0, present: areaKeysPresent.has(area) },
		]),
	) as ConfigMappingResult["areas"];
	const report = summarizeDecisions(
		entries,
		mapped.filter((leaf) => leaf.redacted).map((leaf) => leaf.source),
	);
	return {
		areas,
		entries,
		leaves: mapped,
		report,
		settings: mapped.flatMap((leaf) =>
			settingForLeaf(leaf, leaf.source.split(".").slice(0, -1).join(".")),
		),
	};
}

export function mapDshConfigText(text: string, source = "config.yaml"): ConfigMappingResult {
	const parsed = Bun.YAML.parse(text) as unknown;
	return mapDshConfig(parsed, { source });
}
