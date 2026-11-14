import { createZstdDecompress } from "node:zlib";
import { Readable } from "node:stream";
import { open } from "node:fs/promises";
import { sha256String, stableStringify } from "./fs.ts";

export const DSH_SESSION_SCHEMA_VERSION = 4;
export const DSH_SESSION_RECORD_TYPES = [
	"session",
	"user/message",
	"assistant/message",
	"system/message",
	"tool/call",
	"tool/result",
	"session/title",
] as const;

export interface SessionParseError {
	readonly code:
		| "malformed_json"
		| "missing_session_header"
		| "unsupported_version"
		| "record_too_large"
		| "decompression_failed";
	readonly line: number;
	readonly offset: number;
	readonly length?: number;
	readonly message: string;
	readonly resumable: boolean;
}

export interface SessionDiagnostics {
	readonly errors: readonly SessionParseError[];
	readonly malformedRecords: number;
	readonly recordsRead: number;
	readonly recordsDropped: number;
	readonly bytesRead: number;
	readonly lastOffset: number;
	readonly supported: boolean;
	readonly version: number | null;
	readonly unknownRecordTypes: readonly string[];
}

export interface DshV4Envelope {
	readonly index: number;
	readonly offset: number;
	readonly type: string;
	readonly seq: number | null;
	readonly time: number | null;
	readonly sourceEventSeqs: readonly number[];
	readonly data: Record<string, unknown>;
	/** Unknown fields remain in the original record envelope. */
	readonly record: Readonly<Record<string, unknown>>;
}

export interface DshV4Attachment {
	readonly id: string;
	readonly name: string | null;
	readonly path: string | null;
	readonly mimeType: string | null;
	readonly sha256: string | null;
	readonly sizeBytes: number | null;
	readonly raw: Readonly<Record<string, unknown>>;
}

export interface DshV4Reference {
	readonly kind: "reply" | "source-event";
	readonly targetId: string;
	readonly targetSeq: number | null;
}

export interface DshV4Message {
	readonly id: string;
	readonly role: "user" | "assistant" | "system" | "tool";
	readonly kind: string;
	readonly text: string;
	readonly occurredAtMs: number | null;
	readonly seq: number | null;
	readonly eventType: string;
	readonly attachments: readonly DshV4Attachment[];
	readonly references: readonly DshV4Reference[];
	readonly toolName: string | null;
	readonly source: DshV4Envelope;
}

export interface DshV4Session {
	readonly version: number;
	readonly id: string;
	readonly workspace: string | null;
	readonly title: string;
	readonly createdAt: string | null;
	readonly updatedAt: string | null;
	readonly agentPreset: string | null;
	readonly unknownHeaderFields: readonly string[];
	readonly recordTypes: readonly string[];
	readonly envelopes: readonly DshV4Envelope[];
	readonly messages: readonly DshV4Message[];
	readonly attachments: readonly DshV4Attachment[];
	readonly references: readonly DshV4Reference[];
	readonly diagnostics: SessionDiagnostics;
	readonly sourceHash: string;
}

export interface ParsedSessionFile {
	readonly session: DshV4Session | null;
	readonly diagnostics: SessionDiagnostics;
	readonly textMode: boolean;
}

export interface SessionParseOptions {
	readonly workspace?: string;
	readonly sessionIdFallback?: string;
	readonly maxRecordBytes?: number;
	readonly startOffset?: number;
	readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** DSH headers mix ISO strings and epoch milliseconds; both become ISO in the parsed model. */
function isoFrom(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value < 1e12 ? value * 1000 : value).toISOString();
	}
	if (typeof value === "string" && value !== "") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	return null;
}

function asNumberArray(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function eventData(record: Record<string, unknown>): Record<string, unknown> {
	return isRecord(record.data) ? record.data : {};
}

function textFrom(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => textFrom(isRecord(item) ? (item.text ?? item.content) : item))
			.filter((item) => item.length > 0)
			.join("\n");
	}
	if (isRecord(value)) {
		if (typeof value.text === "string") return value.text;
		if (typeof value.content === "string") return value.content;
		if (Array.isArray(value.content)) return textFrom(value.content);
	}
	return "";
}

/** Only user-visible text blocks: reasoning and tool-call blocks are agent internals. */
function visibleTextFrom(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.filter(isRecord)
			.filter((block) => block.type === "text" || block.type === undefined)
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.filter((text) => text !== "")
			.join("\n");
	}
	if (isRecord(value)) {
		if (Array.isArray(value.content)) return visibleTextFrom(value.content);
		if (value.type === "text" || (value.type === undefined && typeof value.text === "string")) {
			return typeof value.text === "string" ? value.text : "";
		}
	}
	return "";
}

function shaFrom(value: string | null): string | null {
	if (value === null) return null;
	const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
	return /^[0-9a-f]{64}$/i.test(bare) ? bare.toLowerCase() : null;
}

/** Image/file content blocks carry their attachment under `block.attachment`. */
function attachmentsFromBlocks(value: unknown, fallbackPrefix: string): DshV4Attachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		if (!isRecord(item)) return [];
		const attachment = isRecord(item.attachment) ? item.attachment : null;
		if (attachment === null) return [];
		const rawId = stringOrNull(
			attachment.attachmentId ?? attachment.id ?? attachment.mediaId ?? attachment.sha256,
		);
		const path = stringOrNull(attachment.path ?? attachment.file ?? attachment.filePath);
		const name = stringOrNull(attachment.name ?? attachment.fileName ?? attachment.file_name);
		return [
			{
				id: rawId ?? `${fallbackPrefix}:content:${index}`,
				mimeType: stringOrNull(attachment.mediaType ?? attachment.mimeType ?? attachment.mime_type),
				name: name ?? path?.split("/").at(-1) ?? null,
				path,
				raw: attachment,
				sha256: shaFrom(rawId ?? stringOrNull(attachment.sha256)),
				sizeBytes: numberOrNull(
					attachment.bytes ?? attachment.sizeBytes ?? attachment.size_bytes ?? attachment.size,
				),
			},
		];
	});
}

function attachmentsFrom(value: unknown, fallbackPrefix: string): DshV4Attachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		if (typeof item === "string") {
			return [
				{
					id: item,
					mimeType: null,
					name: item.split("/").at(-1) ?? null,
					path: item.includes("/") ? item : null,
					raw: { value: item },
					sha256: null,
					sizeBytes: null,
				},
			];
		}
		if (!isRecord(item)) return [];
		const path = stringOrNull(item.path ?? item.file ?? item.fileName ?? item.file_name);
		const id =
			stringOrNull(item.id ?? item.mediaId ?? item.media_id ?? item.sha256) ??
			`${fallbackPrefix}:attachment:${index}`;
		return [
			{
				id,
				mimeType: stringOrNull(item.mimeType ?? item.mime_type),
				name:
					stringOrNull(item.name ?? item.fileName ?? item.file_name) ??
					path?.split("/").at(-1) ??
					null,
				path,
				raw: item,
				sha256: stringOrNull(item.sha256 ?? item.hash),
				sizeBytes: numberOrNull(item.sizeBytes ?? item.size_bytes ?? item.size),
			},
		];
	});
}

function referencesFrom(
	record: Record<string, unknown>,
	data: Record<string, unknown>,
): DshV4Reference[] {
	const references: DshV4Reference[] = [];
	const reply =
		stringOrNull(
			data.replyToMessageId ?? data.reply_to_message_id ?? data.replyTo ?? data.replyToId,
		) ?? (isRecord(data.reply) ? stringOrNull(data.reply.messageId ?? data.reply.id) : null);
	if (reply) references.push({ kind: "reply", targetId: reply, targetSeq: null });
	for (const seq of asNumberArray(record.sourceEventSeqs ?? data.sourceEventSeqs)) {
		references.push({ kind: "source-event", targetId: `seq:${seq}`, targetSeq: seq });
	}
	const replySeq = numberOrNull(data.replyToSeq ?? data.reply_to_seq);
	if (replySeq !== null && !references.some((reference) => reference.targetSeq === replySeq)) {
		references.push({ kind: "reply", targetId: `seq:${replySeq}`, targetSeq: replySeq });
	}
	return references;
}

function roleFor(eventType: string, data: Record<string, unknown>): DshV4Message["role"] | null {
	const explicit = stringOrNull(data.role)?.toLowerCase();
	if (
		explicit === "user" ||
		explicit === "assistant" ||
		explicit === "system" ||
		explicit === "tool"
	) {
		return explicit;
	}
	if (eventType === "user/message" || eventType === "user") return "user";
	if (eventType === "assistant/message" || eventType === "assistant") return "assistant";
	if (eventType === "system/message" || eventType === "system") return "system";
	if (eventType === "tool/call" || eventType === "tool/result" || eventType === "tool") {
		return "tool";
	}
	if (eventType === "message") return "user";
	return null;
}

function messageFromEnvelope(envelope: DshV4Envelope): DshV4Message | null {
	const role = roleFor(envelope.type, envelope.data);
	if (role === null) return null;
	const data = envelope.data;
	const toolName = stringOrNull(data.name ?? data.tool ?? data.toolName);
	const messagePayload = isRecord(data.message) ? data.message : null;
	const contentBlocks = Array.isArray(messagePayload?.content)
		? messagePayload.content
		: Array.isArray(data.content)
			? data.content
			: [];
	const text =
		(role === "assistant"
			? visibleTextFrom(messagePayload?.content ?? data.content) || visibleTextFrom(data.text)
			: textFrom(data.text ?? data.content ?? data.message ?? data.result ?? data.arguments)) ||
		(toolName === null ? "" : toolName);
	const id =
		stringOrNull(
			data.id ?? data.messageId ?? data.message_id ?? data.callId ?? messagePayload?.id,
		) ?? `${envelope.type}:${envelope.seq ?? envelope.index}`;
	const attachments = [
		...attachmentsFrom(
			data.attachments ?? data.media ?? data.files,
			`${envelope.seq ?? envelope.index}`,
		),
		...attachmentsFromBlocks(contentBlocks, `${envelope.seq ?? envelope.index}`),
	];
	const uniqueAttachments = [
		...new Map(attachments.map((attachment) => [attachment.id, attachment])).values(),
	];
	return {
		attachments: uniqueAttachments,
		eventType: envelope.type,
		id,
		kind: role === "tool" ? "tool" : role,
		occurredAtMs: numberOrNull(data.timestamp ?? data.time) ?? envelope.time,
		references: referencesFrom(envelope.record, data),
		role,
		seq: envelope.seq,
		source: envelope,
		text,
		toolName,
	};
}

export interface NdjsonParseOptions extends SessionParseOptions {
	readonly onRecord?: (
		record: Record<string, unknown>,
		meta: { index: number; offset: number },
	) => void;
	readonly onError?: (error: SessionParseError) => void;
}

export interface NdjsonParseResult {
	readonly diagnostics: SessionDiagnostics;
	readonly records: readonly {
		readonly record: Record<string, unknown>;
		readonly offset: number;
	}[];
}

/** Incremental, bounded NDJSON parser. A malformed record never drops later valid records. */
export async function parseNdjsonChunks(
	chunks: AsyncIterable<Uint8Array>,
	options: NdjsonParseOptions = {},
): Promise<NdjsonParseResult> {
	const maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
	const decoder = new TextDecoder();
	let buffer = "";
	let bufferStart = options.startOffset ?? 0;
	let offset = bufferStart;
	let lineNumber = 0;
	let recordsRead = 0;
	let recordsDropped = 0;
	let bytesRead = 0;
	let discardingOversized = false;
	const errors: SessionParseError[] = [];
	const records: { record: Record<string, unknown>; offset: number }[] = [];

	const fail = (error: SessionParseError): void => {
		recordsDropped += 1;
		errors.push(error);
		options.onError?.(error);
	};

	const processLine = (rawLine: string, lineOffset: number): void => {
		lineNumber += 1;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.trim() === "") return;
		if (discardingOversized) {
			discardingOversized = false;
			fail({
				code: "record_too_large",
				length: line.length,
				line: lineNumber,
				message: `Dropped an oversized or malformed NDJSON record (${line.length} bytes)`,
				offset: lineOffset,
				resumable: true,
			});
			return;
		}
		if (line.length > maxRecordBytes) {
			fail({
				code: "record_too_large",
				length: line.length,
				line: lineNumber,
				message: `Record exceeds the ${maxRecordBytes} byte bound`,
				offset: lineOffset,
				resumable: true,
			});
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			fail({
				code: "malformed_json",
				length: line.length,
				line: lineNumber,
				message: "Malformed JSON record was skipped",
				offset: lineOffset,
				resumable: true,
			});
			return;
		}
		if (!isRecord(parsed)) {
			fail({
				code: "malformed_json",
				length: line.length,
				line: lineNumber,
				message: "NDJSON record is not a JSON object",
				offset: lineOffset,
				resumable: true,
			});
			return;
		}
		const recordOffset = lineOffset;
		recordsRead += 1;
		records.push({ offset: recordOffset, record: parsed });
		options.onRecord?.(parsed, { index: records.length - 1, offset: recordOffset });
	};

	for await (const chunk of chunks) {
		bytesRead += chunk.byteLength;
		buffer += decoder.decode(chunk, { stream: true });
		offset += chunk.byteLength;
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			const lineOffset = bufferStart;
			buffer = buffer.slice(newline + 1);
			bufferStart += newline + 1;
			processLine(line, lineOffset);
			newline = buffer.indexOf("\n");
		}
		if (buffer.length > maxRecordBytes) {
			fail({
				code: "record_too_large",
				length: buffer.length,
				line: lineNumber + 1,
				message: "NDJSON record exceeded the bound and was discarded until a newline",
				offset: bufferStart,
				resumable: true,
			});
			discardingOversized = true;
			buffer = "";
			bufferStart = offset;
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) processLine(buffer, bufferStart);

	return {
		diagnostics: {
			bytesRead,
			errors,
			lastOffset: offset,
			malformedRecords: errors.filter((error) => error.code === "malformed_json").length,
			recordsDropped,
			recordsRead,
			supported: true,
			unknownRecordTypes: [],
			version: null,
		},
		records,
	};
}

async function* bytesFromFile(path: string): AsyncGenerator<Uint8Array> {
	const handle = await open(path, "r");
	const buffer = new Uint8Array(1024 * 1024);
	try {
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) return;
			yield buffer.slice(0, bytesRead);
		}
	} finally {
		await handle.close();
	}
}

async function* decompressZstd(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
	const decompressor = createZstdDecompress();
	const stream = Readable.from(chunks).pipe(decompressor);
	for await (const chunk of stream) {
		yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as Buffer);
	}
}

function finalizeSession(
	records: readonly { record: Record<string, unknown>; offset: number }[],
	diagnostics: SessionDiagnostics,
	options: SessionParseOptions,
): DshV4Session | null {
	if (records.length === 0) {
		return null;
	}
	const header = records[0]!.record;
	if (header.type !== "session") {
		return null;
	}
	const rawVersion = header.version;
	const version =
		typeof rawVersion === "number"
			? rawVersion
			: typeof rawVersion === "string" && /^\d+$/.test(rawVersion)
				? Number(rawVersion)
				: null;
	if (version !== DSH_SESSION_SCHEMA_VERSION) {
		return null;
	}
	const envelopes: DshV4Envelope[] = [];
	const unknownRecordTypes = new Set<string>();
	const recordTypes = new Set<string>();
	for (const [index, item] of records.entries()) {
		const record = item.record;
		const type = typeof record.type === "string" ? record.type : "";
		if (type === "") continue;
		if (type === "session" && index > 0) continue;
		recordTypes.add(type);
		if (!(DSH_SESSION_RECORD_TYPES as readonly string[]).includes(type)) {
			unknownRecordTypes.add(type);
		}
		envelopes.push({
			data: eventData(record),
			index,
			offset: item.offset,
			record,
			seq: numberOrNull(record.seq),
			sourceEventSeqs: asNumberArray(record.sourceEventSeqs),
			time: numberOrNull(record.time),
			type,
		});
	}
	const messages = envelopes
		.map(messageFromEnvelope)
		.filter((message): message is DshV4Message => message !== null);
	const attachments = messages.flatMap((message) => message.attachments);
	const references = messages.flatMap((message) => message.references);
	const titleEvent = envelopes.find((envelope) => envelope.type === "session/title");
	const title = stringOrNull(titleEvent?.data.title) ?? stringOrNull(header.title);
	const id =
		stringOrNull(header.id) ??
		options.sessionIdFallback ??
		`session-${sha256String(stableStringify(header)).slice(7, 15)}`;
	const fullDiagnostics: SessionDiagnostics = {
		...diagnostics,
		supported: true,
		unknownRecordTypes: [...unknownRecordTypes].toSorted((left, right) =>
			left.localeCompare(right),
		),
		version,
	};
	const lastEventTime = envelopes
		.map((envelope) => envelope.time)
		.filter((time): time is number => time !== null)
		.at(-1);
	return {
		agentPreset: stringOrNull(header.agentPreset ?? header.preset),
		attachments,
		createdAt: isoFrom(header.createdAt ?? header.created_at ?? header.time),
		diagnostics: fullDiagnostics,
		envelopes,
		id,
		messages,
		recordTypes: [...recordTypes].toSorted((left, right) => left.localeCompare(right)),
		references,
		sourceHash: sha256String(stableStringify(records.map((item) => item.record))),
		title: title ?? id,
		unknownHeaderFields: Object.keys(header)
			.filter(
				(key) =>
					![
						"type",
						"version",
						"id",
						"title",
						"createdAt",
						"updatedAt",
						"cwd",
						"agentPreset",
						"preset",
					].includes(key),
			)
			.toSorted((left, right) => left.localeCompare(right)),
		updatedAt:
			isoFrom(header.updatedAt ?? header.updated_at) ?? isoFrom(lastEventTime ?? undefined),
		version,
		workspace: stringOrNull(header.cwd) ?? options.workspace ?? null,
	};
}

async function parseRecords(
	chunks: AsyncIterable<Uint8Array>,
	options: SessionParseOptions,
): Promise<ParsedSessionFile> {
	const parsed = await parseNdjsonChunks(chunks, options);
	const records = parsed.records;
	const first = records[0]?.record;
	let diagnostics = parsed.diagnostics;
	if (first === undefined) {
		diagnostics = {
			...diagnostics,
			errors: [
				...diagnostics.errors,
				{
					code: "missing_session_header",
					line: 0,
					message: "Session stream contains no records",
					offset: 0,
					resumable: false,
				},
			],
			supported: false,
		};
		return { diagnostics, session: null, textMode: true };
	}
	if (first.type !== "session") {
		diagnostics = {
			...diagnostics,
			errors: [
				...diagnostics.errors,
				{
					code: "missing_session_header",
					line: 1,
					message: "First record is not a session header",
					offset: records[0]?.offset ?? 0,
					resumable: false,
				},
			],
			supported: false,
		};
		return { diagnostics, session: null, textMode: true };
	}
	const version = first.version;
	const numericVersion =
		typeof version === "number"
			? version
			: typeof version === "string" && /^\d+$/.test(version)
				? Number(version)
				: null;
	if (numericVersion !== DSH_SESSION_SCHEMA_VERSION) {
		diagnostics = {
			...diagnostics,
			errors: [
				...diagnostics.errors,
				{
					code: "unsupported_version",
					line: 1,
					message:
						numericVersion === null
							? "Session header has no supported schema version"
							: `Unsupported session schema version ${numericVersion}; expected v${DSH_SESSION_SCHEMA_VERSION}`,
					offset: records[0]?.offset ?? 0,
					resumable: false,
				},
			],
			supported: false,
			version: numericVersion,
		};
		return { diagnostics, session: null, textMode: true };
	}
	const session = finalizeSession(records, diagnostics, options);
	return {
		diagnostics: session?.diagnostics ?? diagnostics,
		session,
		textMode: true,
	};
}

export async function parseSessionV4Chunks(
	chunks: AsyncIterable<Uint8Array>,
	options: SessionParseOptions = {},
): Promise<ParsedSessionFile> {
	return parseRecords(chunks, options);
}

export async function parseSessionV4Text(
	text: string,
	options: SessionParseOptions = {},
): Promise<ParsedSessionFile> {
	async function* chunks(): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(text);
	}
	return parseRecords(chunks(), options);
}

function decompressionFailure(error: unknown): ParsedSessionFile {
	return {
		diagnostics: {
			bytesRead: 0,
			errors: [
				{
					code: "decompression_failed",
					line: 0,
					message: error instanceof Error ? error.message : String(error),
					offset: 0,
					resumable: false,
				},
			],
			lastOffset: 0,
			malformedRecords: 0,
			recordsDropped: 0,
			recordsRead: 0,
			supported: false,
			unknownRecordTypes: [],
			version: null,
		},
		session: null,
		textMode: false,
	};
}

/** zstd frame magic: 0x28 0xB5 0x2F 0xFD. */
function isZstdFrame(bytes: Uint8Array): boolean {
	return bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

export async function parseSessionV4Bytes(
	bytes: Uint8Array,
	options: SessionParseOptions = {},
): Promise<ParsedSessionFile> {
	async function* chunks(): AsyncGenerator<Uint8Array> {
		yield bytes;
	}
	// Callers (including the normalize pipeline) hand us raw `.jsonl.zstd` file bytes;
	// detect the frame magic so compressed sessions are never parsed as binary text.
	if (isZstdFrame(bytes)) {
		try {
			return await parseRecords(decompressZstd(chunks()), options);
		} catch (error) {
			return decompressionFailure(error);
		}
	}
	return parseRecords(chunks(), options);
}

export async function parseSessionV4File(
	path: string,
	options: SessionParseOptions = {},
): Promise<ParsedSessionFile> {
	if (/\.zst(?:d)?$/i.test(path)) {
		try {
			return await parseRecords(decompressZstd(bytesFromFile(path)), options);
		} catch (error) {
			return decompressionFailure(error);
		}
	}
	return parseRecords(bytesFromFile(path), options);
}

export interface DshConversationIdentity {
	readonly kind: "private" | "group" | "webui" | "task" | "plugin";
	readonly channelId: string;
	readonly platformConversationId: string;
	readonly title: string;
	readonly isTest: boolean;
	readonly isWorkspaceOnly: boolean;
}

/** Map NapCat group/private ids and DSH workspace/test sessions to Elaina chat objects. */
export function mapDshConversationIdentity(input: {
	readonly sessionId: string;
	readonly workspace?: string | null;
	readonly title?: string | null;
	readonly type?: string | null;
}): DshConversationIdentity {
	const id = input.sessionId;
	// Session directories append a random suffix and a `-rN` generation
	// (`napcat-group-118023883-wujhlyc-r1`); the chat key is only the leading id.
	const group =
		/^(?:napcat-(?:archive|interject)-)?(?:group|napcat-group)[-_:](\d+)/i.exec(id) ??
		/(?:^|[-_:])napcat-(?:archive-|interject-)?group[-_:](\d+)/i.exec(id);
	if (group?.[1]) {
		return {
			channelId: "onebot",
			isTest: false,
			isWorkspaceOnly: false,
			kind: "group",
			platformConversationId: group[1],
			title: `Group ${group[1]}`,
		};
	}
	const groupFallback =
		/^(?:napcat-archive-)?(?:group|napcat-group)[-_:]([a-z0-9_]+)$/i.exec(id) ??
		/^group[-_:](.+)$/i.exec(id);
	if (groupFallback?.[1]) {
		return {
			channelId: "onebot",
			isTest: false,
			isWorkspaceOnly: false,
			kind: "group",
			platformConversationId: groupFallback[1],
			title: `Group ${groupFallback[1]}`,
		};
	}
	const privateChat =
		/^(?:napcat-(?:archive|interject)-)?(?:private|napcat-private)[-_:](\d+)/i.exec(id) ??
		/(?:^|[-_:])napcat-(?:archive-|interject-)?private[-_:](\d+)/i.exec(id);
	if (privateChat?.[1]) {
		return {
			channelId: "onebot",
			isTest: false,
			isWorkspaceOnly: false,
			kind: "private",
			platformConversationId: privateChat[1],
			title: `Private ${privateChat[1]}`,
		};
	}
	const privateFallback =
		/^(?:napcat-archive-)?(?:private|napcat-private)[-_:]([a-z0-9_]+)$/i.exec(id) ??
		/^private[-_:](.+)$/i.exec(id);
	if (privateFallback?.[1]) {
		return {
			channelId: "onebot",
			isTest: false,
			isWorkspaceOnly: false,
			kind: "private",
			platformConversationId: privateFallback[1],
			title: `Private ${privateFallback[1]}`,
		};
	}
	const test = /test/i.test(id) || /test/i.test(input.workspace ?? "");
	const workspaceOnly = Boolean(input.workspace) || /workspace/i.test(id);
	if (test || workspaceOnly || input.type === "webui" || input.type === "workspace") {
		return {
			channelId: "webui",
			isTest: test,
			isWorkspaceOnly: workspaceOnly,
			kind: "webui",
			platformConversationId: id,
			title: input.title ?? (test ? `Test ${id}` : `Workspace ${input.workspace ?? id}`),
		};
	}
	return {
		channelId: "dsh",
		isTest: false,
		isWorkspaceOnly: false,
		kind: input.type === "private" ? "private" : input.type === "group" ? "group" : "task",
		platformConversationId: id,
		title: input.title ?? id,
	};
}
