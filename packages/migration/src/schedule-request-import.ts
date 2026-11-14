import type { SnapshotSource } from "./dsh-inspect.ts";
import { promises as fs } from "node:fs";
import { relative } from "node:path";
import type { DecisionEntry } from "./decision.ts";
import { listFiles, resolveSnapshotRoot, sha256String, stableStringify } from "./fs.ts";
import { conversationIdForPlatformKey } from "./memory-import.ts";
import { mapDshConversationIdentity } from "./session-v4.ts";

export type ImportedTaskStatus =
	| "scheduled"
	| "running"
	| "completed"
	| "cancelled"
	| "failed"
	| "skipped";

export interface ImportedScheduledTask {
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
	readonly status: ImportedTaskStatus;
	readonly lastError: string | null;
	readonly createdByKind: "user" | "agent" | "admin";
	readonly createdById: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly sourceHash: string;
	readonly provenance: Readonly<Record<string, unknown>>;
}

export type ImportedRequestStatus = "pending" | "approved" | "rejected" | "failed" | "uncertain";
export type ImportedRequestKind = "friend" | "group-add" | "group-invite";

export interface ImportedRequest {
	readonly id: string;
	readonly accountId: string;
	readonly channelId: string;
	readonly kind: ImportedRequestKind;
	readonly flag: string;
	readonly subType: string | null;
	readonly requesterExternalId: string;
	readonly requesterDisplayName: string | null;
	readonly groupExternalId: string | null;
	readonly comment: string | null;
	readonly status: ImportedRequestStatus;
	readonly resolutionAction: "approve" | "reject" | null;
	readonly resolutionReason: string | null;
	readonly resolvedAt: string | null;
	readonly errorMessage: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly raw: Readonly<Record<string, unknown>>;
	readonly sourceHash: string;
}

export interface ScheduleRequestImportResult {
	readonly tasks: readonly ImportedScheduledTask[];
	readonly requests: readonly ImportedRequest[];
	readonly decisions: readonly DecisionEntry[];
	readonly warnings: readonly string[];
	readonly skippedExpired: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function string(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ms(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string" && value !== "") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
	}
	return null;
}

function iso(value: unknown, fallbackMs: number): string {
	const parsed = ms(value);
	return new Date(parsed ?? fallbackMs).toISOString();
}

function canonicalId(kind: string, sourceId: string): string {
	return `dsh_${kind}_${sourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function looksLikeTask(value: Record<string, unknown>): boolean {
	return (
		"dueAt" in value ||
		"status" in value ||
		"createdAt" in value ||
		"kind" in value ||
		"scheduledFor" in value
	);
}

function collectTasks(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	if (!isRecord(value)) return [];
	if (looksLikeTask(value)) return [value];
	const tasks: Record<string, unknown>[] = [];
	for (const key of ["tables", "tasks", "items", "entries", "scheduled_tasks"]) {
		const child = value[key];
		if (Array.isArray(child)) tasks.push(...collectTasks(child));
		else if (isRecord(child)) tasks.push(...collectTasks(child));
	}
	if (tasks.length === 0) {
		for (const child of Object.values(value)) {
			if (isRecord(child) || Array.isArray(child)) tasks.push(...collectTasks(child));
		}
	}
	return tasks;
}

function conversationForTask(
	task: Record<string, unknown>,
	path: string,
): { conversationId: string; chatObjectId: string | null } {
	const explicit = string(task.conversationId ?? task.conversation_id);
	if (explicit) {
		return {
			chatObjectId: canonicalId("chat", explicit),
			conversationId: canonicalId("conversation", explicit),
		};
	}
	const chatKey = string(task.chatKey ?? task.chat_key ?? task.target ?? task.chatId);
	if (chatKey) {
		const conversationId = conversationIdForPlatformKey(chatKey);
		if (conversationId !== "") {
			return { chatObjectId: canonicalId("chat", conversationId), conversationId };
		}
		return {
			chatObjectId: canonicalId("chat", chatKey),
			conversationId: canonicalId("conversation", chatKey),
		};
	}
	const fallback = /(?:^|\/)napcat\/schedule\.json$/i.test(path)
		? "napcat-schedule"
		: "dsh-schedule";
	const mapped = mapDshConversationIdentity({ sessionId: fallback });
	return {
		chatObjectId: canonicalId("chat", fallback),
		conversationId: canonicalId("conversation", mapped.platformConversationId),
	};
}

function mapStatus(value: string | null): ImportedTaskStatus | null {
	switch (value?.toLowerCase()) {
		case "pending":
		case "scheduled":
		case "queued":
			return "scheduled";
		case "running":
		case "firing":
			return "running";
		case "done":
		case "completed":
		case "complete":
			return "completed";
		case "cancelled":
		case "canceled":
			return "cancelled";
		case "failed":
		case "error":
			return "failed";
		case "skipped":
			return "skipped";
		default:
			return null;
	}
}

function taskFromRecord(
	record: Record<string, unknown>,
	index: number,
	path: string,
	nowMs: number,
): { task: ImportedScheduledTask | null; expired: boolean; reason?: string } {
	const id = string(record.id ?? record.taskId ?? record.task_id) ?? `${path}:${index}`;
	const rawStatus = string(record.status);
	const status = mapStatus(rawStatus);
	const createdAtMs = ms(record.createdAt ?? record.created_at) ?? nowMs;
	const scheduledForMs =
		ms(record.dueAt ?? record.due_at ?? record.scheduledFor ?? record.scheduled_for_ms) ??
		createdAtMs;
	const repeatEveryMs =
		number(record.repeatEveryMs ?? record.repeat_every_ms ?? record.intervalMs) ?? null;
	const fireCount = number(record.fireCount ?? record.fire_count) ?? 0;
	const expired =
		(repeatEveryMs === null || repeatEveryMs <= 0) &&
		(status === "scheduled" || status === null) &&
		scheduledForMs < nowMs &&
		fireCount === 0;
	if (status === null) {
		return {
			expired,
			reason: "Unrecognized schedule status",
			task: null,
		};
	}
	const { conversationId, chatObjectId } = conversationForTask(record, path);
	const kindValue = string(record.kind ?? record.type)?.toLowerCase();
	const kind =
		kindValue === "nudge" || kindValue === "proactive" || kindValue === "workflow"
			? kindValue
			: kindValue === "reminder" || kindValue === "message" || kindValue === "remind"
				? "remind"
				: "remind";
	const prompt =
		string(record.prompt ?? record.message ?? record.text ?? record.content) ??
		`Migrated ${kind} task`;
	return {
		expired,
		...(expired ? { reason: "Expired one-shot task skipped by policy" } : {}),
		task: {
			attempts: number(record.attempts) ?? 0,
			cancelIfReplied: record.cancelIfReplied === true || record.cancel_if_replied === 1,
			chatObjectId,
			conversationId,
			createdAtMs,
			createdById: string(record.createdById ?? record.created_by_id) ?? "dsh-migration",
			createdByKind:
				record.createdByKind === "user" || record.createdByKind === "admin"
					? record.createdByKind
					: "agent",
			dueWindowMs: number(record.flexMs ?? record.dueWindowMs ?? record.due_window_ms) ?? null,
			id: canonicalId("task", id),
			kind,
			lastError: string(record.lastError ?? record.last_error),
			maxAttempts: number(record.maxAttempts ?? record.max_attempts) ?? 3,
			occurrences: number(record.occurrences) ?? fireCount,
			prompt,
			provenance: { path, sourceId: id },
			repeatIntervalMs: repeatEveryMs && repeatEveryMs > 0 ? repeatEveryMs : null,
			scheduledForMs,
			sourceHash: sha256String(stableStringify(record)),
			status,
			taskId: id,
			updatedAtMs:
				ms(record.updatedAt ?? record.updated_at ?? record.closedAt ?? record.firedAt) ??
				createdAtMs,
		},
	};
}

function requestKind(record: Record<string, unknown>): ImportedRequestKind {
	const kind = string(record.kind ?? record.type)?.toLowerCase();
	const subType = string(record.subType ?? record.sub_type)?.toLowerCase();
	if (kind === "friend") return "friend";
	if (subType === "invite") return "group-invite";
	return "group-add";
}

function requestStatus(record: Record<string, unknown>): {
	readonly status: ImportedRequestStatus;
	readonly resolutionAction: "approve" | "reject" | null;
} {
	const status = string(record.status ?? record.decision ?? record.result)?.toLowerCase();
	if (
		status === "approve" ||
		status === "approved" ||
		status === "accept" ||
		status === "accepted"
	) {
		return { resolutionAction: "approve", status: "approved" };
	}
	if (status === "reject" || status === "rejected" || status === "deny" || status === "denied") {
		return { resolutionAction: "reject", status: "rejected" };
	}
	if (status === "failed" || status === "error")
		return { resolutionAction: null, status: "failed" };
	if (status === "uncertain") return { resolutionAction: null, status: "uncertain" };
	if (record.seenAt !== null && record.seenAt !== undefined) {
		return { resolutionAction: null, status: "pending" };
	}
	return { resolutionAction: null, status: "pending" };
}

function requestFromRecord(
	record: Record<string, unknown>,
	index: number,
	path: string,
): ImportedRequest | null {
	const flag = string(record.flag ?? record.requestId ?? record.request_id);
	if (flag === null) return null;
	const requesterExternalId =
		string(record.userId ?? record.user_id ?? record.requesterId ?? record.requester_external_id) ??
		"unknown";
	const createdAt = iso(record.at ?? record.createdAt ?? record.created_at, Date.now());
	const { status, resolutionAction } = requestStatus(record);
	const id = canonicalId(
		"request",
		string(record.id) ?? `${flag}:${requesterExternalId}:${index}:${path}`,
	);
	return {
		accountId: string(record.accountId ?? record.account_id) ?? "migration",
		channelId: string(record.channelId ?? record.channel_id) ?? "onebot-napcat",
		comment: string(record.comment ?? record.message),
		createdAt,
		errorMessage: string(record.error ?? record.errorMessage),
		flag,
		groupExternalId: string(record.groupId ?? record.group_id),
		id,
		kind: requestKind(record),
		raw: record,
		requesterDisplayName: string(record.requesterDisplayName ?? record.nickname ?? record.name),
		requesterExternalId,
		resolutionAction,
		resolutionReason: string(record.reason ?? record.resolutionReason),
		resolvedAt: string(record.resolvedAt ?? record.resolved_at ?? record.decisionAt),
		sourceHash: sha256String(stableStringify(record)),
		status,
		subType: string(record.subType ?? record.sub_type),
		updatedAt: iso(record.updatedAt ?? record.seenAt ?? record.at, new Date(createdAt).getTime()),
	};
}

async function sourceFiles(
	source: SnapshotSource,
): Promise<{ path: string; absolutePath: string }[]> {
	const files: { path: string; absolutePath: string }[] = [];
	for (const [root, label] of source) {
		const stats = await fs.stat(root).catch(() => null);
		if (stats?.isDirectory()) {
			const dataRoot = await resolveSnapshotRoot(root);
			for (const file of await listFiles(dataRoot)) {
				files.push({
					absolutePath: file,
					path: `${label}/${relative(dataRoot, file).replaceAll("\\", "/")}`,
				});
			}
		} else if (stats?.isFile()) {
			files.push({ absolutePath: root, path: label });
		}
	}
	return files;
}

export async function importDshSchedulesAndRequests(
	source: SnapshotSource,
	options: { readonly now?: () => number } = {},
): Promise<ScheduleRequestImportResult> {
	const now = options.now ?? Date.now;
	const nowMs = now();
	const files = await sourceFiles(source);
	const tasks: ImportedScheduledTask[] = [];
	const requests: ImportedRequest[] = [];
	const decisions: DecisionEntry[] = [];
	const warnings: string[] = [];
	let skippedExpired = 0;

	for (const file of files) {
		if (/(?:^|\/)schedule\.json$/i.test(file.path)) {
			try {
				const parsed = JSON.parse(await fs.readFile(file.absolutePath, "utf8")) as unknown;
				for (const [index, record] of collectTasks(parsed).entries()) {
					const result = taskFromRecord(record, index, file.path, nowMs);
					if (result.task === null) {
						decisions.push({
							action: "review",
							area: "schedule-proactive",
							reason: result.reason ?? "Unmappable schedule entry",
							source: `${file.path}#${index}`,
							target: "plugin.proactive-scheduler.tasks",
						});
						continue;
					}
					if (result.expired) {
						skippedExpired += 1;
						decisions.push({
							action: "discard",
							area: "schedule-proactive",
							reason: "Expired one-shot task skipped by policy",
							source: `${file.path}#${index}`,
							target: "plugin.proactive-scheduler.tasks",
						});
						continue;
					}
					tasks.push(result.task);
					decisions.push({
						action: "remap",
						area: "schedule-proactive",
						reason: "Mapped durable schedule record without replaying it",
						source: `${file.path}#${index}`,
						target: "plugin.proactive-scheduler.tasks",
					});
				}
			} catch (error) {
				warnings.push(`Failed to parse ${file.path}: ${String(error)}`);
			}
		}
		if (
			/(?:^|\/)(?:friend-requests|group-requests|requests)-?(?:ledger)?\.jsonl$/i.test(file.path)
		) {
			const content = await fs.readFile(file.absolutePath, "utf8").catch(() => "");
			for (const [index, line] of content.split(/\r?\n/).entries()) {
				if (line.trim() === "") continue;
				let record: unknown;
				try {
					record = JSON.parse(line) as unknown;
				} catch {
					decisions.push({
						action: "review",
						area: "admin-danger",
						reason: "Malformed request ledger record",
						source: `${file.path}#${index}`,
						target: "requests",
					});
					continue;
				}
				if (!isRecord(record)) continue;
				const request = requestFromRecord(record, index, file.path);
				if (request === null) {
					decisions.push({
						action: "review",
						area: "admin-danger",
						reason: "Request ledger entry has no stable flag",
						source: `${file.path}#${index}`,
						target: "requests",
					});
					continue;
				}
				requests.push(request);
				decisions.push({
					action: "remap",
					area: "admin-danger",
					reason: "Archived request decision imported; no outbound action is replayed",
					source: `${file.path}#${index}`,
					target: "requests",
				});
			}
		}
	}

	return {
		decisions,
		requests,
		skippedExpired,
		tasks,
		warnings,
	};
}
