import {
	DSH_SOURCE,
	inspectDshSnapshot,
	type SnapshotSource,
} from "./dsh-inspect.ts";
import { sha256String, stableStringify } from "./fs.ts";
import { readZip } from "./zip.ts";
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";

export type ElainaConversationKind = "private" | "group" | "webui" | "task" | "plugin";
export type ElainaDirection = "inbound" | "outbound" | "system";

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
	readonly [key: string]: unknown;
}

export interface NormalizedMessage {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly conversationId: string;
	readonly platformMessageId: string;
	readonly direction: ElainaDirection;
	readonly kind: string;
	readonly occurredAt: string;
	readonly ingestedAt: string;
	readonly senderUserId: string;
	readonly content: string;
	readonly attachments: readonly string[];
	readonly durableEntryId: string;
	readonly position: number;
}

export interface NormalizedConversation {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly durableConversationId: string;
	readonly kind: ElainaConversationKind;
	readonly channelId: string;
	readonly platformConversationId: string;
	readonly title: string;
	readonly status: "active" | "archived";
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly memberUserIds: readonly string[];
}

export interface NormalizedUser {
	readonly sourceSystem: typeof DSH_SOURCE;
	readonly sourceId: string;
	readonly sourceHash: string;
	readonly canonicalId: string;
	readonly displayName: string;
	readonly kind: "human" | "bot" | "system";
	readonly isAdmin: boolean;
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
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly createdBy: "migration";
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
}

export type NormalizedDatabase = {
	readonly users: readonly NormalizedUser[];
	readonly conversations: readonly NormalizedConversation[];
	readonly messages: readonly NormalizedMessage[];
	readonly personas: readonly NormalizedPersona[];
	readonly memories: readonly NormalizedMemory[];
	readonly settings: readonly NormalizedSetting[];
	readonly stickers: readonly NormalizedSticker[];
};

export type RecordCounts = Record<keyof NormalizedDatabase, number>;
export type MigrationPlan = RecordCounts & {
	readonly warnings: readonly string[];
	readonly estimatedBytes: number;
};

export interface NormalizeResult {
	readonly database: NormalizedDatabase;
	readonly plan: MigrationPlan;
	readonly warnings: readonly string[];
}

const secretKeys = ["token", "secret", "password", "authorization", "apikey"];
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

function mapRole(role: string | undefined): { direction: ElainaDirection; kind: string } {
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

function mapSessionKind(sourceId: string, type: string | undefined): ElainaConversationKind {
	if (/napcat-private/i.test(sourceId) || type === "private") {
		return "private";
	}
	if (/napcat-group/i.test(sourceId) || type === "group") {
		return "group";
	}
	if (/test/i.test(sourceId)) {
		return "webui";
	}
	if (/work/i.test(sourceId)) {
		return "task";
	}
	return "task";
}

function canonicalId(kind: string, sourceId: string): string {
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
		if (typeof child === "string" && secretKeys.includes(key.toLowerCase())) {
			return [childPath];
		}
		return collectSecretPaths(child, childPath);
	});
}

function settingsRecords(sourceId: string, category: string, value: unknown): NormalizedSetting[] {
	const secretsDetected = collectSecretPaths(value);
	return [{
		sourceSystem: DSH_SOURCE,
		sourceId,
		sourceHash: sha256String(stableStringify(value)),
		canonicalId: canonicalId("setting", sourceId),
		category,
		target: category,
		valueJson: JSON.stringify(value),
		secretsDetected,
		requiresManualDecision: secretsDetected.length > 0 || category === "unknown",
	}];
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

function parseSessions(sourceId: string, path: string, content: string): DshSession[] {
	if (path.endsWith(".jsonl")) {
		return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as DshSession);
	}
	const parsed = JSON.parse(content) as unknown;
	if (Array.isArray(parsed)) {
		return parsed as DshSession[];
	}
	if (parsed && typeof parsed === "object") {
		return [parsed as DshSession];
	}
	return [];
}

function normalizeSession(session: DshSession, sourceId: string): {
	user: NormalizedUser;
	conversation: NormalizedConversation;
	messages: NormalizedMessage[];
} {
	const id = session.id ?? sourceId;
	const createdAt = timestamp(session.createdAt, defaultTime);
	const updatedAt = timestamp(session.updatedAt, createdAt);
	const conversationId = canonicalId("conversation", id);
	const botId = canonicalId("user", "dsh-assistant");
	const bot: NormalizedUser = {
		sourceSystem: DSH_SOURCE,
		sourceId: "assistant",
		sourceHash: sha256String("assistant"),
		canonicalId: botId,
		displayName: "DSH Assistant",
		kind: "bot",
		isAdmin: false,
	};
	const conversation: NormalizedConversation = {
		sourceSystem: DSH_SOURCE,
		sourceId: id,
		sourceHash: sha256String(stableStringify(session)),
		canonicalId: conversationId,
		durableConversationId: `durable_${conversationId}`,
		kind: mapSessionKind(id, session.type),
		channelId: /napcat/i.test(id) ? "onebot-napcat" : "dsh",
		platformConversationId: id,
		title: session.title ?? id,
		status: /test/i.test(id) ? "archived" : "active",
		createdAt,
		updatedAt,
		memberUserIds: [botId],
	};
	const messages: NormalizedMessage[] = [];
	const members = new Set<string>([botId]);
	(session.messages ?? []).forEach((entry, index) => {
		const role = entry.role?.toLowerCase() ?? "system";
		const userSourceId = role === "assistant" || role === "tool" ? "assistant" : `user:${role}`;
		const userId = canonicalId("user", userSourceId);
		const sender: NormalizedUser = role === "assistant" || role === "tool" ? bot : {
			sourceSystem: DSH_SOURCE,
			sourceId: userSourceId,
			sourceHash: sha256String(userSourceId),
			canonicalId: userId,
			displayName: role,
			kind: role === "system" ? "system" : "human",
			isAdmin: false,
		};
		members.add(sender.canonicalId);
		const platformMessageId = entry.id ?? `${sourceId}:${index}`;
		messages.push({
			sourceSystem: DSH_SOURCE,
			sourceId: `${conversationId}:${platformMessageId}`,
			sourceHash: sha256String(stableStringify(entry)),
			conversationId,
			platformMessageId,
			...mapRole(role),
			occurredAt: timestamp(entry.timestamp, createdAt),
			ingestedAt: new Date().toISOString(),
			senderUserId: sender.canonicalId,
			content: contentText(entry.content),
			attachments: entry.attachments ?? [],
			durableEntryId: `durable_${conversationId}:${platformMessageId}`,
			position: index,
		});
	});
	return {
		user: bot,
		conversation: { ...conversation, memberUserIds: [...members] },
		messages,
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
			? value.conversationIds.filter((id): id is string => typeof id === "string")
				.map((id) => canonicalId("conversation", id))
			: [],
	};
}

function normalizeMemoryRecord(
	sourceId: string,
	value: Record<string, unknown>,
): NormalizedMemory {
	const conversationId = typeof value.conversationId === "string"
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
		summary: typeof value.summary === "string" ? value.summary : contentText(value.content ?? value.text),
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

export function countRecords(database: NormalizedDatabase): RecordCounts {
	return {
		users: database.users.length,
		conversations: database.conversations.length,
		messages: database.messages.length,
		personas: database.personas.length,
		memories: database.memories.length,
		settings: database.settings.length,
		stickers: database.stickers.length,
	};
}

function estimateBytes(database: NormalizedDatabase): number {
	return Object.values(database).reduce(
		(total, records) => total + records.reduce((sum, record) => sum + stableStringify(record).length, 0),
		0,
	);
}

function emptyDatabase(): NormalizedDatabase {
	return {
		users: [],
		conversations: [],
		messages: [],
		personas: [],
		memories: [],
		settings: [],
		stickers: [],
	};
}

export async function normalizeSnapshot(source: SnapshotSource): Promise<NormalizeResult> {
	const inventory = await inspectDshSnapshot(source);
	const users = new Map<string, NormalizedUser>();
	const conversations = new Map<string, NormalizedConversation>();
	const messages: NormalizedMessage[] = [];
	const personas = new Map<string, NormalizedPersona>();
	const memories = new Map<string, NormalizedMemory>();
	const settings = new Map<string, NormalizedSetting>();
	const stickers = new Map<string, NormalizedSticker>();

	const readRecordFiles = async (
		paths: readonly string[],
		onRecord: (sourceId: string, value: Record<string, unknown>) => void,
	): Promise<void> => {
		for (const path of paths) {
			const content = await readTextSource(source, path);
			const records: Record<string, unknown>[] = [];
			if (path.endsWith(".jsonl")) {
				for (const line of content.split("\n").filter(Boolean)) {
					records.push(JSON.parse(line) as Record<string, unknown>);
				}
			} else {
				const parsed = JSON.parse(content) as unknown;
				if (Array.isArray(parsed)) {
					records.push(...parsed.filter((record): record is Record<string, unknown> =>
						Boolean(record && typeof record === "object")
					));
				} else if (parsed && typeof parsed === "object") {
					records.push(parsed as Record<string, unknown>);
				}
			}
			for (const [index, record] of records.entries()) {
				const sourceId = typeof record.id === "string" ? record.id : `${basename(path)}:${index}`;
				onRecord(sourceId, record);
			}
		}
	};

	for (const path of inventory.sessions) {
		const content = await readTextSource(source, path);
		for (const session of parseSessions(path, path, content)) {
			const normalized = normalizeSession(session, path);
			users.set(normalized.user.canonicalId, normalized.user);
			conversations.set(normalized.conversation.canonicalId, normalized.conversation);
			for (const message of normalized.messages) {
				messages.push(message);
				const sender = message.senderUserId;
				if (message.direction === "inbound") {
					users.set(sender, {
						sourceSystem: DSH_SOURCE,
						sourceId: `user:${sender}`,
						sourceHash: sha256String(sender),
						canonicalId: sender,
						displayName: `User ${sender.split("_").at(-1)}`,
						kind: "human",
						isAdmin: false,
					});
				} else {
					users.set(sender, normalized.user);
				}
			}
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

	const database: NormalizedDatabase = {
		...emptyDatabase(),
		users: [...users.values()],
		conversations: [...conversations.values()],
		messages,
		personas: [...personas.values()],
		memories: [...memories.values()],
		settings: [...settings.values()],
		stickers: [...stickers.values()],
	};
	return {
		database,
		plan: { ...countRecords(database), warnings: inventory.warnings, estimatedBytes: estimateBytes(database) },
		warnings: inventory.warnings,
	};
}

export function buildMigrationPlan(result: NormalizeResult): MigrationPlan {
	return result.plan;
}
