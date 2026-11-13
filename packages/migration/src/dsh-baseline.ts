import { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { basename, relative } from "node:path";
import { DSH_SOURCE, type SnapshotSource } from "./dsh-inspect.ts";
import { listFiles } from "./fs.ts";

export const DSH_BASELINE_SECTIONS = [
	"versions",
	"profile",
	"plugins",
	"configuration",
	"tools",
	"memory",
	"memePacks",
	"schedules",
	"sessions",
	"ledgers",
] as const;

export const DSH_VALUE_CLASSES = [
	"safe",
	"secret",
	"identifying",
	"policy",
	"host-specific",
] as const;

export type DshBaselineSection = (typeof DSH_BASELINE_SECTIONS)[number];
export type DshValueClass = (typeof DSH_VALUE_CLASSES)[number];

export interface DshBaselineTarget {
	readonly host: string | null;
	readonly project: string | null;
	readonly container: string | null;
}

export interface DshBaselineTargetInput {
	readonly host?: string;
	readonly project?: string;
	readonly container?: string;
}

export interface DshVersionInventory {
	readonly image: string | null;
	readonly cli: string | null;
}

export interface DshBundleInventory {
	readonly name: string;
	readonly spec: string;
	readonly version: string | null;
}

export interface DshProfileInventory {
	readonly name: string | null;
	readonly bundles: readonly DshBundleInventory[];
}

export interface DshPluginInventory {
	readonly id: string;
	readonly packageName: string | null;
	readonly enabled: boolean;
	readonly presets: readonly string[];
}

export interface DshClassifiedConfigField {
	readonly path: string;
	readonly key: string;
	readonly classification: DshValueClass;
	readonly configured: boolean;
	readonly state: "configured" | "unconfigured";
	readonly value?: unknown;
}

export interface DshConfigurationInventory {
	readonly entries: readonly DshClassifiedConfigField[];
	readonly counts: Readonly<Record<DshValueClass, number>>;
}

export interface DshSqliteTable {
	readonly name: string;
	readonly columns: readonly string[];
}

export interface DshMemoryDatabase {
	readonly space: string;
	readonly tables: readonly DshSqliteTable[];
}

export interface DshMemoryInventory {
	readonly provider: string | null;
	readonly strategies: readonly string[];
	readonly spaces: readonly string[];
	readonly databases: readonly DshMemoryDatabase[];
	readonly documentFields: readonly string[];
	readonly runtimeFields: readonly string[];
	readonly runtimeEntryFields: readonly string[];
}

export interface DshMemePack {
	readonly id: string;
	readonly name: string | null;
	readonly version: string | null;
	readonly manifestFields: readonly string[];
	readonly tables: readonly DshSqliteTable[];
	readonly fileCount: number;
}

export interface DshMemePackInventory {
	readonly packCount: number;
	readonly fileCount: number;
	readonly schemaNames: readonly string[];
	readonly manifestFields: readonly string[];
	readonly packs: readonly DshMemePack[];
}

export interface DshScheduleSource {
	readonly source: "dsh-host" | "napcat" | "unknown";
	readonly taskCount: number;
	readonly statusClasses: readonly string[];
	readonly timingFields: readonly string[];
}

export interface DshScheduleInventory {
	readonly taskCount: number;
	readonly statusClasses: readonly string[];
	readonly timingFields: readonly string[];
	readonly sources: readonly DshScheduleSource[];
}

export interface DshSessionInventory {
	readonly fileCount: number;
	readonly compressedFileCount: number;
	readonly workspaceCount: number;
	readonly sessionRecordCount: number;
	readonly recordTypes: readonly string[];
	readonly sessionFields: readonly string[];
	readonly eventFields: readonly string[];
	readonly eventTypes: readonly string[];
}

export interface DshLedgerFields {
	readonly count: number;
	readonly fields: readonly string[];
}

export interface DshHumanProfileInventory {
	readonly profileCount: number;
	readonly fields: readonly string[];
	readonly profileFields: readonly string[];
}

export interface DshLedgerInventory {
	readonly friendRequests: DshLedgerFields;
	readonly humanProfiles: DshHumanProfileInventory;
	readonly qaLedger: DshLedgerFields;
	readonly adminAudit: DshLedgerFields;
}

export interface DshBaselineInventory {
	readonly versions: DshVersionInventory;
	readonly profile: DshProfileInventory;
	readonly plugins: readonly DshPluginInventory[];
	readonly configuration: DshConfigurationInventory;
	readonly tools: readonly string[];
	readonly memory: DshMemoryInventory;
	readonly memePacks: DshMemePackInventory;
	readonly schedules: DshScheduleInventory;
	readonly sessions: DshSessionInventory;
	readonly ledgers: DshLedgerInventory;
}

export interface DshBaseline {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly target: DshBaselineTarget;
	readonly inventory: DshBaselineInventory;
}

export interface ExtractDshBaselineOptions {
	readonly target?: DshBaselineTargetInput;
}

interface BaselineFile {
	readonly path: string;
	readonly relativePath: string;
	readonly absolutePath: string;
}

interface ConfigRoot {
	readonly path: string;
	readonly value: unknown;
}

const EXPLICIT_CONFIG_CLASSES: Readonly<Record<string, DshValueClass>> = {
	accessToken: "secret",
	apiKeyEnv: "secret",
	layaGateApiKey: "secret",
	imageEditToken: "secret",
	botQQ: "identifying",
	adminUsers: "identifying",
	personaOverrides: "identifying",
	url: "host-specific",
	host: "host-specific",
	port: "host-specific",
	workspacePath: "host-specific",
	sharedMemoryPath: "host-specific",
	crossStorePath: "host-specific",
	memeDirs: "host-specific",
	imageCache: "host-specific",
	compactRpcUrl: "host-specific",
	layaGateUrl: "host-specific",
	imageEditUrl: "host-specific",
	imageEditOutDir: "host-specific",
	perChatWorkspace: "host-specific",
	enabled: "policy",
	dmPolicy: "policy",
	allowFrom: "policy",
	groupPolicy: "policy",
	groupAllowFrom: "policy",
	triggerKeywords: "policy",
	requireMention: "policy",
	participationMode: "policy",
	burstSettleMs: "policy",
	burstMaxWaitMs: "policy",
	burstMaxMessages: "policy",
	burstLongChars: "policy",
	replyCooldownSeconds: "policy",
	stickerPolicy: "policy",
	staticEveryTurns: "policy",
	noticeEvents: "policy",
	noticeWake: "policy",
	pttToText: "policy",
	pttTimeoutMs: "policy",
	pttMinIntervalMs: "policy",
	forwardExpand: "policy",
	forwardMaxNodes: "policy",
	forwardMaxChars: "policy",
	forwardTimeoutMs: "policy",
	memorySharedEnabled: "policy",
	memorySharedWrite: "policy",
	crossSessionEnabled: "policy",
	crossRecentMinutes: "policy",
	crossRecentLimit: "policy",
	crossInjectMaxChars: "policy",
	crossPrivateToGroup: "policy",
	allowRelay: "policy",
	allowGroupBan: "policy",
	allowGroupWholeBan: "policy",
	allowGroupKick: "policy",
	allowGroupAdmin: "policy",
	allowGroupCard: "policy",
	allowGroupName: "policy",
	allowGroupLeave: "policy",
	allowGroupSpecialTitle: "policy",
	allowGroupAddRequest: "policy",
	allowFriendAddRequest: "policy",
	allowFriendRemark: "policy",
	allowDeleteFriend: "policy",
	allowDeleteUnidirectionalFriend: "policy",
	allowSetQqAvatar: "policy",
	allowSetQqProfile: "policy",
	allowSetSelfLongnick: "policy",
	allowSetOnlineStatus: "policy",
	allowSetDiyOnlineStatus: "policy",
	allowSendLike: "policy",
	allowDeleteGroupFile: "policy",
	allowCreateGroupFileFolder: "policy",
	allowDeleteGroupFileFolder: "policy",
	allowMoveGroupFile: "policy",
	allowRenameGroupFile: "policy",
	friendRequestEvents: "policy",
	friendRequestNotifyAdmin: "policy",
	friendRequestAutoApprove: "policy",
	friendRequestPendingTtlMinutes: "policy",
	ignoreSelf: "policy",
	replyAsQuote: "policy",
	splitMaxChars: "policy",
	dryRun: "policy",
	dangerPolicy: "policy",
	dangerWords: "policy",
	layaGateEnabled: "policy",
	bubbleGateEnabled: "policy",
	bubbleGateThreshold: "policy",
	replyGateEnabled: "policy",
	replyGateThreshold: "policy",
	burstGateEnabled: "policy",
	burstGateThreshold: "policy",
	proactiveEnabled: "policy",
	proactiveRatePerHour: "policy",
	proactiveChance: "policy",
	proactiveCooldownMinutes: "policy",
	proactiveMaxPerHour: "policy",
	proactiveQuietHours: "policy",
	proactiveMinMessages: "policy",
	proactiveWindowMinutes: "policy",
	proactiveTickEnabled: "policy",
	proactiveTickMinutes: "policy",
	proactiveIdleMinutes: "policy",
	proactiveTickMinutesL1: "policy",
	proactiveTickMinutesL2: "policy",
	scheduleEnabled: "policy",
	scheduleMaxPerChat: "policy",
	scheduleMaxDelayMinutes: "policy",
	compactAutoEnabled: "policy",
	compactThresholdTokens: "policy",
	mode: "safe",
	adminTitles: "safe",
	typingIndicator: "safe",
	faceFallback: "safe",
	memeEnabled: "safe",
	memeAsSticker: "safe",
	memeNudgeAfter: "safe",
	memeLooseFallback: "safe",
	outboundImageMaxBytes: "safe",
	imageFlattenTransparent: "safe",
	imageFlattenBackground: "safe",
	imageFlattenMaxEdge: "safe",
	sendIntervalMs: "safe",
	streamNarration: "safe",
	repetitionRewrite: "safe",
	videoPeekMaxBytes: "safe",
	videoPeekFrames: "safe",
	imageEditTimeoutSeconds: "safe",
	reconnectMaxAttempts: "safe",
	imageCacheMaxBytes: "safe",
	imageCacheDailyCap: "safe",
	imageCacheRetentionDays: "safe",
	proactiveUseCannedLines: "safe",
	proactiveContextLines: "safe",
	proactiveBubbleBackoffMinutes: "safe",
	logLevel: "safe",
};

const NON_CREDENTIAL_KEYS = new Set([
	"hotkey",
	"hotkeys",
	"keyboard",
	"keyword",
	"keywords",
	"publickey",
	"triggerkeywords",
	"chatkey",
	"daykey",
	"sessionkey",
	"primarykey",
	"cachekey",
	"sortkey",
	"foreignkey",
]);

const CREDENTIAL_SEGMENTS = new Set([
	"auth",
	"authorization",
	"cookie",
	"credential",
	"credentials",
	"pass",
	"passphrase",
	"password",
	"passwd",
	"secret",
	"token",
]);

const CONFIG_CONTAINER_KEYS = new Set(["config", "configuration", "options", "settings"]);
const TIMING_FIELDS = [
	"createdAt",
	"dueAt",
	"repeatEveryMs",
	"flexMs",
	"firedAt",
	"closedAt",
	"attempts",
	"maxAttempts",
	"fireCount",
	"cancelIfReplied",
	"kind",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmpty(value: string | undefined): string | null {
	return value && value.trim() !== "" ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sqliteTableList(value: unknown): DshSqliteTable[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.name !== "string") {
			return [];
		}
		return [{ name: item.name, columns: stringArray(item.columns) }];
	});
}

function sorted(values: Iterable<string>): string[] {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function keySegments(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

export function isCredentialLikeKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (NON_CREDENTIAL_KEYS.has(lower)) {
		return false;
	}
	const segments = keySegments(key);
	if (segments.some((segment) => CREDENTIAL_SEGMENTS.has(segment))) {
		return true;
	}
	if (segments.includes("apikey")) {
		return true;
	}
	if (segments.some((segment, index) => segment === "api" && segments[index + 1] === "key")) {
		return true;
	}
	return segments.includes("key");
}

export function classifyDshConfigKey(key: string): DshValueClass {
	return EXPLICIT_CONFIG_CLASSES[key] ?? (isCredentialLikeKey(key) ? "secret" : "safe");
}

export function resolveDshBaselineTarget(
	input: DshBaselineTargetInput = {},
	environment: Readonly<Record<string, string | undefined>> = process.env,
): DshBaselineTarget {
	return {
		host: nonEmpty(input.host) ?? nonEmpty(environment.DSH_AUDIT_HOST),
		project: nonEmpty(input.project) ?? nonEmpty(environment.DSH_AUDIT_PROJECT),
		container: nonEmpty(input.container) ?? nonEmpty(environment.DSH_AUDIT_CONTAINER),
	};
}

function isConfigured(value: unknown): boolean {
	if (value === undefined || value === null) {
		return false;
	}
	if (typeof value === "string") {
		return value.trim() !== "";
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (isRecord(value)) {
		return Object.keys(value).length > 0;
	}
	return true;
}

function configField(path: string, key: string, value: unknown): DshClassifiedConfigField {
	const classification = classifyDshConfigKey(key);
	const configured = isConfigured(value);
	const includeValue = classification === "safe" && EXPLICIT_CONFIG_CLASSES[key] === "safe";
	return {
		path,
		key,
		classification,
		configured,
		state: configured ? "configured" : "unconfigured",
		...(includeValue ? { value } : {}),
	};
}

function collectConfigFields(root: ConfigRoot): DshClassifiedConfigField[] {
	const fields: DshClassifiedConfigField[] = [];
	const visit = (value: unknown, path: string, key: string): void => {
		const classification = classifyDshConfigKey(key);
		const opaque =
			Array.isArray(value) ||
			!isRecord(value) ||
			classification === "secret" ||
			classification === "identifying";
		if (opaque) {
			fields.push(configField(path, key, value));
			return;
		}
		for (const [childKey, childValue] of Object.entries(value)) {
			visit(childValue, `${path}.${childKey}`, childKey);
		}
	};
	if (!isRecord(root.value)) {
		return fields;
	}
	for (const [key, value] of Object.entries(root.value)) {
		visit(value, `${root.path}.${key}`, key);
	}
	return fields;
}

function looksLikeConfigRecord(value: Record<string, unknown>): boolean {
	return Object.keys(value).some(
		(key) => key in EXPLICIT_CONFIG_CLASSES || isCredentialLikeKey(key),
	);
}

function findConfigRoots(value: unknown, path = "", roots: ConfigRoot[] = []): ConfigRoot[] {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) {
			findConfigRoots(child, `${path}[${index}]`, roots);
		}
		return roots;
	}
	if (!isRecord(value)) {
		return roots;
	}
	if (looksLikeConfigRecord(value)) {
		roots.push({ path: path || "config", value });
		return roots;
	}
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (CONFIG_CONTAINER_KEYS.has(key) && isRecord(child)) {
			roots.push({ path: childPath, value: child });
		} else {
			findConfigRoots(child, childPath, roots);
		}
	}
	return roots;
}

function pluginRecords(value: unknown): { id: string; record: Record<string, unknown> }[] {
	let collection: unknown = value;
	if (isRecord(value) && "plugins" in value) {
		collection = value.plugins;
	} else if (isRecord(value) && looksLikeConfigRecord(value)) {
		return [];
	}
	if (isRecord(collection) && looksLikeConfigRecord(collection)) {
		return [];
	}
	if (Array.isArray(collection)) {
		return collection.flatMap((item) => {
			if (!isRecord(item)) {
				return [];
			}
			const id = stringOrNull(item.id) ?? stringOrNull(item.key) ?? stringOrNull(item.name);
			return id ? [{ id, record: item }] : [];
		});
	}
	if (!isRecord(collection)) {
		return [];
	}
	return Object.entries(collection).flatMap(([id, item]) => {
		if (isRecord(item)) {
			return [{ id: stringOrNull(item.id) ?? id, record: item }];
		}
		if (typeof item === "string" || typeof item === "boolean") {
			return [{ id, record: { package: item } }];
		}
		return [];
	});
}

function pluginFromRecord(id: string, record: Record<string, unknown>): DshPluginInventory {
	const rawPackage = record.package;
	const packageName =
		stringOrNull(rawPackage) ??
		stringOrNull(record.packageName) ??
		stringOrNull(record.name) ??
		(typeof rawPackage === "string" ? rawPackage : null);
	const disabled = record.disabled === true || record.enabled === false;
	return {
		id,
		packageName,
		enabled: !disabled,
		presets: stringArray(record.presets).toSorted((left, right) => left.localeCompare(right)),
	};
}

function quoteSqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function sqliteTables(path: string): DshSqliteTable[] {
	try {
		const database = new Database(path, { readonly: true });
		try {
			const tables = database
				.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as { name: string }[];
			return tables.map(({ name }) => {
				const columns = database.query(`PRAGMA table_info(${quoteSqlIdentifier(name)})`).all() as {
					name: string;
				}[];
				return { name, columns: columns.map((column) => column.name) };
			});
		} finally {
			database.close();
		}
	} catch {
		return [];
	}
}

function sqliteRowCount(path: string, table: string): number {
	try {
		const database = new Database(path, { readonly: true });
		try {
			const row = database
				.query(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`)
				.get() as { count?: number } | null;
			return Number(row?.count ?? 0);
		} finally {
			database.close();
		}
	} catch {
		return 0;
	}
}

async function loadBaselineFiles(source: SnapshotSource): Promise<BaselineFile[]> {
	const files: BaselineFile[] = [];
	for (const [root, label] of source) {
		const stats = await fs.stat(root);
		if (stats.isDirectory()) {
			for (const file of await listFiles(root)) {
				const relativePath = relative(root, file).replaceAll("\\", "/");
				files.push({
					path: `${label}/${relativePath}`,
					relativePath,
					absolutePath: file,
				});
			}
		} else if (stats.isFile()) {
			files.push({
				path: label,
				relativePath: basename(root),
				absolutePath: root,
			});
		}
	}
	return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function readJsonFile(file: BaselineFile): Promise<unknown> {
	return JSON.parse(await fs.readFile(file.absolutePath, "utf8")) as unknown;
}

async function readJsonObject(file: BaselineFile): Promise<Record<string, unknown>> {
	const value = await readJsonFile(file);
	return isRecord(value) ? value : {};
}

async function readJsonlRecords(file: BaselineFile): Promise<Record<string, unknown>[]> {
	const content = await fs.readFile(file.absolutePath, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				const value = JSON.parse(line) as unknown;
				return isRecord(value) ? [value] : [];
			} catch {
				return [];
			}
		});
}

function recordFields(records: readonly Record<string, unknown>[]): string[] {
	return sorted(records.flatMap((record) => Object.keys(record)));
}

function findFile(files: readonly BaselineFile[], pattern: RegExp): BaselineFile | undefined {
	return files.find((file) => pattern.test(file.path));
}

function findFiles(files: readonly BaselineFile[], pattern: RegExp): BaselineFile[] {
	return files.filter((file) => pattern.test(file.path));
}

function readMemorySpace(path: string): string | null {
	const match = /(?:^|\/)\.mnemon\/data\/([^/]+)\/mnemon\.db$/.exec(path);
	return match?.[1] ?? null;
}

export function sanitizeMemorySpace(space: string): string {
	if (
		space === "dsh-host" ||
		space === "napcat-group-<id>" ||
		space === "napcat-private-<id>" ||
		space === "workspace-<uuid>" ||
		space === "custom-<space>"
	) {
		return space;
	}
	if (space.startsWith("napcat-group-")) {
		return "napcat-group-<id>";
	}
	if (space.startsWith("napcat-private-")) {
		return "napcat-private-<id>";
	}
	if (space.startsWith("workspace-") && UUID_PATTERN.test(space.slice("workspace-".length))) {
		return "workspace-<uuid>";
	}
	if (UUID_PATTERN.test(space)) {
		return "workspace-<uuid>";
	}
	return "custom-<space>";
}

async function readVersions(files: readonly BaselineFile[]): Promise<DshVersionInventory> {
	const file = findFile(files, /(?:^|\/)deployment\.json$/i);
	if (!file) {
		return { image: null, cli: null };
	}
	const record = await readJsonObject(file);
	return {
		image: stringOrNull(record.image),
		cli:
			stringOrNull(record.cliVersion) ?? stringOrNull(record.cli) ?? stringOrNull(record.version),
	};
}

async function readProfile(files: readonly BaselineFile[]): Promise<DshProfileInventory> {
	const packageFile = findFile(files, /(?:^|\/)profiles\/[^/]+\/package\.json$/i);
	if (!packageFile) {
		return { name: null, bundles: [] };
	}
	const record = await readJsonObject(packageFile);
	const dependencies = isRecord(record.dependencies) ? record.dependencies : {};
	const installed = new Map<string, string>();
	for (const file of findFiles(
		files,
		/(?:^|\/)profiles\/[^/]+\/node_modules\/.+\/package\.json$/i,
	)) {
		const installedRecord = await readJsonObject(file);
		const name = stringOrNull(installedRecord.name);
		const version = stringOrNull(installedRecord.version);
		if (name && version) {
			installed.set(name, version);
		}
	}
	const bundles = Object.entries(dependencies)
		.flatMap(([name, value]) => {
			if (typeof value !== "string") {
				return [];
			}
			return [
				{
					name,
					spec: value,
					version: installed.get(name) ?? null,
				},
			];
		})
		.toSorted((left, right) => left.name.localeCompare(right.name));
	return {
		name: stringOrNull(record.name),
		bundles,
	};
}

async function readCordisFiles(files: readonly BaselineFile[]): Promise<unknown[]> {
	const roots: unknown[] = [];
	for (const file of findFiles(files, /(?:^|\/)cordis\.patch\.ya?ml$/i)) {
		const content = await fs.readFile(file.absolutePath, "utf8");
		roots.push(Bun.YAML.parse(content) as unknown);
	}
	return roots;
}

function readPlugins(roots: readonly unknown[]): DshPluginInventory[] {
	const plugins = new Map<string, DshPluginInventory>();
	for (const root of roots) {
		for (const { id, record } of pluginRecords(root)) {
			plugins.set(id, pluginFromRecord(id, record));
		}
	}
	return [...plugins.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

function readConfiguration(roots: readonly unknown[]): DshConfigurationInventory {
	const entries = new Map<string, DshClassifiedConfigField>();
	for (const root of roots) {
		for (const configRoot of findConfigRoots(root)) {
			for (const field of collectConfigFields(configRoot)) {
				entries.set(field.path, field);
			}
		}
	}
	const sortedEntries = [...entries.values()].toSorted((left, right) =>
		left.path.localeCompare(right.path),
	);
	const counts: Record<DshValueClass, number> = {
		safe: 0,
		secret: 0,
		identifying: 0,
		policy: 0,
		"host-specific": 0,
	};
	for (const entry of sortedEntries) {
		counts[entry.classification] += 1;
	}
	return { entries: sortedEntries, counts };
}

async function readTools(files: readonly BaselineFile[]): Promise<string[]> {
	const file =
		findFile(files, /(?:^|\/)audit\/tools\.json$/i) ??
		findFile(files, /(?:^|\/)(?:napcat-)?tools\.json$/i);
	if (!file) {
		return [];
	}
	const record = await readJsonFile(file);
	if (Array.isArray(record)) {
		return stringArray(record);
	}
	if (isRecord(record)) {
		return stringArray(record.napcatTools ?? record.tools);
	}
	return [];
}

async function readMemory(
	files: readonly BaselineFile[],
	profile: DshProfileInventory,
): Promise<DshMemoryInventory> {
	const databases = new Map<string, DshMemoryDatabase>();
	for (const file of files) {
		const space = readMemorySpace(file.path);
		if (!space) {
			continue;
		}
		const sanitizedSpace = sanitizeMemorySpace(space);
		if (!databases.has(sanitizedSpace)) {
			databases.set(sanitizedSpace, {
				space: sanitizedSpace,
				tables: sqliteTables(file.absolutePath),
			});
		}
	}
	const documentsFile = findFile(files, /(?:^|\/)\.mnemon\/documents\/index\.json$/i);
	const documentsRecord = documentsFile ? await readJsonObject(documentsFile) : {};
	const runtimeFile = findFile(files, /(?:^|\/)\.mnemon\/runtime\/memories\.json$/i);
	const runtimeRecord = runtimeFile ? await readJsonObject(runtimeFile) : {};
	const runtimeEntries = Array.isArray(runtimeRecord.entries)
		? runtimeRecord.entries.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		: [];
	const strategies: string[] = [];
	if (profile.bundles.some((bundle) => bundle.name === "dsh-mnemon")) {
		strategies.push("dsh-mnemon sqlite insights");
	}
	if (profile.bundles.some((bundle) => bundle.name === "dsh-napcat")) {
		strategies.push("dsh-napcat shared/cross-session markdown/jsonl");
	}
	return {
		provider: profile.bundles.some((bundle) => bundle.name === "dsh-mnemon") ? "dsh-mnemon" : null,
		strategies,
		spaces: [...databases.keys()].toSorted((left, right) => left.localeCompare(right)),
		databases: [...databases.values()].toSorted((left, right) =>
			left.space.localeCompare(right.space),
		),
		documentFields: sorted(Object.keys(documentsRecord)),
		runtimeFields: sorted(Object.keys(runtimeRecord)),
		runtimeEntryFields: recordFields(runtimeEntries),
	};
}

async function readMemePacks(files: readonly BaselineFile[]): Promise<DshMemePackInventory> {
	const auditFile = findFile(files, /(?:^|\/)audit\/meme-packs\.json$/i);
	if (auditFile) {
		const audit = await readJsonObject(auditFile);
		if (Array.isArray(audit.packs)) {
			const packs = audit.packs.flatMap((item): DshMemePack[] => {
				if (!isRecord(item)) {
					return [];
				}
				return [
					{
						id: stringOrNull(item.id) ?? "unknown",
						name: stringOrNull(item.name),
						version: stringOrNull(item.version),
						manifestFields: sorted(stringArray(item.manifestFields)),
						tables: sqliteTableList(item.tables),
						fileCount: numberOrZero(item.fileCount),
					},
				];
			});
			const sortedPacks = packs.toSorted((left, right) => left.id.localeCompare(right.id));
			return {
				packCount: sortedPacks.length,
				fileCount: sortedPacks.reduce((total, pack) => total + pack.fileCount, 0),
				schemaNames: sorted(sortedPacks.flatMap((pack) => pack.tables.map((table) => table.name))),
				manifestFields: sorted(sortedPacks.flatMap((pack) => pack.manifestFields)),
				packs: sortedPacks,
			};
		}
	}
	const packs: DshMemePack[] = [];
	for (const manifestFile of findFiles(files, /(?:^|\/)meme-packs\/[^/]+\/manifest\.json$/i)) {
		const manifest = await readJsonObject(manifestFile);
		const id =
			stringOrNull(manifest.id) ?? manifestFile.relativePath.split("/").at(-2) ?? "unknown";
		const indexFile = files.find(
			(file) =>
				file.absolutePath === manifestFile.absolutePath.replace(/manifest\.json$/i, "index.db"),
		);
		const tables = indexFile ? sqliteTables(indexFile.absolutePath) : [];
		const memesTable = tables.find((table) => table.name === "memes");
		const fileCount =
			indexFile && memesTable ? sqliteRowCount(indexFile.absolutePath, memesTable.name) : 0;
		packs.push({
			id,
			name: stringOrNull(manifest.name),
			version: stringOrNull(manifest.version),
			manifestFields: sorted(Object.keys(manifest)),
			tables,
			fileCount,
		});
	}
	const sortedPacks = packs.toSorted((left, right) => left.id.localeCompare(right.id));
	return {
		packCount: sortedPacks.length,
		fileCount: sortedPacks.reduce((total, pack) => total + pack.fileCount, 0),
		schemaNames: sorted(sortedPacks.flatMap((pack) => pack.tables.map((table) => table.name))),
		manifestFields: sorted(sortedPacks.flatMap((pack) => pack.manifestFields)),
		packs: sortedPacks,
	};
}

function looksLikeTask(value: Record<string, unknown>): boolean {
	return (
		"status" in value ||
		"dueAt" in value ||
		"createdAt" in value ||
		"kind" in value ||
		"fireCount" in value
	);
}

function collectTaskObjects(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is Record<string, unknown> => isRecord(item));
	}
	if (!isRecord(value)) {
		return [];
	}
	if (looksLikeTask(value)) {
		return [value];
	}
	const tasks: Record<string, unknown>[] = [];
	for (const key of ["tables", "tasks", "items", "entries"]) {
		const child = value[key];
		if (Array.isArray(child)) {
			tasks.push(...collectTaskObjects(child));
		} else if (isRecord(child)) {
			for (const nested of Object.values(child)) {
				tasks.push(...collectTaskObjects(nested));
			}
		}
	}
	if (tasks.length === 0) {
		for (const child of Object.values(value)) {
			if (isRecord(child)) {
				tasks.push(...collectTaskObjects(child));
			}
		}
	}
	return tasks;
}

function scheduleSource(path: string): DshScheduleSource["source"] {
	if (/(?:^|\/)napcat\//i.test(path)) {
		return "napcat";
	}
	if (/(?:^|\/)storages\//i.test(path)) {
		return "dsh-host";
	}
	return "unknown";
}

async function readSchedules(files: readonly BaselineFile[]): Promise<DshScheduleInventory> {
	const sources: DshScheduleSource[] = [];
	for (const file of findFiles(files, /(?:^|\/)schedule\.json$/i)) {
		const record = await readJsonFile(file);
		const tasks = collectTaskObjects(record);
		const timingFields = TIMING_FIELDS.filter((field) => tasks.some((task) => field in task));
		sources.push({
			source: scheduleSource(file.path),
			taskCount: tasks.length,
			statusClasses: sorted(
				tasks.flatMap((task) => (typeof task.status === "string" ? [task.status] : [])),
			),
			timingFields,
		});
	}
	const sortedSources = sources.toSorted((left, right) => left.source.localeCompare(right.source));
	return {
		taskCount: sortedSources.reduce((total, source) => total + source.taskCount, 0),
		statusClasses: sorted(sortedSources.flatMap((source) => source.statusClasses)),
		timingFields: sorted(sortedSources.flatMap((source) => source.timingFields)),
		sources: sortedSources,
	};
}

async function readSessionContent(file: BaselineFile): Promise<string> {
	if (file.path.toLowerCase().endsWith(".zstd")) {
		const compressed = await fs.readFile(file.absolutePath);
		return new TextDecoder().decode(Bun.zstdDecompressSync(compressed));
	}
	return await fs.readFile(file.absolutePath, "utf8");
}

async function readSessions(files: readonly BaselineFile[]): Promise<DshSessionInventory> {
	const auditFile = findFile(files, /(?:^|\/)audit\/sessions\.json$/i);
	if (auditFile) {
		const audit = await readJsonObject(auditFile);
		const auditKeys = [
			"fileCount",
			"compressedFileCount",
			"workspaceCount",
			"sessionRecordCount",
			"recordTypes",
			"sessionFields",
			"eventFields",
			"eventTypes",
		];
		if (auditKeys.some((key) => key in audit)) {
			return {
				fileCount: numberOrZero(audit.fileCount),
				compressedFileCount: numberOrZero(audit.compressedFileCount),
				workspaceCount: numberOrZero(audit.workspaceCount),
				sessionRecordCount: numberOrZero(audit.sessionRecordCount),
				recordTypes: sorted(stringArray(audit.recordTypes)),
				sessionFields: sorted(stringArray(audit.sessionFields)),
				eventFields: sorted(stringArray(audit.eventFields)),
				eventTypes: sorted(stringArray(audit.eventTypes)),
			};
		}
	}
	const sessionFiles = findFiles(
		files,
		/(?:^|\/)sessions\/[^/]+\/[^/]+\/session\.v4\.jsonl(?:\.zstd)?$/i,
	);
	const recordTypes = new Set<string>();
	const sessionFields = new Set<string>();
	const eventFields = new Set<string>();
	const eventTypes = new Set<string>();
	const workspaces = new Set<string>();
	let sessionRecordCount = 0;
	let compressedFileCount = 0;
	for (const file of sessionFiles) {
		if (file.path.toLowerCase().endsWith(".zstd")) {
			compressedFileCount += 1;
		}
		const workspace = /(?:^|\/)sessions\/([^/]+)\//.exec(file.path)?.[1];
		if (workspace) {
			workspaces.add(workspace);
		}
		const content = await readSessionContent(file);
		for (const line of content.split("\n")) {
			if (line.trim() === "") {
				continue;
			}
			let record: unknown;
			try {
				record = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			if (!isRecord(record) || typeof record.type !== "string") {
				continue;
			}
			recordTypes.add(record.type);
			if (record.type === "session") {
				sessionRecordCount += 1;
				for (const key of Object.keys(record)) {
					sessionFields.add(key);
				}
			} else {
				eventTypes.add(record.type);
				for (const key of Object.keys(record)) {
					eventFields.add(key);
				}
			}
		}
	}
	return {
		fileCount: sessionFiles.length,
		compressedFileCount,
		workspaceCount: workspaces.size,
		sessionRecordCount,
		recordTypes: sorted(recordTypes),
		sessionFields: sorted(sessionFields),
		eventFields: sorted(eventFields),
		eventTypes: sorted(eventTypes),
	};
}

async function readLedgers(files: readonly BaselineFile[]): Promise<DshLedgerInventory> {
	const friendRequestsFile = findFile(files, /(?:^|\/)friend-requests\.jsonl$/i);
	const friendRequests = friendRequestsFile ? await readJsonlRecords(friendRequestsFile) : [];
	const qaLedgerFile = findFile(files, /(?:^|\/)qa-ledger\.jsonl$/i);
	const qaLedger = qaLedgerFile ? await readJsonlRecords(qaLedgerFile) : [];
	const adminAuditFile = findFile(files, /(?:^|\/)admin-audit\.jsonl$/i);
	const adminAudit = adminAuditFile ? await readJsonlRecords(adminAuditFile) : [];
	const humanProfilesFile = findFile(files, /(?:^|\/)human-profiles\.json$/i);
	const humanProfilesRecord = humanProfilesFile ? await readJsonObject(humanProfilesFile) : {};
	const profiles = isRecord(humanProfilesRecord.profiles)
		? Object.values(humanProfilesRecord.profiles).filter(
				(profile): profile is Record<string, unknown> => isRecord(profile),
			)
		: [];
	return {
		friendRequests: {
			count: friendRequests.length,
			fields: recordFields(friendRequests),
		},
		humanProfiles: {
			profileCount: profiles.length,
			fields: sorted(Object.keys(humanProfilesRecord)),
			profileFields: recordFields(profiles),
		},
		qaLedger: {
			count: qaLedger.length,
			fields: recordFields(qaLedger),
		},
		adminAudit: {
			count: adminAudit.length,
			fields: recordFields(adminAudit),
		},
	};
}

export async function extractDshBaseline(
	source: SnapshotSource,
	options: ExtractDshBaselineOptions = {},
): Promise<DshBaseline> {
	const files = await loadBaselineFiles(source);
	const cordisRoots = await readCordisFiles(files);
	const profile = await readProfile(files);
	const inventory: DshBaselineInventory = {
		versions: await readVersions(files),
		profile,
		plugins: readPlugins(cordisRoots),
		configuration: readConfiguration(cordisRoots),
		tools: await readTools(files),
		memory: await readMemory(files, profile),
		memePacks: await readMemePacks(files),
		schedules: await readSchedules(files),
		sessions: await readSessions(files),
		ledgers: await readLedgers(files),
	};
	return {
		sourceSystem: DSH_SOURCE,
		target: resolveDshBaselineTarget(options.target),
		inventory,
	};
}
