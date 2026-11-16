import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { isCredentialLikeKey } from "./dsh-baseline.ts";
import { redactSecrets } from "./secrets.ts";
import { DSH_SOURCE, inspectDshSnapshot, type SnapshotSource } from "./dsh-inspect.ts";
import { sha256Bytes, sha256String, stableStringify } from "./fs.ts";
import { listFiles, resolveSnapshotRoot } from "./fs.ts";
import { readZip } from "./zip.ts";
import {
	mergeDecisionReports,
	type DecisionEntry,
	type DecisionReport,
	summarizeDecisions,
} from "./decision.ts";
import { mapDshConfigText, type ConfigMappingResult } from "./config-map.ts";
import { importDshMemory, type ImportedSchedulerState } from "./memory-import.ts";
import { parseDshMemePacks, type ImportedMemeItem, type ImportedMemePack } from "./meme-import.ts";
import {
	importDshSchedulesAndRequests,
	type ImportedRequest,
	type ImportedScheduledTask,
} from "./schedule-request-import.ts";
import {
	type DshV4Message,
	type DshV4Session,
	mapDshConversationIdentity,
	parseSessionV4Bytes,
	parseSessionV4Text,
	type SessionParseError,
} from "./session-v4.ts";

export type TsukaimaConversationKind = "private" | "group" | "webui" | "task" | "plugin";
export type TsukaimaDirection = "inbound" | "outbound" | "system";

export const DSH_IMPORT_ORDER = [
	"users",
	"chatObjects",
	"conversations",
	"media",
	"messages",
	"requests",
	"personas",
	"memories",
	"settings",
	"tasks",
	"schedulerStates",
] as const;

export interface DshSession {
	readonly id?: string;
	readonly title?: string;
	readonly type?: string;
	readonly workspace?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly messages?: readonly DshSessionEntry[];
	readonly branches?: readonly unknown[];
	readonly compactions?: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface DshSessionEntry {
	readonly id?: string;
	readonly role?: string;
	readonly content?: unknown;
	readonly timestamp?: string | number;
	readonly attachments?: readonly string[];
	readonly replyTo?: string;
	readonly [key: string]: unknown;
}

export interface NormalizedAttachment {
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly kind: "image" | "sticker" | "audio" | "video" | "file";
	readonly mimeType: string;
	readonly sha256: string | null;
	readonly sizeBytes: number;
	readonly sourcePath: string | null;
	readonly fileHash?: string | null;
	readonly mediaSourcePath?: string | null;
	readonly mediaRelativePath?: string | null;
}

export interface NormalizedMessage {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly conversationId: string;
	readonly chatObjectId?: string;
	readonly platformMessageId: string;
	readonly direction: TsukaimaDirection;
	readonly kind: string;
	readonly occurredAt: string;
	readonly ingestedAt: string;
	readonly senderUserId: string;
	readonly senderDisplayName?: string;
	readonly senderExternalId?: string | null;
	readonly content: string;
	readonly attachments: readonly string[];
	readonly durableEntryId: string;
	readonly replyToMessageId?: string | null;
	readonly position: number;
}

export interface NormalizedConversation {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly chatObjectId?: string;
	readonly durableConversationId: string;
	readonly kind: TsukaimaConversationKind;
	readonly channelId: string;
	readonly platformConversationId: string;
	readonly title: string;
	readonly status: "active" | "archived";
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly memberUserIds: readonly string[];
}

export interface NormalizedChatObject {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly kind: TsukaimaConversationKind;
	readonly channelId: string;
	readonly platformConversationId: string;
	readonly title: string;
	readonly status: "active" | "archived";
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface NormalizedUser {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly displayName: string;
	readonly kind: "human" | "bot" | "system";
	readonly isAdmin: boolean;
	readonly externalId?: string | null;
	readonly platform?: string | null;
}

export interface NormalizedIdentity {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly canonicalUserId: string;
	readonly kind: "user" | "group" | "system";
	readonly platform: string;
	readonly platformAccountId: string;
	readonly externalId: string;
	readonly displayName: string;
}

export interface NormalizedUserAlias {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly userId: string;
	readonly alias: string;
	readonly source: string;
	readonly confidence: number;
}

export interface NormalizedPersona {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly version: number;
	readonly name: string;
	readonly summary: string;
	readonly promptJson: string;
	readonly behaviorJson: string;
	readonly boundConversationIds: readonly string[];
}

export interface NormalizedMemory {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly scope: "global" | "conversation";
	readonly content: string;
	readonly summary: string;
	readonly kind: string;
	readonly confidence: number;
	readonly importance: number;
	readonly conversationId: string;
	readonly subjectUserId?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly createdBy: "migration";
	readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface NormalizedSetting {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly category: string;
	readonly target: string;
	readonly valueJson: string;
	readonly secretsDetected: readonly string[];
	readonly requiresManualDecision: boolean;
}

export interface NormalizedSticker {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly kind: "sticker";
	readonly packId?: string;
	readonly description?: string;
	readonly keywords?: readonly string[];
	readonly emotions?: readonly string[];
	readonly tags?: readonly string[];
	readonly fileHash?: string | null;
	readonly mediaId?: string;
	readonly mediaSourcePath?: string | null;
	readonly mediaRelativePath?: string | null;
	readonly enabled?: boolean;
	readonly reviewStatus?: "approved" | "pending" | "rejected";
}

export interface NormalizedStickerPack {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly name: string;
	readonly version: string | null;
	readonly tags: readonly string[];
	readonly enabled: false;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface NormalizedTask {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly taskId: string;
	readonly conversationId: string;
	readonly chatObjectId: string | null;
	readonly kind: "remind" | "nudge" | "proactive" | "workflow";
	readonly prompt: string;
	readonly scheduledForMs: number;
	readonly dueWindowMs: number | null;
	readonly repeatIntervalMs: number | null;
	readonly cancelIfReplied: boolean;
	readonly maxAttempts: number;
	readonly attempts: number;
	readonly occurrences: number;
	readonly status: "scheduled" | "running" | "completed" | "cancelled" | "failed" | "skipped";
	readonly lastError: string | null;
	readonly createdByKind: "user" | "agent" | "admin";
	readonly createdById: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface NormalizedRequest {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly id: string;
	readonly accountId: string;
	readonly channelId: string;
	readonly kind: "friend" | "group-add" | "group-invite";
	readonly flag: string;
	readonly subType: string | null;
	readonly requesterExternalId: string;
	readonly requesterDisplayName: string | null;
	readonly groupExternalId: string | null;
	readonly comment: string | null;
	readonly status: "pending" | "approved" | "rejected" | "failed" | "uncertain";
	readonly resolutionAction: "approve" | "reject" | null;
	readonly resolutionReason: string | null;
	readonly resolvedAt: string | null;
	readonly errorMessage: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly raw: Readonly<Record<string, unknown>>;
}

export interface NormalizedSchedulerState {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly conversationId: string;
	readonly lastMessageAtMs: number | null;
	readonly lastInboundAtMs: number | null;
	readonly lastOutboundAtMs: number | null;
	readonly inboundCount: number;
	readonly unansweredStreak: number;
	readonly refusedCount: number;
	readonly silenceUntilMs: number | null;
	readonly activeHoursHistogram: Readonly<Record<string, number>>;
	readonly warmness: number;
	readonly openers: readonly string[];
	readonly dailyCountDate: string | null;
	readonly dailyCount: number;
	readonly hourlyWindowMs: number | null;
	readonly hourlyCount: number;
	readonly updatedAtMs: number;
}

export type NormalizedDatabase = {
	readonly users: readonly NormalizedUser[];
	readonly identities: readonly NormalizedIdentity[];
	readonly userAliases: readonly NormalizedUserAlias[];
	readonly chatObjects: readonly NormalizedChatObject[];
	readonly conversations: readonly NormalizedConversation[];
	readonly messages: readonly NormalizedMessage[];
	readonly attachments: readonly NormalizedAttachment[];
	readonly requests: readonly NormalizedRequest[];
	readonly personas: readonly NormalizedPersona[];
	readonly memories: readonly NormalizedMemory[];
	readonly settings: readonly NormalizedSetting[];
	readonly stickers: readonly NormalizedSticker[];
	readonly stickerPacks: readonly NormalizedStickerPack[];
	readonly tasks: readonly NormalizedTask[];
	readonly schedulerStates: readonly NormalizedSchedulerState[];
};

export type RecordCounts = Record<keyof NormalizedDatabase, number>;

export interface MigrationDiagnostics {
	readonly errors: readonly SessionParseError[];
	readonly malformedRecords: number;
	readonly unsupportedVersions: number;
	readonly skippedExpiredTasks: number;
	readonly mediaMissing: number;
	readonly mediaExtra: number;
	readonly secretPaths: readonly string[];
	readonly warnings: readonly string[];
}

export interface MigrationPlan extends RecordCounts {
	readonly warnings: readonly string[];
	readonly estimatedBytes: number;
	readonly sourceCounts: RecordCounts;
	readonly decisions: DecisionReport;
	readonly diagnostics: MigrationDiagnostics;
	readonly importOrder: readonly string[];
	readonly rollbackIds: readonly string[];
}

export interface NormalizeResult {
	readonly database: NormalizedDatabase;
	readonly plan: MigrationPlan;
	readonly warnings: readonly string[];
	readonly decisions: DecisionReport;
	readonly diagnostics: MigrationDiagnostics;
	readonly config: readonly ConfigMappingResult[];
}

const defaultTime = new Date(0).toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function timestamp(value: string | number | undefined, fallback: string): string {
	if (typeof value === "number") {
		return new Date(value < 1e12 ? value * 1000 : value).toISOString();
	}
	if (typeof value === "string" && value) {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString();
		}
	}
	return fallback;
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map(contentText).join("\n");
	}
	if (content && typeof content === "object") {
		const object = content as Record<string, unknown>;
		if (typeof object.text === "string") {
			return object.text;
		}
		return stableStringify(content);
	}
	return "";
}

function mapRole(role: string | undefined): { direction: TsukaimaDirection; kind: string } {
	switch (role?.toLowerCase()) {
		case "assistant":
			return { direction: "outbound", kind: "assistant" };
		case "tool":
			return { direction: "outbound", kind: "tool" };
		case "system":
			return { direction: "system", kind: "system" };
		case "user":
			return { direction: "inbound", kind: "user" };
		default:
			return { direction: "system", kind: role ?? "unknown" };
	}
}

export function canonicalId(kind: string, sourceId: string): string {
	return `dsh_${kind}_${sourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function collectSecretPaths(value: unknown, path = "$"): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => collectSecretPaths(item, `${path}.${index}`));
	}
	if (!value || typeof value !== "object") {
		return [];
	}
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
		const childPath = `${path}.${key}`;
		if (typeof child === "string" && isCredentialLikeKey(key)) {
			return [childPath];
		}
		return collectSecretPaths(child, childPath);
	});
}

function settingsRecords(sourceId: string, category: string, value: unknown): NormalizedSetting[] {
	const secretsDetected = collectSecretPaths(value);
	return [
		{
			sourceSystem: DSH_SOURCE,
			sourceId,
			sourceHash: sha256String(stableStringify(value)),
			canonicalId: canonicalId("setting", sourceId),
			category,
			target: category,
			valueJson: JSON.stringify(redactSecrets(value, { includeHostSpecific: true }).value),
			secretsDetected,
			requiresManualDecision: secretsDetected.length > 0 || category === "unknown",
		},
	];
}

interface SourceEntry {
	readonly path: string;
	readonly absolutePath: string;
}

async function sourceEntries(source: SnapshotSource): Promise<SourceEntry[]> {
	const entries: SourceEntry[] = [];
	for (const [root, label] of source) {
		const stats = await fs.stat(root);
		if (stats.isDirectory()) {
			const dataRoot = await resolveSnapshotRoot(root);
			for (const file of await listFiles(dataRoot)) {
				entries.push({
					absolutePath: file,
					path: `${label}/${relative(dataRoot, file).replaceAll("\\", "/")}`,
				});
			}
		} else if (stats.isFile()) {
			entries.push({ absolutePath: root, path: label });
		}
	}
	return entries;
}

async function readTextSource(source: SnapshotSource, path: string): Promise<string> {
	const [root] = path.split("/", 1);
	const entryName = path.slice(root!.length + 1);
	const sourcePath = source.find(([, label]) => label === root)?.[0];
	if (!sourcePath) {
		return "";
	}
	const localPath = join(await resolveSnapshotRoot(sourcePath), entryName);
	if (sourcePath.toLowerCase().endsWith(".zip")) {
		const files = Object.entries(await readZip(sourcePath));
		return files.find(([name]) => name === entryName)?.[1] ?? "";
	}
	return await fs.readFile(localPath, "utf8");
}

function parseLegacySessions(content: string): DshSession[] {
	const records = content
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				return parsed && typeof parsed === "object" ? [parsed as DshSession] : [];
			} catch {
				return [];
			}
		});
	if (records.length > 0) return records;
	try {
		const parsed = JSON.parse(content) as unknown;
		if (Array.isArray(parsed)) return parsed as DshSession[];
		if (parsed && typeof parsed === "object") return [parsed as DshSession];
	} catch {
		return [];
	}
	return [];
}

function legacyUser(role: string, entry: DshSessionEntry, bot: NormalizedUser): NormalizedUser {
	const roleLower = role.toLowerCase();
	const external =
		typeof entry.userId === "string"
			? entry.userId
			: typeof entry.senderId === "string"
				? entry.senderId
				: null;
	if (roleLower === "assistant" || roleLower === "tool") return bot;
	const sourceId = external ? `user:${external}` : `user:${roleLower}`;
	return {
		canonicalId: canonicalId("user", sourceId),
		displayName:
			typeof entry.senderName === "string"
				? entry.senderName
				: roleLower === "system"
					? "System"
					: (external ?? roleLower),
		externalId: external,
		isAdmin: false,
		kind: roleLower === "system" ? "system" : "human",
		platform: external ? "onebot-v11" : null,
		sourceHash: sha256String(sourceId),
		sourceId,
		sourceSystem: DSH_SOURCE,
	};
}

function normalizeLegacySession(
	session: DshSession,
	sourceId: string,
): {
	user: NormalizedUser;
	conversation: NormalizedConversation;
	messages: NormalizedMessage[];
} {
	const id = session.id ?? sourceId;
	const createdAt = timestamp(session.createdAt, defaultTime);
	const updatedAt = timestamp(session.updatedAt, createdAt);
	const identity = mapDshConversationIdentity({
		sessionId: id,
		title: session.title ?? null,
		type: session.type ?? null,
		workspace: session.workspace ?? null,
	});
	const conversationId = canonicalId("conversation", id);
	const chatObjectId = canonicalId("chat", id);
	const botId = canonicalId("user", "dsh-assistant");
	const bot: NormalizedUser = {
		sourceSystem: DSH_SOURCE,
		sourceId: "assistant",
		sourceHash: sha256String("assistant"),
		canonicalId: botId,
		displayName: "DSH Assistant",
		kind: "bot",
		isAdmin: false,
		platform: null,
		externalId: null,
	};
	const conversation: NormalizedConversation = {
		sourceSystem: DSH_SOURCE,
		sourceId: id,
		sourceHash: sha256String(stableStringify(session)),
		canonicalId: conversationId,
		chatObjectId,
		durableConversationId: `durable_${conversationId}`,
		kind: identity.kind,
		channelId: identity.channelId,
		platformConversationId: identity.platformConversationId,
		title: session.title ?? identity.title,
		status: identity.isTest ? "archived" : "active",
		createdAt,
		updatedAt,
		memberUserIds: [botId],
	};
	const messages: NormalizedMessage[] = [];
	const members = new Set<string>([botId]);
	const platformIds = new Map<string, string>();
	(session.messages ?? []).forEach((entry, index) => {
		const role = entry.role?.toLowerCase() ?? "system";
		const sender = legacyUser(role, entry, bot);
		members.add(sender.canonicalId);
		const platformMessageId = entry.id ?? `${sourceId}:${index}`;
		platformIds.set(platformMessageId, platformMessageId);
		messages.push({
			attachments: entry.attachments ?? [],
			chatObjectId,
			content: contentText(entry.content),
			conversationId,
			direction: mapRole(role).direction,
			durableEntryId: `durable_${conversationId}:${platformMessageId}`,
			ingestedAt: new Date().toISOString(),
			kind: mapRole(role).kind,
			occurredAt: timestamp(entry.timestamp, createdAt),
			platformMessageId,
			position: index,
			replyToMessageId: entry.replyTo ?? null,
			senderDisplayName: sender.displayName,
			senderExternalId: sender.externalId ?? null,
			senderUserId: sender.canonicalId,
			sourceHash: sha256String(stableStringify(entry)),
			sourceId: `${conversationId}:${platformMessageId}`,
			sourceSystem: DSH_SOURCE,
		});
	});
	return {
		conversation: { ...conversation, memberUserIds: [...members] },
		messages,
		user: bot,
	};
}

function attachmentKind(mimeType: string): NormalizedAttachment["kind"] {
	if (/^image\/gif|webp|png|jpe?g/i.test(mimeType)) return "image";
	if (/^audio/i.test(mimeType)) return "audio";
	if (/^video/i.test(mimeType)) return "video";
	return "file";
}

function sourceKindOf(message: DshV4Message): string | null {
	const source = message.source.data.source;
	if (source && typeof source === "object" && !Array.isArray(source)) {
		const kind = (source as Record<string, unknown>).kind;
		if (typeof kind === "string") return kind;
	}
	return null;
}

function externalIdOf(message: DshV4Message): string | null {
	const external =
		typeof message.source.data.userId === "string"
			? message.source.data.userId
			: typeof message.source.data.senderId === "string"
				? message.source.data.senderId
				: null;
	return external;
}

interface QqPromptLine {
	readonly minute: number;
	readonly nick: string;
	readonly text: string;
}

/**
 * The NapCat bridge injects a fresh prompt every turn: recent QQ chat lines followed by
 * static instructions. Only the `【最近群聊】` block is real chat history.
 */
export function parseQqPromptLines(text: string): QqPromptLine[] {
	const marker = /【最近群聊[^】]*】\s*\n/.exec(text);
	if (marker === null) return [];
	const start = marker.index + marker[0].length;
	const rest = text.slice(start);
	// A message may contain blank lines; only a blank line followed by the next `【…】`
	// instruction section ends the chat block.
	const end = rest.search(/\n\s*\n【/);
	const block = end === -1 ? rest : rest.slice(0, end);
	const lines: QqPromptLine[] = [];
	let current: { minute: number; nick: string; text: string } | null = null;
	for (const raw of block.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") {
			if (current !== null) current.text = `${current.text}\n`;
			continue;
		}
		const match = /^(\d{2}):(\d{2})\s+([^:]+):\s?(.*)$/.exec(line);
		if (match !== null) {
			if (current !== null) lines.push(current);
			current = {
				minute: Number(match[1]) * 60 + Number(match[2]),
				nick: match[3]!.trim(),
				text: match[4] ?? "",
			};
		} else if (current !== null) {
			current.text = `${current.text}\n${line}`;
		}
	}
	if (current !== null) lines.push({ ...current, text: current.text.replace(/\n+$/, "") });
	return lines;
}

/** DSH writes prompt clock times in the container's UTC clock. */
function qqMinuteIso(promptMs: number | null, minute: number): string {
	const base = new Date(promptMs ?? Date.now());
	const day = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
	const candidate = day + minute * 60_000;
	const promptMinute = base.getUTCHours() * 60 + base.getUTCMinutes();
	return new Date(minute > promptMinute + 5 ? candidate - 86_400_000 : candidate).toISOString();
}

function splitQqNick(nick: string): { readonly name: string; readonly id: string | null } {
	const match = /^(.*?)\s*\((\d{4,})\)$/.exec(nick.trim());
	if (match !== null) return { id: match[2]!, name: match[1]!.trim() };
	return { id: null, name: nick.trim() };
}

function mimeTypeForPath(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase();
	if (extension === "png") return "image/png";
	if (extension === "gif") return "image/gif";
	if (extension === "webp") return "image/webp";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	return "application/octet-stream";
}

function inlineImagePaths(text: string): string[] {
	return [...text.matchAll(/\[图片[:：]\s*([^\]\n]+)\]/g)]
		.map((match) => match[1]!.trim())
		.filter((path) => path !== "" && path !== "已过期");
}

function stripInlineImagePaths(text: string): string {
	return text.replace(/\[图片[:：]\s*([^\]\n]+)\]/g, "[图片]");
}

async function loadQqPeople(
	entries: readonly SourceEntry[],
): Promise<Map<string, Map<string, string>>> {
	const people = new Map<string, Map<string, string>>();
	for (const entry of entries) {
		if (!/(?:people-index|cross-recent)\.jsonl$/i.test(entry.path)) continue;
		const content = await fs.readFile(entry.absolutePath, "utf8").catch(() => "");
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				const chatKey = record.chatKey;
				const nick = record.nick;
				const userId = record.userId;
				if (typeof chatKey !== "string" || typeof nick !== "string") continue;
				if (typeof userId !== "string" && typeof userId !== "number") continue;
				const chat = people.get(chatKey) ?? new Map<string, string>();
				chat.set(nick, String(userId));
				people.set(chatKey, chat);
			} catch {
				// Malformed history rows are skipped; provenance stays in the snapshot.
			}
		}
	}
	return people;
}

async function loadBotAliases(entries: readonly SourceEntry[]): Promise<Set<string>> {
	const aliases = new Set<string>(["系统", "临时会话"]);
	for (const entry of entries) {
		if (!/(?:^|\/)home\/(?:node\/)?\.dsh\/profiles\/[^/]+\/cordis\.patch\.ya?ml$/i.test(entry.path))
			continue;
		const content = await fs.readFile(entry.absolutePath, "utf8").catch(() => "");
		for (const match of content.matchAll(/selfAliases:\s*["']?([^"'\n]+)["']?/g)) {
			for (const alias of match[1]!.split(",")) {
				const trimmed = alias.trim();
				if (trimmed !== "") aliases.add(trimmed);
			}
		}
	}
	return aliases;
}

async function loadBotSelfIds(entries: readonly SourceEntry[]): Promise<Set<string>> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!/(?:^|\/)home\/(?:node\/)?\.dsh\/profiles\/[^/]+\/cordis\.patch\.ya?ml$/i.test(entry.path))
			continue;
		const content = await fs.readFile(entry.absolutePath, "utf8").catch(() => "");
		for (const match of content.matchAll(/\bbotQQ:\s*["']?(\d{5,})["']?/g)) {
			ids.add(match[1]!);
		}
	}
	return ids;
}

function findMediaEntry(
	entries: readonly SourceEntry[],
	path: string,
	chatDirectory: string,
): SourceEntry | null {
	const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
	const candidates = normalized.startsWith("workspace/")
		? [normalized]
		: [
				`workspace/napcat/${chatDirectory}/${normalized}`,
				`workspace/napcat/${normalized}`,
				`workspace/${normalized}`,
				normalized,
			];
	for (const candidate of candidates) {
		const match = entries.find((entry) => entry.path.endsWith(`/${candidate}`));
		if (match !== undefined) return match;
	}
	return null;
}

/**
 * OneBot history gives only the image file name (the local cache prefixes it with a
 * download id), while the memory store gives a path. Try the path first, then the
 * cached file name inside the chat inbox.
 */
function findCachedMediaEntry(
	entries: readonly SourceEntry[],
	reference: string,
	chatDirectory: string,
): SourceEntry | null {
	const normalized = reference.replaceAll("\\", "/");
	const file = normalized.split("/").at(-1) ?? normalized;
	if (file === "") return null;
	const matchesName = (entry: SourceEntry): boolean => {
		const name = basename(entry.path);
		return name === file || name.endsWith(`-${file}`);
	};
	return (
		entries.find(
			(entry) => entry.path.includes(`/napcat/${chatDirectory}/`) && matchesName(entry),
		) ??
		entries.find((entry) => /\/napcat-inbox\//i.test(entry.path) && matchesName(entry)) ??
		null
	);
}

interface QqHistoryRecord {
	readonly chatKey: string;
	readonly kind: "group" | "private";
	readonly platformId: string;
	readonly timestamp: number;
	readonly messageId: string | null;
	readonly own: boolean;
	readonly senderName: string;
	readonly senderExternalId: string | null;
	readonly text: string;
	readonly mediaRefs: readonly string[];
	readonly mediaLookup: "path" | "basename";
	readonly replyToMessageId: string | null;
	readonly raw: unknown;
}

function qqChatFromPath(
	path: string,
): { chatKey: string; kind: "group" | "private"; platformId: string } | null {
	const match = /(?:^|\/)(group|private)[-_](\d+)(?:\/|\.|-recent|-archive)/i.exec(path);
	if (match === null) return null;
	const kind = match[1]!.toLowerCase() === "private" ? "private" : "group";
	const platformId = match[2]!;
	return { chatKey: `${kind}:${platformId}`, kind, platformId };
}

function segmentsToHistory(segments: readonly unknown[]): {
	text: string;
	mediaRefs: string[];
	replyToMessageId: string | null;
} {
	let text = "";
	const mediaRefs: string[] = [];
	let replyToMessageId: string | null = null;
	for (const raw of segments) {
		if (!isRecord(raw)) continue;
		const type = typeof raw.type === "string" ? raw.type : "";
		const data = isRecord(raw.data) ? raw.data : {};
		if (type === "text") {
			text += typeof data.text === "string" ? data.text : "";
		} else if (type === "at") {
			text += `@${String(data.qq ?? "")}`;
		} else if (type === "image") {
			text += "[图片]";
			const file =
				typeof data.file === "string"
					? data.file
					: typeof data.path === "string"
						? data.path
						: null;
			if (file !== null) mediaRefs.push(file);
		} else if (type === "face") {
			text += "[表情]";
		} else if (type === "reply") {
			replyToMessageId = typeof data.id === "string" ? data.id : null;
		} else if (type === "json") {
			text += "[卡片]";
		} else if (type === "forward") {
			text += "[合并转发]";
		} else if (type === "file") {
			const name = typeof data.file === "string" ? data.file : "";
			text += name === "" ? "[文件]" : `[文件:${name}]`;
		} else if (type !== "") {
			text += `[${type}]`;
		}
	}
	return { mediaRefs, replyToMessageId, text };
}

function parseToolArgs(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Recover actual sent QQ messages from control-session tool calls and their results. */
function sentMessageRecords(
	session: DshV4Session,
	botSelfIds: ReadonlySet<string>,
): QqHistoryRecord[] {
	const results = new Map<number, string>();
	for (const message of session.messages) {
		if (message.role !== "tool" || message.toolName !== null) continue;
		for (const reference of message.references) {
			if (reference.targetSeq !== null) results.set(reference.targetSeq, message.text);
		}
	}
	const records: QqHistoryRecord[] = [];
	for (const message of session.messages) {
		if (message.role !== "tool" || message.toolName === null) continue;
		const tool = message.toolName;
		if (
			!/^napcat_send_(?:message|private_msg|group_msg|image)$/i.test(tool) &&
			tool !== "napcat_api"
		) {
			continue;
		}
		const rawArgs =
			message.source.data.arguments ?? message.source.data.input ?? message.source.data.params;
		const args = isRecord(rawArgs) ? rawArgs : parseToolArgs(message.text);
		if (args === null) continue;
		const result = message.seq === null ? "" : (results.get(message.seq) ?? "");
		if (result === "" || result.startsWith("Error:") || !/message_id:/i.test(result)) continue;
		const messageIds = (/message_id:\s*([\d,\s]+)/i.exec(result)?.[1] ?? "")
			.split(/[,\s]+/)
			.filter((id) => id !== "");
		const segmentCount = Number(/已发送\s*(\d+)\s*段/.exec(result)?.[1] ?? "0");
		let chatKey: string | null = null;
		if (typeof args.chat_id === "string") {
			const match = /^(group|private)[:_](\d+)$/i.exec(args.chat_id);
			if (match !== null) {
				chatKey = `${match[1]!.toLowerCase()}:${match[2]!}`;
			}
		}
		if (chatKey === null && tool.toLowerCase().endsWith("group_msg")) {
			if (typeof args.group_id === "string" || typeof args.group_id === "number") {
				chatKey = `group:${String(args.group_id)}`;
			}
		}
		if (chatKey === null && tool.toLowerCase().endsWith("private_msg")) {
			if (typeof args.user_id === "string" || typeof args.user_id === "number") {
				chatKey = `private:${String(args.user_id)}`;
			}
		}
		if (chatKey === null) continue;
		const parsedChat = /^(group|private):(\d+)$/.exec(chatKey);
		if (parsedChat === null) continue;
		const kind = parsedChat[1]!.toLowerCase() === "private" ? "private" : "group";
		const platformId = parsedChat[2]!;
		if (kind === "private" && botSelfIds.has(platformId)) continue;
		const atMs = message.occurredAtMs ?? Date.parse(session.createdAt ?? "");
		if (!Number.isFinite(atMs)) continue;
		const mediaRefs: string[] = [];
		let text = "";
		if (tool.toLowerCase() === "napcat_send_image") {
			text = "[图片]";
			if (typeof args.source === "string") mediaRefs.push(args.source);
		} else if (typeof args.text === "string") {
			text = args.text;
		} else if (typeof args.message === "string") {
			text = args.message;
		} else if (Array.isArray(args.message)) {
			text = segmentsToHistory(args.message).text;
		}
		if (text.trim() === "" && mediaRefs.length === 0) continue;
		const lines = text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "");
		const split =
			tool.toLowerCase() !== "napcat_send_image" &&
			lines.length > 1 &&
			(segmentCount > 1 || messageIds.length > 1);
		const parts = split ? lines : [text.trim() === "" ? "[图片]" : text];
		for (const [index, part] of parts.entries()) {
			records.push({
				chatKey,
				kind,
				mediaLookup: "path",
				mediaRefs: index === 0 ? mediaRefs : [],
				messageId: messageIds[index] ?? (parts.length === 1 ? (messageIds[0] ?? null) : null),
				own: true,
				platformId,
				raw: {
					args,
					messageId: messageIds[index] ?? null,
					result,
					segment: index,
					session: session.id,
				},
				replyToMessageId: null,
				senderExternalId: null,
				senderName: "DSH Assistant",
				text: part,
				timestamp: atMs + index,
			});
		}
	}
	return records;
}

async function loadQqHistory(
	source: SnapshotSource,
	entries: readonly SourceEntry[],
): Promise<QqHistoryRecord[]> {
	const records: QqHistoryRecord[] = [];
	for (const entry of entries) {
		const path = entry.path.replaceAll("\\", "/");
		if (!path.includes("/workspace/") || /\/node_modules\//i.test(path)) continue;
		if (
			path.endsWith("/recent.jsonl") ||
			path.endsWith(".recent.jsonl") ||
			path.endsWith("archive-pending.jsonl")
		) {
			const chat = qqChatFromPath(path);
			if (chat === null) continue;
			const content = await readTextSource(source, entry.path).catch(() => "");
			for (const line of content.split(/\r?\n/)) {
				if (line.trim() === "") continue;
				let row: Record<string, unknown>;
				try {
					const parsed = JSON.parse(line) as unknown;
					if (!isRecord(parsed)) continue;
					row = parsed;
				} catch {
					continue;
				}
				const atMs = typeof row.t === "number" ? row.t : null;
				if (atMs === null) continue;
				const rawText = typeof row.text === "string" ? row.text : "";
				const mediaRefs = inlineImagePaths(rawText);
				const text = stripInlineImagePaths(rawText).trim();
				if (text === "" && mediaRefs.length === 0) continue;
				const own = row.own === true;
				const uid =
					typeof row.uid === "string" || typeof row.uid === "number" ? String(row.uid) : null;
				records.push({
					chatKey: chat.chatKey,
					kind: chat.kind,
					mediaLookup: "path",
					mediaRefs,
					messageId: null,
					own,
					platformId: chat.platformId,
					raw: row,
					replyToMessageId: null,
					senderExternalId: own ? null : uid,
					senderName:
						typeof row.nick === "string" && row.nick !== "" ? row.nick : (uid ?? "Unknown"),
					text: text === "" ? "[图片]" : text,
					timestamp: atMs,
				});
			}
			continue;
		}
		if (path.endsWith("cross-recent.jsonl")) {
			const content = await readTextSource(source, entry.path).catch(() => "");
			for (const line of content.split(/\r?\n/)) {
				if (line.trim() === "") continue;
				let row: Record<string, unknown>;
				try {
					const parsed = JSON.parse(line) as unknown;
					if (!isRecord(parsed)) continue;
					row = parsed;
				} catch {
					continue;
				}
				const atMs = typeof row.at === "number" ? row.at : null;
				const rawText = typeof row.text === "string" ? row.text : "";
				if (atMs === null || rawText.trim() === "") continue;
				const chatMatch = /^(group|private):(\d+)$/i.exec(
					typeof row.chatKey === "string" ? row.chatKey : "",
				);
				if (chatMatch === null) continue;
				const kind = chatMatch[1]!.toLowerCase() === "private" ? "private" : "group";
				const platformId = chatMatch[2]!;
				const own = row.own === true;
				const uid =
					typeof row.userId === "string" || typeof row.userId === "number"
						? String(row.userId)
						: null;
				const mediaRefs = inlineImagePaths(rawText);
				const text = stripInlineImagePaths(rawText).trim();
				records.push({
					chatKey: `${kind}:${platformId}`,
					kind,
					mediaLookup: "path",
					mediaRefs,
					messageId: null,
					own,
					platformId,
					raw: row,
					replyToMessageId: null,
					senderExternalId: own ? null : uid,
					senderName:
						typeof row.nick === "string" && row.nick !== "" ? row.nick : (uid ?? "Unknown"),
					text: text === "" ? "[图片]" : text,
					timestamp: atMs,
				});
			}
			continue;
		}
		if (!/\/hist-[^/]+\.json$/i.test(path)) continue;
		const content = await readTextSource(source, entry.path).catch(() => "");
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.messages)) continue;
		const kind = parsed.kind === "private" ? "private" : "group";
		const platformId =
			typeof parsed.chatId === "string" || typeof parsed.chatId === "number"
				? String(parsed.chatId)
				: "";
		if (platformId === "") continue;
		const chatKey = `${kind}:${platformId}`;
		for (const rawMessage of parsed.messages) {
			if (!isRecord(rawMessage)) continue;
			const seconds = typeof rawMessage.time === "number" ? rawMessage.time : null;
			if (seconds === null) continue;
			const atMs = seconds < 1e12 ? seconds * 1000 : seconds;
			const userId =
				typeof rawMessage.user_id === "string" || typeof rawMessage.user_id === "number"
					? String(rawMessage.user_id)
					: null;
			const selfId =
				typeof rawMessage.self_id === "string" || typeof rawMessage.self_id === "number"
					? String(rawMessage.self_id)
					: null;
			const own =
				rawMessage.post_type === "message_sent" ||
				(userId !== null && selfId !== null && userId === selfId);
			const sender = isRecord(rawMessage.sender) ? rawMessage.sender : {};
			const senderName =
				(typeof sender.card === "string" && sender.card !== "" ? sender.card : null) ??
				(typeof sender.nickname === "string" && sender.nickname !== "" ? sender.nickname : null) ??
				userId ??
				"Unknown";
			const segments = Array.isArray(rawMessage.message) ? rawMessage.message : [];
			const parsedSegments = segmentsToHistory(segments);
			const fallbackText =
				typeof rawMessage.raw_message === "string" && segments.length === 0
					? rawMessage.raw_message
					: "";
			const text = (parsedSegments.text || fallbackText).trim();
			if (text === "" && parsedSegments.mediaRefs.length === 0) continue;
			const messageId =
				typeof rawMessage.message_id === "string" || typeof rawMessage.message_id === "number"
					? String(rawMessage.message_id)
					: typeof rawMessage.message_seq === "string" || typeof rawMessage.message_seq === "number"
						? String(rawMessage.message_seq)
						: null;
			records.push({
				chatKey,
				kind,
				mediaLookup: "basename",
				mediaRefs: parsedSegments.mediaRefs,
				messageId,
				own,
				platformId,
				raw: rawMessage,
				replyToMessageId: parsedSegments.replyToMessageId,
				senderExternalId: own ? null : userId,
				senderName,
				text: text === "" ? "[图片]" : text,
				timestamp: atMs,
			});
		}
	}
	return records;
}

function normalizeV4Session(
	session: DshV4Session,
	options: {
		readonly chatObjectId?: string;
		readonly conversationId?: string;
		readonly qqChat?: boolean;
	} = {},
): {
	conversation: NormalizedConversation;
	messages: NormalizedMessage[];
	users: NormalizedUser[];
	attachments: NormalizedAttachment[];
} {
	const identity = mapDshConversationIdentity({
		sessionId: session.id,
		title: session.title,
		workspace: session.workspace,
	});
	const createdAt = timestamp(session.createdAt ?? undefined, defaultTime);
	const conversationId = options.conversationId ?? canonicalId("conversation", session.id);
	const chatObjectId =
		options.chatObjectId ??
		canonicalId(
			"chat",
			`${identity.channelId}:${identity.kind}:${identity.platformConversationId}`,
		);
	const isQqChatSession =
		session.agentPreset === "qq-chat" ||
		(session.agentPreset === null && /(?:^|\/)napcat\//.test(session.workspace ?? ""));
	const botId = canonicalId("user", "dsh-assistant");
	const bot: NormalizedUser = {
		canonicalId: botId,
		displayName: "DSH Assistant",
		externalId: null,
		isAdmin: false,
		kind: "bot",
		platform: null,
		sourceHash: sha256String("assistant"),
		sourceId: "assistant",
		sourceSystem: DSH_SOURCE,
	};
	const users = new Map<string, NormalizedUser>([[botId, bot]]);
	const members = new Set<string>([botId]);
	const messages: NormalizedMessage[] = [];
	const attachments: NormalizedAttachment[] = [];
	const seqToPlatformId = new Map<number, string>();
	const platformIds = new Set<string>();
	for (const message of session.messages) {
		if (options.qqChat && !isQqChatSession) continue;
		const sourceKind = sourceKindOf(message);
		const external = externalIdOf(message);
		if (message.role === "system") continue;
		if (message.role === "assistant" && message.text.trim() === "") continue;
		if (options.qqChat) {
			// QQ inbound text is reconstructed from the plugin prompt context below; the
			// prompt itself is an agent instruction, not a chat message. Explicitly typed
			// user messages (source.kind "user" or unknown in fixtures) still count.
			if (message.role === "user") {
				if (sourceKind !== null && sourceKind !== "user") continue;
			} else if (message.role !== "assistant") {
				continue;
			}
		} else if (message.role === "user") {
			if (sourceKind === "plugin:dsh-napcat") continue;
			if (sourceKind !== null && sourceKind !== "user") continue;
		}
		const senderRole = message.role;
		let sender = bot;
		if (senderRole !== "assistant" && senderRole !== "tool") {
			const sourceId = external ? `user:${external}` : "user:dsh-admin";
			sender = {
				canonicalId: canonicalId("user", sourceId),
				displayName:
					typeof message.source.data.senderName === "string"
						? message.source.data.senderName
						: (external ?? "Admin"),
				externalId: external,
				isAdmin: external === null,
				kind: "human",
				platform: external ? "onebot-v11" : null,
				sourceHash: sha256String(sourceId),
				sourceId,
				sourceSystem: DSH_SOURCE,
			};
		}
		users.set(sender.canonicalId, sender);
		members.add(sender.canonicalId);
		let platformMessageId = message.id;
		if (platformIds.has(platformMessageId)) {
			platformMessageId = `${message.id}:${message.seq ?? message.source.index}`;
		}
		platformIds.add(platformMessageId);
		if (message.seq !== null) seqToPlatformId.set(message.seq, platformMessageId);
		const messageAttachments: string[] = [];
		for (const attachment of message.attachments) {
			const mimeType = attachment.mimeType ?? "application/octet-stream";
			const id = canonicalId("media", `${session.id}:${attachment.id}`);
			const sha = attachment.sha256;
			attachments.push({
				id,
				kind: attachmentKind(mimeType),
				mimeType,
				sha256: sha,
				sizeBytes: attachment.sizeBytes ?? 0,
				sourceHash: sha256String(stableStringify(attachment.raw)),
				sourceId: `${session.id}:${attachment.id}`,
				sourcePath: attachment.path,
			});
			messageAttachments.push(id);
		}
		const occurredAt = timestamp(message.occurredAtMs ?? session.createdAt ?? undefined, createdAt);
		messages.push({
			attachments: messageAttachments,
			chatObjectId,
			content: message.text,
			conversationId,
			direction: message.role === "assistant" || message.role === "tool" ? "outbound" : "inbound",
			durableEntryId: `durable_${conversationId}:${platformMessageId}`,
			ingestedAt: new Date().toISOString(),
			kind: message.role === "tool" ? "tool" : message.role,
			occurredAt,
			platformMessageId,
			position: messages.length,
			replyToMessageId: null,
			senderDisplayName: sender.displayName,
			senderExternalId: sender.externalId ?? null,
			senderUserId: sender.canonicalId,
			sourceHash: sha256String(stableStringify(message.source.record)),
			sourceId: `${conversationId}:${platformMessageId}`,
			sourceSystem: DSH_SOURCE,
		});
	}
	for (const message of messages) {
		const original = session.messages[messages.indexOf(message)];
		const reply = original?.references.find((reference) => reference.kind === "reply");
		if (reply === undefined) continue;
		const target = reply.targetSeq === null ? null : (seqToPlatformId.get(reply.targetSeq) ?? null);
		if (target !== null) {
			(
				messages[messages.indexOf(message)] as { replyToMessageId?: string | null }
			).replyToMessageId = target;
		}
	}
	const updatedAt =
		messages.at(-1)?.occurredAt ??
		timestamp(session.updatedAt ?? session.createdAt ?? undefined, createdAt);
	return {
		attachments,
		conversation: {
			canonicalId: conversationId,
			channelId: identity.channelId,
			chatObjectId,
			createdAt,
			durableConversationId: `durable_${conversationId}`,
			kind: identity.kind,
			memberUserIds: [...members],
			platformConversationId: identity.platformConversationId,
			sourceHash: session.sourceHash,
			sourceId: session.id,
			sourceSystem: DSH_SOURCE,
			status: identity.isTest ? "archived" : "active",
			title: identity.channelId === "onebot" ? identity.title : session.title || identity.title,
			updatedAt,
		},
		messages,
		users: [...users.values()],
	};
}

function chatObjectFromConversation(conversation: NormalizedConversation): NormalizedChatObject {
	return {
		channelId: conversation.channelId,
		createdAt: conversation.createdAt,
		id: conversation.chatObjectId ?? canonicalId("chat", conversation.sourceId),
		kind: conversation.kind,
		platformConversationId: conversation.platformConversationId,
		sourceHash: conversation.sourceHash,
		sourceId: conversation.sourceId,
		sourceSystem: DSH_SOURCE,
		status: conversation.status,
		title: conversation.title,
		updatedAt: conversation.updatedAt,
	};
}

function normalizePersonaRecord(
	sourceId: string,
	value: Record<string, unknown>,
): NormalizedPersona {
	const name = typeof value.name === "string" ? value.name : sourceId;
	const prompt = value.prompt ?? value.systemPrompt ?? value.instructions ?? "";
	const behavior = value.behavior ?? value.rules ?? {};
	return {
		sourceSystem: DSH_SOURCE,
		sourceId,
		sourceHash: sha256String(stableStringify(value)),
		canonicalId: canonicalId("persona", sourceId),
		version: typeof value.version === "number" ? value.version : 1,
		name,
		summary: typeof value.summary === "string" ? value.summary : name,
		promptJson: JSON.stringify(prompt),
		behaviorJson: JSON.stringify(behavior),
		boundConversationIds: Array.isArray(value.conversationIds)
			? value.conversationIds
					.filter((id): id is string => typeof id === "string")
					.map((id) => canonicalId("conversation", id))
			: [],
	};
}

function personasFromConfig(
	value: unknown,
	sourceId: string,
	qqConversationIds: readonly string[],
): NormalizedPersona[] {
	const result: NormalizedPersona[] = [];
	const visit = (node: unknown, path: readonly string[], contextName: string | null): void => {
		if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, [...path, String(index)], contextName));
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		let name = contextName;
		if (record.config && typeof record.config === "object") {
			const config = record.config as Record<string, unknown>;
			if (typeof config.name === "string") name = config.name;
		}
		if (record.id === "persona" && record.config && typeof record.config === "object") {
			const config = record.config as Record<string, unknown>;
			if (typeof config.prefix === "string" && config.prefix.trim() !== "") {
				const personaSourceId = `${sourceId}#persona:${path.join(".")}`;
				const isQq = /qq/i.test(name ?? "") || /qq/i.test(path.join("."));
				result.push({
					behaviorJson: JSON.stringify({
						complete: config.complete ?? null,
						includeRuntimeContext: config.includeRuntimeContext ?? null,
					}),
					boundConversationIds: isQq ? qqConversationIds : [],
					canonicalId: canonicalId("persona", personaSourceId),
					name: name ?? "DSH Persona",
					promptJson: JSON.stringify(config.prefix),
					sourceHash: sha256String(stableStringify(config)),
					sourceId: personaSourceId,
					sourceSystem: DSH_SOURCE,
					summary: name ?? "DSH persona prompt",
					version: 1,
				});
			}
		}
		for (const [key, child] of Object.entries(record)) visit(child, [...path, key], name);
	};
	visit(value, [], null);
	return result;
}

function normalizeMemoryRecord(sourceId: string, value: Record<string, unknown>): NormalizedMemory {
	const conversationId =
		typeof value.conversationId === "string"
			? canonicalId("conversation", value.conversationId)
			: "";
	const createdAt = timestamp(value.createdAt as string | number | undefined, defaultTime);
	return {
		sourceSystem: DSH_SOURCE,
		sourceId,
		sourceHash: sha256String(stableStringify(value)),
		canonicalId: canonicalId("memory", sourceId),
		scope: conversationId ? "conversation" : "global",
		content: contentText(value.content ?? value.text ?? value),
		summary:
			typeof value.summary === "string" ? value.summary : contentText(value.content ?? value.text),
		kind: typeof value.kind === "string" ? value.kind : "fact",
		confidence: typeof value.confidence === "number" ? value.confidence : 1,
		importance: typeof value.importance === "number" ? value.importance : 0.5,
		conversationId,
		createdAt,
		updatedAt: timestamp(value.updatedAt as string | number | undefined, createdAt),
		createdBy: "migration",
	};
}

function normalizeStickerRecord(
	sourceId: string,
	value: Record<string, unknown>,
): NormalizedSticker {
	return {
		sourceSystem: DSH_SOURCE,
		sourceId,
		sourceHash: sha256String(stableStringify(value)),
		canonicalId: canonicalId("sticker", sourceId),
		name: typeof value.name === "string" ? value.name : sourceId,
		mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream",
		sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
		kind: "sticker",
	};
}

function stickerFromMeme(item: ImportedMemeItem): NormalizedSticker {
	return {
		canonicalId: item.id,
		description: item.description,
		emotions: item.emotions,
		enabled: false,
		fileHash: item.fileHash,
		keywords: item.keywords,
		kind: "sticker",
		mediaId: item.mediaId,
		mediaRelativePath: item.mediaRelativePath,
		mediaSourcePath: item.mediaSourcePath,
		mimeType: item.mimeType,
		name: item.name,
		packId: item.packId,
		reviewStatus: "pending",
		sizeBytes: item.sizeBytes,
		sourceHash: sha256String(stableStringify(item.provenance)),
		sourceId: item.id,
		sourceSystem: DSH_SOURCE,
		tags: item.tags,
	};
}

function packFromMeme(pack: ImportedMemePack): NormalizedStickerPack {
	return {
		enabled: false,
		id: pack.id,
		metadata: pack.metadata,
		name: pack.name,
		sourceHash: sha256String(stableStringify(pack.manifest)),
		sourceId: pack.id,
		sourceSystem: DSH_SOURCE,
		tags: pack.tags,
		version: pack.version,
	};
}

function taskFromImported(task: ImportedScheduledTask): NormalizedTask {
	return { ...task, sourceId: task.taskId, sourceSystem: DSH_SOURCE };
}

function requestFromImported(request: ImportedRequest): NormalizedRequest {
	return { ...request, sourceId: request.id, sourceSystem: DSH_SOURCE };
}

function stateFromImported(state: ImportedSchedulerState): NormalizedSchedulerState {
	return { ...state, sourceSystem: DSH_SOURCE };
}

export function countRecords(database: NormalizedDatabase): RecordCounts {
	return {
		attachments: database.attachments.length,
		chatObjects: database.chatObjects.length,
		conversations: database.conversations.length,
		identities: database.identities.length,
		memories: database.memories.length,
		messages: database.messages.length,
		personas: database.personas.length,
		requests: database.requests.length,
		schedulerStates: database.schedulerStates.length,
		settings: database.settings.length,
		stickerPacks: database.stickerPacks.length,
		stickers: database.stickers.length,
		tasks: database.tasks.length,
		userAliases: database.userAliases.length,
		users: database.users.length,
	};
}

function emptyRecordCounts(): RecordCounts {
	return {
		attachments: 0,
		chatObjects: 0,
		conversations: 0,
		identities: 0,
		memories: 0,
		messages: 0,
		personas: 0,
		requests: 0,
		schedulerStates: 0,
		settings: 0,
		stickerPacks: 0,
		stickers: 0,
		tasks: 0,
		userAliases: 0,
		users: 0,
	};
}

function estimateBytes(database: NormalizedDatabase): number {
	return Object.values(database).reduce(
		(total, records) =>
			total + records.reduce((sum, record) => sum + stableStringify(record).length, 0),
		0,
	);
}

function emptyDatabase(): NormalizedDatabase {
	return {
		attachments: [],
		chatObjects: [],
		conversations: [],
		identities: [],
		memories: [],
		messages: [],
		personas: [],
		requests: [],
		schedulerStates: [],
		settings: [],
		stickerPacks: [],
		stickers: [],
		tasks: [],
		userAliases: [],
		users: [],
	};
}

function identityFromUser(user: NormalizedUser): NormalizedIdentity | null {
	if (!user.externalId || user.externalId.trim() === "") return null;
	const platform = user.platform ?? "dsh";
	const external = user.externalId;
	return {
		canonicalUserId: user.canonicalId,
		displayName: user.displayName,
		externalId: external,
		id: canonicalId("identity", `${platform}:${user.kind}:${external}:${user.sourceId}`),
		kind: user.kind === "system" ? "system" : "user",
		platform,
		platformAccountId: platform === "onebot-v11" ? "onebot" : external,
		sourceHash: sha256String(`${platform}:${external}:${user.sourceId}`),
		sourceId: `${user.sourceId}:identity`,
		sourceSystem: DSH_SOURCE,
	};
}

function aliasFromUser(user: NormalizedUser): NormalizedUserAlias | null {
	const alias = user.externalId ?? user.displayName;
	if (!alias || alias.trim() === "") return null;
	return {
		alias,
		confidence: 1,
		id: canonicalId("alias", `${user.canonicalId}:${alias}`),
		source: "dsh-migration",
		sourceHash: sha256String(`${user.canonicalId}:${alias}`),
		sourceId: `${user.sourceId}:alias`,
		sourceSystem: DSH_SOURCE,
		userId: user.canonicalId,
	};
}

interface QqChatAccumulator {
	readonly chatKey: string;
	readonly kind: "group" | "private";
	readonly platformId: string;
	readonly conversationId: string;
	readonly chatObjectId: string;
	readonly title: string;
	readonly sessionIds: string[];
	readonly sourceHashes: string[];
	readonly messages: NormalizedMessage[];
	readonly users: Map<string, NormalizedUser>;
	readonly attachments: Map<string, NormalizedAttachment>;
	createdAt: string;
	updatedAt: string;
}

function dshAssistantUser(): NormalizedUser {
	const sourceId = "assistant";
	return {
		canonicalId: canonicalId("user", "dsh-assistant"),
		displayName: "DSH Assistant",
		externalId: null,
		isAdmin: false,
		kind: "bot",
		platform: null,
		sourceHash: sha256String(sourceId),
		sourceId,
		sourceSystem: DSH_SOURCE,
	};
}

function qqDedupeContent(content: string): string {
	return content
		.replace(/\[表情:[^\]]*\]/g, "")
		.replace(/\[表情\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** DSH newline-chunks QQ output, so one assistant block can contain several sent messages. */
function expandQqSessionMessages(messages: readonly NormalizedMessage[]): NormalizedMessage[] {
	return messages.flatMap((message) => {
		if (message.direction !== "outbound" || qqMessageRank(message) !== 1) return [message];
		const lines = message.content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "");
		if (lines.length <= 1) return [message];
		return lines.map((line, index) => ({
			...message,
			attachments: index === lines.length - 1 ? message.attachments : [],
			content: line,
			durableEntryId: `${message.durableEntryId}:line:${index}`,
			platformMessageId: `${message.platformMessageId}:line:${index}`,
			position: 0,
			sourceHash: sha256String(line),
			sourceId: `${message.sourceId}:line:${index}`,
		}));
	});
}

function sameAttachments(left: NormalizedMessage, right: NormalizedMessage): boolean {
	const leftIds = [...left.attachments].toSorted();
	const rightIds = [...right.attachments].toSorted();
	return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function mergeAttachments(
	left: NormalizedMessage,
	right: NormalizedMessage,
): NormalizedMessage["attachments"] {
	return [...new Set([...left.attachments, ...right.attachments])];
}

/** Prefer OneBot history/recent rows (exact ids/timestamps) over prompt-derived rows. */
function qqMessageRank(message: NormalizedMessage): number {
	if (/:msg:|:recent:/.test(message.platformMessageId)) return 3;
	if (message.platformMessageId.startsWith("qq:")) return 2;
	return 1;
}

function preferQqMessage(left: NormalizedMessage, right: NormalizedMessage): boolean {
	const leftRank = qqMessageRank(left);
	const rightRank = qqMessageRank(right);
	if (leftRank !== rightRank) return leftRank > rightRank;
	if (left.attachments.length !== right.attachments.length) {
		return left.attachments.length > right.attachments.length;
	}
	return left.occurredAt > right.occurredAt;
}

function dedupeQqMessages(input: readonly NormalizedMessage[]): NormalizedMessage[] {
	const sorted = [...input].toSorted(
		(left, right) =>
			left.occurredAt.localeCompare(right.occurredAt) ||
			left.platformMessageId.localeCompare(right.platformMessageId),
	);
	const accepted = new Map<string, NormalizedMessage>();
	const buckets = new Map<string, NormalizedMessage[]>();
	for (const message of sorted) {
		const content = message.content.trim();
		// DSH records a no-output turn as one of these control tokens; they are not chat.
		if (content === "__LURK__" || content === "__SKIP__") continue;
		if (accepted.has(message.sourceId)) continue;
		const normalizedContent = qqDedupeContent(content);
		const key = `${message.direction}\u0000${message.senderUserId}\u0000${normalizedContent || content}`;
		const generic = /^\[(?:图片|表情|视频|语音|文件|卡片|合并转发)(?:\([^)]*\))?\]$/.test(content);
		const candidates = (buckets.get(key) ?? []).filter(
			(candidate) =>
				Math.abs(Date.parse(candidate.occurredAt) - Date.parse(message.occurredAt)) <= 120_000,
		);
		const duplicate = candidates.find((candidate) => {
			if (generic) {
				return (
					message.attachments.length > 0 &&
					candidate.attachments.length > 0 &&
					sameAttachments(message, candidate)
				);
			}
			if (message.attachments.length > 0 && candidate.attachments.length > 0) {
				return sameAttachments(message, candidate);
			}
			return true;
		});
		if (duplicate !== undefined) {
			if (preferQqMessage(message, duplicate)) {
				const merged = { ...message, attachments: mergeAttachments(message, duplicate) };
				accepted.delete(duplicate.sourceId);
				accepted.set(merged.sourceId, merged);
				const index = candidates.indexOf(duplicate);
				if (index >= 0) candidates[index] = merged;
			}
			buckets.set(key, candidates);
			continue;
		}
		accepted.set(message.sourceId, message);
		candidates.push(message);
		buckets.set(key, candidates);
	}
	return [...accepted.values()].toSorted(
		(left, right) =>
			left.occurredAt.localeCompare(right.occurredAt) ||
			left.platformMessageId.localeCompare(right.platformMessageId),
	);
}

function earlierIso(left: string, right: string): string {
	return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string, right: string): string {
	return Date.parse(left) >= Date.parse(right) ? left : right;
}

function mediaSourcePath(entry: SourceEntry): string {
	const workspace = entry.path.indexOf("/workspace/");
	if (workspace >= 0) return entry.path.slice(workspace + 1);
	return entry.path.split("/").slice(1).join("/");
}

export async function normalizeSnapshot(source: SnapshotSource): Promise<NormalizeResult> {
	const inventory = await inspectDshSnapshot(source);
	const entries = await sourceEntries(source);
	const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
	const users = new Map<string, NormalizedUser>();
	const conversations = new Map<string, NormalizedConversation>();
	const chatObjects = new Map<string, NormalizedChatObject>();
	const messages: NormalizedMessage[] = [];
	const attachments = new Map<string, NormalizedAttachment>();
	const personas = new Map<string, NormalizedPersona>();
	const memories = new Map<string, NormalizedMemory>();
	const settings = new Map<string, NormalizedSetting>();
	const stickers = new Map<string, NormalizedSticker>();
	const stickerPacks = new Map<string, NormalizedStickerPack>();
	const tasks = new Map<string, NormalizedTask>();
	const requests = new Map<string, NormalizedRequest>();
	const schedulerStates = new Map<string, NormalizedSchedulerState>();
	const decisions: DecisionEntry[] = [];
	const sessionErrors: SessionParseError[] = [];
	const warnings: string[] = [];

	const addConversation = (conversation: NormalizedConversation): void => {
		conversations.set(conversation.canonicalId, conversation);
		const chat = chatObjectFromConversation(conversation);
		chatObjects.set(chat.id, chat);
	};

	const readRecordFiles = async (
		paths: readonly string[],
		onRecord: (sourceId: string, value: Record<string, unknown>) => void,
	): Promise<void> => {
		for (const path of paths) {
			if (!/\.(?:json|jsonl)$/i.test(path)) continue;
			let content: string;
			try {
				content = await readTextSource(source, path);
			} catch {
				continue;
			}
			const records: Record<string, unknown>[] = [];
			if (path.endsWith(".jsonl")) {
				for (const line of content.split("\n").filter(Boolean)) {
					try {
						const parsed = JSON.parse(line) as unknown;
						if (parsed && typeof parsed === "object") {
							records.push(parsed as Record<string, unknown>);
						}
					} catch {
						// Malformed legacy records are skipped; v4 parsing reports diagnostics.
					}
				}
			} else {
				try {
					const parsed = JSON.parse(content) as unknown;
					if (Array.isArray(parsed)) {
						records.push(
							...parsed.filter((record): record is Record<string, unknown> =>
								Boolean(record && typeof record === "object"),
							),
						);
					} else if (parsed && typeof parsed === "object") {
						records.push(parsed as Record<string, unknown>);
					}
				} catch {
					continue;
				}
			}
			for (const [index, record] of records.entries()) {
				const recordId = typeof record.id === "string" ? record.id : String(index);
				const sourceId = `${path}:${recordId}`;
				onRecord(sourceId, record);
			}
		}
	};

	const qqChats = new Map<string, QqChatAccumulator>();
	const ensureQqChat = (chatKey: string, at: string): QqChatAccumulator => {
		const existing = qqChats.get(chatKey);
		if (existing !== undefined) return existing;
		const match = /^(group|private):(.+)$/.exec(chatKey);
		if (match === null) throw new Error(`Unsupported QQ chat key: ${chatKey}`);
		const kind = match[1] === "private" ? "private" : "group";
		const platformId = match[2]!;
		const identity = mapDshConversationIdentity({
			sessionId: `napcat-${kind}-${platformId}`,
		});
		const conversationId = canonicalId("conversation", `napcat-${kind}-${platformId}`);
		const chatObjectId = canonicalId(
			"chat",
			`${identity.channelId}:${identity.kind}:${identity.platformConversationId}`,
		);
		const createdAt = Number.isNaN(Date.parse(at)) ? defaultTime : at;
		const chat: QqChatAccumulator = {
			attachments: new Map(),
			chatKey,
			chatObjectId,
			conversationId,
			createdAt,
			kind,
			messages: [],
			platformId,
			sessionIds: [],
			sourceHashes: [],
			title: identity.title,
			updatedAt: createdAt,
			users: new Map(),
		};
		qqChats.set(chatKey, chat);
		return chat;
	};
	const [qqPeople, botAliases, botSelfIds] = await Promise.all([
		loadQqPeople(entries),
		loadBotAliases(entries),
		loadBotSelfIds(entries),
	]);

	const historyRecords = await loadQqHistory(source, entries);
	const sessionPaths = inventory.sessions.filter(
		(path) =>
			/\.jsonl(?:\.zstd)?$/i.test(path) &&
			/(?:^|\/)sessions\//i.test(path) &&
			!/(?:^|\/)(?:audit|personas?|memory|settings|stickers?|backups|aya-snapshot|node_modules)\//i.test(
				path,
			),
	);
	for (const path of sessionPaths) {
		const entry = entriesByPath.get(path);
		if (entry === undefined) continue;
		const workspace = /(?:^|\/)sessions\/([^/]+)\//.exec(path)?.[1];
		let parsed: Awaited<ReturnType<typeof parseSessionV4Text>>;
		if (/\.zst(?:d)?$/i.test(path)) {
			const bytes = await fs.readFile(entry.absolutePath);
			parsed = await parseSessionV4Bytes(bytes, {
				sessionIdFallback: basename(path).replace(/\.jsonl(?:\.zstd)?$/i, ""),
				...(workspace === undefined ? {} : { workspace }),
			});
		} else {
			const content = await readTextSource(source, path);
			parsed = await parseSessionV4Text(content, {
				sessionIdFallback: basename(path).replace(/\.jsonl(?:\.zstd)?$/i, ""),
				...(workspace === undefined ? {} : { workspace }),
			});
		}
		sessionErrors.push(...parsed.diagnostics.errors);
		if (parsed.session !== null) {
			historyRecords.push(...sentMessageRecords(parsed.session, botSelfIds));
		}
		if (parsed.session === null) {
			const content = /\.zst(?:d)?$/i.test(path) ? "" : await readTextSource(source, path);
			for (const legacy of parseLegacySessions(content)) {
				const normalized = normalizeLegacySession(legacy, path);
				users.set(normalized.user.canonicalId, normalized.user);
				addConversation(normalized.conversation);
				messages.push(...normalized.messages);
			}
			continue;
		}
		const identity = mapDshConversationIdentity({
			sessionId: parsed.session.id,
			title: parsed.session.title,
			workspace: parsed.session.workspace,
		});
		if (identity.channelId === "onebot") {
			const chatKey = `${identity.kind}:${identity.platformConversationId}`;
			const conversationId = canonicalId(
				"conversation",
				`napcat-${identity.kind}-${identity.platformConversationId}`,
			);
			const chatObjectId = canonicalId(
				"chat",
				`${identity.channelId}:${identity.kind}:${identity.platformConversationId}`,
			);
			const normalized = normalizeV4Session(parsed.session, {
				chatObjectId,
				conversationId,
				qqChat: true,
			});
			const createdAt = timestamp(parsed.session.createdAt ?? undefined, defaultTime);
			const chat = ensureQqChat(chatKey, createdAt);
			chat.sessionIds.push(parsed.session.id);
			chat.sourceHashes.push(parsed.session.sourceHash);
			chat.createdAt = earlierIso(chat.createdAt, createdAt);
			for (const user of normalized.users) chat.users.set(user.canonicalId, user);
			for (const attachment of normalized.attachments) {
				chat.attachments.set(attachment.id, attachment);
			}
			chat.messages.push(...normalized.messages);
			chat.updatedAt = laterIso(chat.updatedAt, normalized.conversation.updatedAt);
			const chatDirectory = `${identity.kind}-${identity.platformConversationId}`;
			for (const prompt of parsed.session.messages) {
				if (prompt.role !== "user" || sourceKindOf(prompt) !== "plugin:dsh-napcat") continue;
				const lines = parseQqPromptLines(prompt.text);
				const promptMs = prompt.occurredAtMs ?? Date.parse(parsed.session.createdAt ?? "");
				let lastInbound: NormalizedMessage | null = null;
				for (const line of lines) {
					const text = line.text.trim();
					if (text === "") continue;
					const author = splitQqNick(line.nick);
					if (botAliases.has(author.name)) continue;
					const occurredAt = qqMinuteIso(Number.isFinite(promptMs) ? promptMs : null, line.minute);
					const numericNick = /^\d{5,}$/.test(author.name) ? author.name : null;
					const external =
						author.id ?? numericNick ?? qqPeople.get(chatKey)?.get(author.name) ?? null;
					const senderSourceId =
						external === null ? `user:nick:${chatKey}:${author.name}` : `user:${external}`;
					const senderId = canonicalId("user", senderSourceId);
					const sender: NormalizedUser = chat.users.get(senderId) ?? {
						canonicalId: senderId,
						displayName: author.name,
						externalId: external,
						isAdmin: false,
						kind: "human",
						platform: "onebot-v11",
						sourceHash: sha256String(senderSourceId),
						sourceId: senderSourceId,
						sourceSystem: DSH_SOURCE,
					};
					chat.users.set(senderId, sender);
					const platformMessageId = `qq:${chatKey}:${occurredAt}:${sha256String(
						`${line.nick}\n${text}`,
					).slice(7, 23)}`;
					const messageAttachments: string[] = [];
					for (const referenced of inlineImagePaths(text)) {
						const found = findMediaEntry(entries, referenced, chatDirectory);
						if (found === null) continue;
						const sourcePath = mediaSourcePath(found);
						const id = canonicalId("media", `${chatKey}:${sourcePath}`);
						chat.attachments.set(id, {
							id,
							kind: "image",
							mimeType: mimeTypeForPath(sourcePath),
							sha256: null,
							sizeBytes: 0,
							sourceHash: sha256String(sourcePath),
							sourceId: `${chatKey}:${sourcePath}`,
							sourcePath,
						});
						messageAttachments.push(id);
					}
					const inbound: NormalizedMessage = {
						attachments: messageAttachments,
						chatObjectId,
						content: stripInlineImagePaths(text),
						conversationId,
						direction: "inbound",
						durableEntryId: `durable_${conversationId}:${platformMessageId}`,
						ingestedAt: new Date().toISOString(),
						kind: "text",
						occurredAt,
						platformMessageId,
						position: 0,
						replyToMessageId: null,
						senderDisplayName: sender.displayName,
						senderExternalId: external,
						senderUserId: senderId,
						sourceHash: sha256String(`${line.nick}\n${text}`),
						sourceId: `${conversationId}:${platformMessageId}`,
						sourceSystem: DSH_SOURCE,
					};
					chat.messages.push(inbound);
					lastInbound = inbound;
				}
				if (lastInbound !== null) {
					for (const attachment of prompt.attachments) {
						const sha = attachment.sha256;
						if (sha === null && attachment.path === null) continue;
						const found =
							attachment.path === null
								? null
								: findMediaEntry(entries, attachment.path, chatDirectory);
						const mediaRelative = found === null ? null : mediaSourcePath(found);
						const id = canonicalId("media", `${chatKey}:${sha ?? mediaRelative ?? attachment.id}`);
						chat.attachments.set(id, {
							id,
							kind: attachmentKind(attachment.mimeType ?? "application/octet-stream"),
							mimeType: attachment.mimeType ?? "application/octet-stream",
							sha256: sha,
							sizeBytes: attachment.sizeBytes ?? 0,
							sourceHash: sha256String(stableStringify(attachment.raw)),
							sourceId: `${chatKey}:${sha ?? mediaRelative ?? attachment.id}`,
							sourcePath: mediaRelative,
						});
						if (lastInbound.attachments.includes(id)) continue;
						lastInbound = {
							...lastInbound,
							attachments: [...lastInbound.attachments, id],
						};
						const index = chat.messages.findIndex(
							(message) => message.sourceId === lastInbound?.sourceId,
						);
						if (index >= 0) chat.messages[index] = lastInbound;
					}
				}
			}
			qqChats.set(chatKey, chat);
			decisions.push({
				action: "remap",
				area: "trigger-pacing",
				reason: `Merged DSH session ${parsed.session.id} into ${chatKey}`,
				source: path,
				target: "conversations",
			});
			continue;
		}
		const normalized = normalizeV4Session(parsed.session);
		if (normalized.messages.length === 0) continue;
		for (const user of normalized.users) users.set(user.canonicalId, user);
		for (const attachment of normalized.attachments) {
			attachments.set(attachment.id, attachment);
		}
		addConversation(normalized.conversation);
		messages.push(...normalized.messages);
		decisions.push({
			action: "remap",
			area: "trigger-pacing",
			reason: `Parsed DSH session v${parsed.session.version} with ${normalized.messages.length} messages`,
			source: path,
			target: "conversations",
		});
	}

	const historyCountByChat = new Map<string, number>();
	for (const record of historyRecords) {
		const occurredAt = new Date(record.timestamp).toISOString();
		const chat = ensureQqChat(record.chatKey, occurredAt);
		const content = record.text.trim();
		if (content === "") continue;
		const chatDirectory = `${record.kind}-${record.platformId}`;
		const bot = dshAssistantUser();
		const external = record.own ? null : record.senderExternalId;
		const senderSourceId =
			external === null
				? record.own
					? "assistant"
					: `user:nick:${record.chatKey}:${record.senderName}`
				: `user:${external}`;
		const senderId = record.own ? bot.canonicalId : canonicalId("user", senderSourceId);
		const sender: NormalizedUser = record.own
			? bot
			: (chat.users.get(senderId) ?? {
					canonicalId: senderId,
					displayName: record.senderName,
					externalId: external,
					isAdmin: false,
					kind: "human",
					platform: "onebot-v11",
					sourceHash: sha256String(senderSourceId),
					sourceId: senderSourceId,
					sourceSystem: DSH_SOURCE,
				});
		chat.users.set(senderId, sender);
		const messageAttachments: string[] = [];
		for (const reference of new Set(record.mediaRefs)) {
			const found =
				record.mediaLookup === "basename"
					? findCachedMediaEntry(entries, reference, chatDirectory)
					: findMediaEntry(entries, reference, chatDirectory);
			if (found === null) continue;
			const sourcePath = mediaSourcePath(found);
			const id = canonicalId("media", `${record.chatKey}:${sourcePath}`);
			chat.attachments.set(id, {
				id,
				kind: attachmentKind(mimeTypeForPath(sourcePath)),
				mimeType: mimeTypeForPath(sourcePath),
				sha256: null,
				sizeBytes: 0,
				sourceHash: sha256String(sourcePath),
				sourceId: `${record.chatKey}:${sourcePath}`,
				sourcePath,
			});
			messageAttachments.push(id);
		}
		const hash = sha256String(`${record.senderName}\n${content}\n${record.timestamp}`).slice(7, 23);
		const platformMessageId =
			record.messageId === null
				? `qq:${record.chatKey}:recent:${record.timestamp}:${hash}`
				: `qq:${record.chatKey}:msg:${record.messageId}`;
		const historyMessage: NormalizedMessage = {
			attachments: messageAttachments,
			chatObjectId: chat.chatObjectId,
			content,
			conversationId: chat.conversationId,
			direction: record.own ? "outbound" : "inbound",
			durableEntryId: `durable_${chat.conversationId}:${platformMessageId}`,
			ingestedAt: new Date().toISOString(),
			kind: "text",
			occurredAt,
			platformMessageId,
			position: 0,
			replyToMessageId:
				record.replyToMessageId === null
					? null
					: `qq:${record.chatKey}:msg:${record.replyToMessageId}`,
			senderDisplayName: sender.displayName,
			senderExternalId: record.own ? null : external,
			senderUserId: senderId,
			sourceHash: sha256String(stableStringify(record.raw)),
			sourceId: `${chat.conversationId}:${platformMessageId}`,
			sourceSystem: DSH_SOURCE,
		};
		chat.messages.push(historyMessage);
		chat.createdAt = earlierIso(chat.createdAt, occurredAt);
		chat.updatedAt = laterIso(chat.updatedAt, occurredAt);
		historyCountByChat.set(record.chatKey, (historyCountByChat.get(record.chatKey) ?? 0) + 1);
	}
	for (const [chatKey, count] of historyCountByChat) {
		decisions.push({
			action: "remap",
			area: "trigger-pacing",
			reason: `Imported ${count} archived QQ chat record(s) for ${chatKey}`,
			source: `chat:${chatKey}:history`,
			target: "conversations",
		});
	}

	for (const chat of qqChats.values()) {
		const bySource = new Map<string, NormalizedMessage>();
		for (const message of expandQqSessionMessages(chat.messages)) {
			bySource.set(message.sourceId, message);
		}
		const unique = dedupeQqMessages([...bySource.values()]).map((message, position) => ({
			...message,
			position,
		}));
		const createdAt =
			unique.length > 0 ? earlierIso(chat.createdAt, unique[0]!.occurredAt) : chat.createdAt;
		const updatedAt =
			unique.length > 0 ? laterIso(chat.updatedAt, unique.at(-1)!.occurredAt) : chat.updatedAt;
		const conversation: NormalizedConversation = {
			canonicalId: chat.conversationId,
			channelId: "onebot",
			chatObjectId: chat.chatObjectId,
			createdAt,
			durableConversationId: `durable_${chat.conversationId}`,
			kind: chat.kind,
			memberUserIds: [...chat.users.keys()],
			platformConversationId: chat.platformId,
			sourceHash: sha256String(chat.sourceHashes.toSorted().join("|")),
			sourceId: `napcat-${chat.kind}-${chat.platformId}`,
			sourceSystem: DSH_SOURCE,
			status: "active",
			title: chat.title,
			updatedAt,
		};
		for (const user of chat.users.values()) users.set(user.canonicalId, user);
		for (const attachment of chat.attachments.values()) {
			attachments.set(attachment.id, attachment);
		}
		addConversation(conversation);
		messages.push(...unique);
		decisions.push({
			action: "remap",
			area: "trigger-pacing",
			reason: `Merged ${chat.sessionIds.length} DSH session(s) into ${chat.chatKey}`,
			source: `chat:${chat.chatKey}`,
			target: "conversations",
		});
	}

	for (const [id, attachment] of attachments) {
		const sha = attachment.sha256;
		const matches =
			attachment.sourcePath === null && sha !== null
				? entries.filter(
						(entry) =>
							/\/attachments\//i.test(entry.path) &&
							entry.path.toLowerCase().endsWith(`/${sha.toLowerCase()}`),
					)
				: (() => {
						if (attachment.sourcePath === null) return [];
						const requested = attachment.sourcePath.replaceAll("\\", "/");
						const exact = entries.filter(
							(entry) => entry.path === requested || entry.path.endsWith(`/${requested}`),
						);
						if (exact.length > 0) return exact;
						return entries.filter((entry) => basename(entry.path) === basename(requested));
					})();
		if (matches.length !== 1) continue;
		try {
			const bytes = await fs.readFile(matches[0]!.absolutePath);
			const fileHash = sha256Bytes(bytes).slice("sha256:".length);
			attachments.set(id, {
				...attachment,
				fileHash,
				mediaRelativePath: mediaSourcePath(matches[0]!),
				mediaSourcePath: matches[0]!.absolutePath,
				sizeBytes: attachment.sizeBytes > 0 ? attachment.sizeBytes : bytes.byteLength,
			});
		} catch {
			// Missing attachment media is reported in diagnostics and review decisions.
		}
	}

	for (const message of messages) {
		if (message.direction === "inbound" && !users.has(message.senderUserId)) {
			const sourceId = `user:${message.senderDisplayName ?? message.senderUserId}`;
			users.set(message.senderUserId, {
				canonicalId: message.senderUserId,
				displayName: message.senderDisplayName ?? `User ${message.senderUserId.split("_").at(-1)}`,
				externalId: message.senderExternalId ?? null,
				isAdmin: false,
				kind: "human",
				platform: message.senderExternalId ? "onebot-v11" : null,
				sourceHash: sha256String(sourceId),
				sourceId,
				sourceSystem: DSH_SOURCE,
			});
		}
	}

	await readRecordFiles(inventory.personas, (sourceId, value) => {
		const persona = normalizePersonaRecord(sourceId, value);
		personas.set(persona.canonicalId, persona);
	});
	await readRecordFiles(
		inventory.memory.filter((path) => !/(?:^|\/)(?:\.mnemon|workspace\/memory)\//i.test(path)),
		(sourceId, value) => {
			const memory = normalizeMemoryRecord(sourceId, value);
			memories.set(memory.canonicalId, memory);
		},
	);
	await readRecordFiles(inventory.stickers, (sourceId, value) => {
		const sticker = normalizeStickerRecord(sourceId, value);
		stickers.set(sticker.canonicalId, sticker);
	});
	await readRecordFiles(inventory.settings, (sourceId, value) => {
		const category = /napcat/i.test(sourceId)
			? "onebot-napcat"
			: /memory/i.test(sourceId)
				? "memory"
				: /meme|sticker/i.test(sourceId)
					? "sticker"
					: /search/i.test(sourceId)
						? "search"
						: /model/i.test(sourceId)
							? "model_policy"
							: "unknown";
		for (const setting of settingsRecords(sourceId, category, value)) {
			settings.set(setting.canonicalId, setting);
		}
	});

	const configResults: ConfigMappingResult[] = [];
	for (const entry of entries) {
		if (!/(?:^|\/)home\/(?:node\/)?\.dsh\/profiles\/[^/]+\/cordis\.patch\.ya?ml$/i.test(entry.path))
			continue;
		try {
			const text = await fs.readFile(entry.absolutePath, "utf8");
			const mapped = mapDshConfigText(text, entry.path);
			configResults.push(mapped);
			for (const setting of mapped.settings) settings.set(setting.canonicalId, setting);
			decisions.push(...mapped.entries);
			const qqConversationIds = [...conversations.values()]
				.filter((conversation) => conversation.channelId === "onebot")
				.map((conversation) => conversation.canonicalId);
			try {
				for (const persona of personasFromConfig(
					Bun.YAML.parse(text) as unknown,
					entry.path,
					qqConversationIds,
				)) {
					personas.set(persona.canonicalId, persona);
				}
			} catch {
				// Invalid YAML is already reported by the config mapper.
			}
		} catch (error) {
			warnings.push(`Failed to map ${entry.path}: ${String(error)}`);
		}
	}

	try {
		const memoryImport = await importDshMemory(source);
		for (const memory of memoryImport.memories) {
			memories.set(memory.canonicalId, {
				...memory,
				createdBy: "migration",
				sourceSystem: DSH_SOURCE,
			});
		}
		for (const state of memoryImport.schedulerStates) {
			schedulerStates.set(state.conversationId, stateFromImported(state));
		}
		decisions.push(...memoryImport.decisions);
		warnings.push(...memoryImport.warnings);
	} catch (error) {
		warnings.push(`Memory import failed: ${String(error)}`);
	}

	try {
		const memeImport = await parseDshMemePacks(source);
		for (const pack of memeImport.packs) {
			stickerPacks.set(pack.id, packFromMeme(pack));
		}
		for (const item of memeImport.items) {
			const sticker = stickerFromMeme(item);
			stickers.set(sticker.canonicalId, sticker);
		}
		decisions.push(...memeImport.decisions);
		warnings.push(...memeImport.warnings);
	} catch (error) {
		warnings.push(`Meme import failed: ${String(error)}`);
	}

	let skippedExpiredTasks = 0;
	try {
		const scheduleImport = await importDshSchedulesAndRequests(source);
		skippedExpiredTasks = scheduleImport.skippedExpired;
		for (const task of scheduleImport.tasks) tasks.set(task.id, taskFromImported(task));
		for (const request of scheduleImport.requests) {
			requests.set(request.id, requestFromImported(request));
		}
		decisions.push(...scheduleImport.decisions);
		warnings.push(...scheduleImport.warnings);
	} catch (error) {
		warnings.push(`Schedule/request import failed: ${String(error)}`);
	}

	const identities: NormalizedIdentity[] = [];
	const userAliases: NormalizedUserAlias[] = [];
	for (const user of users.values()) {
		const identity = identityFromUser(user);
		if (identity !== null) identities.push(identity);
		const alias = aliasFromUser(user);
		if (alias !== null) userAliases.push(alias);
	}

	const database: NormalizedDatabase = {
		...emptyDatabase(),
		attachments: [...attachments.values()],
		chatObjects: [...chatObjects.values()],
		conversations: [...conversations.values()],
		identities,
		memories: [...memories.values()],
		messages,
		personas: [...personas.values()],
		requests: [...requests.values()],
		schedulerStates: [...schedulerStates.values()],
		settings: [...settings.values()],
		stickerPacks: [...stickerPacks.values()],
		stickers: [...stickers.values()],
		tasks: [...tasks.values()],
		userAliases,
		users: [...users.values()],
	};
	const sourceCounts = countRecords(database);
	const secretPaths = configResults.flatMap((result) => result.report.secretPaths);
	const diagnostics: MigrationDiagnostics = {
		errors: sessionErrors,
		malformedRecords: sessionErrors.filter((error) => error.code === "malformed_json").length,
		mediaExtra: 0,
		mediaMissing:
			database.stickers.filter((sticker) => sticker.packId !== undefined && !sticker.fileHash)
				.length +
			database.attachments.filter(
				(attachment) => attachment.sourcePath !== null && !attachment.fileHash,
			).length,
		secretPaths,
		skippedExpiredTasks,
		unsupportedVersions: sessionErrors.filter((error) => error.code === "unsupported_version")
			.length,
		warnings,
	};
	const decisionReport = mergeDecisionReports([
		summarizeDecisions(decisions, secretPaths),
		summarizeDecisions(
			Object.entries(sourceCounts).flatMap(([kind, count]) =>
				count === 0
					? []
					: [
							{
								action: "direct" as const,
								reason: `${count} source ${kind} record(s) mapped`,
								source: `count:${kind}`,
								target: kind,
							},
						],
			),
		),
	]);
	const plan: MigrationPlan = {
		...sourceCounts,
		decisions: decisionReport,
		diagnostics,
		estimatedBytes: estimateBytes(database),
		importOrder: [...DSH_IMPORT_ORDER],
		rollbackIds: Object.entries(database).flatMap(([kind, records]) =>
			records.map((record) => {
				const value = record as unknown as {
					sourceId?: string;
					id?: string;
					canonicalId?: string;
				};
				return `${DSH_SOURCE}:${kind}:${value.sourceId ?? value.id ?? value.canonicalId ?? ""}`;
			}),
		),
		sourceCounts,
		warnings: inventory.warnings.concat(warnings),
	};
	return {
		config: configResults,
		database,
		decisions: decisionReport,
		diagnostics,
		plan,
		warnings: plan.warnings,
	};
}

export function buildMigrationPlan(result: NormalizeResult): MigrationPlan {
	return result.plan;
}

export { emptyRecordCounts, readTextSource };
