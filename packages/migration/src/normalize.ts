import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { isCredentialLikeKey } from "./dsh-baseline.ts";
import { redactSecrets } from "./secrets.ts";
import { DSH_SOURCE, inspectDshSnapshot, type SnapshotSource } from "./dsh-inspect.ts";
import { sha256Bytes, sha256String, stableStringify } from "./fs.ts";
import { listFiles } from "./fs.ts";
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
			for (const file of await listFiles(root)) {
				entries.push({
					absolutePath: file,
					path: `${label}/${relative(root, file).replaceAll("\\", "/")}`,
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
	const localPath = join(sourcePath, entryName);
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
		platform: external ? "onebot-napcat" : null,
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

function normalizeV4Session(session: DshV4Session): {
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
	const updatedAt = timestamp(session.updatedAt ?? session.createdAt ?? undefined, createdAt);
	const conversationId = canonicalId("conversation", session.id);
	const chatObjectId = canonicalId("chat", session.id);
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
		const senderRole = message.role;
		let sender = bot;
		if (senderRole !== "assistant" && senderRole !== "tool") {
			const external =
				typeof message.source.data.userId === "string"
					? message.source.data.userId
					: typeof message.source.data.senderId === "string"
						? message.source.data.senderId
						: null;
			const sourceId = external ? `user:${external}` : `user:${senderRole}`;
			sender = {
				canonicalId: canonicalId("user", sourceId),
				displayName:
					typeof message.source.data.senderName === "string"
						? message.source.data.senderName
						: (external ?? senderRole),
				externalId: external,
				isAdmin: false,
				kind: senderRole === "system" ? "system" : "human",
				platform: external ? "onebot-napcat" : null,
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
			direction:
				message.role === "assistant" || message.role === "tool"
					? "outbound"
					: message.role === "system"
						? "system"
						: "inbound",
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
			title: session.title || identity.title,
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
		platformAccountId: external,
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
				const sourceId = typeof record.id === "string" ? record.id : `${basename(path)}:${index}`;
				onRecord(sourceId, record);
			}
		}
	};

	const sessionPaths = inventory.sessions.filter(
		(path) =>
			/\.jsonl(?:\.zstd)?$/i.test(path) &&
			!/(?:^|\/)(?:audit|personas?|memory|settings|stickers?)\//i.test(path),
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
		const normalized = normalizeV4Session(parsed.session);
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

	for (const [id, attachment] of attachments) {
		if (attachment.sourcePath === null) continue;
		const requested = attachment.sourcePath.replaceAll("\\", "/");
		const matches = entries.filter(
			(entry) =>
				entry.path.endsWith(`/${requested}`) ||
				entry.path === requested ||
				basename(entry.path) === basename(requested),
		);
		if (matches.length !== 1) continue;
		try {
			const bytes = await fs.readFile(matches[0]!.absolutePath);
			const fileHash = sha256Bytes(bytes).slice("sha256:".length);
			attachments.set(id, {
				...attachment,
				fileHash,
				mediaRelativePath: requested,
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
				platform: message.senderExternalId ? "onebot-napcat" : null,
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
	await readRecordFiles(inventory.memory, (sourceId, value) => {
		const memory = normalizeMemoryRecord(sourceId, value);
		memories.set(memory.canonicalId, memory);
	});
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
		if (!/(?:^|\/)(?:config\.ya?ml|cordis\.patch\.ya?ml)$/i.test(entry.path)) continue;
		try {
			const text = await fs.readFile(entry.absolutePath, "utf8");
			const mapped = mapDshConfigText(text, entry.path);
			configResults.push(mapped);
			for (const setting of mapped.settings) settings.set(setting.canonicalId, setting);
			decisions.push(...mapped.entries);
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
